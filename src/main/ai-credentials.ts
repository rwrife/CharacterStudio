import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { aiRouteSchema, type AiRoute } from '../shared/ai'

export interface CredentialEncryption {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
export function credentialScope(route: AiRoute): string {
  return createHash('sha256').update(`${route.provider}\n${route.endpoint}`).digest('hex')
}
export class AiCredentials {
  private values: Record<string, string>
  private path: string
  constructor(root: string, private encryption: CredentialEncryption) {
    mkdirSync(root, { recursive: true })
    this.path = join(root, 'ai-credentials.json')
    this.values = existsSync(this.path) ?
      z.record(z.string().regex(/^[a-f0-9]{64}$/), z.string()).parse(JSON.parse(readFileSync(this.path, 'utf8'))) : {}
  }
  private requireEncryption() {
    if (!this.encryption.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === 'basic_text')
      throw new Error('OS-backed encrypted storage is unavailable. Configure the OS keychain before saving or using API keys. No plaintext fallback is allowed.')
  }
  has(route: AiRoute) { return Object.hasOwn(this.values, credentialScope(route)) }
  get(route: AiRoute): string | undefined {
    const value = this.values[credentialScope(route)]
    if (!value) return undefined
    this.requireEncryption()
    return this.encryption.decryptString(Buffer.from(value, 'base64'))
  }
  set(value: AiRoute, token: string) {
    const route = aiRouteSchema.parse(value)
    const secret = z.string().max(8192).regex(/^[^\r\n]*$/).parse(token).trim()
    if (route.provider === 'builtin') throw new Error('Built-in local models do not use a provider API key.')
    if (secret && !route.endpoint.startsWith('https:'))
      throw new Error('API keys require HTTPS, including on a LAN. Use an HTTPS endpoint or a credential-free local backend.')
    const next = { ...this.values }
    if (secret) {
      this.requireEncryption()
      next[credentialScope(route)] = this.encryption.encryptString(secret).toString('base64')
    } else delete next[credentialScope(route)]
    writeFileSync(this.path + '.tmp', JSON.stringify(next), { mode: 0o600 })
    renameSync(this.path + '.tmp', this.path)
    this.values = next
  }
}
