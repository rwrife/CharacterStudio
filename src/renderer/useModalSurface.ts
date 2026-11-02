import { useEffect, useRef, type RefObject } from 'react'

export function useModalSurface(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const previousFocus = document.activeElement
    const backdrop = dialog.closest('.modal-backdrop')
    const siblings = Array.from(backdrop?.parentElement?.children ?? []).filter((el): el is HTMLElement =>
      el instanceof HTMLElement && el !== backdrop)
    const previousInert = siblings.map(el => el.inert)
    siblings.forEach(el => { el.inert = true })
    dialog.focus()
    const keydown = (event: KeyboardEvent) => {
      const top = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'))
        .filter(el => !el.closest('[hidden], [inert]') && el.getClientRects().length).at(-1)
      if (top !== dialog) return
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return }
      if (event.key !== 'Tab') return
      const fields = Array.from(dialog.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], summary, [tabindex]'))
        .filter(el => !el.matches(':disabled, [tabindex="-1"]') && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0)
      const first = fields[0], last = fields.at(-1)
      if (!first) { event.preventDefault(); dialog.focus() }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault(); last?.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      siblings.forEach((el, index) => { el.inert = previousInert[index] })
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected && !previousFocus.closest('[hidden], [inert]')) previousFocus.focus()
    }
  }, [ref])
}
