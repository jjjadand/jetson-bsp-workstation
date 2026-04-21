#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/../server/config.json"

if [ ! -f "$CONFIG" ]; then
  echo "Error: config.json not found at $CONFIG"
  exit 1
fi

# Parse config
SOURCE=$(python3 -c "import json; print(json.load(open('$CONFIG'))['nasMount']['source'])" 2>/dev/null || echo "")
TARGET=$(python3 -c "import json; print(json.load(open('$CONFIG'))['nasMount']['target'])" 2>/dev/null || echo "")
OPTIONS=$(python3 -c "import json; print(json.load(open('$CONFIG'))['nasMount']['options'])" 2>/dev/null || echo "")

if [ -z "$SOURCE" ] || [ -z "$TARGET" ]; then
  echo "Error: nasMount.source or nasMount.target not configured"
  exit 1
fi

# Escape for systemd unit
ESCAPED_TARGET=$(systemd-escape -p "$TARGET")
UNIT_NAME="${ESCAPED_TARGET//-/\\x2d}.mount"
AUTO_UNIT_NAME="${ESCAPED_TARGET//-/\\x2d}.automount"

echo "Setting up systemd automount for $TARGET"
echo "  Mount unit:   $UNIT_NAME"
echo "  Automount unit: $AUTO_UNIT_NAME"

# Create mount unit
MOUNT_UNIT="/etc/systemd/system/$UNIT_NAME"
sudo tee "$MOUNT_UNIT" > /dev/null <<EOF
[Unit]
Description=Mount NAS share at $TARGET
After=network-online.target
Wants=network-online.target

[Mount]
What=$SOURCE
Where=$TARGET
Type=cifs
Options=$OPTIONS
TimeoutSec=30

[Install]
WantedBy=multi-user.target
EOF

# Create automount unit
AUTO_UNIT="/etc/systemd/system/$AUTO_UNIT_NAME"
sudo tee "$AUTO_UNIT" > /dev/null <<EOF
[Unit]
Description=Automount NAS share at $TARGET

[Automount]
Where=$TARGET
TimeoutIdleSec=600

[Install]
WantedBy=multi-user.target
EOF

sudo mkdir -p "$TARGET"
sudo systemctl daemon-reload
sudo systemctl enable "$AUTO_UNIT_NAME"
sudo systemctl enable "$UNIT_NAME"
sudo systemctl start "$AUTO_UNIT_NAME"

echo ""
echo "Systemd automount configured successfully!"
echo ""
echo "Status:"
sudo systemctl status "$AUTO_UNIT_NAME" --no-pager || true
