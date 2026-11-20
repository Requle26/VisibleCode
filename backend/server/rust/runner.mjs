import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const options = { maxBuffer: 1024 * 1024, timeout: 10000 };
const executable = process.platform === 'win32' ? 'codevis_rust.exe' : 'codevis_rust';
const tracer = fileURLToPath(new URL('./tracer.py', import.meta.url));

async function run() {
  try {
    await exec(process.env.RUSTC_BIN || 'rustc', ['--edition=2021', '--crate-name', 'codevis_rust', '--error-format=json',
      '-C', 'debuginfo=2', '-C', 'opt-level=0', '-C', `split-debuginfo=${process.platform === 'darwin' ? 'packed' : 'off'}`,
      'main.rs', '-o', executable], options);
  } catch (error) {
    if (error.code === 'ENOENT') return { error: 'Rust 컴파일러를 찾을 수 없어요. rustc 설치 또는 RUSTC_BIN 설정을 확인해 주세요.' };
    if (error.killed) return { error: 'Rust 컴파일 제한 시간이나 출력 크기를 초과했어요.' };
    const diagnostics = [];
    for (const line of (error.stderr || '').split('\n')) {
      try {
        const item = JSON.parse(line);
        if (item.level !== 'error' || (!item.spans?.length && /^(aborting|cannot continue)/.test(item.message))) continue;
        let span = item.spans?.find(span => span.is_primary);
        while (span && span.file_name !== 'main.rs') span = span.expansion?.span;
        diagnostics.push({ line: span?.line_start ?? 0, message: item.message });
        if (diagnostics.length >= 20) break;
      } catch { /* rustup or linker output need not be JSON */ }
    }
    return { error: 'Rust 코드를 컴파일하지 못했어요.', diagnostics: diagnostics.length ? diagnostics : [{ line: 0, message: (error.stderr || error.message).trim().slice(0, 1200) }] };
  }

  try {
    await exec(process.env.LLDB_BIN || 'lldb', ['--no-lldbinit', '--batch',
      '-o', `command script import ${JSON.stringify(tracer)}`, '-o', 'codevis-rust-trace', executable],
    { ...options, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    return JSON.parse(await readFile('trace.json', 'utf8'));
  } catch (error) {
    if (error.killed) return { error: 'Rust 실행 추적 제한 시간이나 출력 크기를 초과했어요.' };
    return { error: 'Rust 추적기를 시작하지 못했어요. Python 스크립팅을 지원하는 LLDB 설치 또는 LLDB_BIN 설정을 확인해 주세요.' };
  }
}

process.stdout.write(JSON.stringify(await run()));
