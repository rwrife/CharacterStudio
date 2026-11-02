import { z } from 'zod'
import type { AiRoute } from '../shared/ai'

export async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Provider returned HTTP ${response.status}. Check endpoint, authentication, credits and model availability.`)
  }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new Error('Provider response exceeds the permitted size.')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Provider returned an empty response.')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) throw new Error('Provider response exceeds the permitted size.')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  if (!size) throw new Error('Provider returned an empty response.')
  return Buffer.concat(chunks)
}
export class AiNetwork {
  constructor(readonly route: AiRoute, private token?: string) {
    if (token && !route.endpoint.startsWith('https:')) throw new Error('Credentials may only be sent over HTTPS.')
  }
  async request(path: string, signal: AbortSignal, body?: unknown, method?: string, limit = 2 * 1024 * 1024): Promise<Buffer> {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error('Invalid provider request path.')
    const form = body instanceof FormData
    const response = await fetch(this.route.endpoint + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { ...(form ? {} : { 'Content-Type': 'application/json' }), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    })
    return boundedBody(response, limit)
  }
  async json(path: string, signal: AbortSignal, body?: unknown, method?: string, limit?: number): Promise<unknown> {
    const bytes = await this.request(path, signal, body, method, limit)
    try { return JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Provider returned invalid JSON. Check the endpoint and API contract.') }
  }
  async tripo(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const envelope = z.object({ code: z.number().optional(), data: z.unknown() }).parse(await this.json(path, signal, body))
    if (envelope.code !== undefined && envelope.code !== 0)
      throw new Error(`Tripo API rejected the request (code ${envelope.code}). Check model support, API credits and account permissions in Tripo.`)
    return envelope.data
  }
}
export function decodeBase64(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maxBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error('Provider returned invalid or oversized base64 output.')
  const bytes = Buffer.from(value, 'base64')
  if (!bytes.length || bytes.length > maxBytes) throw new Error('Provider output is empty or oversized.')
  return bytes
}

export async function downloadTripoOutput(value: string, signal: AbortSignal, maxBytes: number): Promise<Buffer> {
  const url = new URL(value)
  const suffixes = ['tripo3d.ai', 'tripo3d.com', 'amazonaws.com', 'aliyuncs.com', 'cloudfront.net']
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' ||
      !suffixes.some(suffix => url.hostname === suffix || url.hostname.endsWith('.' + suffix)))
    throw new Error('Tripo returned an unrecognized result host. No download or credential forwarding was attempted.')
  // Signed asset URLs are ephemeral. They never receive the API token or enter project provenance.
  return boundedBody(await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) }), maxBytes)
}
