import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';

export const bridgeToken = process.env.CODEX_BRIDGE_TOKEN || '';
const codexHome = process.env.CODEX_HOME || '/tmp/codex-home';
export const workspace = process.env.CODEX_WORKSPACE || '/tmp/codex-workspace';
const authPath = `${codexHome}/auth.json`;
function credentialStrings(value, parentKey = '') {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    if (typeof child === 'string') {
      return /token|secret|api.?key|authorization|password/i.test(`${parentKey}.${key}`) && child.length > 0 ? [child] : [];
    }
    return credentialStrings(child, `${parentKey}.${key}`);
  });
}

const credentialDocument = JSON.parse(await readFile(authPath, 'utf8'));
const sensitiveValues = [...new Set([...credentialStrings(credentialDocument), bridgeToken].filter(value => value.length > 0))];
const secretPatterns = [
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

export function containsSecret(value) {
  const text = String(value || '');
  return sensitiveValues.some(secret => text.includes(secret)) || secretPatterns.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function redactSecrets(value) {
  let text = String(value || '');
  for (const secret of sensitiveValues) text = text.replaceAll(secret, '[redacted]');
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, '[redacted]');
  }
  return text;
}

export function codexEnvironment() {
  const environment = { CODEX_HOME: codexHome, HOME: '/home/node', PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' };
  for (const key of ['LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

export function authorized(request) {
  if (!bridgeToken) return false;
  if (!/^Bearer\s+/i.test(request.headers.authorization || '')) return false;
  const supplied = request.headers.authorization.replace(/^Bearer\s+/i, '');
  const left = Buffer.from(supplied);
  const right = Buffer.from(bridgeToken);
  return left.length === right.length && timingSafeEqual(left, right);
}
