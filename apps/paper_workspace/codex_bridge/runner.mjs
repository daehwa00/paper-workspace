import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export function classifyRuntimeError(message) {
  if (/rate.limit|quota|too many requests|\b429\b/i.test(message)) return 'model_rate_limited';
  if (/unauthorized|authentication|invalid.api.key|\b401\b|\b403\b/i.test(message)) return 'model_auth_failed';
  return 'model_execution_failed';
}

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function cancelledError() {
  return new BridgeError('bridge_cancelled', 'rebuttal job cancelled');
}

export function checkAborted(signal) {
  if (signal?.aborted) throw cancelledError();
}

export function runChild(args, { workspace, environment, prompt, timeoutMs, signal }) {
  checkAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: workspace,
      env: environment(),
      stdio: ['pipe', 'ignore', 'pipe'],
      detached: true,
    });
    let stderr = '';
    let stdinFailed = false;
    let failure;

    function stop(error) {
      if (failure) return;
      failure = error;
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { child.kill('SIGKILL'); }
      }
      child.stdin.destroy();
      child.stderr.destroy();
    }

    const abort = () => stop(cancelledError());
    const timer = setTimeout(() => {
      stop(new BridgeError('model_timeout', 'Codex 응답 시간이 초과되었습니다.'));
    }, timeoutMs);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.stdin.on('error', () => { stdinFailed = true; });
    child.once('error', error => {
      failure ??= new BridgeError(
        error.code === 'ENOENT' ? 'model_unavailable' : 'model_execution_failed',
        'Codex를 실행할 수 없습니다.',
      );
    });
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (code === 0 && !stdinFailed) return resolve();
      const status = exitSignal ? `신호 ${exitSignal}` : `종료 코드 ${code}`;
      const message = code === 0 ? 'Codex에 요청을 전달할 수 없습니다.' : `Codex가 ${status}(으)로 끝났습니다.`;
      const errorCode = classifyRuntimeError(stderr);
      reject(new BridgeError(errorCode, message));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else child.stdin.end(prompt);
  });
}

export async function readOutput(path, limit) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) {
      throw new BridgeError('model_response_invalid', 'Codex 응답 파일이 너무 크거나 올바르지 않습니다.');
    }
    // Leave one byte to detect growth after the size check.
    const buffer = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size);
      if (!bytesRead) return JSON.parse(buffer.toString('utf8', 0, size));
      size += bytesRead;
    }
    throw new Error('output size changed');
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('model_response_invalid', 'Codex 응답 파일을 읽을 수 없습니다.');
  } finally {
    await file?.close();
  }
}
