import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { extname, join, normalize, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const repository = resolve(import.meta.dirname, '../../..')
const staticRoot = join(repository, 'apps/paper_workspace/static')
const projectRoot = join(repository, 'examples/paper-workspace-project')
const port = Number(process.env.PAPER_E2E_PORT || 18080)
const mime = { '.css': 'text/css', '.gif': 'image/gif', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml', '.tex': 'text/plain' }

const collaborationEnvironment = { ...process.env, HOST: '127.0.0.1', PORT: '18765' }
delete collaborationEnvironment.YPERSISTENCE
const collaboration = spawn(process.execPath, ['node_modules/y-websocket/bin/server.cjs'], {
  cwd: import.meta.dirname,
  env: collaborationEnvironment,
  stdio: 'inherit'
})

const assetTokens = {
  __APP_CSS_HASH__: 'app.css', __BOOTSTRAP_JS_HASH__: 'bootstrap.js', __COMPONENTS_CSS_HASH__: 'components.css', __UX_CSS_HASH__: 'ux.css',
  __THEME_CSS_HASH__: 'theme.css', __THEME_JS_HASH__: 'theme.js', __PAPER_COLLAB_HASH__: 'vendor/paper-collab.js',
  __I18N_JS_HASH__: 'i18n.js', __WORKSPACE_I18N_JS_HASH__: 'workspace-i18n.js',
  __WORKSPACE_CORE_JS_HASH__: 'workspace-core.js', __WORKSPACE_STORAGE_JS_HASH__: 'workspace-storage.js', __WORKSPACE_PROJECT_JS_HASH__: 'workspace-project.js', __WORKSPACE_COMPILE_JS_HASH__: 'workspace-compile.js', __WORKSPACE_BACKUP_JS_HASH__: 'workspace-backup.js', __PDF_VIEWPORT_JS_HASH__: 'pdf-viewport.js',
  __PAPER_EDITOR_HASH__: 'vendor/paper-editor.js', __APP_JS_HASH__: 'app.js'
}
let renderedIndex = readFileSync(join(staticRoot, 'index.html'), 'utf8')
for (const [token, asset] of Object.entries(assetTokens)) {
  const hash = createHash('sha256').update(readFileSync(join(staticRoot, asset))).digest('hex').slice(0, 16)
  renderedIndex = renderedIndex.replaceAll(token, hash)
}

function safeFile(root, requestPath) {
  const relative = normalize(decodeURIComponent(requestPath)).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '')
  const candidate = resolve(root, relative)
  return candidate.startsWith(`${resolve(root)}/`) || candidate === resolve(root) ? candidate : null
}

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`)
  let root = staticRoot
  let pathname = url.pathname
  if (pathname.startsWith('/project/')) {
    root = projectRoot
    pathname = pathname.slice('/project/'.length)
  }
  if (pathname === '/') pathname = 'index.html'
  if (root === staticRoot && pathname === 'index.html') {
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    response.end(renderedIndex)
    return
  }
  let file = safeFile(root, pathname)
  if (file && existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    if (!url.pathname.includes('.') && !url.pathname.startsWith('/api/')) file = join(staticRoot, 'index.html')
    else {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not available in E2E fixture"}')
      return
    }
  }
  response.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
  createReadStream(file).pipe(response)
})

server.on('upgrade', (request, socket, head) => {
  const upstream = connect(18765, '127.0.0.1', () => {
    const headers = Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')
    upstream.write(`${request.method} ${request.url.replace(/^\/collab/, '') || '/'} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`)
    if (head.length) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  socket.on('error', () => upstream.destroy())
  upstream.on('error', () => socket.destroy())
})

server.listen(port, '127.0.0.1')
function shutdown() {
  server.close()
  collaboration.kill('SIGTERM')
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
