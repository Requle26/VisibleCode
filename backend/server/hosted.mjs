import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createSandboxRunner, parseTraceRequest, TraceError } from './sandbox.mjs';

const digest = value => createHash('sha256').update(value).digest();

export function createHostedApp({ token, runTrace, concurrency = 2, requestsPerMinute = 60 }) {
  if (!/^[a-zA-Z0-9_-]{32,}$/.test(token ?? '')) throw new Error('TRACE_API_TOKEN에 32자 이상의 안전한 토큰을 설정해 주세요.');
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  const expected = digest(`Bearer ${token}`);
  let active = 0;
  let recent = [];
  app.post('/api/trace', (req, res, next) => {
    if (!timingSafeEqual(expected, digest(req.get('authorization') ?? ''))) {
      return res.status(401).json({ error: '실행 서버 접속 권한이 없어요.' });
    }
    if (!req.is('application/json')) return res.status(415).json({ error: 'JSON으로 코드를 보내 주세요.' });
    next();
  }, express.json({ limit: '64kb' }), async (req, res) => {
    const request = parseTraceRequest(req.body);
    const now = Date.now();
    recent = recent.filter(started => now - started < 60_000);
    if (active >= concurrency || recent.length >= requestsPerMinute) {
      return res.status(429).set('Retry-After', '10').json({ error: '실행 요청이 많아요. 잠시 후 다시 실행해 주세요.' });
    }
    recent.push(now);
    active++;
    const cancelled = new AbortController();
    res.once('close', () => { if (!res.writableEnded) cancelled.abort(); });
    try {
      const body = await runTrace(request, cancelled.signal);
      if (!res.destroyed) {
        res.type('application/json').set('Content-Length', String(body.length)).end(body);
        await finished(res, { cleanup: true });
      }
    } finally {
      active--;
    }
  });
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (res.destroyed) return;
    if (error instanceof TraceError) return res.status(error.status).json({ error: error.message });
    if (error.status === 413) return res.status(413).json({ error: '코드가 너무 길어요.' });
    if (error.status === 400) return res.status(400).json({ error: '코드를 읽을 수 없어요.' });
    console.error('Trace worker unavailable:', error.name);
    res.status(503).json({ error: '실행 서버가 준비되지 않았어요. 잠시 후 다시 시도해 주세요.' });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { E2B_API_KEY, E2B_TEMPLATE, TRACE_API_TOKEN, PORT = '8787' } = process.env;
  if (!E2B_API_KEY || !E2B_TEMPLATE) throw new Error('E2B_API_KEY와 E2B_TEMPLATE을 설정해 주세요.');
  createHostedApp({ token: TRACE_API_TOKEN, runTrace: createSandboxRunner({ template: E2B_TEMPLATE }) })
    .listen(Number(PORT), '0.0.0.0', () => console.info(`VisibleCode API listening on port ${PORT}`));
}
