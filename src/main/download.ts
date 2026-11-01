import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface DownloadProgress { received: number; total?: number }

async function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to) } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
      await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)))
    }
  }
}

export async function freeBytes(directory: string): Promise<number> {
  const stats = await statfs(directory)
  return stats.bavail * stats.bsize
}

export async function ensureSpace(directory: string, bytes: number) {
  const free = await freeBytes(directory)
  // Keep a margin so a completed download does not leave the drive full.
  const needed = bytes + 1024 ** 3
  if (free < needed) throw new Error(`Not enough free disk space: ${(needed / 1024 ** 3).toFixed(1)} GB needed, ${(free / 1024 ** 3).toFixed(1)} GB available.`)
}

/**
 * Streams an HTTPS download to `<target>.part`, verifying the size and SHA-256 before it replaces `target`.
 * A failed, cancelled or mismatched download never leaves a file at `target`.
 */
export async function downloadVerified(url: string, target: string, expected: { sha256: string; bytes?: number },
  options: { signal?: AbortSignal; onProgress?: (progress: DownloadProgress) => void; fetcher?: typeof fetch } = {}) {
  if (!url.startsWith('https://')) throw new Error('Setup downloads must use HTTPS.')
  if (options.signal?.aborted) throw new Error('Operation cancelled')
  await mkdir(dirname(target), { recursive: true })
  if (expected.bytes) await ensureSpace(dirname(target), expected.bytes)
  const partial = target + '.part'
  const response = await (options.fetcher ?? fetch)(url, { redirect: 'follow', signal: options.signal })
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}.`)
  if (!response.url.startsWith('https://')) throw new Error('Download redirected to an insecure location.')
  const length = Number(response.headers.get('content-length')) || undefined
  const total = expected.bytes ?? length
  if (expected.bytes && length && length !== expected.bytes) throw new Error('Download size does not match the pinned release.')
  if (!expected.bytes && length) await ensureSpace(dirname(target), length)
  const hash = createHash('sha256')
  let received = 0, reported = 0
  const counter = async function* (source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      received += chunk.length
      if (total && received > total) throw new Error('Download is larger than the pinned release.')
      hash.update(chunk)
      if (received - reported > 4 * 1024 * 1024 || received === total) { reported = received; options.onProgress?.({ received, total }) }
      yield chunk
    }
  }
  const file = createWriteStream(partial)
  try {
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), counter, file, { signal: options.signal })
    if (expected.bytes && received !== expected.bytes) throw new Error('Download ended before the complete file was received.')
    if (hash.digest('hex') !== expected.sha256.toLowerCase()) throw new Error('Downloaded file checksum does not match the pinned release. It was discarded.')
    await renameWithRetry(partial, target)
  } catch (error) {
    // The write stream opens asynchronously; wait until it is closed so cleanup cannot run before the file exists.
    file.destroy()
    if (!file.closed) await new Promise(resolve => file.once('close', resolve))
    // Antivirus scanners can briefly lock new files on Windows; keep the original error if cleanup still fails.
    await rm(partial, { force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
    if (options.signal?.aborted) throw new Error('Operation cancelled')
    throw error
  }
}
