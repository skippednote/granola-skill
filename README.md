# granola-skill

A [Claude Code](https://claude.ai/code) skill that authenticates with [Granola](https://granola.ai) and saves OAuth tokens to a `.env` file — ready to use with Granola's MCP server.

## What it is

`granola-skill` implements the full OAuth 2.1 + PKCE + Dynamic Client Registration flow for Granola's MCP API. It runs entirely locally, requires no pre-registered app credentials, and stores the resulting tokens in a `.env` file in your project directory. Once authenticated, you can point Claude Desktop or Claude Code at Granola's MCP server using the saved access token.

## Prerequisites

- **Node.js 22+** (`node --version` to check)
- **Claude Code** (the CLI)
- A **Granola account** (sign in with Google)

## Installation

```bash
npx skills add skippednote/granola-skill
```

This will:
1. Verify Node.js 22+ is available
2. Copy `auth.js` and `refresh.js` to `~/.claude/skills/granola-auth/`
3. Write a `SKILL.md` referencing those stable paths

After installation, **restart Claude Code** to pick up the new skill.

> **Alternatively**, if you prefer to clone the repo manually:
> ```bash
> git clone https://github.com/skippednote/granola-skill.git
> cd granola-skill
> bash install.sh
> ```

## Usage

### Via Claude Code skill (recommended)

Inside any Claude Code session, run:

```
/granola-auth
```

Claude will first try to silently refresh your existing token using `refresh.js`. If that succeeds, no browser is opened. If the token is missing or expired beyond refresh, it falls back to the full browser OAuth flow via `auth.js`.

### Standalone

```bash
# Try silent refresh first
node refresh.js

# Full OAuth flow (opens browser)
node auth.js
```

Tokens are written to `.env` in whichever directory you run the command from.

## What gets saved

After a successful run, your `.env` will contain:

| Variable | Description |
|---|---|
| `GRANOLA_ACCESS_TOKEN` | Bearer token for MCP API requests |
| `GRANOLA_REFRESH_TOKEN` | Refresh token (may be empty if not issued) |
| `GRANOLA_TOKEN_EXPIRES_AT` | Unix timestamp when the access token expires |
| `GRANOLA_CLIENT_ID` | The dynamically registered OAuth client ID |
| `GRANOLA_TOKEN_ENDPOINT` | Token endpoint URL (for refreshing) |

## Using with MCP

The auth flow will prompt you to configure MCP automatically at the end. Choose from:

- **Claude Code** — configured via `claude mcp add --transport http` (global config)
- **Cursor** — configured in `~/.cursor/mcp.json`
- **Both** or **Skip**

### Manual configuration

If you prefer to configure manually, use the `GRANOLA_ACCESS_TOKEN` from `.env`:

#### Claude Code

```bash
claude mcp add --transport http granola https://mcp.granola.ai/mcp \
  --header "Authorization: Bearer YOUR_GRANOLA_ACCESS_TOKEN"
```

#### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "granola": {
      "url": "https://mcp.granola.ai/mcp",
      "headers": { "Authorization": "Bearer YOUR_GRANOLA_ACCESS_TOKEN" }
    }
  }
}
```

Replace `YOUR_GRANOLA_ACCESS_TOKEN` with the value of `GRANOLA_ACCESS_TOKEN` from `.env`.

## Token refresh

Access tokens expire in approximately **1 hour**. The `/granola-auth` skill handles this automatically — it tries a silent refresh first and only opens the browser if the refresh token is also missing or invalid.

To refresh manually:

```bash
node refresh.js
# or, in Claude Code:
/granola-auth
```

The script preserves any non-`GRANOLA_*` variables already in your `.env`.

## How it works

1. **Discovery** — POSTs to `https://mcp.granola.ai/mcp`, which returns a `401` with a `WWW-Authenticate` header pointing to a resource metadata URL. That metadata contains the authorization server URL.

2. **Dynamic Client Registration (DCR)** — Registers a new OAuth client on the fly with the authorization server. No pre-registered app credentials needed.

3. **PKCE flow** — Generates a cryptographic `code_verifier` + `code_challenge` (SHA-256), builds an authorization URL, and opens it in your browser.

4. **Local callback server** — Spins up a temporary HTTP server on `localhost:3334` to capture the OAuth redirect with the authorization `code`.

5. **Token exchange** — POSTs the code + verifier to the token endpoint to obtain `access_token` (and optionally `refresh_token`).

6. **Saves to `.env`** — Writes all token variables to `.env` in the current working directory, preserving any existing non-Granola variables.

7. **MCP configuration** — Prompts to configure Claude Code (`claude mcp add`) and/or Cursor (`~/.cursor/mcp.json`) with the new access token.

## License

MIT
