/**
 * Shared auth module for Spotify scripts.
 * Handles .env loading, multi-profile support, token caching, refresh, and OAuth flow.
 *
 * Profile support:
 *   .env uses SPOTIFY_<profile>_CLIENT_ID, SPOTIFY_<profile>_CLIENT_SECRET, etc.
 *   Set SPOTIFY_PROFILE=<name> in .env for the default, or pass --profile <name> on CLI.
 *   Tokens are stored per-profile in data/.spotify-token-<profile>.json
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL, URLSearchParams } = require('url');

// Load .env from project root (one level up from scripts/)
const envPath = path.resolve(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
envContent.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;
  const [key, ...valueParts] = trimmed.split('=');
  process.env[key.trim()] = valueParts.join('=').trim();
});

// --- Profile resolution ---
function getProfile() {
  const profileIdx = process.argv.indexOf('--profile');
  if (profileIdx !== -1 && process.argv[profileIdx + 1]) {
    return process.argv[profileIdx + 1];
  }
  return process.env.SPOTIFY_PROFILE || 'default';
}

function getProfileCredentials(profile) {
  const clientId = process.env[`SPOTIFY_${profile}_CLIENT_ID`];
  const clientSecret = process.env[`SPOTIFY_${profile}_CLIENT_SECRET`];
  const redirectUri = process.env[`SPOTIFY_${profile}_REDIRECT_URI`] || 'http://127.0.0.1:8080/spotify_api';

  if (!clientId) {
    console.error(`Error: No credentials found for profile "${profile}".`);
    console.error(`  Expected: SPOTIFY_${profile}_CLIENT_ID in ${envPath}`);
    console.error(`  Available profiles:`);
    // List available profiles by scanning env vars
    const profiles = new Set();
    for (const key of Object.keys(process.env)) {
      const match = key.match(/^SPOTIFY_(.+)_CLIENT_ID$/);
      if (match) profiles.add(match[1]);
    }
    for (const p of profiles) console.error(`    - ${p}`);
    process.exit(1);
  }

  return { clientId, clientSecret, redirectUri };
}

const PROFILE = getProfile();
const { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI } = getProfileCredentials(PROFILE);
const TOKEN_FILE = path.resolve(__dirname, '..', 'data', `.spotify-token-${PROFILE}.json`);
const SCOPES = 'playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-library-read user-top-read user-modify-playback-state';

// --- PKCE Helpers ---
function generateRandomString(length) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

function generateCodeVerifier() {
  return generateRandomString(64);
}

function generateCodeChallenge(verifier) {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return hash.toString('base64url');
}

// --- Token Management ---
function saveToken(tokenData) {
  tokenData.obtained_at = Date.now();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
}

function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function isTokenExpired(tokenData) {
  if (!tokenData || !tokenData.obtained_at) return true;
  const elapsed = Date.now() - tokenData.obtained_at;
  return elapsed >= (tokenData.expires_in - 60) * 1000;
}

async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Token refresh failed: ${response.status} - ${err}`);
  }

  const data = await response.json();
  if (!data.refresh_token) {
    data.refresh_token = refreshToken;
  }
  saveToken(data);
  return data.access_token;
}

async function getValidToken() {
  const tokenData = loadToken();

  if (!tokenData) return null;

  if (!isTokenExpired(tokenData)) {
    return tokenData.access_token;
  }

  if (tokenData.refresh_token) {
    console.log('Token expired, refreshing...');
    try {
      return await refreshAccessToken(tokenData.refresh_token);
    } catch (err) {
      console.error('Refresh failed:', err.message);
      return null;
    }
  }

  return null;
}

// --- OAuth Flow ---
function startAuthFlow() {
  return new Promise((resolve, reject) => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateRandomString(16);

    const redirectUrl = new URL(REDIRECT_URI);
    const port = parseInt(redirectUrl.port, 10);
    const callbackPath = redirectUrl.pathname;

    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('scope', SCOPES);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('code_challenge', codeChallenge);

    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);

      if (reqUrl.pathname === callbackPath) {
        const code = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');
        const error = reqUrl.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h1>Authorization Error</h1><p>${error}</p>`);
          server.close();
          reject(new Error(`Auth error: ${error}`));
          return;
        }

        if (returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h1>State Mismatch</h1>');
          server.close();
          reject(new Error('State mismatch'));
          return;
        }

        try {
          const params = new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code_verifier: codeVerifier,
          });

          const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
          });

          if (!tokenResponse.ok) {
            const err = await tokenResponse.text();
            throw new Error(`Token exchange failed: ${tokenResponse.status} - ${err}`);
          }

          const tokenData = await tokenResponse.json();
          saveToken(tokenData);

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>Success!</h1><p>You can close this tab and return to the terminal.</p>');
          server.close();
          resolve(tokenData.access_token);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<h1>Error</h1><p>${err.message}</p>`);
          server.close();
          reject(err);
        }
      }
    });

    server.listen(port, '127.0.0.1', () => {
      console.log('\n========================================');
      console.log(`Profile: ${PROFILE}`);
      console.log('Open this URL in your browser to log in:');
      console.log('========================================\n');
      console.log(authUrl.toString());
      console.log('\nWaiting for callback...\n');
    });
  });
}

/**
 * Get an access token — uses cache, refreshes if needed, or starts auth flow.
 */
async function authenticate() {
  console.log(`Checking for existing token (profile: ${PROFILE})...`);
  let accessToken = await getValidToken();

  if (!accessToken) {
    console.log('No valid token found. Starting login flow...');
    accessToken = await startAuthFlow();
  } else {
    console.log('Using cached token.');
  }

  return accessToken;
}

module.exports = { authenticate, getProfile, PROFILE };
