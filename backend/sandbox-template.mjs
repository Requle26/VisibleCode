import { Template, defaultBuildLogger } from 'e2b';

const root = { user: 'root' };
const template = Template()
  .fromImage('mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim')
  .runCmd('apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openjdk-17-jdk-headless python3 && rm -rf /var/lib/apt/lists/*', root)
  .runCmd('useradd --create-home --shell /bin/sh visiblecode && mkdir -p /opt/visiblecode/java /tmp/tracer-csharp', root)
  .copy('server/java/MemoryTracer.java', '/tmp/MemoryTracer.java')
  .copy(['server/csharp/Tracer.csproj', 'server/csharp/Program.cs'], '/tmp/tracer-csharp/')
  .copy(['server/python/tracer.py', 'server/runner.sh'], '/opt/visiblecode/')
  .runCmd('javac --add-modules jdk.jdi -d /opt/visiblecode/java /tmp/MemoryTracer.java && dotnet publish /tmp/tracer-csharp/Tracer.csproj -c Release -o /opt/visiblecode/csharp --nologo && rm -rf /tmp/MemoryTracer.java /tmp/tracer-csharp && chown -R root:root /opt/visiblecode && chmod -R go-w /opt/visiblecode', root)
  .setEnvs({ DOTNET_NOLOGO: '1', DOTNET_EnableDiagnostics: '0' })
  .setUser('visiblecode');

if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY를 설정해 주세요.');
await Template.build(template, process.env.E2B_TEMPLATE || 'visiblecode-runner', {
  cpuCount: 1, memoryMB: 1024, onBuildLogs: defaultBuildLogger(),
});
