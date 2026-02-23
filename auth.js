#!/usr/bin/env node
/**
 * Granola OAuth Authentication
 * Implements OAuth 2.1 + PKCE + Dynamic Client Registration for Granola MCP
 * No external dependencies — uses Node.js built-ins only
 */

import http, { createServer } from 'http';
import https from 'https';
import { createHash, randomBytes } from 'crypto';
import { exec } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { promisify } from 'util';
import { URL } from 'url';

const execAsync = promisify(exec);

const MCP_URL = 'https://mcp.granola.ai/mcp';
const CALLBACK_PORT = 3334;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function base64url(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateCodeVerifier() {
  return base64url(randomBytes(32));
}

function generateCodeChallenge(verifier) {
  return base64url(createHash('sha256').update(verifier).digest());
}

function generateState() {
  return base64url(randomBytes(16));
}

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
          headers: res.headers,
          body: data,
          json: () => JSON.parse(data),
        });
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

// ─── Step 1: Discover OAuth server ───────────────────────────────────────────

async function discoverOAuthEndpoints() {
  console.log('Discovering OAuth endpoints...');

  // Hit MCP URL to get WWW-Authenticate header (POST required; AWS remaps the header)
  const mcpRes = await fetchJson(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '2' },
    body: '{}',
  });

  if (mcpRes.status !== 401) {
    throw new Error(`Expected 401 from MCP endpoint, got ${mcpRes.status}`);
  }

  // AWS API Gateway remaps WWW-Authenticate → x-amzn-remapped-www-authenticate
  const wwwAuth = mcpRes.headers['www-authenticate']
    || mcpRes.headers['x-amzn-remapped-www-authenticate'];
  if (!wwwAuth) {
    throw new Error('No WWW-Authenticate header in response');
  }

  // Extract resource_metadata URL from header
  const metadataMatch = wwwAuth.match(/resource_metadata="([^"]+)"/);
  if (!metadataMatch) {
    throw new Error(`Could not parse resource_metadata from: ${wwwAuth}`);
  }

  const resourceMetadataUrl = metadataMatch[1];
  console.log(`  Resource metadata URL: ${resourceMetadataUrl}`);

  // Fetch resource metadata
  const metadataRes = await fetchJson(resourceMetadataUrl);
  if (metadataRes.status !== 200) {
    throw new Error(`Failed to fetch resource metadata: ${metadataRes.status}`);
  }

  const metadata = metadataRes.json();
  const authServerUrl = metadata.authorization_servers?.[0];
  if (!authServerUrl) {
    throw new Error('No authorization_servers in resource metadata');
  }

  console.log(`  Auth server: ${authServerUrl}`);

  // Fetch authorization server metadata
  const authServerMetaUrl = `${authServerUrl}/.well-known/oauth-authorization-server`;
  const authServerRes = await fetchJson(authServerMetaUrl);
  if (authServerRes.status !== 200) {
    throw new Error(`Failed to fetch auth server metadata: ${authServerRes.status}`);
  }

  const authServerMeta = authServerRes.json();

  const endpoints = {
    authorization_endpoint: authServerMeta.authorization_endpoint,
    token_endpoint: authServerMeta.token_endpoint,
    registration_endpoint: authServerMeta.registration_endpoint,
  };

  console.log('  Endpoints discovered:');
  console.log(`    authorization: ${endpoints.authorization_endpoint}`);
  console.log(`    token:         ${endpoints.token_endpoint}`);
  console.log(`    registration:  ${endpoints.registration_endpoint}`);

  return endpoints;
}

// ─── Step 2: Dynamic Client Registration ─────────────────────────────────────

async function registerClient(registrationEndpoint) {
  console.log('\nRegistering OAuth client...');

  const body = JSON.stringify({
    client_name: 'granola-skill',
    redirect_uris: [REDIRECT_URI],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });

  const res = await fetchJson(registrationEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });

  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Client registration failed: ${res.status} ${res.body}`);
  }

  const client = res.json();
  console.log(`  Client registered: ${client.client_id}`);
  return client.client_id;
}

// ─── Step 3: Local callback server ───────────────────────────────────────────

function startCallbackServer() {
  return new Promise((resolveServer, rejectServer) => {
    let callbackResolve;
    const callbackPromise = new Promise((resolve) => {
      callbackResolve = resolve;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        const safeError = error.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>Authentication failed</h2><p>${safeError}</p><script>window.close()</script></body></html>`);
        callbackResolve({ error });
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f4f8">
            <div style="text-align:center;padding:2rem;background:white;border-radius:12px;box-shadow:0 2px 20px rgba(0,0,0,0.1)">
              <h2 style="color:#22c55e;margin-top:0">Authentication successful!</h2>
              <p style="color:#64748b">You can close this tab and return to your terminal.</p>
            </div>
            <script>setTimeout(() => window.close(), 2000)</script>
          </body>
        </html>
      `);

      callbackResolve({ code, state });
      res.on('finish', () => server.close());
    });

    server.listen(CALLBACK_PORT, () => {
      console.log(`\nCallback server listening on http://localhost:${CALLBACK_PORT}`);
      resolveServer({ callbackPromise });
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        rejectServer(new Error(`Port ${CALLBACK_PORT} is already in use. Please free the port and try again.`));
      } else {
        rejectServer(err);
      }
    });
  });
}

// ─── Step 4: Build auth URL and open browser ─────────────────────────────────

function buildAuthUrl(authorizationEndpoint, clientId, codeChallenge, state) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

async function openBrowser(url) {
  console.log('\nOpening browser for authentication...');
  console.log(`If the browser does not open automatically, visit:\n${url}\n`);

  const platform = process.platform;
  let command;
  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  try {
    await execAsync(command);
  } catch {
    // Non-fatal — user can open URL manually
  }
}

// ─── Step 5: Exchange code for tokens ────────────────────────────────────────

async function exchangeCode(tokenEndpoint, code, clientId, codeVerifier) {
  console.log('\nExchanging authorization code for tokens...');

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  const body = params.toString();
  const res = await fetchJson(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });

  if (res.status !== 200) {
    throw new Error(`Token exchange failed: ${res.status} ${res.body}`);
  }

  const tokens = res.json();
  if (!tokens.access_token) {
    throw new Error(`No access_token in response: ${res.body}`);
  }

  return tokens;
}

// ─── Step 6: Save to .env ────────────────────────────────────────────────────

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

  // Read existing .env if present, preserve non-Granola vars
  let existing = {};
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      const val = trimmed.slice(eqIdx + 1);
      if (!key.startsWith('GRANOLA_')) {
        existing[key] = val;
      }
    }
  }

  const merged = { ...existing, ...newVars };
  const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');

  const expiresDate = new Date(expiresAt * 1000).toLocaleString();
  console.log(`\nTokens saved to ${envPath}`);
  console.log(`  Access token expires: ${expiresDate}`);
  console.log(`  Client ID: ${clientId}`);
  console.log('\nDone! Use GRANOLA_ACCESS_TOKEN as your Bearer token in MCP config.');
}

// ─── Step 7: Configure MCP ───────────────────────────────────────────────────

async function promptUser(question) {
  const { createInterface } = await import('readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeJsonFile(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function configureClaudeCode(accessToken) {
  // Remove existing entry first (ignore errors if it doesn't exist)
  await execAsync('claude mcp remove granola 2>/dev/null || true');
  await execAsync(
    `claude mcp add --transport http granola https://mcp.granola.ai/mcp --header "Authorization: Bearer ${accessToken}"`
  );
  console.log('  Claude Code configured: ~/.claude.json (restart Claude Code to apply)');
}

function configureCursor(home, accessToken) {
  const configPath = `${home}/.cursor/mcp.json`;
  const config = readJsonFile(configPath);
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.granola = {
    url: 'https://mcp.granola.ai/mcp',
    headers: { Authorization: `Bearer ${accessToken}` },
  };
  writeJsonFile(configPath, config);
  console.log(`  Cursor configured:      ${configPath}`);
}

async function setupMcp(accessToken) {
  const home = process.env.HOME || process.env.USERPROFILE;

  console.log('\n─── MCP Configuration ───────────────────────────────────────────────────────');
  console.log('Configure Granola MCP for:');
  console.log('  1) Claude Code  (~/.claude.json via CLI)');
  console.log('  2) Cursor       (~/.cursor/mcp.json)');
  console.log('  3) Both');
  console.log('  4) Skip');

  const answer = await promptUser('\nYour choice [1-4]: ');

  if (answer === '1' || answer === '3') await configureClaudeCode(accessToken);
  if (answer === '2' || answer === '3') configureCursor(home, accessToken);
  if (answer === '4' || answer === '') console.log('  Skipping MCP configuration.');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Granola OAuth Authentication\n');

  try {
    // Step 1: Discover
    const endpoints = await discoverOAuthEndpoints();

    // Step 2: Register client
    const clientId = await registerClient(endpoints.registration_endpoint);

    // Step 3: Start local server
    const { callbackPromise } = await startCallbackServer();

    // Step 4: PKCE + open browser
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();

    const authUrl = buildAuthUrl(endpoints.authorization_endpoint, clientId, codeChallenge, state);
    await openBrowser(authUrl);

    console.log('Waiting for authentication... (complete login in the browser)');

    // Step 5: Wait for callback (5-minute timeout)
    const authTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Authentication timed out after 5 minutes')), 5 * 60 * 1000)
    );
    const callback = await Promise.race([callbackPromise, authTimeout]);

    if (callback.error) {
      throw new Error(`OAuth error: ${callback.error}`);
    }

    if (callback.state !== state) {
      throw new Error('State mismatch — possible CSRF attack, aborting');
    }

    const tokens = await exchangeCode(endpoints.token_endpoint, callback.code, clientId, codeVerifier);

    // Step 6: Save
    saveToEnv(tokens, clientId, endpoints.token_endpoint);

    // Step 7: Configure MCP
    await setupMcp(tokens.access_token);

  } catch (err) {
    console.error('\nError:', err.message);
    process.exit(1);
  }
}

main();
