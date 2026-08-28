#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
THIRD="$ROOT/3rdparty"
mkdir -p "$THIRD"

# npm install in the vendored dirs writes node_modules onto the bind-mounted
# project dir (NOT the container's anon volume), so an interrupted boot leaves
# npm's half-moved ".pkg-XXXXXXXX" temp dirs behind and every later install
# dies with ENOTEMPTY renaming pkg -> .pkg-XXXX — a permanent crash-loop that
# survives restarts and git pulls. Self-heal: sweep leftover temp dirs first,
# and if install still fails, wipe node_modules (fully npm-managed, always
# safe to rebuild) and retry once.
npm_install_clean() {
  local dir="$1"
  find "$dir/node_modules" -mindepth 1 -maxdepth 1 -name '.*-*' \
    ! -name '.package-lock.json' ! -name '.bin' -exec rm -rf {} + 2>/dev/null || true
  if ! (cd "$dir" && npm install); then
    echo "[3rdparty] npm install failed in $dir — wiping node_modules and retrying"
    rm -rf "$dir/node_modules"
    (cd "$dir" && npm install)
  fi
}

clone_and_build() {
  local name="$1"
  local url="$2"
  local dir="$THIRD/$name"

  if [ -d "$dir/.git" ]; then
    echo "[3rdparty] $name already present — skipping clone"
  else
    if [ -d "$dir" ]; then
      echo "[3rdparty] $name dir exists but is not a git repo — removing and re-cloning"
      rm -rf "$dir"
    fi
    echo "[3rdparty] cloning $name from $url"
    git clone --depth 1 "$url" "$dir"
  fi

  echo "[3rdparty] installing $name"
  npm_install_clean "$dir"

  if [ ! -d "$dir/dist" ]; then
    echo "[3rdparty] building $name"
    (cd "$dir" && npm run build)
  else
    echo "[3rdparty] $name dist/ already built — skipping"
  fi
}

# flexdb-node must come first — better-starlite3 depends on it at build time
clone_and_build flexdb-node https://github.com/tluyben/flexdb-node.git

# Clone and install better-starlite3 (do NOT build yet — dependencies must be
# wired before the TypeScript compiler runs)
BS3="$THIRD/better-starlite3"
if [ -d "$BS3/.git" ]; then
  echo "[3rdparty] better-starlite3 already present — skipping clone"
else
  if [ -d "$BS3" ]; then
    echo "[3rdparty] better-starlite3 dir exists but is not a git repo — removing and re-cloning"
    rm -rf "$BS3"
  fi
  echo "[3rdparty] cloning better-starlite3 from https://github.com/tluyben/better-starlite3.git"
  git clone --depth 1 https://github.com/tluyben/better-starlite3.git "$BS3"
fi
# Replace stub flexdb-node (empty dir committed in better-starlite3 git repo)
# with a symlink to the real built one so npm can resolve it.
rm -rf "$BS3/3rdparty/flexdb-node"
mkdir -p "$BS3/3rdparty"
ln -s "$THIRD/flexdb-node" "$BS3/3rdparty/flexdb-node"
echo "[3rdparty] installing better-starlite3"
npm_install_clean "$BS3"

# Wire flexdb-node into better-starlite3's node_modules so its build resolves
mkdir -p "$BS3/node_modules"
if [ ! -e "$BS3/node_modules/flexdb-node" ]; then
  ln -s "$THIRD/flexdb-node" "$BS3/node_modules/flexdb-node"
fi

# Clone and build better-starlite inside better-starlite3's own 3rdparty dir
# before building better-starlite3 — its driver-better-starlite.ts imports it
BSL_DIR="$BS3/3rdparty/better-starlite"
mkdir -p "$BS3/3rdparty"
if [ -d "$BSL_DIR/.git" ]; then
  echo "[3rdparty] better-starlite already present — skipping clone"
else
  if [ -d "$BSL_DIR" ]; then
    rm -rf "$BSL_DIR"
  fi
  echo "[3rdparty] cloning better-starlite"
  git clone --depth 1 https://github.com/tluyben/better-starlite.git "$BSL_DIR"
fi
echo "[3rdparty] installing better-starlite"
npm_install_clean "$BSL_DIR"
# Fix: npm symlinks better-starlite/node_modules/flexdb-node to the stub;
# replace with the real built package.
rm -rf "$BSL_DIR/node_modules/flexdb-node"
mkdir -p "$BSL_DIR/node_modules"
ln -s "$THIRD/flexdb-node" "$BSL_DIR/node_modules/flexdb-node"
# Fix: patch implicit-any TypeScript errors (strict mode build)
sed -i -e 's/result\.rows\.map(row =>/result.rows.map((row: any) =>/' \
  -e 's/result\.columns\.forEach((col, i)/result.columns.forEach((col: string, i: number)/' \
  "$BSL_DIR/src/drivers/flexdb-client.ts"
if [ ! -d "$BSL_DIR/dist" ]; then
  echo "[3rdparty] building better-starlite"
  (cd "$BSL_DIR" && npm run build)
else
  echo "[3rdparty] better-starlite dist/ already built — skipping"
fi

# Remove optional native peer deps from better-starlite3's own node_modules so
# the root node_modules/ copies (with compiled binaries) are used instead.
rm -rf "$BS3/node_modules/better-sqlite3" "$BS3/node_modules/best-sqlite3"

# Now build better-starlite3 with all dependencies in place
if [ ! -d "$BS3/dist" ]; then
  echo "[3rdparty] building better-starlite3"
  (cd "$BS3" && npm run build)
else
  echo "[3rdparty] better-starlite3 dist/ already built — skipping"
fi

echo "[3rdparty] done"
