#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
THIRD="$ROOT/3rdparty"
mkdir -p "$THIRD"

clone_and_build() {
  local name="$1"
  local url="$2"
  local dir="$THIRD/$name"

  if [ -d "$dir/.git" ]; then
    echo "[3rdparty] $name already present — skipping clone"
  else
    echo "[3rdparty] cloning $name from $url"
    git clone --depth 1 "$url" "$dir"
  fi

  echo "[3rdparty] installing $name"
  (cd "$dir" && npm install)

  if [ ! -d "$dir/dist" ]; then
    echo "[3rdparty] building $name"
    (cd "$dir" && npm run build)
  else
    echo "[3rdparty] $name dist/ already built — skipping"
  fi
}

# flexdb-node must come first — better-starlite3 depends on it at build time
clone_and_build flexdb-node   https://github.com/tluyben/flexdb-node.git
clone_and_build better-starlite3 https://github.com/tluyben/better-starlite3.git

# Wire flexdb-node into better-starlite3's node_modules so its build resolves
BS3="$THIRD/better-starlite3"
mkdir -p "$BS3/node_modules"
if [ ! -e "$BS3/node_modules/flexdb-node" ]; then
  ln -s "$THIRD/flexdb-node" "$BS3/node_modules/flexdb-node"
fi

# Remove optional native peer deps from better-starlite3's own node_modules so
# the root node_modules/ copies (with compiled binaries) are used instead.
rm -rf "$BS3/node_modules/better-sqlite3" "$BS3/node_modules/best-sqlite3"

# Rebuild better-starlite3 now that flexdb-node is linked
if [ ! -d "$BS3/dist" ]; then
  echo "[3rdparty] building better-starlite3"
  (cd "$BS3" && npm run build)
fi

echo "[3rdparty] done"
