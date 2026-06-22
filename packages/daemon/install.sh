#!/usr/bin/env bash
# agent-phonon 本地安装：全局命令 + systemd user unit。
# 用法：bash packages/daemon/install.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$REPO/packages/daemon/dist/cli.js"
BIN_DIR="$HOME/.local/bin"
WRAPPER="$BIN_DIR/agent-phonon"
NODE="$(command -v node)"

if [ ! -f "$CLI" ]; then
  echo "error: $CLI not found — build first: pnpm -C \"$REPO\" -r build"
  exit 1
fi

echo "[1/3] install global command → $WRAPPER"
mkdir -p "$BIN_DIR"
# 用 wrapper 而非 symlink，确保用对的 node + 绝对路径
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec "$NODE" "$CLI" "\$@"
EOF
chmod +x "$WRAPPER"

echo "[2/3] generate systemd user unit"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/agent-phonon.service" <<EOF
[Unit]
Description=agent-phonon device daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$NODE $CLI start
Restart=always
RestartSec=5
MemoryMax=256M

[Install]
WantedBy=default.target
EOF

echo "[3/3] done."
echo ""
echo "global command ready:  agent-phonon doctor"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "⚠️  $BIN_DIR not in PATH — add: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac
echo ""
echo "to run as a service:"
echo "  agent-phonon init                              # generate config"
echo "  agent-phonon adapter add openclaw --agent main # configure an agent runtime"
echo "  agent-phonon server add ws://127.0.0.1:PORT --trust-local"
echo "  systemctl --user daemon-reload"
echo "  systemctl --user enable --now agent-phonon"
echo "  systemctl --user status agent-phonon"
