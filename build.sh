#!/usr/bin/env bash
set -euo pipefail

echo "=== System Info ==="
node -v
npm -v

echo "=== Installing Dependencies ==="
npm install

echo "=== Building Project ==="
npm --workspace=@sm-office/shared run build
npm --workspace=@sm-office/admin run build
npm --workspace=@sm-office/server run build

echo "=== Build Completed Successfully ==="
