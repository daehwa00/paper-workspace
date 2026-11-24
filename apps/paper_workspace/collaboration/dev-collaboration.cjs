'use strict'

// Loopback-only fixture: use the real protocol/initialization handlers, while
// permitting the synthetic project slugs created by independent browser tests.
const {createCollaborationServer} = require('./server.cjs')
class FixtureProjects extends Set {
  has(slug) { return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(slug) }
}
const instance = createCollaborationServer({
  host: '127.0.0.1', port: Number(process.env.PORT),
  allowedOrigins: new Set([process.env.PAPER_E2E_ORIGIN]),
  allowedProjectSlugs: new FixtureProjects(), defaultProjectSlugs: new Set(['example-paper', 'default']),
  projectRuntimeDir: process.env.PAPER_E2E_RUNTIME_ROOT, defaultProjectSourceDir: process.env.PAPER_E2E_REBUTTAL_SOURCE_ROOT || '',
  projectsSourceDir: '', persistenceDir: '', sourceHistoryDir: '',
  maxConnectionsPerIp: 128, maxConnections: 512, maxRooms: 256
})
instance.server.listen(instance.config.port, instance.config.host)
let closing = false
const close = () => {
  if (closing) return
  closing = true
  instance.close().then(() => process.exit(0), error => {console.error(error);process.exit(1)})
}
process.once('SIGINT', close)
process.once('SIGTERM', close)
