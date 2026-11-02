import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'

interface RunningMcp {
  close(): Promise<void>
}

export class DesktopMcpControl {
  private running?: RunningMcp
  private tail = Promise.resolve()
  private disposed = false
  constructor(
    private directory: string,
    private start: () => Promise<RunningMcp>,
    private changed: (enabled: boolean) => void
  ) {}
  get enabled() { return !!this.running }

  initialize(forceEnabled: boolean) {
    return this.enqueue(async () => {
      const saved = await readFile(join(this.directory, 'mcp-settings.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      const enabled = saved === null ? false : z.object({ enabled: z.boolean() }).strict().parse(JSON.parse(saved)).enabled
      return this.apply(forceEnabled || enabled, false)
    })
  }
  private async persist(enabled: boolean) {
    const temporary = join(this.directory, `.mcp-${randomUUID().replaceAll('-', '')}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify({ enabled }), { flag: 'wx', mode: 0o600 })
      await rename(temporary, join(this.directory, 'mcp-settings.json'))
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    }
  }
  private enqueue<T>(action: () => Promise<T>) {
    const result = this.tail.then(action)
    this.tail = result.then(() => {}, () => {})
    return result
  }
  private async apply(enabled: boolean, persist: boolean) {
    if (this.disposed) throw new Error('Desktop MCP is shutting down.')
    try {
      if (enabled && !this.running) {
        const running = await this.start()
        this.running = running
        if (persist) {
          try { await this.persist(true) }
          catch (error) {
            this.running = undefined
            await running.close()
            throw error
          }
        }
      } else if (!enabled) {
        const running = this.running
        this.running = undefined
        try { await running?.close() }
        finally { if (persist) await this.persist(false) }
      } else if (persist) await this.persist(true)
      return this.enabled
    } finally { this.changed(this.enabled) }
  }
  setEnabled(enabled: boolean) { return this.enqueue(() => this.apply(enabled, true)) }
  close() {
    return this.enqueue(async () => {
      this.disposed = true
      const running = this.running
      this.running = undefined
      try { await running?.close() }
      finally { this.changed(false) }
    })
  }
}
