import { Template, defaultBuildLogger } from 'e2b';

const root = { user: 'root' };
const template = Template()
  .fromImage('mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim')
  .runCmd('apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openjdk-17-jdk-headless python3 && rm -rf /var/lib/apt/lists/*', root)
  .runCmd('useradd --create-home --shell /bin/sh visiblecode && mkdir -p /opt/visiblecode/java /opt/visiblecode/rust /opt/visiblecode-build/csharp', root)
  // Keep sources outside /tmp, which can be cleared when E2B resumes a cached build layer.
  .copy('server/java/MemoryTracer.java', '/opt/visiblecode-build/MemoryTracer.java')
  .copy(['server/csharp/Tracer.csproj', 'server/csharp/Program.cs'], '/opt/visiblecode-build/csharp/')
  .runCmd('javac -encoding UTF-8 --add-modules jdk.jdi -d /opt/visiblecode/java /opt/visiblecode-build/MemoryTracer.java && dotnet publish /opt/visiblecode-build/csharp/Tracer.csproj -c Release -o /opt/visiblecode/csharp --nologo && rm -rf /opt/visiblecode-build', root)
  .copy(['server/python/tracer.py', 'server/runner.sh'], '/opt/visiblecode/')
  .runCmd('apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl gcc libc6-dev lldb-19 python3-lldb-19 nodejs && rm -rf /var/lib/apt/lists/*', root)
  .runCmd([
    'export RUSTUP_HOME=/opt/visiblecode/rustup CARGO_HOME=/opt/visiblecode/cargo',
    'curl -fsSL https://sh.rustup.rs -o /tmp/visiblecode-rustup.sh',
    'sh /tmp/visiblecode-rustup.sh -y --no-modify-path --profile minimal --default-toolchain 1.96.0',
    'ln -s "$(/opt/visiblecode/cargo/bin/rustup which rustc)" /usr/local/bin/codevis-rustc',
    'rm /tmp/visiblecode-rustup.sh',
  ].join(' && '), root)
  .copy(['server/rust/runner.mjs', 'server/rust/tracer.py'], '/opt/visiblecode/rust/')
  .runCmd('chown -R root:root /opt/visiblecode && chmod -R go-w /opt/visiblecode', root)
  .setUser('visiblecode');

if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY를 설정해 주세요.');
await Template.build(template, process.env.E2B_TEMPLATE || 'visiblecode-runner', {
  cpuCount: 1, memoryMB: 1024, onBuildLogs: defaultBuildLogger(),
});
