#!/bin/bash
set -euo pipefail

echo "🔨 Building ghostty-vt.wasm..."

# Ghostty states the Zig it needs in build.zig.zon; builds with older or newer
# minor releases fail in confusing ways, so check up front.
REQUIRED_ZIG=$(sed -n 's/.*minimum_zig_version = "\([^"]*\)".*/\1/p' ghostty/build.zig.zon 2>/dev/null || true)

if ! command -v zig &> /dev/null; then
    echo "❌ Error: Zig not found"
    echo ""
    echo "Install Zig ${REQUIRED_ZIG:-0.16.0}:"
    echo "  macOS:   brew install zig"
    echo "  Linux:   https://ziglang.org/download/"
    echo ""
    exit 1
fi

ZIG_VERSION=$(zig version)
echo "✓ Found Zig $ZIG_VERSION"

# Initialize the submodule (ghostty/.git is a file inside a submodule checkout)
if [ ! -e "ghostty/.git" ]; then
    echo "📦 Initializing Ghostty submodule..."
    git submodule update --init --recursive
    REQUIRED_ZIG=$(sed -n 's/.*minimum_zig_version = "\([^"]*\)".*/\1/p' ghostty/build.zig.zon)
fi

ZIG_MINOR=$(echo "$ZIG_VERSION" | cut -d. -f1,2)
REQUIRED_MINOR=$(echo "$REQUIRED_ZIG" | cut -d. -f1,2)
if [ -n "$REQUIRED_ZIG" ] && [ "$ZIG_MINOR" != "$REQUIRED_MINOR" ]; then
    echo "❌ Error: Ghostty needs Zig $REQUIRED_MINOR.x (found $ZIG_VERSION)"
    exit 1
fi

# libghostty-vt features ghostty-web uses: the render state (drawing), input
# encoding (keyboard) and grid introspection (scrollback reads, hyperlink URIs).
# Everything else (selection, search, snapshots, formatter...) only adds size.
VT_FEATURES="-all,+render-state,+input-encode,+grid-introspection"

echo "⚙️  Building libghostty-vt (features: $VT_FEATURES)..."
cd ghostty
zig build \
    -Demit-lib-vt \
    -Dtarget=wasm32-freestanding \
    -Doptimize=ReleaseSmall \
    "-Dvt-features=$VT_FEATURES"
cd ..

cp ghostty/zig-out/bin/ghostty-vt.wasm ./

SIZE=$(du -h ghostty-vt.wasm | cut -f1)
echo "✅ Built ghostty-vt.wasm ($SIZE)"
