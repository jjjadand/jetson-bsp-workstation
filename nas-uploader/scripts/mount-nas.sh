#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/../server/config.json"

if [ ! -f "$CONFIG" ]; then
  echo "Error: config.json not found at $CONFIG"
  exit 1
fi

# Parse config using Python (more reliable than jq which may not be installed)
SOURCE=$(python3 -c "import json; print(json.load(open('$CONFIG'))['nasMount']['source'])" 2>/dev/null || echo "")
TARGET=$(python3 -c "import json; print(json.load(open('$CONFIG'))['nasMount']['target'])" 2>/dev/null || echo "")
OPTIONS=$(python3 -c "import json; print(json.load(open('$CONFIG'))['nasMount']['options'])" 2>/dev/null || echo "")

if [ -z "$SOURCE" ] || [ -z "$TARGET" ]; then
  echo "Error: nasMount.source or nasMount.target not configured in $CONFIG"
  exit 1
fi

echo "Mounting NAS..."
echo "  Source: $SOURCE"
echo "  Target: $TARGET"
echo "  Options: $OPTIONS"

mkdir -p "$TARGET"

if mountpoint -q "$TARGET" 2>/dev/null; then
  echo "Already mounted at $TARGET"
  exit 0
fi

MOUNT_CMD="mount -t cifs '$SOURCE' '$TARGET'"
if [ -n "$OPTIONS" ]; then
  MOUNT_CMD="$MOUNT_CMD -o '$OPTIONS'"
fi

echo "Running: $MOUNT_CMD"
if eval "$MOUNT_CMD"; then
  echo "Success: NAS mounted at $TARGET"
else
  echo "Failed. Trying with sudo..."
  if eval "sudo $MOUNT_CMD"; then
    echo "Success: NAS mounted at $TARGET (with sudo)"
  else
    echo "Error: Failed to mount NAS"
    exit 1
  fi
fi
