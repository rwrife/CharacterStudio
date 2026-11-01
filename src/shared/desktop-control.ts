export type DesktopCommand =
  | { action: 'inspect' }
  | { action: 'click' | 'focus'; ref: string }
  | { action: 'fill'; ref: string; value: string }
  | { action: 'select'; ref: string; values: string[] }
  | { action: 'check'; ref: string; checked: boolean }
  | { action: 'scroll'; ref: string; x: number; y: number }

export interface DesktopElement {
  ref: string
  role: string
  name: string
  tag: string
  type?: string
  value?: string
  checked?: boolean
  disabled: boolean
  expanded?: string
  selected?: string
  pressed?: string
  options?: { label: string; value: string; disabled: boolean }[]
  bounds: { x: number; y: number; width: number; height: number }
}

// Self-contained: the main process injects this trusted function, never client-supplied JavaScript.
export async function desktopControl(command: DesktopCommand) {
  const root = window as Window & {
    __studioMcpElements?: { document: Document; epoch: string; next: number; elements: Map<string, Element>; refs: WeakMap<Element, string> }
  }
  if (!root.__studioMcpElements || root.__studioMcpElements.document !== document) {
    root.__studioMcpElements = { document, epoch: crypto.randomUUID().replaceAll('-', ''), next: 1, elements: new Map(), refs: new WeakMap() }
  }
  const registry = root.__studioMcpElements
  const visible = (el: Element) => {
    const style = getComputedStyle(el)
    return el.isConnected && !el.closest('[hidden], [inert], [aria-hidden="true"]') &&
      style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0
  }
  const label = (el: Element): string => {
    const labelled = el.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ')
    const labels = 'labels' in el ? Array.from((el as HTMLInputElement).labels ?? []).map(l => l.textContent).join(' ') : ''
    return (el.getAttribute('aria-label') || labelled || labels || el.getAttribute('title') ||
      el.getAttribute('alt') || (el instanceof HTMLInputElement ? el.placeholder : el instanceof HTMLElement ? el.innerText : el.textContent) || el.tagName.toLowerCase())
      .replace(/\s+/g, ' ').trim().slice(0, 1000)
  }
  const disabled = (el: Element) => el.matches(':disabled') || !!el.closest('[aria-disabled="true"]')
  const modal = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).filter(visible).at(-1)
  const bounds = (el: Element) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }
  if (command.action === 'inspect') {
    for (const [ref, el] of registry.elements) if (!el.isConnected) registry.elements.delete(ref)
    const elements: DesktopElement[] = []
    const scope = modal ?? document.body
    const candidates = [scope, ...scope.querySelectorAll('button, input, textarea, select, a, summary, canvas, img, [role], [tabindex], [aria-label], .react-flow__handle')]
    for (const el of candidates) {
      if (!visible(el)) continue
      let ref = registry.refs.get(el)
      if (!ref) { ref = `e${registry.epoch}-${registry.next++}`; registry.refs.set(el, ref); registry.elements.set(ref, el) }
      const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
      elements.push({
        ref, tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') ?? (el instanceof HTMLButtonElement ? 'button' : field ? el instanceof HTMLSelectElement ? 'combobox' : el instanceof HTMLInputElement && ['checkbox', 'radio', 'range'].includes(el.type) ? el.type : 'textbox' : el.tagName.toLowerCase()),
        name: label(el), disabled: disabled(el), bounds: bounds(el),
        ...(el instanceof HTMLInputElement ? { type: el.type, checked: el.checked } : {}),
        ...(field && !(el instanceof HTMLInputElement && el.type === 'password') ? { value: el.value } : {}),
        ...(el instanceof HTMLSelectElement ? { options: Array.from(el.options).map(o => ({ label: o.label, value: o.value, disabled: o.disabled || !!o.closest('optgroup:disabled') })) } : {}),
        ...(el.hasAttribute('aria-expanded') ? { expanded: el.getAttribute('aria-expanded')! } : {}),
        ...(el.hasAttribute('aria-selected') ? { selected: el.getAttribute('aria-selected')! } : {}),
        ...(el.hasAttribute('aria-pressed') ? { pressed: el.getAttribute('aria-pressed')! } : {})
      })
    }
    return {
      title: document.title, modal: modal ? label(modal) : null,
      text: (scope as HTMLElement).innerText.slice(0, 60000), elements,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      alerts: Array.from(scope.querySelectorAll('[role="alert"], [role="status"]')).filter(visible).map(el => el.textContent?.trim())
    }
  }
  const el = registry.elements.get(command.ref)
  if (!el || !visible(el)) throw new Error('Element is stale or hidden. Call studio_get_ui again.')
  if (modal && !modal.contains(el)) throw new Error('A modal dialog is open. Interact with that dialog first.')
  if (!(el instanceof HTMLElement || el instanceof SVGElement)) throw new Error('Element cannot be controlled.')
  if (disabled(el)) throw new Error('This control is disabled. Resolve the visible prerequisites first.')
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  if (command.action === 'scroll') {
    el.scrollBy({ left: command.x, top: command.y, behavior: 'instant' })
  } else {
    el.focus()
    if (command.action === 'focus' && document.activeElement !== el) throw new Error('This element cannot receive keyboard focus. Choose a focusable control.')
    if (command.action === 'click') {
      const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      if (!hit || !(el.contains(hit) || hit.contains(el))) throw new Error('Control is covered. Scroll it into view or close the covering panel.')
      if (!(el instanceof HTMLElement)) throw new Error('Use studio_pointer for SVG controls.')
      el.click()
    } else if (command.action === 'fill') {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ||
          el instanceof HTMLInputElement && !['text', 'search', 'url', 'tel', 'email', 'number', 'range'].includes(el.type) ||
          el.readOnly) throw new Error('This is not an editable text, number, or range field.')
      if (el.maxLength >= 0 && command.value.length > el.maxLength) throw new Error(`Field permits at most ${el.maxLength} characters.`)
      if (el instanceof HTMLInputElement && ['number', 'range'].includes(el.type)) {
        const n = Number(command.value)
        if (!command.value.trim() || !Number.isFinite(n) || el.min !== '' && n < Number(el.min) || el.max !== '' && n > Number(el.max)) throw new Error('Value is outside this field\'s numeric range.')
      }
      const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(el, command.value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (command.action === 'select') {
      if (!(el instanceof HTMLSelectElement)) throw new Error('This is not a select control.')
      if (!el.multiple && command.values.length !== 1) throw new Error('Choose exactly one option.')
      for (const value of command.values) {
        const option = Array.from(el.options).find(o => o.value === value)
        if (!option || option.disabled || option.closest('optgroup:disabled')) throw new Error(`Unavailable option: ${value}`)
      }
      for (const option of el.options) option.selected = command.values.includes(option.value)
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (command.action === 'check') {
      if (!(el instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(el.type)) throw new Error('This is not a checkbox or radio control.')
      if (el.type === 'radio' && !command.checked) throw new Error('Select another radio option instead.')
      if (el.checked !== command.checked) el.click()
    }
  }
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  return { ref: command.ref, action: command.action, bounds: bounds(el) }
}
