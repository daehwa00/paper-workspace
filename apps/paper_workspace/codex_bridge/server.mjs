import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { authorized, bridgeToken, codexEnvironment, containsSecret, redactSecrets, workspace } from './auth.mjs';
import { BridgeError } from './runner.mjs';
import { prepareRevision, runCodex } from './revision.mjs';
import { runRebuttal, cancelJob, classifyRebuttalError } from './rebuttal.mjs';

function configuredPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('CODEX_BRIDGE_PORT must be an integer between 1 and 65535.');
  }
  return port;
}

const PORT = configuredPort(process.env.CODEX_BRIDGE_PORT || 8790);
const MAX_BODY_BYTES = 120_000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 10;
const MAX_RATE_CLIENTS = 2_048;
const modelProfiles = Object.freeze({
  'rebuttal-translation-light': Object.freeze({ model: 'gpt-6.1-terra', reasoningEffort: 'low' }),
  // Keep existing profile IDs for compatibility with queued requests.
  'rebuttal-sol-light': Object.freeze({ model: 'gpt-6.1-terra', reasoningEffort: 'medium' }),
  'rebuttal-sol-medium': Object.freeze({ model: 'gpt-6.1-terra', reasoningEffort: 'high' }),
  'rebuttal-sol-high': Object.freeze({ model: 'gpt-6.1-terra', reasoningEffort: 'xhigh' }),
  'sol61-light': Object.freeze({ model: 'gpt-6.1-sol', reasoningEffort: 'low' }),
  'sol61-medium': Object.freeze({ model: 'gpt-6.1-sol', reasoningEffort: 'medium' }),
  'sol61-high': Object.freeze({ model: 'gpt-6.1-sol', reasoningEffort: 'high' }),
  // Legacy preference IDs remain compatible while every model uses Sol 6.1.
  'luna-medium': Object.freeze({ model: 'gpt-6.1-sol', reasoningEffort: 'low' }),
  'luna-high': Object.freeze({ model: 'gpt-6.1-sol', reasoningEffort: 'medium' }),
  'sol-high': Object.freeze({ model: 'gpt-6.1-sol', reasoningEffort: 'high' }),
});
const calls = new Map();
let running = false;

function json(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(encoded);
}

function normalizedAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return '';
  const canonical = new URL(`http://[${address.split('%')[0]}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

function clientAddress(request) {
  const paper = normalizedAddress(request.headers['x-paper-client-ip']);
  const forwarded = normalizedAddress(request.headers['x-forwarded-for']?.split(',').at(-1));
  // Some ingress configurations pass the Paper header through. If the
  // proxy supplies a forwarding address too, require them to agree.
  if (paper && (!forwarded || paper === forwarded)) return paper;
  return forwarded || normalizedAddress(request.socket.remoteAddress);
}

function withinRateLimit(request) {
  const key = clientAddress(request);
  const now = Date.now();
  for (const [client, timestamps] of calls) {
    const active = timestamps.filter(timestamp => now - timestamp < RATE_WINDOW_MS);
    if (active.length) calls.set(client, active);
    else calls.delete(client);
  }
  if (!calls.has(key) && calls.size >= MAX_RATE_CLIENTS) {
    calls.delete(calls.keys().next().value);
  }
  const recent = (calls.get(key) || []).filter(timestamp => now - timestamp < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  calls.delete(key);
  calls.set(key, recent);
  return true;
}

async function bodyOf(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw new BridgeError('bridge_invalid_request', '요청 문맥이 너무 큽니다.');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BridgeError('bridge_invalid_request', 'Codex 요청 형식이 올바르지 않습니다.');
  }
}


function rebuttalFailure(response, error) {
  const code = classifyRebuttalError(error);
  return json(response, 422, {
    error: code === 'bridge_cancelled' ? 'rebuttal job cancelled' : 'Rebuttal bridge request failed',
    error_code: code,
  });
}

function revisionFailure(response, error) {
  return json(response, 422, {
    error: redactSecrets(error instanceof BridgeError ? error.message : 'Codex 요청 처리에 실패했습니다.'),
    error_code: error instanceof BridgeError ? error.code : 'model_execution_failed',
  });
}

async function handleRequest(request, response, signal) {
  if (request.method === 'GET' && request.url === '/health') return json(response, 200, { status: 'ok', busy: running });
  if (request.method !== 'POST' || !['/api/codex', '/internal/rebuttal', '/internal/rebuttal/cancel'].includes(request.url)) return json(response, 404, { error: 'not found' });
  if (!bridgeToken) return json(response, 503, { error: 'Codex 브리지 접근 키가 서버에 설정되지 않았습니다.' });
  if (!authorized(request)) return json(response, 401, { error: 'Codex 접근 키가 올바르지 않습니다.' });
  if (request.url === '/internal/rebuttal/cancel') {
    try {
      const body = await bodyOf(request, 1000);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['job_id', 'attempt'].includes(key))) throw new Error('invalid cancellation request');
      return json(response, 200, { cancelled: cancelJob(body.job_id, body.attempt) });
    } catch (error) {
      return rebuttalFailure(response, error);
    }
  }
  const options = { workspace, environment: codexEnvironment, containsSecret, signal };
  if (request.url === '/internal/rebuttal') {
    try {
      const body = await bodyOf(request, 1_000_000);
      const result = await runRebuttal(body, { ...options, profiles: modelProfiles });
      return json(response, 200, { result });
    } catch (error) {
      return rebuttalFailure(response, error);
    }
  }

  let prepared;
  try {
    prepared = prepareRevision(await bodyOf(request), modelProfiles);
  } catch (error) {
    return revisionFailure(response, error);
  }
  if (signal.aborted) return;
  if (running) return json(response, 429, { error: '다른 Codex 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.' });
  if (!withinRateLimit(request)) return json(response, 429, { error: 'Codex 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.' });
  running = true;
  try {
    return json(response, 200, await runCodex(prepared, options));
  } catch (error) {
    return revisionFailure(response, error);
  } finally {
    running = false;
  }
}

createServer(async (request, response) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const onClose = () => { if (!response.writableFinished) abort(); };
  request.once('aborted', abort);
  response.once('close', onClose);
  try {
    await handleRequest(request, response, controller.signal);
  } finally {
    request.removeListener('aborted', abort);
    response.removeListener('close', onClose);
  }
}).listen(PORT, '0.0.0.0');
