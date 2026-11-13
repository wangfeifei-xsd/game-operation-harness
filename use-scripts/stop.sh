#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，无法读取本项目的运行记录。" >&2
  exit 1
fi
exec node "$SCRIPT_DIR/service.mjs" stop "$@"
