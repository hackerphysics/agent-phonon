#!/usr/bin/env bash
# 更新 agent-phonon HITL plugin 到 OpenClaw。
# 用法：bash scripts/update-plugin.sh
# 流程：build → 导出干净产物（无 monorepo node_modules symlink）→ force 安装 → 提示重启
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../packages/openclaw-plugin" && pwd)"
DIST="$HOME/agent-phonon-plugin-dist"

echo "[1/4] build plugin…"
cd "$PLUGIN_DIR"
pnpm build

echo "[2/4] export clean dist → $DIST"
rm -rf "$DIST" && mkdir -p "$DIST"
cp -r dist "$DIST/"
cp openclaw.plugin.json "$DIST/"
node -e '
const p=require("./package.json"); delete p.devDependencies;
require("fs").writeFileSync(process.env.HOME+"/agent-phonon-plugin-dist/package.json", JSON.stringify(p,null,2));
'

echo "[3/4] install (force)…"
openclaw plugins install --force "$DIST" 2>&1 | grep -E 'Installed|Install' || true

echo "[4/4] done. Restart gateway to load the new build:"
echo "    systemctl --user restart openclaw-gateway.service"
