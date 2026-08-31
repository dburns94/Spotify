// --- Shared utilities for all pages ---

// API helper
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || 'Unexpected response');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Toast notifications
function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = 'toast visible' + (isError ? ' error' : '');
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => { toast.className = 'toast'; }, 4000);
}

// HTML/attribute escaping
function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// Render a track's artist(s) as links to their library page (/artist/:name),
// mirroring how the Spotify catalog search links artists to their discography.
// Prefers a structured `artists` array; otherwise splits the comma-joined
// `artist` string. Each name links individually so collaborations resolve to
// each artist's own library page. Falls back to plain text when no artist.
// Pass a className (e.g. 'lib-link') to style links that sit outside a table
// cell, where the .data-table td a styling doesn't reach.
function libraryArtistLinks(track, className = '') {
  const names = (track.artists && track.artists.length)
    ? track.artists.map(a => (typeof a === 'string' ? a : a.name))
    : (track.artist ? track.artist.split(',').map(s => s.trim()) : []);
  if (!names.length) return escHtml(track.artist || '');
  const cls = className ? ` class="${className}"` : '';
  return names
    .filter(Boolean)
    .map(name => `<a${cls} href="/artist/${encodeURIComponent(name)}" title="View ${escAttr(name)} in your library">${escHtml(name)}</a>`)
    .join(', ');
}

// Render a track's album as a link to its in-app album view (/album/:id) when
// the album id is known, mirroring how artist names link to their library page.
// Falls back to plain album-name text when no album id is present.
function albumLink(track) {
  const name = track.album || '';
  if (!name) return '';
  const id = track.album_id;
  if (!id) return escHtml(name);
  return `<a href="/album/${encodeURIComponent(id)}" title="View album ${escAttr(name)}">${escHtml(name)}</a>`;
}

// Build a case-insensitive playlist-name -> id lookup from a playlists array
// (as returned by /api/playlists). Used to turn playlist names shown in
// "In Playlists" / "Also in" columns into links to /playlist/:id.
function buildPlaylistNameIndex(playlistList) {
  const index = new Map();
  for (const p of (playlistList || [])) {
    // First occurrence wins; keep the id for each distinct name.
    if (!index.has(p.name)) index.set(p.name, p.id);
  }
  return index;
}

// Render a list of playlist names as links to their playlist page
// (/playlist/:id), mirroring how artist names link to their library page.
// `names` is an array (or comma-joined string) of playlist names. `nameIndex`
// is a Map from name -> id (see buildPlaylistNameIndex); it falls back to the
// global `playlists` array when omitted. Names with no known id render as
// plain text (e.g. a playlist not present in the current list).
function playlistLinks(names, nameIndex) {
  const list = Array.isArray(names)
    ? names
    : (names ? String(names).split(',').map(s => s.trim()) : []);
  if (!list.length) return '';
  const idx = nameIndex
    || (typeof playlists !== 'undefined' ? buildPlaylistNameIndex(playlists) : new Map());
  return list
    .filter(Boolean)
    .map(name => {
      const id = idx.get(name);
      if (!id) return escHtml(name);
      return `<a href="/playlist/${encodeURIComponent(id)}" title="Open playlist ${escAttr(name)}">${escHtml(name)}</a>`;
    })
    .join(', ');
}

// Formatting helpers
function formatDuration(ms) {
  if (!ms) return '-';
  const totalMin = Math.floor(ms / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours === 0) return `${mins}m`;
  return `${hours}h ${mins}m`;
}

function formatTrackDuration(ms) {
  if (!ms) return '-';
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function formatDate(isoStr) {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function timeAgo(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// Modal helper
function closeModal(id) {
  document.getElementById(id).classList.remove('visible');
}

// Queue track
async function queueTrack(uri, btn) {
  btn.disabled = true;
  btn.textContent = '...';
  try {
    await api('/api/queue', { method: 'POST', body: JSON.stringify({ uri }) });
    btn.textContent = '\u2713';
    btn.style.color = '#1DB954';
    btn.style.borderColor = '#1DB954';
    setTimeout(() => { btn.textContent = '+ Queue'; btn.style.color = ''; btn.style.borderColor = ''; btn.disabled = false; }, 2000);
  } catch (err) {
    showToast(err.message, true);
    btn.textContent = '+ Queue';
    btn.disabled = false;
  }
}

// Add tracks with duplicate check
async function addTracksWithDuplicateCheck(playlistId, uris, targetName) {
  const checkData = await api(`/api/playlist/${playlistId}/add-tracks`, {
    method: 'POST',
    body: JSON.stringify({ uris, checkOnly: true }),
  });

  if (checkData.duplicates > 0) {
    return new Promise((resolve) => {
      const text = document.getElementById('duplicatesModalText');
      const checkbox = document.getElementById('duplicatesIncludeCheckbox');
      checkbox.checked = false;

      const updateText = () => {
        const addCount = checkbox.checked ? checkData.total : checkData.newCount;
        text.textContent = `${checkData.duplicates} of ${checkData.total} track(s) already exist in "${targetName}". ${addCount} track(s) will be added.`;
      };
      updateText();
      checkbox.onchange = updateText;

      document.getElementById('duplicatesModal').classList.add('visible');

      document.getElementById('duplicatesConfirmBtn').onclick = async () => {
        closeModal('duplicatesModal');
        const skipDuplicates = !checkbox.checked;
        showToast(`Adding track(s) to "${targetName}"...`);
        const data = await api(`/api/playlist/${playlistId}/add-tracks`, {
          method: 'POST',
          body: JSON.stringify({ uris, skipDuplicates }),
        });
        resolve(data);
      };
    });
  } else {
    showToast(`Adding ${uris.length} track(s) to "${targetName}"...`);
    return await api(`/api/playlist/${playlistId}/add-tracks`, {
      method: 'POST',
      body: JSON.stringify({ uris, skipDuplicates: true }),
    });
  }
}

// Auth check
async function checkAuth() {
  try {
    const data = await api('/api/auth-status');
    const banner = document.getElementById('authBanner');
    if (!banner) return;
    if (!data.authenticated) {
      banner.classList.add('visible');
    } else {
      banner.classList.remove('visible');
    }
  } catch {
    const banner = document.getElementById('authBanner');
    if (banner) banner.classList.add('visible');
  }
}

async function startLogin() {
  try {
    const data = await api('/api/login');
    window.open(data.url, '_blank', 'width=500,height=700');
    showToast('Complete login in the popup, then actions will work.');
    const pollInterval = setInterval(async () => {
      const status = await api('/api/auth-status');
      if (status.authenticated) {
        clearInterval(pollInterval);
        const banner = document.getElementById('authBanner');
        if (banner) banner.classList.remove('visible');
        showToast('Authenticated successfully!');
      }
    }, 2000);
    setTimeout(() => clearInterval(pollInterval), 120000);
  } catch (err) {
    showToast('Login failed: ' + err.message, true);
  }
}

// Stale cache check
function checkCacheAge(cachedAt) {
  const cacheAge = Date.now() - new Date(cachedAt).getTime();
  const warning = document.getElementById('staleCacheWarning');
  if (!warning) return;
  if (cacheAge > 24 * 60 * 60 * 1000) {
    warning.classList.add('visible');
  } else {
    warning.classList.remove('visible');
  }
}

// --- URL view-state persistence (shared across pages) ---
// Read the current query string as a plain object.
function getUrlParams() {
  const out = {};
  for (const [k, v] of new URLSearchParams(window.location.search)) out[k] = v;
  return out;
}

// Write view state into the URL without reloading or adding history entries.
// Pass a plain object of key -> value; falsy/empty values are omitted so the
// URL only carries state that differs from the page defaults. Values may be
// strings, numbers, booleans, or arrays (arrays are comma-joined).
// Debounced by default so typing in a filter box doesn't thrash the address bar.
let _persistTimeout = null;
function persistParams(obj, { debounce = 0 } = {}) {
  const write = () => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null || v === false || v === '') continue;
      if (Array.isArray(v)) { if (v.length) params.set(k, v.join(',')); }
      else params.set(k, String(v));
    }
    const qs = params.toString();
    history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  };
  clearTimeout(_persistTimeout);
  if (debounce > 0) _persistTimeout = setTimeout(write, debounce);
  else write();
}

// Common header HTML generator
function getHeaderHtml(activePage) {
  return `
  <div class="header">
    <div class="header-inner">
      <div class="header-top">
        <h1><a href="/">Spotify Playlist Tools</a></h1>
        <div class="header-cache">
          <span class="header-info" id="headerInfo"></span>
          <button class="btn btn-secondary btn-small" id="cacheBtn" onclick="updateCache()">Update Cache</button>
        </div>
        <div class="header-actions">
          <a class="nav-link ${activePage === 'search' ? 'active' : ''}" href="/search">Search</a>
          <a class="nav-link ${activePage === 'playlists' ? 'active' : ''}" href="/">Playlists</a>
          <a class="nav-link ${activePage === 'artists' ? 'active' : ''}" href="/artists">Artists</a>
          <a class="nav-link ${activePage === 'genres' ? 'active' : ''}" href="/genres">Genres</a>
          <a class="nav-link ${activePage === 'billboard' ? 'active' : ''}" href="/billboard">Billboard</a>
          <a class="nav-link ${activePage === 'duplicates' ? 'active' : ''}" href="/duplicates">Duplicates</a>
        </div>
      </div>
    </div>
  </div>`;
}

// Update cache (shared across all pages via the header button).
// Pages may define window.onCacheUpdated() to re-render themselves after a
// successful update; otherwise the page is reloaded to pick up fresh data.
async function updateCache() {
  const btn = document.getElementById('cacheBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Updating...'; }
  showToast('Updating cache (this may take a moment)...');
  try {
    await api('/api/cache', { method: 'POST' });
    showToast('Cache updated!');
    if (typeof window.onCacheUpdated === 'function') {
      await window.onCacheUpdated();
    } else {
      window.location.reload();
      return;
    }
  } catch (err) {
    showToast('Cache update failed: ' + err.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Update Cache'; }
  }
}

// Load and display cache info in header (shared across all pages)
let _cacheTimestamp = null;
let _cacheInterval = null;

async function loadHeaderInfo() {
  try {
    const data = await api('/api/playlists');
    _cacheTimestamp = data.cached_at;
    updateHeaderAgo();
    if (_cacheInterval) clearInterval(_cacheInterval);
    _cacheInterval = setInterval(updateHeaderAgo, 30000); // update every 30s
    checkCacheAge(data.cached_at);
    return data;
  } catch { return null; }
}

function updateHeaderAgo() {
  const el = document.getElementById('headerInfo');
  if (!el || !_cacheTimestamp) return;
  el.textContent = `Cached: ${timeAgo(_cacheTimestamp)}`;
}

// Duplicates modal HTML (shared across pages that add tracks)
function getDuplicatesModalHtml() {
  return `
  <div class="modal-overlay" id="duplicatesModal">
    <div class="modal">
      <h3>Duplicates Detected</h3>
      <p id="duplicatesModalText"></p>
      <label style="display:inline-flex; align-items:center; gap:6px; margin-bottom:16px; font-size:13px; color:#888; cursor:pointer; line-height:1;">
        <input type="checkbox" id="duplicatesIncludeCheckbox" style="accent-color:#1DB954; width:14px; height:14px; flex-shrink:0; margin:0;"> Include duplicates anyway
      </label>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeModal('duplicatesModal')">Cancel</button>
        <button class="btn btn-primary" id="duplicatesConfirmBtn">Add Tracks</button>
      </div>
    </div>
  </div>`;
}
