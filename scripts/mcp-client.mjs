import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const defaultDirectory = process.platform === 'win32' ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'KimodoStudio')
  : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'KimodoStudio')
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'KimodoStudio')

export function validateConnection(value) {
  if (!value || typeof value.url !== 'string' || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error('Invalid desktop MCP connection file.')
  const url = new URL(value.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw new Error('Desktop MCP must use an authenticated 127.0.0.1 endpoint.')
  return { url, token: value.token }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--connection')) throw new Error('Usage: node scripts\\mcp-client.mjs [--connection <absolute mcp-connection.json path>]')
  const file = args[1] ?? join(defaultDirectory, 'mcp-connection.json')
  const connection = validateConnection(JSON.parse(await readFile(file, 'utf8')))
  const remote = new Client({ name: 'character-studio-stdio', version: '1.0.0' })
  await remote.connect(new StreamableHTTPClientTransport(connection.url, {
    requestInit: { headers: { Authorization: `Bearer ${connection.token}` }, redirect: 'error' }
  }))
  const server = new Server({ name: 'character-studio-desktop', version: '1.0.0' }, {
    capabilities: { tools: {} }, instructions: remote.getInstructions()
  })
  server.setRequestHandler(ListToolsRequestSchema, () => remote.listTools())
  server.setRequestHandler(CallToolRequestSchema, request => remote.callTool(request.params))
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await remote.close()
    await server.close()
  }
  process.once('SIGINT', () => { void close().catch(error => { console.error(error.message); process.exitCode = 1 }) })
  process.once('SIGTERM', () => { void close().catch(error => { console.error(error.message); process.exitCode = 1 }) })
  const transport = new StdioServerTransport()
  server.onclose = () => { void close().catch(error => { console.error(error.message); process.exitCode = 1 }) }
  await server.connect(transport)
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Character Studio MCP: ${error.message}\nStart the desktop with --mcp first; use --connection for a custom STUDIO_DATA_DIR. Restart this client after restarting the app.`)
    process.exitCode = 1
  })
}
