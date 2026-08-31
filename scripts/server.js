/**
 * Local web UI server for Spotify playlist tools.
 *
 * Usage:
 *   node scripts/server.js
 *   npm run ui
 *
 * Opens http://localhost:3000 with a playlist management dashboard.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { authenticate, PROFILE } = require('./auth');

const app = express();
const PORT = 3000;

const CACHE_FILE = path.resolve(__dirname, '..', 'data', `spotify-cache-${PROFILE}.json`);
const TOKEN_FILE = path.resolve(__dirname, '..', 'data', `.spotify-token-${PROFILE}.json`);
const DELETE_LOG = path.resolve(__dirname, '..', 'data', 'delete-log.json');
const SCAN_EXCLUSIONS_FILE = path.resolve(__dirname, '..', 'data', `scan-exclusions-${PROFILE}.json`);

// Load env
const envPath = path.resolve(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
envContent.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;
  const [key, ...valueParts] = trimmed.split('=');
  process.env[key.trim()] = valueParts.join('=').trim();
});

const CLIENT_ID = process.env[`SPOTIFY_${PROFILE}_CLIENT_ID`];
const CLIENT_SECRET = process.env[`SPOTIFY_${PROFILE}_CLIENT_SECRET`];
const REGISTERED_REDIRECT_URI = process.env[`SPOTIFY_${PROFILE}_REDIRECT_URI`] || 'http://127.0.0.1:8080/spotify_api';
const UI_REDIRECT_URI = `http://127.0.0.1:${PORT}/api/oauth-callback`;
const SCOPES = 'playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-library-read user-top-read user-modify-playback-state';

app.use(express.json());

// --- Page routes (multi-page UI) ---
const UI_DIR = path.resolve(__dirname, 'ui');
app.get('/', (req, res) => res.sendFile(path.join(UI_DIR, 'playlists.html')));
app.get('/playlist/:id', (req, res) => res.sendFile(path.join(UI_DIR, 'playlist.html')));
app.get('/artist/:name', (req, res) => res.sendFile(path.join(UI_DIR, 'artist.html')));
app.get('/discography/:name', (req, res) => res.sendFile(path.join(UI_DIR, 'discography.html')));
app.get('/album/:id', (req, res) => res.sendFile(path.join(UI_DIR, 'album.html')));
app.get('/artists', (req, res) => res.sendFile(path.join(UI_DIR, 'artists.html')));
app.get('/genres', (req, res) => res.sendFile(path.join(UI_DIR, 'genres.html')));
app.get('/genre/:name', (req, res) => res.sendFile(path.join(UI_DIR, 'genre.html')));
app.get('/billboard', (req, res) => res.sendFile(path.join(UI_DIR, 'billboard.html')));
app.get('/duplicates', (req, res) => res.sendFile(path.join(UI_DIR, 'duplicates.html')));
app.get('/search', (req, res) => res.sendFile(path.join(UI_DIR, 'search.html')));

// Static files (CSS, JS)
app.use(express.static(UI_DIR));

// --- OAuth for web UI ---
let pendingAuthState = null;
let pendingCodeVerifier = null;

app.get('/api/login', (req, res) => {
  const codeVerifier = crypto.randomBytes(32).toString('hex').slice(0, 64);
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex').slice(0, 16);

  pendingAuthState = state;
  pendingCodeVerifier = codeVerifier;

  // Use the registered redirect URI
  const redirectUri = REGISTERED_REDIRECT_URI;
  const redirectUrl = new URL(redirectUri);
  const callbackPort = parseInt(redirectUrl.port, 10);
  const callbackPath = redirectUrl.pathname;

  // Start a temporary server on the callback port to catch the OAuth response
  const http = require('http');
  const callbackServer = http.createServer(async (cbReq, cbRes) => {
    const url = new URL(cbReq.url, `http://127.0.0.1:${callbackPort}`);
    if (url.pathname !== callbackPath) return;

    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error || returnedState !== pendingAuthState) {
      cbRes.writeHead(400, { 'Content-Type': 'text/html' });
      cbRes.end(`<h1>Auth Error</h1><p>${error || 'State mismatch'}</p>`);
      callbackServer.close();
      return;
    }

    try {
      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code_verifier: pendingCodeVerifier,
      });

      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        cbRes.writeHead(500, { 'Content-Type': 'text/html' });
        cbRes.end(`<h1>Token Error</h1><p>${err}</p>`);
        callbackServer.close();
        return;
      }

      const tokenData = await tokenRes.json();
      tokenData.obtained_at = Date.now();
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));

      cbRes.writeHead(200, { 'Content-Type': 'text/html' });
      cbRes.end('<h1>Authenticated!</h1><p>You can close this tab and return to the dashboard.</p><script>setTimeout(()=>window.close(),2000)</script>');
    } catch (err) {
      cbRes.writeHead(500, { 'Content-Type': 'text/html' });
      cbRes.end(`<h1>Error</h1><p>${err.message}</p>`);
    }

    callbackServer.close();
  });

  callbackServer.listen(callbackPort, '127.0.0.1', () => {
    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', SCOPES);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('code_challenge', codeChallenge);

    res.json({ url: authUrl.toString() });
  });

  // Auto-close callback server after 2 minutes if unused
  setTimeout(() => { try { callbackServer.close(); } catch {} }, 120000);
});

app.get('/api/oauth-callback', async (req, res) => {
  // Fallback if the redirect URI points to port 3000
  const { code, state, error } = req.query;

  if (error) return res.status(400).send(`<h1>Auth Error</h1><p>${error}</p><script>setTimeout(()=>window.close(),3000)</script>`);
  if (state !== pendingAuthState) return res.status(400).send('<h1>State mismatch</h1>');

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: UI_REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code_verifier: pendingCodeVerifier,
    });

    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return res.status(500).send(`<h1>Token Error</h1><p>${err}</p>`);
    }

    const tokenData = await tokenRes.json();
    tokenData.obtained_at = Date.now();
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));

    res.send('<h1>Authenticated!</h1><p>You can close this tab and return to the dashboard.</p><script>setTimeout(()=>window.close(),2000)</script>');
  } catch (err) {
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// --- Auth status ---
app.get('/api/auth-status', (req, res) => {
  if (!fs.existsSync(TOKEN_FILE)) {
    return res.json({ authenticated: false, message: 'No token file. Login required.' });
  }
  try {
    const token = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
    const elapsed = Date.now() - (token.obtained_at || 0);
    const expired = elapsed >= (token.expires_in - 60) * 1000;
    if (expired && !token.refresh_token) {
      return res.json({ authenticated: false, message: 'Token expired. Login required.' });
    }
    // Has refresh token or not expired — good to go
    res.json({ authenticated: true });
  } catch {
    res.json({ authenticated: false, message: 'Token file corrupted. Login required.' });
  }
});

// --- Helpers ---
function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function logDelete(entry) {
  let log = [];
  if (fs.existsSync(DELETE_LOG)) {
    try { log = JSON.parse(fs.readFileSync(DELETE_LOG, 'utf-8')); } catch {}
  }
  log.push({ ...entry, deletedAt: new Date().toISOString() });
  fs.writeFileSync(DELETE_LOG, JSON.stringify(log, null, 2));
}

function loadExclusions() {
  if (!fs.existsSync(SCAN_EXCLUSIONS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SCAN_EXCLUSIONS_FILE, 'utf-8')); } catch { return []; }
}

function saveExclusions(ids) {
  fs.writeFileSync(SCAN_EXCLUSIONS_FILE, JSON.stringify(ids, null, 2));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function spotifyFetch(url, accessToken, options = {}) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    ...options,
  });

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
    await sleep(retryAfter * 1000);
    return spotifyFetch(url, accessToken, options);
  }

  return response;
}

async function getPlaylistTracks(playlistId, accessToken) {
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&fields=items(added_at,track(id,name,uri,explicit,popularity,duration_ms,artists(name),album(name,release_date))),next`;

  while (url) {
    const res = await spotifyFetch(url, accessToken);
    if (!res.ok) throw new Error(`Failed to get tracks: ${res.status}`);
    const data = await res.json();
    for (const item of data.items) {
      if (item.track && item.track.id) {
        tracks.push({
          id: item.track.id,
          name: item.track.name,
          uri: item.track.uri,
          artists: item.track.artists || [],
          album: item.track.album || {},
          duration_ms: item.track.duration_ms || 0,
          explicit: item.track.explicit || false,
          popularity: item.track.popularity || 0,
          added_at: item.added_at,
        });
      }
    }
    url = data.next;
    if (url) await sleep(100);
  }

  return tracks;
}

async function reorderPlaylist(playlistId, uris, accessToken) {
  const firstBatch = uris.slice(0, 100);
  const res = await spotifyFetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, accessToken, {
    method: 'PUT',
    body: JSON.stringify({ uris: firstBatch }),
  });
  if (!res.ok) throw new Error(`Reorder failed: ${res.status}`);

  for (let i = 100; i < uris.length; i += 100) {
    const batch = uris.slice(i, i + 100);
    const addRes = await spotifyFetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, accessToken, {
      method: 'POST',
      body: JSON.stringify({ uris: batch }),
    });
    if (!addRes.ok) throw new Error(`Reorder append failed: ${addRes.status}`);
    await sleep(150);
  }
}

function shuffleArray(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Refetch a single playlist from Spotify and upsert it in the local cache.
 * Call after any playlist modification to keep cache in sync.
 */
async function refreshPlaylistCache(playlistId, accessToken) {
  const cache = loadCache();
  if (!cache) return;

  // Fetch playlist metadata
  const metaRes = await spotifyFetch(`https://api.spotify.com/v1/playlists/${playlistId}?fields=id,name,owner(id),public`, accessToken);
  if (!metaRes.ok) return; // silently fail if playlist was deleted
  const meta = await metaRes.json();

  // Fetch tracks
  const tracks = await getPlaylistTracks(playlistId, accessToken);

  // Upsert in cache
  const idx = cache.user_playlists.findIndex(p => p.id === playlistId);
  const entry = {
    id: meta.id,
    name: meta.name,
    owner: meta.owner?.id || '',
    public: meta.public,
    tracks,
  };

  if (idx >= 0) {
    cache.user_playlists[idx] = entry;
  } else {
    cache.user_playlists.unshift(entry);
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// --- API Routes ---

// Get all playlists from cache
app.get('/api/playlists', (req, res) => {
  const cache = loadCache();
  if (!cache) return res.status(404).json({ error: 'No cache found. Run npm run cache first.' });

  // Determine the current user's owner identifiers (could be user ID or display name)
  const ownerCounts = new Map();
  for (const p of cache.user_playlists) {
    if (p.owner) ownerCounts.set(p.owner, (ownerCounts.get(p.owner) || 0) + 1);
  }
  // The owner with the most playlists is the current user; also include "You" (Liked Songs)
  const currentUserOwners = new Set(['You']);
  if (ownerCounts.size > 0) {
    const topOwner = [...ownerCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    currentUserOwners.add(topOwner);
    // Also add second-most if close (handles mixed ID/display name from different cache sources)
    const sorted = [...ownerCounts.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length > 1 && sorted[1][1] > sorted.length * 0.2) {
      currentUserOwners.add(sorted[1][0]);
    }
  }

  const playlists = cache.user_playlists.map((p, i) => {
    // Compute last modified (most recent added_at)
    let lastModified = null;
    let totalDurationMs = 0;
    for (const track of p.tracks) {
      if (track.added_at && (!lastModified || track.added_at > lastModified)) {
        lastModified = track.added_at;
      }
      totalDurationMs += track.duration_ms || 0;
    }

    return {
      id: p.id,
      name: p.name,
      tracks: p.tracks.length,
      owner: p.owner,
      isOwned: currentUserOwners.has(p.owner),
      public: p.public,
      lastModified,
      durationMs: totalDurationMs,
      index: i,
    };
  });

  res.json({ playlists, cached_at: cache.cached_at, profile: PROFILE, scanExclusions: loadExclusions() });
});

// Get/set scan exclusions
app.get('/api/scan-exclusions', (req, res) => {
  res.json({ exclusions: loadExclusions() });
});

app.put('/api/scan-exclusions/:id', (req, res) => {
  const exclusions = loadExclusions();
  if (!exclusions.includes(req.params.id)) {
    exclusions.push(req.params.id);
    saveExclusions(exclusions);
  }
  res.json({ success: true, excluded: true });
});

app.delete('/api/scan-exclusions/:id', (req, res) => {
  let exclusions = loadExclusions();
  exclusions = exclusions.filter(id => id !== req.params.id);
  saveExclusions(exclusions);
  res.json({ success: true, excluded: false });
});

// Update cache (smart sync)
app.post('/api/cache', async (req, res) => {
  try {
    const scriptPath = path.resolve(__dirname, 'cache-data.js');
    execSync(`node "${scriptPath}"`, {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'pipe',
      timeout: 300000,
    });
    res.json({ success: true, message: 'Cache updated.' });
  } catch (err) {
    res.status(500).json({ error: 'Cache update failed', details: err.stderr?.toString() || err.message });
  }
});

// Search tracks
app.get('/api/search', (req, res) => {
  const query = (req.query.q || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!query) return res.json({ results: [] });

  const cache = loadCache();
  if (!cache) return res.status(404).json({ error: 'No cache' });

  const results = new Map();
  for (const pl of cache.user_playlists) {
    for (const track of pl.tracks) {
      const name = track.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const artists = track.artists
        ? track.artists.map(a => a.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')).join(' ')
        : (track.artist || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (name.includes(query) || artists.includes(query)) {
        if (!results.has(track.id)) {
          results.set(track.id, {
            id: track.id,
            name: track.name,
            uri: track.uri,
            artist: track.artists ? track.artists.map(a => a.name).join(', ') : (track.artist || ''),
            popularity: track.popularity || 0,
            playlists: [],
          });
        }
        results.get(track.id).playlists.push(pl.name);
      }
    }
  }

  const sorted = [...results.values()]
    .map(r => ({ ...r, playlists: [...new Set(r.playlists)] }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 100);

  res.json({ results: sorted, total: results.size });
});

// Shuffle a playlist
app.post('/api/shuffle/:id', async (req, res) => {
  try {
    const accessToken = await authenticate();
    const playlistId = req.params.id;

    const tracks = await getPlaylistTracks(playlistId, accessToken);
    const shuffled = shuffleArray(tracks);
    const uris = shuffled.map(t => t.uri);

    await reorderPlaylist(playlistId, uris, accessToken);
    await refreshPlaylistCache(playlistId, accessToken);
    res.json({ success: true, message: `Shuffled ${tracks.length} tracks.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sort a playlist
app.post('/api/sort/:id', async (req, res) => {
  try {
    const accessToken = await authenticate();
    const playlistId = req.params.id;
    const sortBy = req.body.sortBy || 'title';

    const tracks = await getPlaylistTracks(playlistId, accessToken);
    const sorted = [...tracks];

    switch (sortBy) {
      case 'title':
        sorted.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
        break;
      case 'artist':
        sorted.sort((a, b) => {
          const aArtist = (a.artists?.[0]?.name || '').toLowerCase();
          const bArtist = (b.artists?.[0]?.name || '').toLowerCase();
          const cmp = aArtist.localeCompare(bArtist);
          return cmp !== 0 ? cmp : a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });
        break;
      case 'date-added':
        sorted.sort((a, b) => new Date(b.added_at) - new Date(a.added_at));
        break;
      case 'date-added-asc':
        sorted.sort((a, b) => new Date(a.added_at) - new Date(b.added_at));
        break;
      case 'release-date':
        sorted.sort((a, b) => (a.album?.release_date || '').localeCompare(b.album?.release_date || ''));
        break;
      case 'release-date-desc':
        sorted.sort((a, b) => (b.album?.release_date || '').localeCompare(a.album?.release_date || ''));
        break;
      case 'popularity':
        sorted.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
        break;
      case 'popularity-asc':
        sorted.sort((a, b) => (a.popularity || 0) - (b.popularity || 0));
        break;
      default:
        return res.status(400).json({ error: `Unknown sort: ${sortBy}` });
    }

    const uris = sorted.map(t => t.uri);
    await reorderPlaylist(playlistId, uris, accessToken);
    await refreshPlaylistCache(playlistId, accessToken);
    res.json({ success: true, message: `Sorted ${tracks.length} tracks by ${sortBy}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a playlist
app.delete('/api/playlist/:id', async (req, res) => {
  try {
    const accessToken = await authenticate();
    const playlistId = req.params.id;

    // Grab playlist info from cache before deleting
    const cache = loadCache();
    const playlist = cache?.user_playlists?.find(p => p.id === playlistId);

    const delRes = await spotifyFetch(`https://api.spotify.com/v1/playlists/${playlistId}/followers`, accessToken, {
      method: 'DELETE',
    });

    if (!delRes.ok) {
      const err = await delRes.text();
      throw new Error(`Delete failed: ${delRes.status} - ${err}`);
    }

    // Log the deletion
    logDelete({
      type: 'playlist',
      playlist: playlist?.name || playlistId,
      trackCount: playlist?.tracks?.length || 0,
      tracks: (playlist?.tracks || []).map(t => t.name),
    });

    // Remove from cache
    if (cache) {
      cache.user_playlists = cache.user_playlists.filter(p => p.id !== playlistId);
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    }

    res.json({ success: true, message: 'Playlist deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Combine playlists into a shuffled random playlist
app.post('/api/combine', async (req, res) => {
  try {
    const { playlistIds, name } = req.body;
    if (!playlistIds || playlistIds.length === 0) {
      return res.status(400).json({ error: 'No playlists selected.' });
    }

    const cache = loadCache();
    if (!cache) return res.status(404).json({ error: 'No cache' });

    const accessToken = await authenticate();

    // Collect all tracks, deduplicate
    const seen = new Set();
    const allTracks = [];
    const selectedNames = [];

    for (const id of playlistIds) {
      const pl = cache.user_playlists.find(p => p.id === id);
      if (!pl) continue;
      selectedNames.push(pl.name);
      for (const track of pl.tracks) {
        if (!seen.has(track.id)) {
          seen.add(track.id);
          allTracks.push(track);
        }
      }
    }

    // Shuffle
    const shuffled = shuffleArray(allTracks);
    const uris = shuffled.map(t => t.uri);

    // Determine playlist name
    const playlistName = (name || `${selectedNames.join(' + ')} - Random`).slice(0, 100);
    const description = `Shuffled: ${selectedNames.join(', ')}. Generated ${new Date().toISOString().split('T')[0]}.`.slice(0, 300);

    // Get user ID
    const meRes = await spotifyFetch('https://api.spotify.com/v1/me', accessToken);
    const me = await meRes.json();
    const userId = me.id;

    // Check if playlist exists
    let targetPlaylist;
    let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
    while (url) {
      const plRes = await spotifyFetch(url, accessToken);
      const plData = await plRes.json();
      const match = plData.items.find(p => p.name === playlistName && p.owner.id === userId);
      if (match) { targetPlaylist = match; break; }
      url = plData.next;
      if (url) await sleep(100);
    }

    if (targetPlaylist) {
      // Update description
      await spotifyFetch(`https://api.spotify.com/v1/playlists/${targetPlaylist.id}`, accessToken, {
        method: 'PUT',
        body: JSON.stringify({ description }),
      });
    } else {
      // Create new
      const createRes = await spotifyFetch(`https://api.spotify.com/v1/users/${userId}/playlists`, accessToken, {
        method: 'POST',
        body: JSON.stringify({ name: playlistName, public: false, description }),
      });
      targetPlaylist = await createRes.json();
    }

    // Add tracks
    await reorderPlaylist(targetPlaylist.id, uris, accessToken);
    await refreshPlaylistCache(targetPlaylist.id, accessToken);

    res.json({
      success: true,
      message: `"${playlistName}" — ${uris.length} tracks (shuffled).`,
      playlistName,
      trackCount: uris.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get tracks for a specific playlist
app.get('/api/playlist/:id/tracks', (req, res) => {
  const cache = loadCache();
  if (!cache) return res.status(404).json({ error: 'No cache' });

  const pl = cache.user_playlists.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });

  // Build cross-reference map if requested
  let xrefMap = null;
  if (req.query.xref === '1') {
    xrefMap = new Map();
    for (const other of cache.user_playlists) {
      if (other.id === req.params.id) continue;
      for (const t of other.tracks) {
        if (!xrefMap.has(t.id)) xrefMap.set(t.id, []);
        if (!xrefMap.get(t.id).includes(other.name)) xrefMap.get(t.id).push(other.name);
      }
    }
  }

  // Build genre map if requested
  let genreMap = null;
  if (req.query.genres === '1') {
    genreMap = new Map(); // artistName (lowercase) -> genres[]
    const GENRE_CACHE_FILE = path.resolve(__dirname, '..', 'cli', 'data', 'artist-genres-cache.json');
    if (fs.existsSync(GENRE_CACHE_FILE)) {
      try {
        const genreCache = JSON.parse(fs.readFileSync(GENRE_CACHE_FILE, 'utf-8'));
        for (const entry of Object.values(genreCache)) {
          if (entry.name && entry.genres && entry.genres.length > 0) {
            genreMap.set(entry.name.toLowerCase(), entry.genres);
          }
        }
      } catch {}
    }
  }

  const tracks = pl.tracks.map(t => {
    const track = {
      id: t.id,
      name: t.name,
      uri: t.uri,
      artist: t.artists ? t.artists.map(a => a.name).join(', ') : (t.artist || ''),
      album: t.album?.name || '',
      release_date: t.album?.release_date || '',
      duration_ms: t.duration_ms,
      explicit: t.explicit,
      popularity: t.popularity,
      added_at: t.added_at,
    };
    if (xrefMap) {
      track.alsoIn = xrefMap.get(t.id) || [];
    }
    if (genreMap) {
      const artists = t.artists ? t.artists.map(a => a.name) : [t.artist || ''];
      const allGenres = new Set();
      for (const name of artists) {
        const g = genreMap.get(name.toLowerCase());
        if (g) g.forEach(genre => allGenres.add(genre));
      }
      track.genres = [...allGenres];
    }
    return track;
  });

  res.json({ name: pl.name, id: pl.id, tracks });
});

// Remove tracks from a playlist
app.post('/api/playlist/:id/remove-tracks', async (req, res) => {
  try {
    const accessToken = await authenticate();
    const { uris, trackNames, playlistName } = req.body;
    if (!uris || uris.length === 0) return res.status(400).json({ error: 'No tracks provided.' });

    // Spotify accepts max 100 tracks per request
    for (let i = 0; i < uris.length; i += 100) {
      const batch = uris.slice(i, i + 100);
      const removeRes = await spotifyFetch(`https://api.spotify.com/v1/playlists/${req.params.id}/tracks`, accessToken, {
        method: 'DELETE',
        body: JSON.stringify({ tracks: batch.map(uri => ({ uri })) }),
      });
      if (!removeRes.ok) {
        const err = await removeRes.text();
        throw new Error(`Remove failed: ${removeRes.status} - ${err}`);
      }
      if (i + 100 < uris.length) await sleep(150);
    }

    // Log the removal
    logDelete({
      type: 'track-removal',
      playlist: playlistName || req.params.id,
      tracks: trackNames || uris,
    });

    await refreshPlaylistCache(req.params.id, accessToken);
    res.json({ success: true, message: `Removed ${uris.length} track(s).` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add tracks to an existing playlist (append, no replace)
app.post('/api/playlist/:id/add-tracks', async (req, res) => {
  try {
    const accessToken = await authenticate();
    const { uris, skipDuplicates, checkOnly } = req.body;
    if (!uris || uris.length === 0) return res.status(400).json({ error: 'No tracks provided.' });

    // Check for duplicates against current playlist tracks
    const cache = loadCache();
    const pl = cache?.user_playlists?.find(p => p.id === req.params.id);
    const existingUris = new Set();
    if (pl) {
      for (const t of pl.tracks) {
        existingUris.add(t.uri);
      }
    }

    const duplicateUris = uris.filter(uri => existingUris.has(uri));
    const newUris = uris.filter(uri => !existingUris.has(uri));

    // If checkOnly, just return the duplicate info without adding
    if (checkOnly) {
      return res.json({ duplicates: duplicateUris.length, total: uris.length, newCount: newUris.length });
    }

    const toAdd = skipDuplicates ? newUris : uris;

    if (toAdd.length === 0) {
      return res.json({ success: true, message: 'All tracks already in playlist. Nothing added.', added: 0, skipped: duplicateUris.length });
    }

    for (let i = 0; i < toAdd.length; i += 100) {
      const batch = toAdd.slice(i, i + 100);
      const addRes = await spotifyFetch(`https://api.spotify.com/v1/playlists/${req.params.id}/tracks`, accessToken, {
        method: 'POST',
        body: JSON.stringify({ uris: batch }),
      });
      if (!addRes.ok) {
        const err = await addRes.text();
        throw new Error(`Add tracks failed: ${addRes.status} - ${err}`);
      }
      if (i + 100 < toAdd.length) await sleep(150);
    }

    await refreshPlaylistCache(req.params.id, accessToken);
    const skippedMsg = (skipDuplicates && duplicateUris.length > 0) ? ` (${duplicateUris.length} duplicate(s) skipped)` : '';
    res.json({ success: true, message: `Added ${toAdd.length} track(s).${skippedMsg}`, added: toAdd.length, skipped: duplicateUris.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new playlist
app.post('/api/playlist', async (req, res) => {
  try {
    const accessToken = await authenticate();
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required.' });

    const meRes = await spotifyFetch('https://api.spotify.com/v1/me', accessToken);
    const me = await meRes.json();

    const createRes = await spotifyFetch(`https://api.spotify.com/v1/users/${me.id}/playlists`, accessToken, {
      method: 'POST',
      body: JSON.stringify({ name, public: false }),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Create failed: ${createRes.status} - ${err}`);
    }

    const newPlaylist = await createRes.json();

    await refreshPlaylistCache(newPlaylist.id, accessToken);
    res.json({ success: true, message: `Created "${name}".`, playlist: { id: newPlaylist.id, name: newPlaylist.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename a playlist
app.put('/api/playlist/:id/rename', async (req, res) => {
  try {
    const accessToken = await authenticate();
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required.' });

    const renameRes = await spotifyFetch(`https://api.spotify.com/v1/playlists/${req.params.id}`, accessToken, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    });

    if (!renameRes.ok) {
      const err = await renameRes.text();
      throw new Error(`Rename failed: ${renameRes.status} - ${err}`);
    }

    await refreshPlaylistCache(req.params.id, accessToken);
    res.json({ success: true, message: `Renamed to "${name}".` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle playlist visibility (public/private)
app.put('/api/playlist/:id/visibility', async (req, res) => {
  try {
    const accessToken = await authenticate();
    const { isPublic } = req.body;
    if (typeof isPublic !== 'boolean') return res.status(400).json({ error: 'isPublic (boolean) required.' });

    const visRes = await spotifyFetch(`https://api.spotify.com/v1/playlists/${req.params.id}`, accessToken, {
      method: 'PUT',
      body: JSON.stringify({ public: isPublic }),
    });

    if (!visRes.ok) {
      const err = await visRes.text();
      throw new Error(`Visibility change failed: ${visRes.status} - ${err}`);
    }

    // Update locally — no need to refetch tracks for a visibility change
    const cache = loadCache();
    if (cache) {
      const pl = cache.user_playlists.find(p => p.id === req.params.id);
      if (pl) {
        pl.public = isPublic;
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
      }
    }

    res.json({ success: true, message: `Playlist is now ${isPublic ? 'public' : 'private'}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all tracks by an artist
app.get('/api/artist/:name', (req, res) => {
  const cache = loadCache();
  if (!cache) return res.status(404).json({ error: 'No cache' });

  const searchName = req.params.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const results = new Map(); // trackId -> { track, playlists[] }

  for (const pl of cache.user_playlists) {
    for (const track of pl.tracks) {
      const trackArtists = track.artists || [{name: track.artist || ''}];
      const matches = trackArtists.some(a =>
        a.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') === searchName
      );
      if (matches) {
        if (!results.has(track.id)) {
          results.set(track.id, {
            id: track.id,
            name: track.name,
            uri: track.uri,
            artist: trackArtists.map(a => a.name).join(', '),
            album: track.album?.name || '',
            release_date: track.album?.release_date || '',
            duration_ms: track.duration_ms,
            explicit: track.explicit,
            popularity: track.popularity,
            added_at: track.added_at,
            playlists: [],
          });
        }
        results.get(track.id).playlists.push(pl.name);
      }
    }
  }

  const tracks = [...results.values()].map(t => ({
    ...t,
    playlists: [...new Set(t.playlists)],
  }));

  // Look up genres for this artist
  const GENRE_CACHE_FILE = path.resolve(__dirname, '..', 'cli', 'data', 'artist-genres-cache.json');
  let genres = [];
  if (fs.existsSync(GENRE_CACHE_FILE)) {
    try {
      const genreCache = JSON.parse(fs.readFileSync(GENRE_CACHE_FILE, 'utf-8'));
      for (const entry of Object.values(genreCache)) {
        if (entry.name && entry.name.toLowerCase() === searchName) {
          genres = entry.genres || [];
          break;
        }
      }
    } catch {}
  }

  res.json({ artist: req.params.name, tracks, total: tracks.length, genres });
});

// Find duplicates across playlists
app.post('/api/duplicates', (req, res) => {
  try {
    const { playlistIds, mode } = req.body; // mode: 'include' or 'exclude'
    const cache = loadCache();
    if (!cache) return res.status(404).json({ error: 'No cache' });

    // Determine which playlists to scan
    // First, determine current user's owner identifiers
    const ownerCounts = new Map();
    for (const p of cache.user_playlists) {
      if (p.owner) ownerCounts.set(p.owner, (ownerCounts.get(p.owner) || 0) + 1);
    }
    const currentUserOwners = new Set(['You']);
    if (ownerCounts.size > 0) {
      const sorted = [...ownerCounts.entries()].sort((a, b) => b[1] - a[1]);
      currentUserOwners.add(sorted[0][0]);
      if (sorted.length > 1 && sorted[1][1] > sorted.length * 0.2) {
        currentUserOwners.add(sorted[1][0]);
      }
    }

    let scanPlaylists;
    if (mode === 'include') {
      scanPlaylists = cache.user_playlists.filter(p => playlistIds.includes(p.id) && currentUserOwners.has(p.owner));
    } else {
      scanPlaylists = cache.user_playlists.filter(p => !playlistIds.includes(p.id) && currentUserOwners.has(p.owner));
    }

    // --- Exact duplicates (same track ID) ---
    const trackMap = new Map(); // trackId -> [{ playlist, track }]
    const withinPlaylist = []; // { track, playlist, count }

    for (const pl of scanPlaylists) {
      const seenInPlaylist = new Map(); // trackId -> count
      for (const track of pl.tracks) {
        // Within-playlist tracking
        seenInPlaylist.set(track.id, (seenInPlaylist.get(track.id) || 0) + 1);

        // Cross-playlist tracking
        if (!trackMap.has(track.id)) trackMap.set(track.id, []);
        trackMap.get(track.id).push({
          playlist: pl.name,
          playlistId: pl.id,
          name: track.name,
          artist: track.artists ? track.artists.map(a => a.name).join(', ') : (track.artist || ''),
          uri: track.uri,
          popularity: track.popularity || 0,
        });
      }
      // Flag within-playlist duplicates
      for (const [trackId, count] of seenInPlaylist) {
        if (count > 1) {
          const track = pl.tracks.find(t => t.id === trackId);
          withinPlaylist.push({
            id: trackId,
            name: track.name,
            artist: track.artists ? track.artists.map(a => a.name).join(', ') : (track.artist || ''),
            uri: track.uri,
            popularity: track.popularity || 0,
            playlist: pl.name,
            playlistId: pl.id,
            count,
          });
        }
      }
    }

    // Cross-playlist exact duplicates (appear in 2+ playlists)
    const exactDuplicates = [];
    for (const [trackId, entries] of trackMap) {
      const uniquePlaylists = [...new Set(entries.map(e => e.playlist))];
      if (uniquePlaylists.length > 1) {
        exactDuplicates.push({
          id: trackId,
          name: entries[0].name,
          artist: entries[0].artist,
          uri: entries[0].uri,
          popularity: entries[0].popularity,
          playlists: uniquePlaylists,
          matchType: 'exact',
        });
      }
    }

    // --- Fuzzy duplicates (same normalized name+artist, different track IDs) ---
    function normalize(str) {
      return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\(feat[^)]*\)/gi, '').replace(/\(ft[^)]*\)/gi, '').replace(/\(with[^)]*\)/gi, '')
        .replace(/- remaster(ed)?( \d+)?/gi, '').replace(/- radio edit/gi, '').replace(/- single version/gi, '')
        .replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    }

    const fuzzyMap = new Map(); // normalizedKey -> [{ trackId, name, artist, playlists }]
    for (const pl of scanPlaylists) {
      for (const track of pl.tracks) {
        const artist = track.artists ? track.artists[0]?.name || '' : (track.artist || '');
        const key = `${normalize(track.name)}::${normalize(artist)}`;
        if (!fuzzyMap.has(key)) fuzzyMap.set(key, []);
        fuzzyMap.get(key).push({
          id: track.id,
          name: track.name,
          artist: track.artists ? track.artists.map(a => a.name).join(', ') : (track.artist || ''),
          uri: track.uri,
          popularity: track.popularity || 0,
          playlist: pl.name,
          playlistId: pl.id,
        });
      }
    }

    const fuzzyDuplicates = [];
    for (const [key, entries] of fuzzyMap) {
      const uniqueIds = [...new Set(entries.map(e => e.id))];
      if (uniqueIds.length > 1) {
        // Different track IDs with same normalized name — these are fuzzy matches
        // Skip if already caught as exact duplicates
        const playlists = [...new Set(entries.map(e => e.playlist))];
        fuzzyDuplicates.push({
          normalizedKey: key,
          variants: entries.map(e => ({ id: e.id, name: e.name, artist: e.artist, uri: e.uri, popularity: e.popularity, playlist: e.playlist })),
          playlists,
          matchType: 'fuzzy',
        });
      }
    }

    res.json({
      scannedPlaylists: scanPlaylists.length,
      exactDuplicates: exactDuplicates.sort((a, b) => b.playlists.length - a.playlists.length),
      fuzzyDuplicates: fuzzyDuplicates.sort((a, b) => b.variants.length - a.variants.length),
      withinPlaylist: withinPlaylist.sort((a, b) => b.count - a.count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all artists with track counts
app.get('/api/artists', (req, res) => {
  const cache = loadCache();
  if (!cache) return res.status(404).json({ error: 'No cache' });

  const artistMap = new Map(); // name -> { count, playlists, playlistCounts }
  const seenTracks = new Set();
  for (const pl of cache.user_playlists) {
    for (const track of pl.tracks) {
      if (seenTracks.has(track.id)) continue;
      seenTracks.add(track.id);
      const trackArtists = track.artists || [{name: track.artist || ''}];
      for (const a of trackArtists) {
        if (!a.name) continue;
        if (!artistMap.has(a.name)) artistMap.set(a.name, { name: a.name, count: 0, playlists: new Set(), playlistCounts: new Map() });
        const entry = artistMap.get(a.name);
        entry.count++;
        entry.playlists.add(pl.name);
        entry.playlistCounts.set(pl.name, (entry.playlistCounts.get(pl.name) || 0) + 1);
      }
    }
  }

  // Load genre cache
  const GENRE_CACHE_FILE = path.resolve(__dirname, '..', 'cli', 'data', 'artist-genres-cache.json');
  const artistGenres = new Map(); // artistName (lowercase) -> genres[]
  if (fs.existsSync(GENRE_CACHE_FILE)) {
    try {
      const genreCache = JSON.parse(fs.readFileSync(GENRE_CACHE_FILE, 'utf-8'));
      for (const entry of Object.values(genreCache)) {
        if (entry.name && entry.genres) {
          artistGenres.set(entry.name.toLowerCase(), entry.genres);
        }
      }
    } catch {}
  }

  const artists = [...artistMap.values()].map(a => ({
    name: a.name,
    count: a.count,
    playlistCount: a.playlists.size,
    playlists: [...a.playlists],
    playlistCounts: Object.fromEntries(a.playlistCounts),
    genres: artistGenres.get(a.name.toLowerCase()) || [],
  }));

  res.json({ artists, total: artists.length });
});

// Get all genres with artist/track counts
app.get('/api/genres', (req, res) => {
  const cache = loadCache();
  if (!cache) return res.status(404).json({ error: 'No cache' });

  const GENRE_CACHE_FILE = path.resolve(__dirname, '..', 'cli', 'data', 'artist-genres-cache.json');
  let genreCache = {};
  if (fs.existsSync(GENRE_CACHE_FILE)) {
    try { genreCache = JSON.parse(fs.readFileSync(GENRE_CACHE_FILE, 'utf-8')); } catch {}
  }

  // Build artist name -> genres map
  const artistGenres = new Map(); // artistName -> genres[]
  for (const entry of Object.values(genreCache)) {
    if (entry.name && entry.genres && entry.genres.length > 0) {
      artistGenres.set(entry.name.toLowerCase(), entry.genres);
    }
  }

  // Count tracks per genre
  const genreMap = new Map(); // genre -> { artists: Set, trackCount }
  const seenTracks = new Set();
  for (const pl of cache.user_playlists) {
    for (const track of pl.tracks) {
      if (seenTracks.has(track.id)) continue;
      seenTracks.add(track.id);
      const trackArtists = track.artists || [{name: track.artist || ''}];
      for (const a of trackArtists) {
        const genres = artistGenres.get(a.name.toLowerCase()) || [];
        for (const genre of genres) {
          if (!genreMap.has(genre)) genreMap.set(genre, { name: genre, artists: new Set(), trackCount: 0 });
          const entry = genreMap.get(genre);
          entry.artists.add(a.name);
          entry.trackCount++;
        }
      }
    }
  }

  const genres = [...genreMap.values()].map(g => ({
    name: g.name,
    artistCount: g.artists.size,
    trackCount: g.trackCount,
  }));

  res.json({ genres, total: genres.length });
});

// Get all tracks for a specific genre
app.get('/api/genre/:name', (req, res) => {
  const cache = loadCache();
  if (!cache) return res.status(404).json({ error: 'No cache' });

  const GENRE_CACHE_FILE = path.resolve(__dirname, '..', 'cli', 'data', 'artist-genres-cache.json');
  let genreCache = {};
  if (fs.existsSync(GENRE_CACHE_FILE)) {
    try { genreCache = JSON.parse(fs.readFileSync(GENRE_CACHE_FILE, 'utf-8')); } catch {}
  }

  const targetGenre = decodeURIComponent(req.params.name).toLowerCase();

  // Find all artist names that have this genre
  const artistsInGenre = new Set();
  for (const entry of Object.values(genreCache)) {
    if (entry.genres && entry.genres.some(g => g.toLowerCase() === targetGenre)) {
      artistsInGenre.add(entry.name.toLowerCase());
    }
  }

  // Find all tracks by those artists
  const results = new Map();
  for (const pl of cache.user_playlists) {
    for (const track of pl.tracks) {
      const trackArtists = track.artists || [{name: track.artist || ''}];
      const matches = trackArtists.some(a => artistsInGenre.has(a.name.toLowerCase()));
      if (matches) {
        if (!results.has(track.id)) {
          results.set(track.id, {
            id: track.id,
            name: track.name,
            uri: track.uri,
            artist: trackArtists.map(a => a.name).join(', '),
            album: track.album?.name || '',
            release_date: track.album?.release_date || '',
            duration_ms: track.duration_ms || 0,
            explicit: track.explicit || false,
            popularity: track.popularity || 0,
            playlists: [],
          });
        }
        results.get(track.id).playlists.push(pl.name);
      }
    }
  }

  const tracks = [...results.values()].map(t => ({ ...t, playlists: [...new Set(t.playlists)] }));
  res.json({ genre: req.params.name, tracks, total: tracks.length, artistCount: artistsInGenre.size });
});

// Get matching artist names for search suggestions
app.get('/api/artists/search', (req, res) => {
  const cache = loadCache();
  if (!cache) return res.json({ artists: [] });

  const query = (req.query.q || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!query) return res.json({ artists: [] });

  const artistCounts = new Map();
  const seenTracks = new Set();
  for (const pl of cache.user_playlists) {
    for (const track of pl.tracks) {
      if (seenTracks.has(track.id)) continue;
      seenTracks.add(track.id);
      const trackArtists = track.artists || [{name: track.artist || ''}];
      for (const a of trackArtists) {
        const norm = a.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (norm.includes(query)) {
          artistCounts.set(a.name, (artistCounts.get(a.name) || 0) + 1);
        }
      }
    }
  }

  const artists = [...artistCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  res.json({ artists });
});

// Billboard scoring
app.get('/api/billboard', async (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear().toString();
    const top = parseInt(req.query.top) || 50;

    const VALID_DATES_URL = 'https://raw.githubusercontent.com/mhollingshead/billboard-hot-100/main/valid_dates.json';
    const CHART_BASE_URL = 'https://raw.githubusercontent.com/mhollingshead/billboard-hot-100/main/date';
    const BILLBOARD_CACHE_DIR = path.resolve(__dirname, '..', 'data', 'billboard');
    if (!fs.existsSync(BILLBOARD_CACHE_DIR)) fs.mkdirSync(BILLBOARD_CACHE_DIR, { recursive: true });

    // Get valid dates
    const datesRes = await fetch(VALID_DATES_URL);
    if (!datesRes.ok) throw new Error('Failed to fetch chart dates');
    const allDates = await datesRes.json();

    let chartDates;
    if (req.query.from || req.query.to) {
      // Normalize: accept YYYY-MM or MM-YYYY formats
      let fromStr = req.query.from || '1958-08';
      let toStr = req.query.to || '9999-12';
      // If format is MM-YYYY, flip it
      if (/^\d{2}-\d{4}$/.test(fromStr)) fromStr = fromStr.split('-').reverse().join('-');
      if (/^\d{2}-\d{4}$/.test(toStr)) toStr = toStr.split('-').reverse().join('-');
      chartDates = allDates.filter(d => d >= fromStr && d <= (toStr + '-99'));
    } else {
      chartDates = allDates.filter(d => d.startsWith(year + '-'));
    }

    if (chartDates.length === 0) throw new Error(`No chart dates found for ${year}`);

    // Fetch charts (with cache)
    const charts = [];
    for (const date of chartDates) {
      const dateYear = date.substring(0, 4);
      const yearDir = path.join(BILLBOARD_CACHE_DIR, dateYear);
      if (!fs.existsSync(yearDir)) fs.mkdirSync(yearDir, { recursive: true });
      const cacheFile = path.join(yearDir, `${date}.json`);
      if (fs.existsSync(cacheFile)) {
        charts.push(JSON.parse(fs.readFileSync(cacheFile, 'utf-8')));
      } else {
        // Check old location (flat structure) for migration
        const oldFile = path.join(BILLBOARD_CACHE_DIR, `${date}.json`);
        if (fs.existsSync(oldFile)) {
          // Migrate to year folder
          fs.renameSync(oldFile, cacheFile);
          charts.push(JSON.parse(fs.readFileSync(cacheFile, 'utf-8')));
        } else {
          const chartRes = await fetch(`${CHART_BASE_URL}/${date}.json`);
          if (chartRes.ok) {
            const chart = await chartRes.json();
            fs.writeFileSync(cacheFile, JSON.stringify(chart, null, 2));
            charts.push(chart);
          }
          await sleep(50);
        }
      }
    }

    // Score
    const scores = new Map();
    for (const chart of charts) {
      for (const entry of chart.data) {
        const key = `${entry.song}::${entry.artist}`;
        if (!scores.has(key)) {
          scores.set(key, { song: entry.song, artist: entry.artist, totalScore: 0, appearances: 0 });
        }
        const s = scores.get(key);
        s.totalScore += (101 - entry.this_week);
        s.appearances++;
      }
    }

    // Rank all
    const ranked = [...scores.values()].sort((a, b) => b.totalScore - a.totalScore);
    ranked.forEach((entry, i) => entry.overallRank = i + 1);

    // Check which are in library
    const cache = loadCache();
    const existingNames = new Map(); // key -> [playlist names]
    if (cache) {
      for (const pl of cache.user_playlists) {
        for (const track of pl.tracks) {
          const normName = track.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\(feat[^)]*\)/gi, '').replace(/\(ft[^)]*\)/gi, '').replace(/\(with[^)]*\)/gi, '').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
          const normArtist = (track.artists[0]?.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
          const key = `${normName}::${normArtist}`;
          if (!existingNames.has(key)) existingNames.set(key, []);
          if (!existingNames.get(key).includes(pl.name)) existingNames.get(key).push(pl.name);
        }
      }
    }

    function simplifyNorm(str) {
      return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\(feat[^)]*\)/gi, '').replace(/\(ft[^)]*\)/gi, '').replace(/\(with[^)]*\)/gi, '').replace(/\(from[^)]*\)/gi, '').replace(/&/g, 'and').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    }

    function extractArtist(artist) {
      return artist.replace(/\([^)]*\)/g, '').split(/[,&:]|\bfeaturing\b|\bfeat\b\.?|\bft\b\.?|\bwith\b|\bduet\b/i)[0].trim().split(/\sx\s/i)[0].trim();
    }

    const results = ranked.map(entry => {
      const normSong = simplifyNorm(entry.song);
      const normArtist = simplifyNorm(extractArtist(entry.artist));
      const key = `${normSong}::${normArtist}`;
      const inLibrary = existingNames.has(key);
      const inPlaylists = existingNames.get(key) || [];
      return { ...entry, inLibrary, inPlaylists };
    });

    // Return top N not in library, but also flag all
    const notInLibrary = results.filter(r => !r.inLibrary);
    const inLibraryResults = results.filter(r => r.inLibrary).map((entry, i) => ({ ...entry, filterRank: i + 1 }));
    const topResults = notInLibrary.slice(0, top).map((entry, i) => ({ ...entry, filterRank: i + 1 }));

    res.json({
      year,
      chartsAnalyzed: charts.length,
      dateRange: `${chartDates[0]} to ${chartDates[chartDates.length - 1]}`,
      totalScored: ranked.length,
      inLibrary: inLibraryResults.length,
      results: topResults,
      inLibraryResults,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a track to playback queue
app.post('/api/queue', async (req, res) => {
  try {
    const { uri } = req.body;
    if (!uri) return res.status(400).json({ error: 'URI required.' });

    const accessToken = await authenticate();
    const queueRes = await spotifyFetch(`https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`, accessToken, {
      method: 'POST',
    });

    if (queueRes.status === 404) {
      return res.status(404).json({ error: 'No active Spotify session. Start playing something first.' });
    }
    if (!queueRes.ok) {
      const err = await queueRes.text();
      throw new Error(`Queue failed: ${queueRes.status} - ${err}`);
    }

    res.json({ success: true, message: 'Added to queue.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search Spotify catalog (and cross-reference with library)
app.get('/api/spotify-catalog-search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.json({ results: [] });

    const accessToken = await authenticate();
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 50);
    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`;
    const searchRes = await spotifyFetch(url, accessToken);
    if (!searchRes.ok) throw new Error(`Spotify search failed: ${searchRes.status}`);
    const data = await searchRes.json();
    const items = data.tracks?.items || [];

    // Build a set of track IDs in library for cross-reference
    const cache = loadCache();
    const libraryIds = new Map(); // trackId -> [playlist names]
    if (cache) {
      for (const pl of cache.user_playlists) {
        for (const track of pl.tracks) {
          if (!libraryIds.has(track.id)) libraryIds.set(track.id, []);
          libraryIds.get(track.id).push(pl.name);
        }
      }
    }

    const results = items.map(t => ({
      id: t.id,
      uri: t.uri,
      name: t.name,
      artist: t.artists.map(a => a.name).join(', '),
      artists: t.artists.map(a => a.name),
      album: t.album?.name || '',
      album_id: t.album?.id || '',
      release_date: t.album?.release_date || '',
      explicit: t.explicit,
      popularity: t.popularity,
      inLibrary: libraryIds.has(t.id),
      playlists: libraryIds.get(t.id) || [],
    }));

    res.json({ results, total: data.tracks?.total || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get an artist's full discography from Spotify (cross-referenced with library)
app.get('/api/spotify-discography', async (req, res) => {
  try {
    const artistName = req.query.artist;
    if (!artistName) return res.status(400).json({ error: 'artist required' });

    const accessToken = await authenticate();

    // 1. Resolve the artist. Prefer an explicit id, otherwise search by name.
    let artist = null;
    if (req.query.id) {
      const aRes = await spotifyFetch(`https://api.spotify.com/v1/artists/${req.query.id}`, accessToken);
      if (aRes.ok) artist = await aRes.json();
    }
    if (!artist) {
      const searchUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(artistName)}&type=artist&limit=5`;
      const searchRes = await spotifyFetch(searchUrl, accessToken);
      if (!searchRes.ok) throw new Error(`Artist search failed: ${searchRes.status}`);
      const searchData = await searchRes.json();
      const candidates = searchData.artists?.items || [];
      const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      artist = candidates.find(a => norm(a.name) === norm(artistName)) || candidates[0] || null;
    }
    if (!artist) return res.json({ artist: artistName, found: false, tracks: [], total: 0 });

    // 2. Fetch all albums/singles/compilations for the artist.
    const albums = [];
    const seenAlbumIds = new Set();
    let albumUrl = `https://api.spotify.com/v1/artists/${artist.id}/albums?include_groups=album,single&limit=50&market=US`;
    while (albumUrl) {
      const albRes = await spotifyFetch(albumUrl, accessToken);
      if (!albRes.ok) throw new Error(`Failed to fetch albums: ${albRes.status}`);
      const albData = await albRes.json();
      for (const alb of albData.items || []) {
        if (!seenAlbumIds.has(alb.id)) {
          seenAlbumIds.add(alb.id);
          albums.push(alb);
        }
      }
      albumUrl = albData.next;
      if (albumUrl) await sleep(80);
    }

    // 3. Fetch tracks for each album (batched album lookups, 20 at a time).
    const trackMap = new Map(); // trackId -> track
    for (let i = 0; i < albums.length; i += 20) {
      const batch = albums.slice(i, i + 20);
      const ids = batch.map(a => a.id).join(',');
      const fullRes = await spotifyFetch(`https://api.spotify.com/v1/albums?ids=${ids}&market=US`, accessToken);
      if (!fullRes.ok) throw new Error(`Failed to fetch album tracks: ${fullRes.status}`);
      const fullData = await fullRes.json();
      for (const alb of fullData.albums || []) {
        if (!alb) continue;
        const albumRelease = alb.release_date || '';
        const albumName = alb.name || '';
        const albumId = alb.id || '';
        for (const t of alb.tracks?.items || []) {
          // Only keep tracks where this artist actually appears.
          const onTrack = (t.artists || []).some(a => a.id === artist.id);
          if (!onTrack) continue;
          if (!trackMap.has(t.id)) {
            trackMap.set(t.id, {
              id: t.id,
              uri: t.uri,
              name: t.name,
              artist: (t.artists || []).map(a => a.name).join(', '),
              album: albumName,
              album_id: albumId,
              release_date: albumRelease,
              duration_ms: t.duration_ms || 0,
              explicit: t.explicit || false,
              popularity: 0,
              track_number: t.track_number || 0,
            });
          }
        }
      }
      await sleep(80);
    }

    // 3.5. Album-track objects are "simplified" and omit popularity.
    // Hydrate it with the full-track endpoint (up to 50 ids per call).
    const allIds = [...trackMap.keys()];
    for (let i = 0; i < allIds.length; i += 50) {
      const idBatch = allIds.slice(i, i + 50);
      const trRes = await spotifyFetch(`https://api.spotify.com/v1/tracks?ids=${idBatch.join(',')}&market=US`, accessToken);
      if (!trRes.ok) throw new Error(`Failed to fetch track details: ${trRes.status}`);
      const trData = await trRes.json();
      for (const t of trData.tracks || []) {
        if (t && trackMap.has(t.id)) {
          trackMap.get(t.id).popularity = t.popularity || 0;
        }
      }
      await sleep(80);
    }

    // 4. Cross-reference with the local library cache.
    const cache = loadCache();
    const libraryIds = new Map(); // trackId -> [playlist names]
    if (cache) {
      for (const pl of cache.user_playlists) {
        for (const track of pl.tracks) {
          if (!libraryIds.has(track.id)) libraryIds.set(track.id, []);
          libraryIds.get(track.id).push(pl.name);
        }
      }
    }

    const tracks = [...trackMap.values()].map(t => ({
      ...t,
      inLibrary: libraryIds.has(t.id),
      playlists: [...new Set(libraryIds.get(t.id) || [])],
    }));

    res.json({
      artist: artist.name,
      artistId: artist.id,
      found: true,
      genres: artist.genres || [],
      albumCount: albums.length,
      tracks,
      total: tracks.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a single album's tracks from Spotify (cross-referenced with library)
app.get('/api/album/:id', async (req, res) => {
  try {
    const albumId = req.params.id;
    if (!albumId) return res.status(400).json({ error: 'album id required' });

    const accessToken = await authenticate();

    // 1. Fetch the album (metadata + first page of simplified track objects).
    const albRes = await spotifyFetch(`https://api.spotify.com/v1/albums/${albumId}?market=US`, accessToken);
    if (albRes.status === 404) return res.status(404).json({ error: 'Album not found on Spotify' });
    if (!albRes.ok) throw new Error(`Failed to fetch album: ${albRes.status}`);
    const album = await albRes.json();

    const albumName = album.name || '';
    const albumRelease = album.release_date || '';
    const albumArtists = (album.artists || []).map(a => a.name).join(', ');
    const albumImage = album.images?.[0]?.url || '';

    // 2. Collect all track items, paging through if the album has >50 tracks.
    //    Album track objects are "simplified" and preserve album order.
    const items = [...(album.tracks?.items || [])];
    let nextUrl = album.tracks?.next;
    while (nextUrl) {
      const pageRes = await spotifyFetch(nextUrl, accessToken);
      if (!pageRes.ok) throw new Error(`Failed to fetch album tracks: ${pageRes.status}`);
      const pageData = await pageRes.json();
      items.push(...(pageData.items || []));
      nextUrl = pageData.next;
      if (nextUrl) await sleep(80);
    }

    const trackMap = new Map(); // trackId -> track
    items.forEach((t, i) => {
      if (!t || !t.id || trackMap.has(t.id)) return;
      trackMap.set(t.id, {
        id: t.id,
        uri: t.uri,
        name: t.name,
        artist: (t.artists || []).map(a => a.name).join(', '),
        artists: (t.artists || []).map(a => a.name),
        album: albumName,
        album_id: albumId,
        release_date: albumRelease,
        duration_ms: t.duration_ms || 0,
        explicit: t.explicit || false,
        popularity: 0,
        disc_number: t.disc_number || 1,
        track_number: t.track_number || (i + 1),
        _index: i,
      });
    });

    // 3. Simplified album tracks omit popularity; hydrate via the full-track
    //    endpoint (up to 50 ids per call).
    const allIds = [...trackMap.keys()];
    for (let i = 0; i < allIds.length; i += 50) {
      const idBatch = allIds.slice(i, i + 50);
      const trRes = await spotifyFetch(`https://api.spotify.com/v1/tracks?ids=${idBatch.join(',')}&market=US`, accessToken);
      if (!trRes.ok) throw new Error(`Failed to fetch track details: ${trRes.status}`);
      const trData = await trRes.json();
      for (const t of trData.tracks || []) {
        if (t && trackMap.has(t.id)) trackMap.get(t.id).popularity = t.popularity || 0;
      }
      if (i + 50 < allIds.length) await sleep(80);
    }

    // 4. Cross-reference with the local library cache.
    const cache = loadCache();
    const libraryIds = new Map(); // trackId -> [playlist names]
    if (cache) {
      for (const pl of cache.user_playlists) {
        for (const track of pl.tracks) {
          if (!libraryIds.has(track.id)) libraryIds.set(track.id, []);
          libraryIds.get(track.id).push(pl.name);
        }
      }
    }

    const tracks = [...trackMap.values()].map(t => ({
      ...t,
      inLibrary: libraryIds.has(t.id),
      playlists: [...new Set(libraryIds.get(t.id) || [])],
    }));

    res.json({
      id: albumId,
      name: albumName,
      artist: albumArtists,
      release_date: albumRelease,
      image: albumImage,
      total_tracks: album.total_tracks || tracks.length,
      tracks,
      total: tracks.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search Spotify for a specific track (for billboard add)
app.post('/api/spotify-search', async (req, res) => {
  try {
    const { song, artist } = req.body;
    if (!song || !artist) return res.status(400).json({ error: 'song and artist required' });

    const accessToken = await authenticate();
    const primaryArtist = artist
      .replace(/\([^)]*\)/g, '')
      .split(/[,&:]|\bfeaturing\b|\bfeat\b\.?|\bft\b\.?|\bwith\b|\bduet\b/i)[0]
      .trim()
      .split(/\sx\s/i)[0]
      .trim();

    const query = encodeURIComponent(`track:${song} artist:${primaryArtist}`);
    let url = `https://api.spotify.com/v1/search?q=${query}&type=track&limit=10`;

    let searchRes = await spotifyFetch(url, accessToken);
    if (!searchRes.ok) throw new Error(`Search failed: ${searchRes.status}`);
    let data = await searchRes.json();
    let results = data.tracks?.items || [];

    // Fallback: unstructured search
    if (results.length === 0) {
      const fallbackQuery = encodeURIComponent(`${song} ${primaryArtist}`);
      searchRes = await spotifyFetch(`https://api.spotify.com/v1/search?q=${fallbackQuery}&type=track&limit=10`, accessToken);
      if (searchRes.ok) {
        data = await searchRes.json();
        results = data.tracks?.items || [];
      }
    }

    if (results.length === 0) {
      return res.json({ found: false, song, artist });
    }

    // Pick best match — prefer explicit
    const pick = results.find(r => r.explicit) || results[0];
    res.json({
      found: true,
      track: { id: pick.id, uri: pick.uri, name: pick.name, artist: pick.artists.map(a => a.name).join(', ') },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`\n  Spotify Playlist Tools UI`);
  console.log(`  Profile: ${PROFILE}`);
  console.log(`  http://localhost:${PORT}\n`);

  // Open in browser (cross-platform)
  const url = `http://localhost:${PORT}`;
  try {
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    execSync(cmd);
  } catch {}
});
