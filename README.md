# Bandcamp Hub

A local web app for managing your Bandcamp library. Build playlists, play tracks, sync your wishlist, and push tracks directly to your Bandcamp cart — all from `localhost:3000`.

Built as a self-hosted alternative to trackden.org.

![Dark theme SPA with playlist and player](https://raw.githubusercontent.com/jman85931/bandcamp-hub/main/screenshot.png)

---

## Features

### Library
- **Playlists** — create multiple playlists, add tracks by pasting Bandcamp URLs (track or album)
- **Folders** — organise playlists into collapsible folders in the sidebar
- **Smart playlists** — auto-curated views filtered by genre, ownership, price, or date added (Recently Added, Unowned, Free built in; create your own)
- **Duplicate detection** — warns when a URL already exists in your library before adding
- **Tags & filtering** — filter any playlist by genre, ownership, or price
- **Sort** — sort by artist, album, price, duration, or release date
- **Global search** — find any track across all playlists instantly
- **Export / import** — save a playlist to JSON and reload it later

### Player
- **Playback** — plays tracks in order with next/prev and progress bar
- **Shuffle & repeat** — shuffle mode and repeat (all/one) per session
- **Queue panel** — see and reorder what's playing next
- **Keyboard shortcuts** — space to play/pause, arrow keys to seek and skip, and more

### Track management
- **Batch genre edit** — select multiple tracks and set their genre in one action
- **Notes** — add freeform notes to any track, visible in the detail panel
- **Track refresh** — re-fetch price and metadata for individual tracks or a whole playlist
- **Refresh All** — bulk refresh every track in a playlist
- **Non-streamable detection** — tracks Bandcamp won't stream are flagged and skipped automatically

### Wishlist & cart
- **Wishlist sync** — pulls your full Bandcamp wishlist with album groupings
- **Cart push** — one-click push of any track, selection, or full playlist to your Bandcamp cart (via Chrome extension)
- **Cart pull** — reads your live Bandcamp cart into the Hub
- **Cart removal** — remove individual tracks or clear the whole cart from within the Hub
- **Collection sync** — imports purchased items and marks them as owned

### Metadata & prices
- **Price display** — shows per-track and album prices with GBP conversion
- **Library stats** — total tracks, total value, genre breakdown, priciest unowned albums

---

## Requirements

- [Node.js](https://nodejs.org/) v18+
- Google Chrome (for the cart extension)
- A Bandcamp account

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Start the server

```bash
npm start
```

Then open **http://localhost:3000**.

### 3. Load the Chrome extension

The extension handles all cart operations (push, pull, remove) using your real browser session.

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder inside this project
5. Reload the Hub page — the Settings panel will show the extension as installed

### 4. Configure Settings

Open Settings (gear icon, top-right) and:

- Click **Fetch from Extension** to automatically grab your Bandcamp session cookie (requires the extension and being logged in to bandcamp.com)
- Enter your **Bandcamp username** (from your profile URL, e.g. `bandcamp.com/yourusername`)

Save settings. That's it.

> **Cookie note:** The session cookie is stored locally in `data.json` (gitignored). It's needed for wishlist/collection sync and high-quality audio streams. It is never sent anywhere except back to Bandcamp's own API.

---

## Usage

### Adding tracks

Paste any Bandcamp track or album URL into the input at the top of a playlist. Album URLs open a picker so you can add individual tracks or all at once. If a URL is already in your library, a warning will appear before adding.

### Organising with folders

Click **+ Folder** in the sidebar to create a folder. Drag playlists into it to group them. Folders collapse to keep the sidebar tidy.

### Smart playlists

Smart playlists auto-populate based on criteria — genre, ownership, price range, or how recently tracks were added. Four built-in views (Recently Added, Unowned, Free) are created automatically. Click **+ Smart Playlist** to define your own.

### Playing music

Click any track to play it. Use the player bar at the bottom for playback controls. Press **Space** to play/pause, **←/→** to seek, **Shift+←/→** to skip tracks. Click the queue icon to see and reorder what's up next.

### Pushing to cart

Select tracks (checkbox on hover) and click **Push Selected to Cart**, or use **Push to Cart** on a full playlist. The extension silently adds them to your Bandcamp cart in the background.

### Wishlist

Click **Cart / Wishlist** (top-right) → **Wishlist** tab → **Pull from Bandcamp**. Albums appear as expandable groups. Click any track to add it to a playlist.

### Cart

Click **Cart / Wishlist** → **Cart** tab → **Pull from Bandcamp** to read your current cart. From here you can remove individual items or clear the whole cart.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / pause |
| `←` / `→` | Seek back / forward 10s |
| `Shift+←` / `Shift+→` | Previous / next track |
| `M` | Mute / unmute |
| `/` | Focus search bar |
| `Esc` | Close panel / clear search |

---

## Data

Everything is stored in `data.json` in the project root — playlists, track metadata, settings, and your session cookie. This file is gitignored and never leaves your machine.

Stream URLs are fetched fresh on every play (Bandcamp tokens expire quickly) and are never stored.

---

## Tech stack

- **Server:** Node.js + Express (ESM), [`bandcamp-fetch`](https://www.npmjs.com/package/bandcamp-fetch) for Bandcamp API calls
- **Frontend:** Vanilla JS SPA, dark theme, no build step
- **Extension:** Chrome MV3 service worker, communicates with the Hub via `externally_connectable`
