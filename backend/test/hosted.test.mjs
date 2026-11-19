import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { proxyTrace } from '../../frontend/api/trace.js';
import { createHostedApp } from '../server/hosted.mjs';
import { createSandboxRunner } from '../server/sandbox.mjs';

const token = 'test-only-token-0123456789-abcdef';
const headers = { 'content-type': 'application/json' };
const example = { code: 'print(42)', language: 'python' };
const req = (extraHeaders = {}, body = JSON.stringify(example)) => new Request('https://visiblecode.vercel.app/api/trace', {
  method: 'POST', headers: { ...headers, ...extraHeaders }, body,
});
const env = { TRACE_BACKEND_URL: 'https://visiblecode.example', TRACE_API_TOKEN: token };

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('Vercel 프록시가 환경 변수 주소의 인증된 실행 API에만 코드를 전달한다', async t => {
  const output = { snapshots: [], output: '42\n' };
  let calls = 0;
  const base = await listen(t, createHostedApp({ token, runTrace: async input => {
    calls++;
    assert.deepEqual(input, example);
    return output;
  } }));
  const send = (url, options) => {
    assert.equal(url.href, 'https://visiblecode.example/api/trace');
    assert.equal(options.redirect, 'error');
    return fetch(`${base}${url.pathname}`, options);
  };
  const direct = await fetch(`${base}/api/trace`, { method: 'POST', headers, body: JSON.stringify(example) });
  assert.equal(direct.status, 401);
  assert.equal((await proxyTrace(req({ 'sec-fetch-site': 'cross-site' }), env, send)).status, 403);
  assert.equal((await proxyTrace(req(), { ...env, TRACE_BACKEND_URL: 'http://visiblecode.example' }, send)).status, 503);
  assert.equal((await proxyTrace(req({}, JSON.stringify({ ...example, code: '한'.repeat(30_000) })), env, send)).status, 413);
  assert.equal(calls, 0);
  const response = await proxyTrace(req({ authorization: 'client-input' }), env, send);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), output);
  assert.equal(calls, 1);
});

test('호스팅 API가 동시 실행과 분당 요청을 제한한다', async t => {
  let release, started;
  const waiting = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  const base = await listen(t, createHostedApp({ token, concurrency: 1, requestsPerMinute: 1, runTrace: async () => {
    started();
    await waiting;
    return { snapshots: [] };
  } }));
  const send = () => fetch(`${base}/api/trace`, {
    method: 'POST', headers: { ...headers, authorization: `Bearer ${token}` }, body: JSON.stringify(example),
  });
  const first = send();
  await running;
  assert.equal((await send()).status, 429);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await send()).status, 429);
});

test('실행마다 네트워크를 차단한 샌드박스를 생성하고 잘못된 결과가 와도 정리한다', async () => {
  const cleaned = [];
  let count = 0;
  const run = createSandboxRunner({ template: 'test-runner', create: async (template, options) => {
    assert.equal(template, 'test-runner');
    assert.equal(options.allowInternetAccess, false);
    assert.equal(options.network.allowPublicTraffic, false);
    assert.ok(options.timeoutMs <= 30_000);
    const id = ++count;
    return {
      files: {
        write: async (file, code, opts) => {
          assert.equal(file, '/home/visiblecode/source');
          assert.equal(code, example.code);
          assert.equal(opts.user, 'visiblecode');
        },
        read: async () => new Response(id === 1 ? '{"snapshots":[]}' : 'invalid result').body,
      },
      commands: { run: async (command, opts) => {
        assert.match(command, /runner\.sh python$/);
        assert.equal(opts.user, 'visiblecode');
      } },
      kill: async () => { cleaned.push(id); },
    };
  } });
  const signal = new AbortController().signal;
  assert.deepEqual(await run(example, signal), { snapshots: [] });
  await assert.rejects(() => run(example, signal), { status: 422 });
  assert.deepEqual(cleaned, [1, 2]);
});
