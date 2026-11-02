import { z } from 'zod'
import type { AiRoute } from '../shared/ai'

async function responseBody(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new Error('Provider response exceeds the permitted size.')
  }
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
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
  return Buffer.concat(chunks)
}
export async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Provider returned HTTP ${response.status}. Check endpoint, authentication, credits and model availability.`)
  }
  const bytes = await responseBody(response, limit)
  if (!bytes.length) throw new Error('Provider returned an empty response.')
  return bytes
}
const tripoEnvelope = z.object({
  code: z.number().int().optional(), status: z.string().optional(), data: z.unknown().optional(),
  message: z.string().optional(), suggestion: z.string().optional(), request_id: z.string().optional()
})
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
    if (!response.ok && this.route.provider === 'tripo') {
      const bytes = await responseBody(response, Math.min(limit, 64 * 1024))
      let payload: unknown
      try { payload = bytes.length ? JSON.parse(bytes.toString('utf8')) : {} }
      catch { throw this.tripoError(path, { message: 'Tripo returned a non-JSON error response.' }, response.status, response.headers.get('X-Tripo-Trace-ID')) }
      throw this.tripoError(path, payload, response.status, response.headers.get('X-Tripo-Trace-ID'))
    }
    return boundedBody(response, limit)
  }
  async json(path: string, signal: AbortSignal, body?: unknown, method?: string, limit?: number): Promise<unknown> {
    const bytes = await this.request(path, signal, body, method, limit)
    try { return JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Provider returned invalid JSON. Check the endpoint and API contract.') }
  }
  async tripo(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const envelope = tripoEnvelope.parse(await this.json(path, signal, body))
    if (envelope.code !== undefined && envelope.code !== 0 || envelope.status === 'error')
      throw this.tripoError(path, envelope)
    return envelope.data
  }
  private tripoError(path: string, payload: unknown, status?: number, trace?: string | null): Error {
    const parsed = tripoEnvelope.safeParse(payload)
    const details = parsed.success ? parsed.data : undefined
    const identifiers = [status === undefined ? '' : `HTTP ${status}`, details?.code === undefined ? '' : `code ${details.code}`].filter(Boolean)
    const traceId = z.uuid().safeParse(trace ?? details?.request_id)
    const reason = [details?.message, details?.suggestion].filter(Boolean).join(' ') ||
      'Check model support, request parameters, API credits and account permissions in Tripo.'
    let message = `Tripo ${path} failed${identifiers.length ? ` (${identifiers.join('; ')})` : ''}.`
    if (traceId.success) message += ` Trace ID: ${traceId.data}.`
    message += ` ${reason}`
    if (this.token) {
      for (const secret of [this.token, encodeURIComponent(this.token), Buffer.from(this.token).toString('base64')])
        message = message.replaceAll(secret, '[redacted]')
    }
    message = message.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\btsk_[a-zA-Z0-9_.-]+/g, '[redacted]')
      .replace(/https?:\/\/\S+/gi, '[URL omitted]')
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    return new Error(message.length > 1600 ? message.slice(0, 1597) + '...' : message)
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
