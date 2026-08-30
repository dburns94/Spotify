# Spotify Playlist Tools — Web UI

A local web dashboard for managing Spotify playlists. Browse, search, sort, shuffle, combine, and organize your library through a dark-themed interface.

## Quick Start

```bash
npm install
npm run ui
```

Opens at [http://localhost:3000](http://localhost:3000). Requires Node.js 18+ and a Spotify Developer App (see SETUP.md for credentials).

## Pages

### Playlists (/)

The main page showing all your playlists in a sortable table.

**Features:**
- Sort by name, track count, duration, or last modified
- Filter playlists by name
- Toggle public/private visibility (click the badge)
- Toggle scan exclusion for duplicate detection
- Sort/shuffle playlists on Spotify (dropdown per row)
- Rename and delete playlists
- Select multiple playlists to combine & shuffle into a new one
- Create new playlists
- Stale cache warning (shows if cache is older than 24 hours)

**Non-owned playlists:** Playlists you follow but don't own have sort, rename, and scan options disabled. Delete unfollows them from your library.

### Playlist Detail (/playlist/:id)

View and manage tracks within a playlist.

**Features:**
- Sortable columns: title, artist, album, duration, popularity, release date, date added
- Filter tracks by name or artist (with diacritics normalization)
- Select tracks and add to another playlist, move to another playlist, or remove
- Duplicate detection on add (modal with option to include duplicates)
- Sort playlist on Spotify (shuffle, by title, artist, date, release date, popularity)
- Queue tracks to Spotify playback
- Popularity threshold selector (select all tracks above/below a value)
- **Show cross-refs toggle:** adds an "Also in" column showing which other playlists each track appears in (sortable)
- **Show genres toggle:** adds a Genres column with clickable genre chips per track
- **Genre filter dropdown:** when genres are shown, filter tracks to only specific genres (multi-select with exclude/invert mode)

### Artists (/artists)

Browse all artists in your library.

**Views:**
- **Most Tracks** (default): table sorted by track count, with genre chips
- **Alphabetical**: grid grouped by first letter with jump-links

**Features:**
- Filter by artist name
- Multi-select playlist filter (checkbox dropdown) to show only artists in specific playlists
- Track counts update to reflect the filtered playlist(s)
- Genre chips link to genre detail pages
- Click any artist to view their tracks

### Artist Detail (/artist/:name)

All tracks by a specific artist across your library.

**Features:**
- Genre chips displayed below artist name (clickable, links to genre page)
- Stats: track count, total duration, avg popularity, playlist count
- Sortable columns, filter, select, add to playlist, queue
- Popularity threshold selector
- Shows which playlists each track appears in

### Genres (/genres)

Browse all genres in your library (sourced from Spotify's artist genre data).

**Features:**
- Sort by most tracks, most artists, or alphabetical
- Filter by genre name
- Adjustable minimum track threshold (hide niche genres with few tracks)
- Click a genre to see all tracks

### Genre Detail (/genre/:name)

All tracks by artists tagged with a specific genre.

**Features:**
- Stats: track count, unique artists, total duration, avg popularity
- Full track table with sort, filter, select, add to playlist, queue
- Popularity threshold selector

### Search (/search)

Search your library and the Spotify catalog.

**Library search:**
- Searches track names and artist names (with diacritics normalization)
- Shows artist suggestion chips (click to go to artist page)
- Results show popularity and which playlists tracks appear in
- Sortable columns

**Spotify catalog search:**
- Searches Spotify's full catalog
- Adjustable result limit (10/20/30/50)
- Shows "In Library" badge for tracks you already have
- Shows album, release date, popularity
- Sortable columns

**Both:** Select tracks and add to any owned playlist (with duplicate detection).

### Billboard (/billboard)

Score Billboard Hot 100 chart songs and find ones missing from your library.

**Features:**
- Single year mode (defaults to current year)
- Date range mode (year/month dropdowns for multi-year analysis)
- Shows songs scored by chart performance (higher score = more weeks at higher positions)
- Filters out songs already in your library
- Select and add missing songs to a playlist (searches Spotify, handles duplicates)
- Collapsible "Already in library" section with playlist info and its own add-to-playlist controls

### Duplicates (/duplicates)

Find and remove duplicate tracks across your playlists.

**Access:** Click "Scan Dupes" on the playlists page, or use the nav link (uses saved scan exclusions).

**Three sections:**
- **Within-Playlist Duplicates:** same track appearing multiple times in one playlist. "Keep 1" button removes extras.
- **Exact Duplicates (cross-playlist):** same track ID in 2+ playlists. Shows which playlists with remove buttons.
- **Fuzzy Duplicates:** different track IDs with same normalized name + artist (catches remasters, re-releases). Shows each variant.

**Batch operations:**
- Checkbox next to each removable entry
- "Remove Selected" button processes all checked items at once (grouped by playlist for efficiency)
- Scroll position preserved after removals

**Scan modes:**
- From nav link: scans all playlists except those marked "SKIP"
- Select playlists on main page → "Scan Selected" or "Exclude & Scan"

## Shared Features

**Navigation:** persistent header with links to all pages and a live "Cached: X ago" timestamp that updates every 30 seconds.

**Authentication:** if the Spotify token is missing or expired, an auth banner appears with a login button that opens the Spotify OAuth flow.

**Profiles:** supports multiple Spotify accounts. Set `SPOTIFY_PROFILE` in `.env` and restart the server. Tokens and caches are per-profile.

**Cache:** the server maintains a local JSON cache of your playlists and tracks. Individual playlist modifications (add, remove, sort, shuffle, create, rename) automatically refresh that playlist's cache from the Spotify API. Use "Update Cache" for a full sync.

## Data Files

| File | Purpose |
|------|---------|
| `data/spotify-cache-{profile}.json` | Cached playlist and track data |
| `data/.spotify-token-{profile}.json` | OAuth tokens (access + refresh) |
| `data/scan-exclusions-{profile}.json` | Playlists excluded from duplicate scans |
| `data/delete-log.json` | Log of deleted playlists/tracks |
| `data/billboard/` | Cached Billboard Hot 100 chart data (organized by year) |

## Tech Stack

- **Server:** Node.js + Express
- **Frontend:** Vanilla HTML/CSS/JS (no build step, no framework)
- **API:** Spotify Web API with PKCE OAuth
- **Data:** JSON file-based caching
