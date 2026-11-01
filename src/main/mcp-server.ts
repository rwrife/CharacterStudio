import { createServer, type IncomingMessage } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createDesktopMcp, type DesktopAdapter } from './mcp-tools'

export function authorizeMcp(request: Pick<IncomingMessage, 'headers' | 'url' | 'method'>, token: string, host: string) {
  if (request.headers.host !== host || request.headers.origin !== undefined) return 403
  const supplied = Buffer.from(request.headers.authorization ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return 401
  if (request.url !== '/mcp') return 404
  return request.method === 'POST' ? 200 : 405
}

export async function startDesktopMcp(adapter: DesktopAdapter, directory: string) {
  const token = randomBytes(32).toString('hex')
  let host = ''
  let closing = false
  // Serialize interactions across clients, but never block inspection behind a running UI job.
  let tail = Promise.resolve()
  const serialize = <T>(action: () => Promise<T>) => {
    const result = tail.then(() => {
      if (closing) throw new Error('Desktop MCP is shutting down.')
      return action()
    })
    tail = result.then(() => {}, () => {})
    return result
  }
  const controlled: DesktopAdapter = {
    ...adapter,
    ui: command => serialize(() => adapter.ui(command)),
    key: (...args) => serialize(() => adapter.key(...args)),
    pointer: (...args) => serialize(() => adapter.pointer(...args)),
    wheel: (...args) => serialize(() => adapter.wheel(...args)),
    show: () => serialize(() => adapter.show()),
    screenshot: () => serialize(() => adapter.screenshot())
  }
  const transports = new Set<StreamableHTTPServerTransport>()
  const http = createServer(async (request, response) => {
    const status = authorizeMcp(request, token, host)
    if (closing || status !== 200) {
      response.writeHead(closing ? 503 : status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Desktop MCP request rejected.')
      return
    }
    const server = createDesktopMcp(controlled)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    transports.add(transport)
    response.on('close', () => {
      transports.delete(transport)
      void server.close().catch(error => console.error('MCP request cleanup failed:', error))
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(request, response)
    } catch (error) {
      console.error('Desktop MCP request failed:', error)
      if (!response.headersSent) response.writeHead(500).end('Desktop MCP request failed.')
      else response.end()
    }
  })
  http.requestTimeout = 30000
  http.headersTimeout = 10000
  http.maxConnections = 16
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve() })
  })
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Desktop MCP did not bind a loopback port.')
  host = `127.0.0.1:${address.port}`
  const connectionPath = join(directory, 'mcp-connection.json')
  const temporary = join(directory, `.mcp-${randomBytes(8).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify({ url: `http://${host}/mcp`, token, pid: process.pid }, null, 2), { mode: 0o600, flag: 'wx' })
    await rename(temporary, connectionPath)
  } catch (error) {
    http.close()
    http.closeAllConnections()
    await unlink(temporary).catch((cleanup: NodeJS.ErrnoException) => { if (cleanup.code !== 'ENOENT') console.error('MCP temporary file cleanup failed:', cleanup) })
    throw error
  }
  http.on('error', error => console.error('Desktop MCP listener error:', error))
  return {
    connectionPath,
    async close() {
      closing = true
      try {
        await unlink(connectionPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      } finally {
        try { await Promise.all([...transports].map(transport => transport.close())) }
        finally {
          await new Promise<void>((resolve, reject) => {
            http.close(error => error ? reject(error) : resolve())
            http.closeAllConnections()
          })
        }
      }
    }
  }
}
