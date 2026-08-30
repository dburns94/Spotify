# Spotify Playlist Tools — Setup Guide

A collection of Node.js scripts and a web UI for managing Spotify playlists. Works on macOS and Windows.

## Prerequisites

- **Node.js 18+** — Download from [nodejs.org](https://nodejs.org/)
- **A Spotify account** (free or premium)
- **A Spotify Developer App** (free to create)

## 1. Create a Spotify Developer App

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Log in with your Spotify account
3. Click **Create App**
4. Fill in:
   - App Name: anything (e.g. "Playlist Tools")
   - App Description: anything
   - Redirect URI: `http://127.0.0.1:8080/spotify_api`
   - Check "Web API"
5. Click **Save**
6. On your app page, click **Settings**
7. Note your **Client ID** and **Client Secret**

## 2. Clone / Download the Project

Place the `Spotify/` folder anywhere on your machine.

## 3. Install Dependencies

Open a terminal (macOS: Terminal, Windows: Command Prompt or PowerShell) and navigate to the project folder:

```bash
cd path/to/Spotify
npm install
```

This installs `express` (the only dependency).

## 4. Configure Credentials

Create a `.env` file in the project root:

```
# Default profile
SPOTIFY_PROFILE=personal

# Your credentials (from Step 1)
SPOTIFY_personal_CLIENT_ID=your_client_id_here
SPOTIFY_personal_CLIENT_SECRET=your_client_secret_here
SPOTIFY_personal_REDIRECT_URI=http://127.0.0.1:8080/spotify_api
```

### Adding more accounts

Add additional profiles by repeating the credential block:

```
SPOTIFY_wife_CLIENT_ID=another_client_id
SPOTIFY_wife_CLIENT_SECRET=another_client_secret
SPOTIFY_wife_REDIRECT_URI=http://127.0.0.1:8080/spotify_api
```

Switch profiles with `--profile wife` on any command, or change `SPOTIFY_PROFILE` in `.env`.

## 5. First Run — Authenticate

Run any command to trigger the login flow:

```bash
npm run cache
```

This will:
1. Print a URL to your terminal
2. Open your browser to Spotify's login page
3. After you approve, redirect back to the local callback
4. Save your token to `data/.spotify-token-personal.json`

The token refreshes automatically. You only need to log in again if you delete the token file or add new permission scopes.

## 6. Build Your Cache

The first run of `npm run cache` will pull all your playlists and tracks into a local JSON file. This can take a few minutes depending on how many playlists you have.

```bash
npm run cache
```

After the initial pull, subsequent runs are fast — it only fetches playlists that changed (using Spotify's snapshot IDs).

## 7. Start Using

### Web UI (recommended)

```bash
npm run ui
```

Opens a dashboard at [http://localhost:3000](http://localhost:3000) where you can:
- View all playlists with track counts, duration, last modified
- Search your library or the Spotify catalog
- Sort, shuffle, rename, delete playlists
- Select tracks and add them to playlists
- Add tracks to your Spotify queue
- Combine playlists into shuffled randoms
- Browse Billboard Hot 100 scored rankings
- Drill into artists to see all their tracks

### CLI Commands

Run `npm run help` to see all available commands:

```bash
npm run help
```

Key commands:

| Command | Description |
|---------|-------------|
| `npm run cache` | Smart sync — fetch only what changed |
| `npm run cache:force` | Full re-fetch of everything |
| `npm run cache:update -- "Name"` | Refresh one playlist |
| `npm run ui` | Start the web dashboard |
| `npm run stats` | Generate HTML stats dashboard |
| `npm run search -- "query"` | Search your library from CLI |
| `npm run duplicates` | Find duplicate tracks |
| `npm run billboard` | Score Billboard Hot 100 songs |
| `npm run random` | Combine playlists into a shuffled one |
| `npm run artist -- "Name"` | Find all tracks by an artist |
| `npm run playlist -- create "Name"` | Create a new playlist |
| `npm run playlist -- shuffle "Name"` | Shuffle a playlist in place |

## Project Structure

```
Spotify/
├── .env                          # Credentials (not committed)
├── package.json                  # Scripts and dependencies
├── ignore-playlists-personal.json # Playlists to exclude from duplicate checks
├── data/
│   ├── spotify-cache-personal.json  # Cached playlist data
│   ├── .spotify-token-personal.json # Auth token
│   ├── artist-genres-cache.json     # Genre data
│   ├── billboard/                   # Cached Billboard charts
│   └── ...
├── reports/
│   ├── stats-personal.html       # Stats dashboard
│   ├── duplicates-report.txt     # Duplicate findings
│   └── ...
└── scripts/
    ├── auth.js                   # Shared authentication
    ├── server.js                 # Web UI server
    ├── ui/index.html             # Web UI frontend
    ├── cache-data.js             # Cache builder
    ├── billboard-add.js          # Billboard scoring
    ├── find-duplicates.js        # Duplicate finder
    └── ...
```

## Troubleshooting

### "No valid token found" / Auth errors

Delete the token file and re-authenticate:

```bash
# macOS
rm data/.spotify-token-personal.json

# Windows
del data\.spotify-token-personal.json
```

Then run any command again to trigger the login flow.

### "Insufficient client scope"

You need to re-authenticate with updated permissions. Delete the token file (see above) and log in again. The scripts request all needed scopes automatically.

### "redirect_uri: Not matching configuration"

The redirect URI in your `.env` must exactly match what's registered in the Spotify Developer Dashboard. Check for trailing slashes or port mismatches.

### Cache is stale

Run `npm run cache` to smart-sync. If you want a complete refresh:

```bash
npm run cache:force
```

### Web UI won't start

Make sure nothing else is running on port 3000. If needed, you can change the `PORT` constant at the top of `scripts/server.js`.

## Windows-Specific Notes

- Use `\` instead of `/` in file paths if navigating manually
- All `npm run` commands work the same in Command Prompt, PowerShell, or Git Bash
- For the `--` separator in npm commands with arguments, use:
  ```
  npm run cache:update -- "Playlist Name"
  ```
- Node.js 18+ includes `fetch` natively — no additional HTTP libraries needed

## Permissions Requested

The app requests these Spotify scopes:

| Scope | Used for |
|-------|----------|
| `playlist-read-private` | Reading your private playlists |
| `playlist-read-collaborative` | Reading collaborative playlists |
| `playlist-modify-public` | Creating/modifying public playlists |
| `playlist-modify-private` | Creating/modifying private playlists |
| `user-library-read` | Reading your Liked Songs |
| `user-top-read` | Your top artists/tracks for stats |
| `user-modify-playback-state` | Adding tracks to queue |
