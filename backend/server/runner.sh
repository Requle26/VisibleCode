#!/bin/sh
set -eu
umask 077
ulimit -c 0
ulimit -f 4096
cd "$(mktemp -d /tmp/trace.XXXXXXXX)"

input=/home/visiblecode/source
exec > /home/visiblecode/result.json 2>/dev/null

case "${1:-}" in
  java)
    cp "$input" source.txt
    exec timeout --signal=KILL 12s java -Xmx192m -XX:+UseSerialGC --add-modules jdk.jdi -cp /opt/visiblecode/java MemoryTracer "$PWD"
    ;;
  csharp)
    cp "$input" Program.cs
    exec timeout --signal=KILL 12s dotnet /opt/visiblecode/csharp/Tracer.dll "$PWD/Program.cs"
    ;;
  python)
    cp "$input" main.py
    exec timeout --signal=KILL 12s python3 -I /opt/visiblecode/tracer.py "$PWD/main.py"
    ;;
  *) exit 64 ;;
esac
