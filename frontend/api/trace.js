const maxRequestBytes = 64 * 1024;
const maxResponseBytes = 16 * 1024 * 1024;
const languages = new Set(['java', 'csharp', 'python']);

function backendEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) {
      return new URL('/api/trace', url);
    }
  } catch { /* Report invalid configuration below. */ }
}

function failure(status, error) {
  return { status, body: Buffer.from(JSON.stringify({ error })) };
}

async function readBody(stream, limit) {
  if (!stream) return;
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) return;
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function limitResponse(stream) {
  let size = 0;
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maxResponseBytes) throw new Error('Trace response exceeded the byte limit');
      controller.enqueue(chunk);
    },
  }));
}

export async function proxyTrace(req, env = process.env, request = fetch) {
  if (req.method !== 'POST') return failure(405, 'POST 요청만 지원해요.');
  if (req.headers.get('sec-fetch-site') === 'cross-site') return failure(403, 'VisibleCode에서 실행해 주세요.');
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) return failure(415, 'JSON으로 코드를 보내 주세요.');
  let data;
  try {
    if (!req.body) return failure(400, '코드를 읽을 수 없어요.');
    const bytes = await readBody(req.body, maxRequestBytes);
    if (!bytes) return failure(413, '코드가 너무 길어요.');
    data = JSON.parse(bytes.toString('utf8'));
  } catch { return failure(400, '코드를 읽을 수 없어요.'); }
  const { code, language = 'java' } = data ?? {};
  if (typeof code !== 'string' || !code.trim() || code.length > 40000 || !languages.has(language)) {
    return failure(400, '지원하는 언어의 코드를 40,000자 이하로 입력해 주세요.');
  }
  const payload = JSON.stringify({ code, language });
  if (Buffer.byteLength(payload) > maxRequestBytes) return failure(413, '코드가 너무 길어요.');

  const endpoint = backendEndpoint(env.TRACE_BACKEND_URL);
  const token = env.TRACE_API_TOKEN;
  if (!endpoint || !/^[a-zA-Z0-9_-]{32,}$/.test(token ?? '')) return failure(503, '실행 서버 주소와 인증을 설정해 주세요.');
  const deadline = AbortSignal.timeout(24_000);
  try {
    const response = await request(endpoint, {
      method: 'POST', redirect: 'error', cache: 'no-store', body: payload,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      signal: AbortSignal.any([req.signal, deadline]),
    });
    const status = response.status;
    if (![200, 400, 408, 413, 415, 422, 429, 503].includes(status) || !/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel().catch(() => {});
      return failure(502, '실행 서버에 연결할 수 없어요. 설정을 확인해 주세요.');
    }
    if (!response.body) return failure(502, '실행 서버의 응답을 읽을 수 없어요.');
    const encoding = response.headers.get('content-encoding');
    if ((!encoding || encoding === 'identity') && Number(response.headers.get('content-length')) > maxResponseBytes) {
      await response.body.cancel().catch(() => {});
      return failure(502, '실행 서버의 응답이 너무 길어요.');
    }
    // A streamed Response lets Vercel relay large traces without buffering them in the function.
    return { status, body: limitResponse(response.body) };
  } catch {
    return deadline.aborted ? failure(504, '실행 서버의 응답 시간이 초과됐어요.') : failure(502, '실행 서버에 연결할 수 없어요.');
  }
}

export default {
  async fetch(req) {
    const { status, body } = await proxyTrace(req);
    const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
    if (status === 405) headers.Allow = 'POST';
    return new Response(body, { status, headers });
  },
};
