#!/bin/bash

# Build script for creating the installable MCP Bundle for Claude Desktop.
#
# Anthropic renamed the format: the ".dxt" Desktop Extension is now the ".mcpb"
# MCP Bundle, @anthropic-ai/dxt is deprecated in favour of @anthropic-ai/mcpb,
# and the manifest carries `manifest_version` rather than the deprecated
# `dxt_version`. v1.3.9 shipped both extensions during the transition; from here
# on only .mcpb is produced.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Building MCP SSH bundle (.mcpb)${NC}"

if ! command -v npx &> /dev/null; then
    echo -e "${RED}Error: npm/npx not found. Please install Node.js${NC}"
    exit 1
fi

if ! npm list @anthropic-ai/mcpb &> /dev/null; then
    echo -e "${RED}Error: @anthropic-ai/mcpb not found. Please run 'npm install'${NC}"
    exit 1
fi

# Create build directory (not tracked in git, and excluded from the npm package)
BUILD_DIR="build"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# The entry point (bin/mcp-ssh.js) loads dist/, which is compiled from src/ and
# not tracked in git — build it before packing or the extension ships empty.
echo -e "${YELLOW}Building TypeScript sources...${NC}"
npm run build

# Keep the bundle version in step with the package version; they used to drift.
PKG_VERSION=$(node -p "require('./package.json').version")
MANIFEST_VERSION=$(node -p "require('./manifest.json').version")
if [ "$PKG_VERSION" != "$MANIFEST_VERSION" ]; then
    echo -e "${RED}Error: manifest.json ($MANIFEST_VERSION) and package.json ($PKG_VERSION) disagree.${NC}"
    echo -e "${RED}Update manifest.json before building.${NC}"
    exit 1
fi

MCPB_FILE="mcp-ssh-${PKG_VERSION}.mcpb"

echo -e "${YELLOW}Validating manifest...${NC}"
npx mcpb validate manifest.json

# Pack from a staging copy holding only what the extension needs at runtime.
# Packing the working tree directly would bundle every devDependency — vitest,
# TypeScript, ESLint, the packer itself — which was ~290 packages and 81 MB
# unpacked. An extension that holds SSH credentials should not carry a test
# runner around; it is dead weight and needless attack surface.
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

echo -e "${YELLOW}Staging runtime files...${NC}"
cp manifest.json package.json package-lock.json LICENSE README.md "$STAGE/"
cp -R bin dist "$STAGE/"
mkdir -p "$STAGE/doc" && cp doc/Claude.png "$STAGE/doc/"

# --ignore-scripts: the staging copy needs no prepare/build step (dist is
# already compiled and copied in), and running lifecycle scripts from a
# dependency tree during packaging is worth avoiding on principle.
( cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 )

echo -e "${YELLOW}Packing bundle...${NC}"
npx mcpb pack "$STAGE" "$BUILD_DIR/$MCPB_FILE"

echo -e "${GREEN}✓ Bundle created: $BUILD_DIR/$MCPB_FILE${NC}"
echo -e "${GREEN}✓ Size: $(ls -lh "$BUILD_DIR/$MCPB_FILE" | awk '{print $5}')${NC}"

echo -e "\n${YELLOW}Next steps:${NC}"
echo "1. Test the bundle locally"
echo "2. Attach it to the GitHub release:"
echo "   gh release upload v${PKG_VERSION} $BUILD_DIR/$MCPB_FILE"
