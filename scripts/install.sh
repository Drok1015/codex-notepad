#!/usr/bin/env bash
set -euo pipefail
notepad_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$notepad_root"
if ! command -v node >/dev/null 2>&1; then
  echo '需要 Node.js 22.13+。请安装后重新运行此脚本。' >&2
  exit 1
fi
node scripts/runtime.mjs --check
command -v npm >/dev/null 2>&1 || { echo '需要 npm，请检查 Node 安装。' >&2; exit 1; }
npm ci --ignore-scripts
npm run build
npm test
npm run install:plugin
npm run verify:plugin
echo '安装与握手验证通过。请完全退出并重新打开 Codex，检查侧边栏「记事本」。'
