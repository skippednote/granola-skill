---
name: granola-auth
description: Authenticate with Granola and save OAuth tokens to .env
allowed-tools: Bash
---

Run the Granola OAuth authentication flow to obtain API tokens.

Execute this command using the Bash tool:

```
node /path/to/granola-skill/auth.js
```

> **Note:** `install.sh` replaces the path above with the actual absolute path to `auth.js`
> on your machine when it writes this file to `~/.claude/skills/granola-auth/SKILL.md`.
> Do not use this file directly — run `bash install.sh` instead.

This will:
1. Discover the Granola OAuth endpoints automatically
2. Register a temporary OAuth client via Dynamic Client Registration
3. Open the browser to log in with Google via Granola
4. Capture the OAuth callback on localhost:3334
5. Exchange the authorization code for access + refresh tokens
6. Save all tokens to a `.env` file in the current working directory

After running, display the contents of `.env` (mask token values to show only first + last 6 chars) and confirm the path where it was written.

If the command fails, show the full error output and suggest:
- Checking that port 3334 is not in use (`lsof -i :3334`)
- Ensuring Node.js 18+ is installed (`node --version`)
- Verifying internet connectivity to mcp.granola.ai
