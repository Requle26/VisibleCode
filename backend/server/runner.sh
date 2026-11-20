#!/bin/sh
set -eu
umask 077
ulimit -c 0
export LANG=C.UTF-8 LC_ALL=C.UTF-8 DOTNET_NOLOGO=1 DOTNET_EnableDiagnostics=0
cd "$(mktemp -d /tmp/trace.XXXXXXXX)"

input=/home/visiblecode/source
result=/home/visiblecode/result.json
# Older API versions omit the limit. Keep their response size unchanged.
case "${2:-4194304}" in
  4194304|16777216) limit=${2:-4194304} ;;
  *) exit 64 ;;
esac
capture_bytes=$((limit + 1))
file_blocks=$(((capture_bytes + 511) / 512))

case "${1:-}" in
  java)
    ulimit -f "$file_blocks"
    cp "$input" source.txt
    set -- java -Xmx192m -XX:+UseSerialGC --add-modules jdk.jdi -cp /opt/visiblecode/java MemoryTracer "$PWD"
    ;;
  csharp)
    cp "$input" Program.cs
    # .NET needs an unrestricted file size limit for its JIT backing file.
    set -- dotnet /opt/visiblecode/csharp/Tracer.dll "$PWD/Program.cs"
    ;;
  python)
    ulimit -f "$file_blocks"
    cp "$input" main.py
    set -- python3 -I /opt/visiblecode/tracer.py "$PWD/main.py"
    ;;
  rust)
    # Include space for the compiled binary and its debug information.
    ulimit -f 131072
    cp "$input" main.rs
    export RUSTC_BIN=/usr/local/bin/codevis-rustc LLDB_BIN=/usr/bin/lldb-19
    set -- /usr/bin/node /opt/visiblecode/rust/runner.mjs
    ;;
  *) exit 64 ;;
esac

# Keep one byte past the API limit so oversize is distinguishable from invalid JSON.
exec /bin/bash -o pipefail -c '
  result=$1
  capture_bytes=$2
  shift 2
  timeout --signal=KILL 12s "$@" 2>/dev/null | head -c "$capture_bytes" > "$result"
  status=$?
  if [ "$status" -ne 0 ] && [ "$(stat -c %s "$result")" -eq "$capture_bytes" ]; then
    exit 0
  fi
  exit "$status"
' runner "$result" "$capture_bytes" "$@"
