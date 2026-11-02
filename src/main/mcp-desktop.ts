import type { BrowserWindow, MouseInputEvent } from 'electron'
import { desktopControl, type DesktopCommand } from '../shared/desktop-control'
import type { Snapshot } from '../shared/types'
import type { DesktopAdapter } from './mcp-tools'

export function desktopAdapter(window: BrowserWindow, snapshot: () => Snapshot): DesktopAdapter {
  const ready = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isLoadingMainFrame()) throw new Error('The desktop is not ready.')
    if (window.isMinimized()) window.restore()
    window.show()
  }
  const ui = async (command: DesktopCommand) => {
    ready()
    return window.webContents.executeJavaScript(`(${desktopControl.toString()})(${JSON.stringify(command)})`)
  }
  const settle = () => new Promise<void>(resolve => setTimeout(resolve, 50))
  const validatePoint = (x: number, y: number) => {
    const { width, height } = window.getContentBounds()
    const zoom = window.webContents.getZoomFactor()
    if (x < 0 || y < 0 || x >= width / zoom || y >= height / zoom) throw new Error('Pointer coordinates must be inside the desktop viewport.')
  }
  return {
    ui, snapshot,
    screenshot: async () => {
      ready()
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))')
      return (await window.webContents.capturePage()).toPNG().toString('base64')
    },
    show: async () => { ready(); window.focus() },
    key: async (ref, key, modifiers) => {
      await ui({ action: 'focus', ref })
      window.focus()
      window.webContents.focus()
      const keyCode = ({ Enter: 'Return', Escape: 'Escape', Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' } as Record<string, string>)[key] ?? key
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      if (key.length === 1 && !modifiers.some(m => ['control', 'alt', 'meta'].includes(m))) window.webContents.sendInputEvent({ type: 'char', keyCode: key, modifiers })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
      await settle()
    },
    pointer: async (points, button, kind) => {
      ready()
      for (const point of points) validatePoint(point.x, point.y)
      window.focus()
      window.webContents.focus()
      const send = (type: MouseInputEvent['type'], point: { x: number; y: number }, clickCount = 1) =>
        window.webContents.sendInputEvent({ type, ...point, button, clickCount })
      send('mouseMove', points[0])
      if (kind === 'move') { await settle(); return }
      const repeats = kind === 'doubleClick' ? 2 : 1
      for (let click = 1; click <= repeats; click++) {
        send('mouseDown', points[0], click)
        try {
          if (kind === 'drag') for (let i = 1; i < points.length; i++) {
            const from = points[i - 1], to = points[i]
            for (let step = 1; step <= 8; step++) {
              send('mouseMove', { x: Math.round(from.x + (to.x - from.x) * step / 8), y: Math.round(from.y + (to.y - from.y) * step / 8) })
              await new Promise<void>(resolve => setTimeout(resolve, 8))
            }
          }
        } finally { send('mouseUp', points.at(-1)!, click) }
      }
      await settle()
    },
    wheel: async (x, y, deltaX, deltaY) => {
      ready(); validatePoint(x, y)
      window.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX, deltaY, canScroll: true })
      await settle()
    }
  }
}
