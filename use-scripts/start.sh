#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 24.9 或更高版本。" >&2
  exit 1
fi
exec node "$SCRIPT_DIR/service.mjs" start "$@"
