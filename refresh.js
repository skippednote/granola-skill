#!/usr/bin/env node
/**
 * Granola Token Refresh
 * Uses the saved refresh token to get a new access token — no browser needed.
 * Runs node auth.js first to get initial tokens.
 */

import https from 'https';
import http from 'http';
import { exec } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { promisify } from 'util';
import { URL } from 'url';

const execAsync = promisify(exec);
const MCP_URL = 'https://mcp.granola.ai/mcp';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchJson(url, options = {}) {
  const client = url.startsWith('https') ? https : http;

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (url.startsWith('https') ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = client.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: data,
          json: () => JSON.parse(data),
        });
      });
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function readEnv() {
  const envPath = process.cwd() + '/.env';
  if (!existsSync(envPath)) return {};
  const vars = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return vars;
}

function saveToEnv(tokens, clientId, tokenEndpoint) {
  const envPath = process.cwd() + '/.env';
  const expiresAt = Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600);

  const newVars = {
    GRANOLA_ACCESS_TOKEN: tokens.access_token,
    GRANOLA_REFRESH_TOKEN: tokens.refresh_token || '',
    GRANOLA_TOKEN_EXPIRES_AT: String(expiresAt),
    GRANOLA_CLIENT_ID: clientId,
    GRANOLA_TOKEN_ENDPOINT: tokenEndpoint,
  };

  let existing = {};
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      if (!key.startsWith('GRANOLA_')) existing[key] = trimmed.slice(eqIdx + 1);
    }
  }

  const lines = Object.entries({ ...existing, ...newVars }).map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');

  const expiresDate = new Date(expiresAt * 1000).toLocaleString();
  console.log(`  Tokens saved to ${envPath}`);
  console.log(`  Access token expires: ${expiresDate}`);
}

async function requestRefresh(tokenEndpoint, refreshToken, clientId) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  }).toString();

  const res = await fetchJson(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });

  if (res.status !== 200) {
    throw new Error(`Token refresh failed: ${res.status} ${res.body}`);
  }

  const tokens = res.json();
  if (!tokens.access_token) {
    throw new Error(`No access_token in response: ${res.body}`);
  }

  return tokens;
}

async function updateMcpConfig(accessToken) {
  const home = process.env.HOME || process.env.USERPROFILE;

  // Update Claude Code
  try {
    await execAsync('claude mcp remove granola 2>/dev/null || true');
    await execAsync(
      `claude mcp add --transport http granola ${MCP_URL} --header "Authorization: Bearer ${accessToken}"`
    );
    console.log('  Claude Code MCP updated');
  } catch {
    // claude CLI not available
  }

  // Update Cursor if it has a granola entry
  const cursorPath = `${home}/.cursor/mcp.json`;
  if (existsSync(cursorPath)) {
    try {
      const config = JSON.parse(readFileSync(cursorPath, 'utf8'));
      if (config.mcpServers?.granola) {
        config.mcpServers.granola.headers = { Authorization: `Bearer ${accessToken}` };
        writeFileSync(cursorPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
        console.log('  Cursor MCP updated');
      }
    } catch {
      // ignore malformed config
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Granola Token Refresh\n');

  const env = readEnv();
  const { GRANOLA_REFRESH_TOKEN, GRANOLA_TOKEN_EXPIRES_AT, GRANOLA_CLIENT_ID, GRANOLA_TOKEN_ENDPOINT } = env;

  if (!GRANOLA_REFRESH_TOKEN) {
    console.error('No refresh token found. Run node auth.js to authenticate.');
    process.exit(1);
  }

  if (!GRANOLA_TOKEN_ENDPOINT || !GRANOLA_CLIENT_ID) {
    console.error('Missing token endpoint or client ID. Run node auth.js to re-authenticate.');
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = parseInt(GRANOLA_TOKEN_EXPIRES_AT || '0', 10);
  const secondsLeft = expiresAt - now;

  if (secondsLeft > 60 && !process.argv.includes('--force')) {
    const expiresDate = new Date(expiresAt * 1000).toLocaleString();
    console.log(`Access token is still valid (expires ${expiresDate}).`);
    console.log('Run with --force to refresh anyway.');
    process.exit(0);
  }

  console.log('Refreshing access token...');

  try {
    const tokens = await requestRefresh(GRANOLA_TOKEN_ENDPOINT, GRANOLA_REFRESH_TOKEN, GRANOLA_CLIENT_ID);
    saveToEnv(tokens, GRANOLA_CLIENT_ID, GRANOLA_TOKEN_ENDPOINT);
    await updateMcpConfig(tokens.access_token);
    console.log('\nDone!');
  } catch (err) {
    console.error('\nRefresh failed:', err.message);
    console.error('Run node auth.js to re-authenticate.');
    process.exit(1);
  }
}

main();
