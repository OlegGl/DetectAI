#!/usr/bin/env bash
# =============================================================================
# DetectAI — Ollama Setup Script for macOS
# Installs Ollama, pulls gemma4, configures CORS for Chrome extensions,
# and wires up the DetectAI extension to use it automatically.
#
# Usage:  chmod +x setup-ollama.sh && ./setup-ollama.sh
# =============================================================================

set -euo pipefail

# ─── Colours ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

step()  { echo -e "\n${BLUE}${BOLD}▶ $*${NC}"; }
ok()    { echo -e "  ${GREEN}✓ $*${NC}"; }
warn()  { echo -e "  ${YELLOW}⚠ $*${NC}"; }
info()  { echo -e "  ${CYAN}→ $*${NC}"; }
die()   { echo -e "\n${RED}${BOLD}✗ ERROR: $*${NC}" >&2; exit 1; }

# ─── Config ───────────────────────────────────────────────────────────────────
OLLAMA_MODEL="gemma4"
OLLAMA_URL="http://localhost:11434"
# Allow any Chrome extension to call Ollama (required for the extension to work)
OLLAMA_ORIGINS="chrome-extension://*"
DETECTAI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHAGENT_PLIST="$HOME/Library/LaunchAgents/com.ollama.ollama.plist"
PLISTBUDDY="/usr/libexec/PlistBuddy"

# ─── Banner ───────────────────────────────────────────────────────────────────
echo -e ""
echo -e "${BOLD}╔═══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║      DetectAI — Ollama Setup for macOS            ║${NC}"
echo -e "${BOLD}║      Model: ${CYAN}${OLLAMA_MODEL}${NC}${BOLD}                              ║${NC}"
echo -e "${BOLD}╚═══════════════════════════════════════════════════╝${NC}"

# ─── 1. macOS check ───────────────────────────────────────────────────────────
step "Checking system requirements"

if [[ "$(uname -s)" != "Darwin" ]]; then
  die "This script is for macOS only."
fi

MACOS_VERSION=$(sw_vers -productVersion)
ARCH=$(uname -m)
ok "macOS $MACOS_VERSION ($ARCH)"

# gemma4 is large — check available disk space (need at least 6 GB)
AVAILABLE_GB=$(df -g "$HOME" | awk 'NR==2 {print $4}')
if [[ "$AVAILABLE_GB" -lt 6 ]]; then
  warn "Low disk space: ${AVAILABLE_GB}GB free. gemma4 requires ~5–6GB. Continuing anyway…"
else
  ok "Disk space: ${AVAILABLE_GB}GB available"
fi

# ─── 2. Homebrew ─────────────────────────────────────────────────────────────
step "Checking Homebrew"

if command -v brew &>/dev/null; then
  ok "Homebrew already installed: $(brew --version | head -1)"
else
  info "Homebrew not found — installing…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  # Add brew to PATH for Apple Silicon
  if [[ "$ARCH" == "arm64" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    # Persist to shell profile
    PROFILE="$HOME/.zprofile"
    if ! grep -q 'homebrew/bin/brew shellenv' "$PROFILE" 2>/dev/null; then
      echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$PROFILE"
      info "Added Homebrew to $PROFILE"
    fi
  fi
  ok "Homebrew installed"
fi

# ─── 3. Ollama ───────────────────────────────────────────────────────────────
step "Checking Ollama"

if command -v ollama &>/dev/null; then
  OLLAMA_VERSION=$(ollama --version 2>/dev/null | head -1 || echo "unknown")
  ok "Ollama already installed: $OLLAMA_VERSION"
else
  info "Ollama not found — installing via Homebrew…"

  # Try Homebrew cask first (official package)
  if brew install --cask ollama 2>/dev/null; then
    ok "Ollama installed via Homebrew cask"
  else
    # Fallback: direct download
    warn "Homebrew cask failed — trying direct download…"

    if [[ "$ARCH" == "arm64" ]]; then
      OLLAMA_URL_DMG="https://ollama.ai/download/Ollama-darwin-arm64.zip"
    else
      OLLAMA_URL_DMG="https://ollama.ai/download/Ollama-darwin-x86_64.zip"
    fi

    TMPDIR_DL=$(mktemp -d)
    curl -fL --progress-bar -o "$TMPDIR_DL/Ollama.zip" "$OLLAMA_URL_DMG"
    unzip -q "$TMPDIR_DL/Ollama.zip" -d "$TMPDIR_DL/"

    # Move app to Applications
    if [[ -d "$TMPDIR_DL/Ollama.app" ]]; then
      rm -rf "/Applications/Ollama.app"
      mv "$TMPDIR_DL/Ollama.app" "/Applications/"
      ok "Ollama.app moved to /Applications"
    else
      die "Could not find Ollama.app in downloaded zip. Please install manually from https://ollama.ai"
    fi
    rm -rf "$TMPDIR_DL"

    # Symlink the CLI
    if [[ ! -f /usr/local/bin/ollama ]]; then
      ln -sf "/Applications/Ollama.app/Contents/Resources/ollama" /usr/local/bin/ollama 2>/dev/null || \
      sudo ln -sf "/Applications/Ollama.app/Contents/Resources/ollama" /usr/local/bin/ollama
    fi
    ok "Ollama CLI linked"
  fi

  ok "Ollama installed"
fi

# ─── 4. Configure CORS for Chrome extensions ─────────────────────────────────
step "Configuring Ollama CORS for Chrome extensions"

# Ollama must allow requests from chrome-extension:// origins.
# We set OLLAMA_ORIGINS in the LaunchAgent plist so it persists across reboots.

configure_launchagent_cors() {
  local plist="$1"

  if [[ ! -f "$plist" ]]; then
    warn "LaunchAgent plist not found at: $plist"
    info "Falling back to ~/.ollama/env file…"
    configure_env_file
    return
  fi

  info "Patching LaunchAgent plist: $plist"

  # Add EnvironmentVariables dict if it doesn't exist
  "$PLISTBUDDY" -c "Add :EnvironmentVariables dict" "$plist" 2>/dev/null || true

  # Set OLLAMA_ORIGINS (add if missing, set if present)
  if "$PLISTBUDDY" -c "Print :EnvironmentVariables:OLLAMA_ORIGINS" "$plist" &>/dev/null; then
    "$PLISTBUDDY" -c "Set :EnvironmentVariables:OLLAMA_ORIGINS $OLLAMA_ORIGINS" "$plist"
  else
    "$PLISTBUDDY" -c "Add :EnvironmentVariables:OLLAMA_ORIGINS string $OLLAMA_ORIGINS" "$plist"
  fi

  # Also set HOME so Ollama can find its model store
  if ! "$PLISTBUDDY" -c "Print :EnvironmentVariables:HOME" "$plist" &>/dev/null; then
    "$PLISTBUDDY" -c "Add :EnvironmentVariables:HOME string $HOME" "$plist"
  fi

  ok "CORS configured in LaunchAgent plist"
}

configure_env_file() {
  # Ollama respects ~/.ollama/env on some builds
  mkdir -p "$HOME/.ollama"
  local env_file="$HOME/.ollama/env"

  # Write or update OLLAMA_ORIGINS in the env file
  if [[ -f "$env_file" ]]; then
    # Replace existing line or append
    if grep -q "^OLLAMA_ORIGINS=" "$env_file"; then
      sed -i '' "s|^OLLAMA_ORIGINS=.*|OLLAMA_ORIGINS=$OLLAMA_ORIGINS|" "$env_file"
    else
      echo "OLLAMA_ORIGINS=$OLLAMA_ORIGINS" >> "$env_file"
    fi
  else
    echo "OLLAMA_ORIGINS=$OLLAMA_ORIGINS" > "$env_file"
  fi
  ok "CORS configured in ~/.ollama/env"
}

# Try the LaunchAgent plist first (most reliable on macOS)
# The plist location differs by install method
FOUND_PLIST=""
POSSIBLE_PLISTS=(
  "$HOME/Library/LaunchAgents/com.ollama.ollama.plist"
  "/Library/LaunchAgents/com.ollama.ollama.plist"
  "$HOME/Library/LaunchAgents/ai.ollama.ollama.plist"
)

for p in "${POSSIBLE_PLISTS[@]}"; do
  if [[ -f "$p" ]]; then
    FOUND_PLIST="$p"
    break
  fi
done

if [[ -n "$FOUND_PLIST" ]]; then
  configure_launchagent_cors "$FOUND_PLIST"
else
  info "No LaunchAgent plist found yet (Ollama may not have been launched once)"
  info "Using ~/.ollama/env file as fallback"
  configure_env_file
fi

# Also set for the current shell session so it takes effect immediately
export OLLAMA_ORIGINS="$OLLAMA_ORIGINS"
ok "OLLAMA_ORIGINS=$OLLAMA_ORIGINS set for current session"

# ─── 5. Start / restart Ollama ───────────────────────────────────────────────
step "Starting Ollama service"

ollama_is_running() {
  curl -sf "$OLLAMA_URL/api/tags" &>/dev/null
}

if ollama_is_running; then
  info "Ollama is already running — restarting to apply CORS config…"

  # Try launchctl first (proper way)
  if [[ -n "$FOUND_PLIST" ]]; then
    launchctl unload "$FOUND_PLIST" 2>/dev/null || true
    sleep 1
    OLLAMA_ORIGINS="$OLLAMA_ORIGINS" launchctl load "$FOUND_PLIST" 2>/dev/null || \
      OLLAMA_ORIGINS="$OLLAMA_ORIGINS" ollama serve &>/tmp/ollama-detectai.log &
  else
    # Kill existing serve process and restart with env var
    pkill -f "ollama serve" 2>/dev/null || true
    sleep 1
    OLLAMA_ORIGINS="$OLLAMA_ORIGINS" ollama serve &>/tmp/ollama-detectai.log &
  fi
else
  info "Starting Ollama…"
  if [[ -n "$FOUND_PLIST" ]]; then
    OLLAMA_ORIGINS="$OLLAMA_ORIGINS" launchctl load "$FOUND_PLIST" 2>/dev/null || \
      OLLAMA_ORIGINS="$OLLAMA_ORIGINS" ollama serve &>/tmp/ollama-detectai.log &
  else
    # Open the app if it exists (installs the LaunchAgent on first run)
    if [[ -d "/Applications/Ollama.app" ]]; then
      open -a "Ollama" 2>/dev/null &
    fi
    # Also start serve in background as fallback
    OLLAMA_ORIGINS="$OLLAMA_ORIGINS" ollama serve &>/tmp/ollama-detectai.log &
  fi
fi

# Wait for Ollama to be ready
info "Waiting for Ollama to be ready…"
MAX_WAIT=30
WAITED=0
until ollama_is_running; do
  sleep 1
  WAITED=$((WAITED + 1))
  if [[ "$WAITED" -ge "$MAX_WAIT" ]]; then
    die "Ollama did not start within ${MAX_WAIT}s. Check /tmp/ollama-detectai.log for errors."
  fi
  printf "  Waiting… (%ds)\r" "$WAITED"
done
echo ""
ok "Ollama is running at $OLLAMA_URL"

# Now that Ollama has launched once, the LaunchAgent plist should exist
# Try to configure CORS in it if we couldn't find it before
if [[ -z "$FOUND_PLIST" ]]; then
  for p in "${POSSIBLE_PLISTS[@]}"; do
    if [[ -f "$p" ]]; then
      FOUND_PLIST="$p"
      configure_launchagent_cors "$FOUND_PLIST"
      break
    fi
  done
fi

# ─── 6. Pull gemma4 model ─────────────────────────────────────────────────────
step "Pulling $OLLAMA_MODEL model"

# Check if model is already present
if ollama list 2>/dev/null | grep -q "^${OLLAMA_MODEL}"; then
  ok "$OLLAMA_MODEL is already downloaded"
else
  info "Downloading $OLLAMA_MODEL — this may take several minutes depending on your connection…"
  info "gemma4 is ~5–6GB. Progress is shown below."
  echo ""

  # Pull with full output so the user sees progress
  if ! ollama pull "$OLLAMA_MODEL"; then
    echo ""
    warn "ollama pull $OLLAMA_MODEL failed."
    info "This could mean:"
    info "  • The model name 'gemma4' is not yet in the Ollama library"
    info "  • Network issue"
    echo ""
    info "Available models with 'gemma' in the name:"
    ollama search gemma 2>/dev/null | head -10 || true
    echo ""
    read -rp "  Enter an alternative model name (or press Enter to skip): " ALT_MODEL
    if [[ -n "$ALT_MODEL" ]]; then
      OLLAMA_MODEL="$ALT_MODEL"
      ollama pull "$OLLAMA_MODEL" || die "Failed to pull $OLLAMA_MODEL. Check your internet connection."
    else
      warn "Skipping model pull. You can run 'ollama pull gemma4' manually later."
    fi
  fi

  ok "$OLLAMA_MODEL downloaded successfully"
fi

# ─── 7. Verify the model responds ────────────────────────────────────────────
step "Verifying $OLLAMA_MODEL is working"

info "Running a quick test prompt…"

TEST_RESPONSE=$(curl -sf "$OLLAMA_URL/api/chat" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$OLLAMA_MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Reply with just the word: OK\"}],
    \"stream\": false
  }" 2>&1 || true)

if echo "$TEST_RESPONSE" | grep -q '"content"'; then
  ok "Model responded correctly"
else
  warn "Could not verify model response. It may still be loading."
  info "Raw response: $TEST_RESPONSE"
fi

# ─── 8. Verify CORS headers ──────────────────────────────────────────────────
step "Verifying CORS headers for Chrome extension origins"

CORS_TEST=$(curl -sf \
  -H "Origin: chrome-extension://fakeextensionid" \
  -H "Access-Control-Request-Method: POST" \
  -X OPTIONS \
  "$OLLAMA_URL/api/chat" \
  -D - -o /dev/null 2>/dev/null || true)

if echo "$CORS_TEST" | grep -qi "access-control-allow-origin"; then
  ALLOWED_ORIGIN=$(echo "$CORS_TEST" | grep -i "access-control-allow-origin" | head -1)
  ok "CORS is configured: $ALLOWED_ORIGIN"
else
  warn "CORS headers not detected yet — Ollama may need a full restart."
  info "If the extension cannot connect, run: pkill -f 'ollama serve' && OLLAMA_ORIGINS='chrome-extension://*' ollama serve"
fi

# ─── 9. Patch DetectAI extension defaults ────────────────────────────────────
step "Updating DetectAI extension configuration"

BG_JS="$DETECTAI_DIR/background.js"
OPT_JS="$DETECTAI_DIR/options.js"

update_defaults() {
  local file="$1"
  local label="$2"

  if [[ ! -f "$file" ]]; then
    warn "Not found: $file — skipping"
    return
  fi

  # Switch apiBackend to ollama
  sed -i '' "s|apiBackend: 'anthropic'|apiBackend: 'ollama'|g" "$file"
  sed -i '' 's|apiBackend: "anthropic"|apiBackend: "ollama"|g' "$file"

  # Set ollamaModel to gemma4
  sed -i '' "s|ollamaModel: '[^']*'|ollamaModel: '$OLLAMA_MODEL'|g" "$file"
  sed -i '' "s|ollamaModel: \"[^\"]*\"|ollamaModel: \"$OLLAMA_MODEL\"|g" "$file"

  ok "$label updated → backend: ollama, model: $OLLAMA_MODEL"
}

update_defaults "$BG_JS"  "background.js"
update_defaults "$OPT_JS" "options.js"

# ─── 10. Optional: auto-enable extension on install ───────────────────────────
# Write a local config file the extension can read at startup
CONFIG_FILE="$DETECTAI_DIR/.detectai-config.json"
cat > "$CONFIG_FILE" <<JSON
{
  "apiBackend": "ollama",
  "ollamaUrl": "$OLLAMA_URL",
  "ollamaModel": "$OLLAMA_MODEL",
  "detectionThreshold": 0.65,
  "autoScan": true,
  "enabled": true,
  "showReasoning": true,
  "highlightAmbiguous": false,
  "configuredAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "setupScript": "setup-ollama.sh"
}
JSON
ok "Saved config snapshot to .detectai-config.json"

# ─── 11. Startup persistence check ───────────────────────────────────────────
step "Checking startup persistence"

if [[ -n "$FOUND_PLIST" ]]; then
  LOADED=$(launchctl list | grep "com.ollama" || echo "")
  if [[ -n "$LOADED" ]]; then
    ok "Ollama LaunchAgent is loaded and will start at login"
  else
    warn "LaunchAgent not active in launchctl — loading now…"
    launchctl load "$FOUND_PLIST" 2>/dev/null && ok "LaunchAgent loaded" || warn "Could not load LaunchAgent"
  fi
else
  warn "No LaunchAgent plist found — Ollama will NOT auto-start on login."
  info "To add auto-start, create ~/Library/LaunchAgents/com.ollama.ollama.plist:"
  info "  Or open the Ollama.app from Applications and enable 'Launch at Login' in its menu."
fi

# Create a startup script the user can add to their login items as a fallback
STARTUP_SCRIPT="$DETECTAI_DIR/start-ollama.sh"
cat > "$STARTUP_SCRIPT" <<'STARTUP'
#!/usr/bin/env bash
# start-ollama.sh — Run this at login to ensure Ollama starts with CORS enabled.
# Add it to System Settings → General → Login Items if auto-start isn't working.

export OLLAMA_ORIGINS="chrome-extension://*"

if ! curl -sf http://localhost:11434/api/tags &>/dev/null; then
  ollama serve >> /tmp/ollama-detectai.log 2>&1 &
  echo "[DetectAI] Ollama started with CORS enabled"
else
  echo "[DetectAI] Ollama is already running"
fi
STARTUP
chmod +x "$STARTUP_SCRIPT"
ok "Created start-ollama.sh (fallback startup script)"

# ─── 12. Final summary ────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║            ✅  Setup Complete!                            ║${NC}"
echo -e "${BOLD}╠═══════════════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}║${NC}  Ollama:    running at ${CYAN}$OLLAMA_URL${NC}"
echo -e "${BOLD}║${NC}  Model:     ${CYAN}$OLLAMA_MODEL${NC}"
echo -e "${BOLD}║${NC}  CORS:      ${CYAN}chrome-extension://*${NC} allowed"
echo -e "${BOLD}║${NC}  Extension: defaults set to ollama + $OLLAMA_MODEL"
echo -e "${BOLD}╠═══════════════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}║  Next steps:                                              ║${NC}"
echo -e "${BOLD}║${NC}  1. Open chrome://extensions                               ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  2. Enable Developer mode (top right toggle)               ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  3. Click \"Load unpacked\" → select:                         ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}     ${CYAN}$DETECTAI_DIR${NC}"
echo -e "${BOLD}║${NC}  4. Browse any article — AI text gets a red border!        ${BOLD}║${NC}"
echo -e "${BOLD}╠═══════════════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}║  Useful commands:                                         ║${NC}"
echo -e "${BOLD}║${NC}  ${CYAN}ollama list${NC}                 — see installed models              ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  ${CYAN}ollama ps${NC}                   — see running models                ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  ${CYAN}ollama pull gemma4${NC}           — re-download model                ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  ${CYAN}tail -f /tmp/ollama-detectai.log${NC} — view Ollama logs           ${BOLD}║${NC}"
echo -e "${BOLD}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
