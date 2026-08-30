/**
 * Pulls playlists and track data from Spotify into a local cache.
 *
 * Default behavior (smart sync):
 *   - Adds new playlists, removes deleted ones
 *   - Only re-fetches tracks for playlists whose snapshot_id changed
 *   - Skips unchanged playlists entirely
 *
 * Options:
 *   (no args)               Smart sync — only fetch what changed
 *   --update "Name"         Refresh only the named playlist
 *   --force                 Full re-fetch of all playlists and tracks
 */

const fs = require('fs');
const path = require('path');
const { authenticate, PROFILE } = require('./auth');

const CACHE_FILE = path.resolve(__dirname, '..', 'data', `spotify-cache-${PROFILE}.json`);
const GENRE_CACHE_FILE = path.resolve(__dirname, '..', 'cli', 'data', 'artist-genres-cache.json');

// --- Rate-limit-friendly fetch with retry ---
async function spotifyFetch(url, accessToken, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
      console.log(`  Rate limited. Waiting ${retryAfter}s...`);
      await sleep(retryAfter * 1000);
      continue;
    }

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`API error ${response.status}: ${err}`);
    }

    return response.json();
  }
  throw new Error(`Failed after ${retries} retries`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Fetch all playlists ---
async function getAllPlaylists(accessToken) {
  const playlists = [];
  let url = 'https://api.spotify.com/v1/me/playlists?limit=50';

  while (url) {
    const data = await spotifyFetch(url, accessToken);
    playlists.push(...data.items);
    url = data.next;
    if (url) await sleep(100); // Be gentle
  }

  return playlists;
}

// --- Fetch all tracks for a playlist ---
async function getPlaylistTracks(playlistId, accessToken) {
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&fields=items(added_at,track(id,name,artists(id,name),album(id,name,release_date),duration_ms,explicit,external_ids,uri,popularity)),next`;

  while (url) {
    const data = await spotifyFetch(url, accessToken);
    for (const item of data.items) {
      if (item.track && item.track.id) {
        tracks.push({
          id: item.track.id,
          name: item.track.name,
          uri: item.track.uri,
          artists: item.track.artists.map(a => ({ id: a.id, name: a.name })),
          album: {
            id: item.track.album?.id,
            name: item.track.album?.name,
            release_date: item.track.album?.release_date,
          },
          duration_ms: item.track.duration_ms,
          explicit: item.track.explicit,
          isrc: item.track.external_ids?.isrc || null,
          popularity: item.track.popularity,
          added_at: item.added_at,
        });
      }
    }
    url = data.next;
    if (url) await sleep(100);
  }

  return tracks;
}

// --- Fetch Liked Songs (Saved Tracks) ---
async function getLikedSongs(accessToken) {
  const tracks = [];
  let url = 'https://api.spotify.com/v1/me/tracks?limit=50';

  while (url) {
    const data = await spotifyFetch(url, accessToken);
    for (const item of data.items) {
      if (item.track && item.track.id) {
        tracks.push({
          id: item.track.id,
          name: item.track.name,
          uri: item.track.uri,
          artists: item.track.artists.map(a => ({ id: a.id, name: a.name })),
          album: {
            id: item.track.album?.id,
            name: item.track.album?.name,
            release_date: item.track.album?.release_date,
          },
          duration_ms: item.track.duration_ms,
          explicit: item.track.explicit,
          isrc: item.track.external_ids?.isrc || null,
          popularity: item.track.popularity,
          added_at: item.added_at,
        });
      }
    }
    url = data.next;
    if (url) await sleep(100);
  }

  return tracks;
}

// --- Artist genre fetching ---
function loadGenreCache() {
  if (!fs.existsSync(GENRE_CACHE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(GENRE_CACHE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveGenreCache(cache) {
  fs.writeFileSync(GENRE_CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function fetchArtistGenres(artistIds, accessToken, genreCache) {
  // Filter to only artists we don't already have
  const uncached = artistIds.filter(id => genreCache[id] === undefined);

  if (uncached.length === 0) {
    console.log(`  All ${artistIds.length} artists already in genre cache.`);
    return;
  }

  console.log(`  Fetching genres for ${uncached.length} new artists (${artistIds.length - uncached.length} already cached)...`);

  // Batch into groups of 50
  const batches = [];
  for (let i = 0; i < uncached.length; i += 50) {
    batches.push(uncached.slice(i, i + 50));
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const url = `https://api.spotify.com/v1/artists?ids=${batch.join(',')}`;

    try {
      const data = await spotifyFetch(url, accessToken);
      for (const artist of (data.artists || [])) {
        if (artist) {
          genreCache[artist.id] = {
            name: artist.name,
            genres: artist.genres || [],
          };
        }
      }
    } catch (err) {
      console.error(`    Error on batch ${i + 1}: ${err.message}`);
    }

    if (i < batches.length - 1) await sleep(200);
  }

  saveGenreCache(genreCache);
}

// --- Main ---
function loadExistingCache() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.includes('--force')) return { mode: 'full' };
  const updateIdx = args.indexOf('--update');
  if (updateIdx !== -1) {
    const name = args[updateIdx + 1];
    if (!name) {
      console.error('Error: --update requires a playlist name. Example:');
      console.error('  npm run cache:update -- "2025"');
      process.exit(1);
    }
    return { mode: 'update', name };
  }
  return { mode: 'smart' };
}

async function runFull(accessToken) {
  console.log('\nFetching all playlists...');
  const playlists = await getAllPlaylists(accessToken);
  console.log(`Found ${playlists.length} playlists.\n`);

  const cache = {
    cached_at: new Date().toISOString(),
    user_playlists: [],
  };

  for (let i = 0; i < playlists.length; i++) {
    const pl = playlists[i];
    const trackCount = pl.tracks?.total || 0;
    console.log(`[${i + 1}/${playlists.length}] "${pl.name}" (${trackCount} tracks)...`);

    const tracks = await getPlaylistTracks(pl.id, accessToken);

    cache.user_playlists.push({
      id: pl.id,
      name: pl.name,
      description: pl.description || '',
      owner: pl.owner?.display_name || 'Unknown',
      public: pl.public,
      collaborative: pl.collaborative,
      total_tracks: trackCount,
      snapshot_id: pl.snapshot_id,
      uri: pl.uri,
      tracks: tracks,
    });

    if (i < playlists.length - 1) await sleep(200);
  }

  // Fetch Liked Songs
  console.log(`[+] "Liked Songs"...`);
  const likedTracks = await getLikedSongs(accessToken);
  console.log(`    ${likedTracks.length} tracks`);
  cache.user_playlists.push({
    id: '__liked_songs__',
    name: 'Liked Songs',
    description: 'Your saved/liked tracks',
    owner: 'You',
    public: false,
    collaborative: false,
    total_tracks: likedTracks.length,
    snapshot_id: `liked_${Date.now()}`,
    uri: null,
    tracks: likedTracks,
  });

  return cache;
}

async function runUpdate(name, accessToken) {
  const existingCache = loadExistingCache();
  if (!existingCache) {
    console.error('No existing cache. Run a full cache first: npm run cache');
    process.exit(1);
  }

  // Find the playlist in the cache
  const idx = existingCache.user_playlists.findIndex(
    p => p.name.toLowerCase() === name.toLowerCase()
  );

  if (idx === -1) {
    console.error(`Playlist "${name}" not found in cache.`);
    console.error('Available playlists:');
    existingCache.user_playlists
      .map(p => p.name)
      .sort()
      .forEach(n => console.error(`  - ${n}`));
    process.exit(1);
  }

  const cached = existingCache.user_playlists[idx];
  console.log(`\nRefreshing "${cached.name}" (${cached.total_tracks} cached tracks)...`);

  const tracks = await getPlaylistTracks(cached.id, accessToken);

  existingCache.user_playlists[idx] = {
    ...cached,
    total_tracks: tracks.length,
    tracks: tracks,
  };
  existingCache.cached_at = new Date().toISOString();

  console.log(`  Updated: ${tracks.length} tracks (was ${cached.total_tracks})`);
  return existingCache;
}

async function runSmart(accessToken) {
  const existingCache = loadExistingCache();
  if (!existingCache) {
    console.log('  No existing cache, doing full pull.\n');
    return runFull(accessToken);
  }

  console.log('\nFetching playlist list from Spotify...');
  const spotifyPlaylists = await getAllPlaylists(accessToken);
  console.log(`Found ${spotifyPlaylists.length} playlists on Spotify.`);

  const cachedById = new Map(existingCache.user_playlists.map(p => [p.id, p]));
  const spotifyIds = new Set(spotifyPlaylists.map(p => p.id));

  // Categorize playlists
  const newPlaylists = spotifyPlaylists.filter(p => !cachedById.has(p.id));
  const deletedIds = [...cachedById.keys()].filter(id => !spotifyIds.has(id));
  const changed = spotifyPlaylists.filter(p => {
    const cached = cachedById.get(p.id);
    return cached && cached.snapshot_id !== p.snapshot_id;
  });
  const unchanged = spotifyPlaylists.filter(p => {
    const cached = cachedById.get(p.id);
    return cached && cached.snapshot_id === p.snapshot_id;
  });

  console.log(`  New: ${newPlaylists.length} | Changed: ${changed.length} | Unchanged: ${unchanged.length} | Deleted: ${deletedIds.length}`);

  // Update metadata for unchanged playlists (name, description changes don't affect snapshot_id... actually they do)
  // But let's update metadata for all existing playlists from the API response just in case
  for (const sp of spotifyPlaylists) {
    const cached = cachedById.get(sp.id);
    if (!cached) continue;
    if (cached.name !== sp.name) {
      console.log(`  Renamed: "${cached.name}" → "${sp.name}"`);
    }
    cached.name = sp.name;
    cached.description = sp.description || '';
    cached.public = sp.public;
    cached.collaborative = sp.collaborative;
    cached.uri = sp.uri;
  }

  // Remove deleted
  if (deletedIds.length > 0) {
    const deletedNames = deletedIds.map(id => cachedById.get(id).name);
    console.log('\n  Removing from cache:');
    deletedNames.forEach(n => console.log(`    - ${n}`));
    existingCache.user_playlists = existingCache.user_playlists.filter(p => !deletedIds.includes(p.id));
  }

  // Re-fetch changed playlists
  if (changed.length > 0) {
    console.log('\n  Refreshing changed playlists:');
    for (let i = 0; i < changed.length; i++) {
      const pl = changed[i];
      const trackCount = pl.tracks?.total || 0;
      console.log(`    [${i + 1}/${changed.length}] "${pl.name}" (${trackCount} tracks)...`);

      const tracks = await getPlaylistTracks(pl.id, accessToken);
      const cached = cachedById.get(pl.id);
      cached.total_tracks = trackCount;
      cached.snapshot_id = pl.snapshot_id;
      cached.tracks = tracks;

      if (i < changed.length - 1) await sleep(200);
    }
  }

  // Fetch new playlists
  if (newPlaylists.length > 0) {
    console.log('\n  Adding new playlists:');
    for (let i = 0; i < newPlaylists.length; i++) {
      const pl = newPlaylists[i];
      const trackCount = pl.tracks?.total || 0;
      console.log(`    [${i + 1}/${newPlaylists.length}] "${pl.name}" (${trackCount} tracks)...`);

      const tracks = await getPlaylistTracks(pl.id, accessToken);

      existingCache.user_playlists.push({
        id: pl.id,
        name: pl.name,
        description: pl.description || '',
        owner: pl.owner?.display_name || 'Unknown',
        public: pl.public,
        collaborative: pl.collaborative,
        total_tracks: trackCount,
        snapshot_id: pl.snapshot_id,
        uri: pl.uri,
        tracks: tracks,
      });

      if (i < newPlaylists.length - 1) await sleep(200);
    }
  }

  if (newPlaylists.length === 0 && changed.length === 0 && deletedIds.length === 0) {
    console.log('\n  Everything up to date — no changes detected.');
  }

  // Always refresh Liked Songs
  console.log('\n  Refreshing Liked Songs...');
  const likedTracks = await getLikedSongs(accessToken);
  const likedIdx = existingCache.user_playlists.findIndex(p => p.id === '__liked_songs__');
  const likedEntry = {
    id: '__liked_songs__',
    name: 'Liked Songs',
    description: 'Your saved/liked tracks',
    owner: 'You',
    public: false,
    collaborative: false,
    total_tracks: likedTracks.length,
    snapshot_id: `liked_${Date.now()}`,
    uri: null,
    tracks: likedTracks,
  };
  if (likedIdx !== -1) {
    existingCache.user_playlists[likedIdx] = likedEntry;
  } else {
    existingCache.user_playlists.push(likedEntry);
  }
  console.log(`    ${likedTracks.length} tracks`);

  existingCache.cached_at = new Date().toISOString();
  return existingCache;
}

async function main() {
  const { mode, name } = parseArgs();
  const accessToken = await authenticate();

  let cache;
  if (mode === 'update') {
    cache = await runUpdate(name, accessToken);
  } else if (mode === 'full') {
    cache = await runFull(accessToken);
  } else {
    cache = await runSmart(accessToken);
  }

  // Write cache
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));

  const sizeMB = (Buffer.byteLength(JSON.stringify(cache)) / 1024 / 1024).toFixed(2);
  const totalTracks = cache.user_playlists.reduce((sum, pl) => sum + pl.tracks.length, 0);

  console.log('\n========================================');
  console.log('Cache complete!');
  console.log('========================================');
  console.log(`  File: ${CACHE_FILE}`);
  console.log(`  Size: ${sizeMB} MB`);
  console.log(`  Playlists: ${cache.user_playlists.length}`);
  console.log(`  Total tracks: ${totalTracks}`);
  console.log(`  Cached at: ${cache.cached_at}`);

  // Fetch artist genres (only new artists)
  console.log('\nUpdating artist genre cache...');
  const genreCache = loadGenreCache();
  const allArtistIds = new Set();
  for (const pl of cache.user_playlists) {
    for (const track of pl.tracks) {
      for (const artist of track.artists) {
        if (artist.id) allArtistIds.add(artist.id);
      }
    }
  }
  await fetchArtistGenres([...allArtistIds], accessToken, genreCache);
  console.log(`  Artist genre cache: ${Object.keys(genreCache).length} artists`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
