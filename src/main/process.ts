import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import type { Writable } from 'node:stream'

export function runProcess(exe: string, args: string[], options: {
  cwd?: string
  signal?: AbortSignal
  log?: string
  onLine?: (line: string) => void
  timeout?: number
} = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error('Operation cancelled')); return }
    const child = spawn(exe, args, { cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } })
    const log: Writable | undefined = options.log ? createWriteStream(options.log, { flags: 'a' }) : undefined
    let output = '', processError: Error | undefined
    const pending = { stdout: '', stderr: '' }
    const consume = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const value = chunk.toString()
      output = (output + value).slice(-250_000)
      log?.write(value)
      pending[stream] += value
      const lines = pending[stream].split(/\r?\n/)
      pending[stream] = lines.pop() ?? ''
      try {
        for (const line of lines) options.onLine?.(line)
      } catch (error) {
        processError = new Error(`Invalid backend progress: ${String(error)}`)
        child.kill()
      }
    }
    child.stdout.on('data', chunk => consume('stdout', chunk))
    child.stderr.on('data', chunk => consume('stderr', chunk))
    log?.on('error', (error) => { processError = new Error(`Could not write job log: ${error.message}`); child.kill() })
    const abort = () => child.kill()
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { processError = new Error('Backend timed out. Inspect the job log and character geometry.'); child.kill() }, options.timeout ?? 20 * 60_000)
    child.on('error', error => { processError = error })
    child.on('close', code => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      log?.end()
      if (options.signal?.aborted) reject(new Error('Operation cancelled'))
      else if (processError) reject(processError)
      else if (code !== 0) {
        const failure = output.split(/\r?\n/).reverse().find(l => l.startsWith('STUDIO:') && l.includes('"failed"'))
        reject(new Error(failure ? JSON.parse(failure.slice(7)).message : `${exe} exited with code ${code}.\n${output.slice(-5000)}`))
      } else resolve(output)
    })
  })
}
