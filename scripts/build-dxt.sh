#!/bin/bash

# Build script for creating DXT packages for mcp-ssh
# This script creates .dxt files for distribution without committing them to the repository

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Building MCP SSH DXT Package${NC}"

# Check if dxt CLI is available
if ! command -v npx &> /dev/null; then
    echo -e "${RED}Error: npm/npx not found. Please install Node.js${NC}"
    exit 1
fi

# Check if we have the dxt package
if ! npm list @anthropic-ai/dxt &> /dev/null; then
    echo -e "${RED}Error: @anthropic-ai/dxt not found. Please run 'npm install'${NC}"
    exit 1
fi

# Create build directory (not tracked in git)
BUILD_DIR="build"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# The entry point (bin/mcp-ssh.js) loads dist/, which is compiled from src/ and
# not tracked in git — build it before packing or the extension ships empty.
echo -e "${YELLOW}Building TypeScript sources...${NC}"
npm run build

echo -e "${YELLOW}Creating DXT package...${NC}"

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")
DXT_FILE="mcp-ssh-${VERSION}.dxt"

# Create the DXT package
npx dxt pack . "$BUILD_DIR/$DXT_FILE"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ DXT package created successfully: $BUILD_DIR/$DXT_FILE${NC}"
    echo -e "${GREEN}✓ Package size: $(ls -lh "$BUILD_DIR/$DXT_FILE" | awk '{print $5}')${NC}"
    
    # Display next steps
    echo -e "\n${YELLOW}Next steps:${NC}"
    echo "1. Test the DXT package locally"
    echo "2. Upload to GitHub releases:"
    echo "   gh release create v${VERSION} $BUILD_DIR/$DXT_FILE --title 'Release v${VERSION}' --notes 'MCP SSH Agent v${VERSION}'"
    echo "3. Or upload manually to GitHub releases page"
else
    echo -e "${RED}✗ Failed to create DXT package${NC}"
    exit 1
fi