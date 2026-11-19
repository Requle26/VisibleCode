import { Template, defaultBuildLogger } from 'e2b';

const root = { user: 'root' };
const template = Template()
  .fromImage('mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim')
  .runCmd('apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openjdk-17-jdk-headless python3 && rm -rf /var/lib/apt/lists/*', root)
  .runCmd('useradd --create-home --shell /bin/sh visiblecode && mkdir -p /opt/visiblecode/java /opt/visiblecode-build/csharp', root)
  // Keep sources outside /tmp, which can be cleared when E2B resumes a cached build layer.
  .copy('server/java/MemoryTracer.java', '/opt/visiblecode-build/MemoryTracer.java')
  .copy(['server/csharp/Tracer.csproj', 'server/csharp/Program.cs'], '/opt/visiblecode-build/csharp/')
  .runCmd('javac -encoding UTF-8 --add-modules jdk.jdi -d /opt/visiblecode/java /opt/visiblecode-build/MemoryTracer.java && dotnet publish /opt/visiblecode-build/csharp/Tracer.csproj -c Release -o /opt/visiblecode/csharp --nologo && rm -rf /opt/visiblecode-build', root)
  .copy(['server/python/tracer.py', 'server/runner.sh'], '/opt/visiblecode/')
  .runCmd('chown -R root:root /opt/visiblecode && chmod -R go-w /opt/visiblecode', root)
  .setUser('visiblecode');

if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY를 설정해 주세요.');
await Template.build(template, process.env.E2B_TEMPLATE || 'visiblecode-runner', {
  cpuCount: 1, memoryMB: 1024, onBuildLogs: defaultBuildLogger(),
});
