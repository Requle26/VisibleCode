import { CommandExitError, Sandbox } from 'e2b';

const maxResultBytes = 16 * 1024 * 1024;
const languages = new Set(['java', 'csharp', 'python']);

export class TraceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function parseTraceRequest(body) {
  const { code, language = 'java' } = body ?? {};
  if (!languages.has(language)) throw new TraceError(400, '지원하는 언어는 Java, C#, Python입니다.');
  if (typeof code !== 'string' || !code.trim() || code.length > 40000) {
    throw new TraceError(400, '40,000자 이하의 코드를 입력해 주세요.');
  }
  return { code, language };
}

async function readResult(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResultBytes) throw new TraceError(422, '실행 결과가 너무 길어요. 더 짧은 예제를 실행해 주세요.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, size);
  try {
    const result = JSON.parse(body.toString('utf8'));
    // Forward the already-validated bytes instead of serializing all snapshots again.
    if (result && (Array.isArray(result.snapshots) || typeof result.error === 'string')) return body;
  } catch { /* A failed runner may leave an incomplete result. */ }
  throw new TraceError(422, '실행 결과를 가져오지 못했어요. 코드를 확인해 주세요.');
}

export function createSandboxRunner({ template, create = Sandbox.create.bind(Sandbox) }) {
  return async (request, cancelled) => {
    const { code, language } = parseTraceRequest(request);
    const deadline = AbortSignal.timeout(18_000);
    const signal = cancelled ? AbortSignal.any([cancelled, deadline]) : deadline;
    const options = { user: 'visiblecode', signal, requestTimeoutMs: 5000 };
    let sandbox;
    try {
      sandbox = await create(template, {
        timeoutMs: 30_000, requestTimeoutMs: 5000, signal,
        allowInternetAccess: false, network: { allowPublicTraffic: false },
      });
      await sandbox.files.write('/home/visiblecode/source', code, options);
      await sandbox.commands.run(`/bin/sh /opt/visiblecode/runner.sh ${language} ${maxResultBytes}`, {
        ...options, timeoutMs: 13_000, retainOutput: false,
      });
      return await readResult(await sandbox.files.read('/home/visiblecode/result.json', { ...options, format: 'stream' }));
    } catch (error) {
      if (error instanceof TraceError) throw error;
      if (deadline.aborted || (error instanceof CommandExitError && [124, 137, 152, 153].includes(error.exitCode))) {
        throw new TraceError(408, '실행 시간 또는 자원 한도를 초과했어요.');
      }
      if (error instanceof CommandExitError) throw new TraceError(422, '실행이 중단됐어요. 코드를 확인해 주세요.');
      throw error;
    } finally {
      // Cleanup has its own timeout; the provider's sandbox TTL also applies if this process stops.
      if (sandbox) await sandbox.kill({ requestTimeoutMs: 2000 }).catch(() => {});
    }
  };
}
