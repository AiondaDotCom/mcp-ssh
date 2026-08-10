# Publishing Instructions

This document contains instructions for publishing the @aiondadotcom/mcp-ssh package to npm.

## Prerequisites

1. You need to be a member of the @aiondadotcom organization on npm
2. You need to be logged in to npm: `npm login`
3. Verify your access: `npm access list packages @aiondadotcom`

## Publishing Process

### Automated Publishing (Recommended)

The package is automatically published when you create a GitHub release:

1. Commit all changes
2. Create a new release on GitHub
3. The GitHub Action will automatically publish to npm

### Manual Publishing

```bash
# 1. Make sure you're on the main branch and everything is committed
git checkout main
git pull origin main

# 2. Bump the version (patch, minor, or major)
npm version patch  # or minor/major

# 3. Publish to npm
npm publish

# 4. Push the version commit and tag
git push origin main --tags
```

### Testing Before Publishing

```bash
# Test the package locally
npm pack
npm install -g ./aiondadotcom-mcp-ssh-1.0.0.tgz

# Test the binary
mcp-ssh --help

# Clean up
npm uninstall -g @aiondadotcom/mcp-ssh
rm *.tgz
```

## First-Time Setup

If this is the first time publishing this package:

```bash
# Login to npm
npm login

# Verify you have access to the @aiondadotcom scope
npm access list packages @aiondadotcom

# Publish the package
npm publish --access public
```

## Package Configuration

The package is configured with:
- Scoped name: `@aiondadotcom/mcp-ssh`
- Public access
- Binary: `mcp-ssh` command
- Entry point: `dist/server.js`, compiled from `src/` (`prepublishOnly` runs the build and the test suite)
