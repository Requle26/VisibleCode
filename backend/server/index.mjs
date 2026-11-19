import express from 'express';
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = path.join(root, '.runtime');
await mkdir(runtime, { recursive: true });
const exec = promisify(execFile);
const built = new Map();
const dotnetName = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
const localDotnet = [runtime, path.join(root, '..', '.runtime')].map(dir => path.join(dir, 'dotnet', dotnetName)).find(existsSync);
const dotnet = process.env.DOTNET_BIN || localDotnet || dotnetName;
const dotnetEnv = { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
const python = process.env.PYTHON_BIN || 'python3';
const names = { java: 'Java', csharp: 'C#', python: 'Python' };
const requirements = { java: 'JDK 17 이상(java, javac)', csharp: '.NET SDK 8 이상(dotnet)', python: 'Python 3.9 이상(python3)' };

function prepare(language) {
  if (language === 'python') return Promise.resolve();
  if (built.has(language)) return built.get(language);
  const job = (async () => {
    if (language === 'java') {
      await exec('javac', ['--add-modules', 'jdk.jdi', '-d', runtime, path.join(root, 'server/java/MemoryTracer.java')], { timeout: 30000 });
    } else {
      const options = { env: dotnetEnv, timeout: 45000 };
      const { stdout } = await exec(dotnet, ['--list-sdks'], options);
      const major = Math.max(0, ...[...stdout.matchAll(/^([0-9]+)\./gm)].map(match => Number(match[1])));
      if (major < 8) throw new Error('The .NET SDK 8 or newer is required.');
      await exec(dotnet, ['build', path.join(root, 'server/csharp/Tracer.csproj'), '--nologo', '--output', path.join(runtime, 'csharp'),
        `-p:TracerTarget=net${major}.0`, `-p:BaseIntermediateOutputPath=${path.join(runtime, 'csharp-obj')}${path.sep}`, '-p:UseSharedCompilation=false'], options);
    }
  })().catch(error => { built.delete(language); throw error; });
  built.set(language, job);
  return job;
}

function command(language, dir, source) {
  if (language === 'python') return [python, ['-I', path.join(root, 'server/python/tracer.py'), source], process.env];
  if (language === 'csharp') return [dotnet, [path.join(runtime, 'csharp/Tracer.dll'), source], dotnetEnv];
  return ['java', ['-Xmx192m', '--add-modules', 'jdk.jdi', '-cp', runtime, 'MemoryTracer', dir], process.env];
}

const app = express();
const server = createServer(app);
// The API executes the submitted code with the current user's local permissions.
// Accept browser requests only from the directly served loopback origin.
app.use((req, res, next) => {
  const host = req.get('host') || '';
  const origin = req.get('origin');
  const allowedOrigins = new Set([`http://${host}`, 'http://localhost:5173', 'http://127.0.0.1:5173']);
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host) || (origin && !allowedOrigins.has(origin))) {
    return res.status(403).json({ error: '로컬 Memory Studio에서만 실행할 수 있어요.' });
  }
  next();
});
app.use(express.json({ limit: '64kb' }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', engine: 'JVM / JDI', languages: Object.keys(names) }));
let active = 0;
app.post('/api/trace', async (req, res) => {
  const { code, language = 'java' } = req.body ?? {};
  if (typeof language !== 'string' || !Object.hasOwn(names, language)) return res.status(400).json({ error: '지원하는 언어는 Java, C#, Python입니다.' });
  if (typeof code !== 'string' || code.length > 40000) return res.status(400).json({ error: '40,000자 이하의 코드를 입력해 주세요.' });
  if (active >= 3) return res.status(429).json({ error: '이전 실행을 정리하고 있습니다. 잠시 후 다시 실행해 주세요.' });
  active++;
  let dir;
  let child;
  let timer;
  try {
    await prepare(language);
    if (res.destroyed) return;
    dir = await mkdtemp(path.join(os.tmpdir(), 'memory-studio-'));
    const source = path.join(dir, language === 'python' ? 'main.py' : language === 'csharp' ? 'Program.cs' : 'source.txt');
    await writeFile(source, code);
    if (res.destroyed) return;
    const [bin, args, env] = command(language, dir, source);
    const grouped = process.platform !== 'win32';
    child = spawn(bin, args, { cwd: dir, env, detached: grouped });
    const stop = () => {
      if (!child?.pid) return;
      try { grouped ? process.kill(-child.pid, 'SIGTERM') : child.kill('SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') child.kill('SIGTERM'); }
    };
    let output = '';
    let errors = '';
    let timedOut = false;
    timer = setTimeout(() => { timedOut = true; stop(); }, 15000);
    res.on('close', () => { if (!res.writableEnded) stop(); });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 18000000) stop(); });
    child.stderr.on('data', chunk => { if (errors.length < 1000) errors += chunk; });
    await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
    if (res.destroyed) return;
    if (timedOut) return res.status(408).json({ error: '실행 시간이 초과되었습니다. 무한 루프 또는 입력 대기 상태인지 확인해 주세요.' });
    try { res.json(JSON.parse(output)); }
    catch { res.status(500).json({ error: '실행 결과를 가져오지 못했습니다. 코드를 확인해 주세요.', detail: errors.slice(0, 1000) }); }
  } catch (error) {
    if (!res.destroyed) res.status(503).json({ error: `${names[language]} 실행 준비에 실패했어요. ${requirements[language]} 설치를 확인해 주세요.` });
  } finally {
    clearTimeout(timer);
    active--;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
app.use('/api', (error, _req, res, _next) => {
  res.status(error.status === 413 ? 413 : 400).json({ error: error.status === 413 ? '코드가 너무 길어요. 짧은 예제로 다시 실행해 주세요.' : '코드를 읽을 수 없어요.' });
});

const port = Number(process.env.PORT || 8787);
server.listen(port, '127.0.0.1', () => console.log(`Memory Studio → http://localhost:${server.address().port}`));
