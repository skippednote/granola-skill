#!/usr/bin/env bash
set -euo pipefail

# ── Check Node.js ≥ 18 ────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is not installed. Please install Node.js 18 or later." >&2
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: Node.js 18+ required (found $(node --version))." >&2
  exit 1
fi

# ── Resolve paths ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTH_JS="$SCRIPT_DIR/auth.js"

if [ ! -f "$AUTH_JS" ]; then
  echo "Error: auth.js not found at $AUTH_JS" >&2
  exit 1
fi

# ── Install skill ─────────────────────────────────────────────────────────────
SKILL_DIR="$HOME/.claude/skills/granola-auth"
mkdir -p "$SKILL_DIR"

cat > "$SKILL_DIR/SKILL.md" << EOF
---
name: granola-auth
description: Authenticate with Granola and save OAuth tokens to .env
allowed-tools: Bash
---

Run the Granola OAuth authentication flow to obtain API tokens.

Execute this command using the Bash tool:

\`\`\`
node $AUTH_JS
\`\`\`

This will:
1. Discover the Granola OAuth endpoints automatically
2. Register a temporary OAuth client via Dynamic Client Registration
3. Open the browser to log in with Google via Granola
4. Capture the OAuth callback on localhost:3334
5. Exchange the authorization code for access + refresh tokens
6. Save all tokens to a \`.env\` file in the current working directory

After running, display the contents of \`.env\` (mask token values to show only first + last 6 chars) and confirm the path where it was written.

If the command fails, show the full error output and suggest:
- Checking that port 3334 is not in use (\`lsof -i :3334\`)
- Ensuring Node.js 18+ is installed (\`node --version\`)
- Verifying internet connectivity to mcp.granola.ai
EOF

echo ""
echo "Skill installed at: $SKILL_DIR/SKILL.md"
echo "auth.js path:       $AUTH_JS"
echo ""
echo "Restart Claude Code, then use /granola-auth to authenticate."
