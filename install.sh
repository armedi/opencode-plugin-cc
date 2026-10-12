#!/usr/bin/env bash
# Marketplace preparation for opencode-plugin-cc (install explicitly in Claude Code)
# Usage (inside Claude Code):
#   ! curl -fsSL https://raw.githubusercontent.com/armedi/opencode-plugin-cc/main/install.sh | bash
#
# Or clone + run locally:
#   ! bash <(curl -fsSL https://raw.githubusercontent.com/armedi/opencode-plugin-cc/main/install.sh)

set -euo pipefail

REPO="armedi/opencode-plugin-cc"
PLUGIN_NAME="opencode"
MARKETPLACE_NAME="armedi-opencode-plugin-cc"
BRANCH="main"

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
MARKETPLACES_DIR="$CLAUDE_DIR/plugins/marketplaces"
KNOWN_MKT="$CLAUDE_DIR/plugins/known_marketplaces.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[opencode-plugin]${NC} $1"; }
warn()  { echo -e "${YELLOW}[opencode-plugin]${NC} $1"; }
error() { echo -e "${RED}[opencode-plugin]${NC} $1"; exit 1; }

# --- Pre-checks ---
[ -d "$CLAUDE_DIR" ] || error "Claude Code directory not found at $CLAUDE_DIR. Is Claude Code installed?"
command -v node >/dev/null || error "Node.js 22 or later is required."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || error "Node.js 22 or later is required."
command -v npm >/dev/null || error "npm is required to install the V2 client."

mkdir -p "$MARKETPLACES_DIR"

# --- Step 1: Clone marketplace ---
MKT_DIR="$MARKETPLACES_DIR/$MARKETPLACE_NAME"

if [ -d "$MKT_DIR" ]; then
  info "Marketplace already exists, pulling latest..."
  git -C "$MKT_DIR" pull --ff-only origin "$BRANCH" 2>/dev/null || true
else
  info "Cloning marketplace from GitHub..."
  # Try SSH first, fall back to HTTPS
  if git clone --depth 1 -b "$BRANCH" "git@github.com:$REPO.git" "$MKT_DIR" 2>/dev/null; then
    info "Cloned via SSH."
  elif git clone --depth 1 -b "$BRANCH" "https://github.com/$REPO.git" "$MKT_DIR" 2>/dev/null; then
    info "Cloned via HTTPS."
  else
    error "Failed to clone repository. Please check your network and GitHub access."
  fi
fi

# --- Step 2: Read plugin version ---
PLUGIN_JSON="$MKT_DIR/plugins/$PLUGIN_NAME/.claude-plugin/plugin.json"
[ -f "$PLUGIN_JSON" ] || error "plugin.json not found at $PLUGIN_JSON"

VERSION=$(python3 -c "import json; print(json.load(open('$PLUGIN_JSON'))['version'])" 2>/dev/null || echo "1.0.0")
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

info "Plugin version: $VERSION"

# --- Step 3: Prepare dependencies in the marketplace source ---
# Claude Code will copy this source into its cache on explicit /plugin install.
npm --prefix "$MKT_DIR/plugins/$PLUGIN_NAME" ci --omit=dev --ignore-scripts --workspaces=false
info "Plugin dependencies prepared in the marketplace."

# --- Step 4: Register marketplace in known_marketplaces.json ---
if [ ! -f "$KNOWN_MKT" ]; then
  echo '{}' > "$KNOWN_MKT"
fi

python3 -c "
import json, sys
with open('$KNOWN_MKT', 'r') as f:
    data = json.load(f)
data['$MARKETPLACE_NAME'] = {
    'source': {'source': 'github', 'repo': '$REPO'},
    'installLocation': '$MKT_DIR',
    'lastUpdated': '$NOW'
}
with open('$KNOWN_MKT', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" || warn "Could not update known_marketplaces.json (non-fatal)"

# --- Done ---
echo ""
info "Marketplace ready. The plugin has not been installed or enabled by this script."
echo ""
echo -e "  ${GREEN}Next step:${NC} Run this command inside Claude Code:"
echo ""
echo -e "    ${YELLOW}/plugin install $PLUGIN_NAME@$MARKETPLACE_NAME${NC}"
echo ""
echo -e "  Choose your installation scope, then reload and verify:"
echo ""
echo -e "    ${YELLOW}/reload-plugins${NC}"
echo -e "    ${YELLOW}/opencode:setup${NC}"
echo ""
