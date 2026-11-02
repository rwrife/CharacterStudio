import type { AiConsent } from '../shared/ai'

export class RemoteConsent {
  private pending?: { id: string; finish: (approved: boolean) => void }
  constructor(private show: (request: AiConsent | null) => void) {}
  request(request: AiConsent, signal: AbortSignal): Promise<boolean> {
    if (this.pending) throw new Error('Another remote approval is already open.')
    signal.throwIfAborted()
    return new Promise(resolve => {
      const finish = (approved: boolean) => {
        signal.removeEventListener('abort', abort)
        this.pending = undefined
        this.show(null)
        resolve(approved)
      }
      const abort = () => finish(false)
      this.pending = { id: request.id, finish }
      signal.addEventListener('abort', abort, { once: true })
      this.show(request)
    })
  }
  reply(id: string, approved: boolean) {
    if (!this.pending || this.pending.id !== id) throw new Error('This remote approval is stale or no longer open.')
    this.pending.finish(approved)
  }
  cancel() { this.pending?.finish(false) }
}
