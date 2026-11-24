import { createReadStream, existsSync, readFileSync, statSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import { extname, join, normalize, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const repository = resolve(import.meta.dirname, '../../..')
const staticRoot = process.env.PAPER_E2E_STATIC_ROOT ? resolve(process.env.PAPER_E2E_STATIC_ROOT) : join(repository, 'apps/paper_workspace/static')
const projectRoot = join(repository, 'examples/paper-workspace-project')
const port = Number(process.env.PAPER_E2E_PORT || 18080)
// A custom HTTP port needs its own collaboration server as well. Keep the
// historical port for the default fixture, while deriving an adjacent port for
// isolated parallel runs without requiring a second environment variable.
const collaborationPort = Number(process.env.PAPER_E2E_COLLAB_PORT || (process.env.PAPER_E2E_PORT ? port + 1 : 18765))
const rebuttalPort = Number(process.env.PAPER_E2E_REBUTTAL_PORT || port + 2)
const rebuttalDirectory = mkdtempSync(join(tmpdir(), 'paper-rebuttal-dev-'))
const runtimeDirectory = join(rebuttalDirectory, 'runtime')
mkdirSync(join(runtimeDirectory, 'project'), {recursive: true})
mkdirSync(join(runtimeDirectory, 'projects', 'example-paper'), {recursive: true})
copyFileSync(join(projectRoot, 'project.json'), join(runtimeDirectory, 'project', 'project.json'))
copyFileSync(join(repository, 'examples/project-library/index.json'), join(runtimeDirectory, 'projects/index.json'))
copyFileSync(join(repository, 'examples/project-library/example-paper/project.json'), join(runtimeDirectory, 'projects/example-paper/project.json'))
// Give runtime scenarios real server-owned metadata without changing the
// default legacy fixture used by the rest of the browser suite.
const runtimeFixtures = new Set(['stale-metadata-runtime', 'reload-sync-edited', 'reload-sync-empty'])
for (const slug of runtimeFixtures) {
  const root = join(runtimeDirectory, 'projects', slug)
  mkdirSync(root, {recursive: true})
  const sources = {'main.tex': readFileSync(join(projectRoot, 'main.tex')), 'section.tex': 'section baseline'}
  for (const [name, value] of Object.entries(sources)) writeFileSync(join(root, name), value)
  writeFileSync(join(root, 'project.json'), JSON.stringify({
    id: slug, version: '1', entrypoint: 'main.tex', runtime_revision: '1'.repeat(64),
    files: Object.keys(sources).map(path => ({path, managed: true})),
    runtime_file_revisions: Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, createHash('sha256').update(value).digest('hex')]))
  }))
}

const rebuttal = spawn(process.env.PYTHON || 'python3', ['-m', 'apps.paper_workspace.rebuttal.server'], {
  cwd: repository,
  env: {...process.env, REBUTTAL_HOST: '127.0.0.1', REBUTTAL_PORT: String(rebuttalPort), REBUTTAL_ENABLED: 'true', REBUTTAL_PROJECTS: '', REBUTTAL_ACTOR_MODE: 'proxy', REBUTTAL_DB_PATH: join(rebuttalDirectory, 'rebuttal.sqlite3'), REBUTTAL_PROJECT_RUNTIME: runtimeDirectory},
  stdio: 'inherit'
})
const mime = { '.css': 'text/css', '.gif': 'image/gif', '.html': 'text/html', '.ico': 'image/x-icon', '.js': 'text/javascript', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml', '.tex': 'text/plain', '.webmanifest': 'application/manifest+json' }

const collaborationEnvironment = { ...process.env, HOST: '127.0.0.1', PORT: String(collaborationPort), PAPER_E2E_ORIGIN: `http://127.0.0.1:${port}`,
  PAPER_E2E_RUNTIME_ROOT: runtimeDirectory }
delete collaborationEnvironment.YPERSISTENCE
const collaboration = spawn(process.execPath, ['dev-collaboration.cjs'], {
  cwd: import.meta.dirname,
  env: collaborationEnvironment,
  stdio: 'inherit'
})

const assetTokens = {
  __FAVICON_ICO_HASH__: 'favicon.ico', __FAVICON_PNG_HASH__: 'assets/favicon-64.png', __APPLE_TOUCH_ICON_HASH__: 'apple-touch-icon.png', __WEBMANIFEST_HASH__: 'site.webmanifest',
  __HUB_CSS_HASH__: 'hub.css', __HUB_UX_CSS_HASH__: 'hub-ux.css', __HUB_JS_HASH__: 'hub.js',
  __FOLIO_LIGHT_HASH__: 'assets/paper-folio-light.svg', __FOLIO_DARK_HASH__: 'assets/paper-folio-dark.svg',
  __PROJECT_FRAME_CSS_HASH__: 'project-frame.css', __APP_CSS_HASH__: 'app.css', __BOOTSTRAP_JS_HASH__: 'bootstrap.js', __COMPONENTS_CSS_HASH__: 'components.css', __UX_CSS_HASH__: 'ux.css',
  __SIDEBAR_ACCOUNT_JS_HASH__: 'sidebar-account.js',
  __PROJECT_PRESENCE_JS_HASH__: 'project-presence.js', __PROJECT_PRESENCE_CSS_HASH__: 'project-presence.css',
  __THEME_CSS_HASH__: 'theme.css', __THEME_JS_HASH__: 'theme.js', __PAPER_COLLAB_HASH__: 'vendor/paper-collab.js',
  __I18N_JS_HASH__: 'i18n.js', __WORKSPACE_I18N_JS_HASH__: 'workspace-i18n.js',
  __WORKSPACE_CORE_JS_HASH__: 'workspace-core.js', __WORKSPACE_STORAGE_JS_HASH__: 'workspace-storage.js', __PDF_VIEWPORT_JS_HASH__: 'pdf-viewport.js',
  __PAPER_EDITOR_HASH__: 'vendor/paper-editor.js', __APP_JS_HASH__: 'app.js',
  __PROJECT_TITLE_STARTUP_JS_HASH__: 'project-title-startup.js',
  __REBUTTAL_BACKUP_JS_HASH__: 'rebuttal-backup.js'
}
function renderHtml(name) {
  let html = readFileSync(join(staticRoot, name), 'utf8')
  const tokens = {...assetTokens, __REBUTTAL_JS_HASH__: 'rebuttal.js', __REBUTTAL_CSS_HASH__: 'rebuttal.css', __REBUTTAL_MODEL_JS_HASH__: 'rebuttal-model.js', __REBUTTAL_I18N_JS_HASH__: 'rebuttal-i18n.js'}
  for (const [token, asset] of Object.entries(tokens)) {
    if (!html.includes(token)) continue
    const hash = createHash('sha256').update(readFileSync(join(staticRoot, asset))).digest('hex').slice(0, 16)
    html = html.replaceAll(token, hash)
  }
  if (html.includes('__FAVICON_DATA__')) html = html.replaceAll('__FAVICON_DATA__', readFileSync(join(staticRoot, 'assets/favicon-64.png')).toString('base64'))
  return html
}
let renderedIndex = renderHtml('index.html')

function safeFile(root, requestPath) {
  const relative = normalize(decodeURIComponent(requestPath)).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '')
  const candidate = resolve(root, relative)
  return candidate.startsWith(`${resolve(root)}/`) || candidate === resolve(root) ? candidate : null
}

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`)
  if (url.pathname.startsWith('/collab-runtime/')) {
    const upstream = httpRequest({host: '127.0.0.1', port: collaborationPort, path: url.pathname + url.search, method: request.method,
      headers: {...request.headers, 'x-paper-actor': 'dev-author', 'x-paper-role': 'editor', 'x-paper-allowed-projects': 'fixture'}}, result => {
      response.writeHead(result.statusCode, result.headers)
      result.pipe(response)
    })
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(503, {'content-type': 'application/json'}); response.end('{"error":"Collaboration development service unavailable"}') })
    request.pipe(upstream)
    return
  }
  if (url.pathname.startsWith('/api/rebuttal/')) {
    const upstream = httpRequest({host: '127.0.0.1', port: rebuttalPort, path: url.pathname + url.search, method: request.method,
      headers: {...request.headers, 'x-paper-actor': 'dev-author', 'x-paper-role': 'editor', 'x-paper-allowed-projects': 'example-paper'}}, result => {
      response.writeHead(result.statusCode, result.headers)
      result.pipe(response)
    })
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(503, {'content-type': 'application/json'}); response.end('{"error":"Rebuttal development service unavailable"}') })
    request.pipe(upstream)
    return
  }
  if (/^\/p\/[^/]+\/rebuttal(?:\/[^/]+)?\/?$/.test(url.pathname) || url.pathname === '/rebuttal.html') {
    response.writeHead(200, {'content-type': 'text/html', 'cache-control': 'no-store'})
    response.end(renderHtml(url.searchParams.get('embedded') === '1' || url.searchParams.has('standalone') || url.pathname === '/rebuttal.html' ? 'rebuttal.html' : 'index.html'))
    return
  }
  if (url.pathname === '/_auth/context.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' })
    response.end('window.PaperAccess=null;')
    return
  }
  let root = staticRoot
  // Give isolated test rooms the same public example and rendered assets.
  let pathname = url.pathname.replace(/^\/p\/[^/]+(?=\/project\/)/, '')
  if (/^\/p\/[^/]+\/?$/.test(pathname)) pathname = '/'
  if (pathname.startsWith('/project/')) {
    const slug = url.pathname.match(/^\/p\/([^/]+)\/project\//)?.[1]
    root = runtimeFixtures.has(slug) ? join(runtimeDirectory, 'projects', slug) : projectRoot
    pathname = pathname.slice('/project/'.length)
  }
  if (pathname === '/') pathname = 'index.html'
  if (root === staticRoot && pathname === '/hub.html') {
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    response.end(renderHtml('hub.html'))
    return
  }
  if (root === staticRoot && (pathname === '/site.webmanifest' || pathname === '/assets/paper-workspace.webmanifest')) {
    response.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' })
    response.end(renderHtml('site.webmanifest'))
    return
  }
  if (root === staticRoot && pathname === '/assets/paper-workspace-icon.png') pathname = '/assets/favicon-64.png'
  if (root === staticRoot && pathname === '/assets/paper-workspace-touch.png') pathname = '/apple-touch-icon.png'
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
  const upstream = connect(collaborationPort, '127.0.0.1', () => {
    const headers = Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`)
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
  rebuttal.kill('SIGTERM')
  rmSync(rebuttalDirectory, {recursive: true, force: true})
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
