#!/usr/bin/env node
import { mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Check Node.js ≥ 18 ────────────────────────────────────────────────────────
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 18) {
  console.error(`Error: Node.js 18+ required (found ${process.version}).`);
  process.exit(1);
}

// ── Copy scripts to a stable location ────────────────────────────────────────
const skillDir = join(homedir(), '.claude', 'skills', 'granola-auth');
mkdirSync(skillDir, { recursive: true });

const authJsSrc = join(__dirname, '..', 'auth.js');
const authJsDest = join(skillDir, 'auth.js');
copyFileSync(authJsSrc, authJsDest);

const refreshJsSrc = join(__dirname, '..', 'refresh.js');
const refreshJsDest = join(skillDir, 'refresh.js');
copyFileSync(refreshJsSrc, refreshJsDest);

// ── Write SKILL.md referencing the stable path ────────────────────────────────
writeFileSync(join(skillDir, 'SKILL.md'), `\
---
name: granola-auth
description: Authenticate with Granola and save OAuth tokens to .env
allowed-tools: Bash
---

Authenticate with Granola. Try to silently refresh the existing token first;
only open the browser for a full OAuth flow if refresh fails or no token exists.

## Step 1 — Try refresh first

Run:

\`\`\`
node ${refreshJsDest}
\`\`\`

- If it exits 0: tokens are valid (or were refreshed). Report the new expiry and stop.
- If it exits non-zero: proceed to Step 2.

## Step 2 — Full OAuth flow (browser)

Run:

\`\`\`
node ${authJsDest}
\`\`\`

This will:
1. Discover the Granola OAuth endpoints automatically
2. Register a temporary OAuth client via Dynamic Client Registration
3. Open the browser to log in with Google via Granola
4. Capture the OAuth callback on localhost:3334
5. Exchange the authorization code for access + refresh tokens
6. Save all tokens to a \`.env\` file in the current working directory
7. Prompt to configure MCP for Claude Code, Cursor, or both

After either step succeeds, display the contents of \`.env\` (mask token values
to show only first + last 6 chars), confirm the path where it was written, and
report which MCP config files were updated.

If Step 2 fails, show the full error output and suggest:
- Checking that port 3334 is not in use (\`lsof -i :3334\`)
- Ensuring Node.js 18+ is installed (\`node --version\`)
- Verifying internet connectivity to mcp.granola.ai
`);

console.log('');
console.log(`Skill installed at: ${skillDir}/SKILL.md`);
console.log(`auth.js copied to:  ${authJsDest}`);
console.log(`refresh.js copied to: ${refreshJsDest}`);
console.log('');
console.log('Restart Claude Code, then use /granola-auth to authenticate.');
