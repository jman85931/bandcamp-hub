# Bandcamp Hub

A local web app for managing your Bandcamp music library. Build playlists, keep a standalone Library, sync purchased and wishlist items, and push tracks or sample packs directly to your Bandcamp cart — all from `localhost:3000`.

Built as a self-hosted alternative to trackden.org.

![Dark theme SPA with playlist and player](https://raw.githubusercontent.com/jman85931/bandcamp-hub/main/screenshot.png)

---

## Features

### Library
- **Library + playlists** — keep a standalone Library alongside regular playlists
- **Playlists** — create multiple playlists, add tracks by pasting Bandcamp URLs (track or album)
- **Folders** — organise playlists into collapsible folders in the sidebar
- **Smart playlists** — auto-curated views filtered by genre, purchased state, price, or date added (Recently Added, Unpurchased, Free built in; create your own)
- **Duplicate detection** — warns when a URL already exists in your library before adding
- **Tags & filtering** — filter any playlist or Library view by genre, purchased state, or price, including a hide-purchased option
- **Header sorting** — click track-list column headers to sort by title, time, artist, album, purchased state, purchase date, genre, or price
- **Scoped search** — search within Library, Purchased, or Wishlist from the global search bar
- **Export / import** — save a playlist to JSON and reload it later

### Release inbox
- **New Releases view** — track artists already represented in your Library/playlists and pull their latest Bandcamp releases into a review queue
- **Inbox states** — releases are stored locally as `new`, `added`, or `archived`
- **Manual refresh** — pull releases on demand rather than running background syncs
- **Quick actions** — open on Bandcamp, add straight to Library, send to a playlist, or archive
- **Bulk archive** — clear handled releases from the inbox without losing history

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
- **Sample-pack aware carting** — demo-track entries can resolve to the underlying digital album/package when pushing to cart
- **Cart pull** — reads your live Bandcamp cart into the Hub
- **Cart removal** — remove individual tracks or clear the whole cart from within the Hub
- **Collection sync** — imports purchased items, stores purchase dates, and marks matching library tracks as purchased

### Metadata & prices
- **Price display** — shows per-track and album prices with GBP conversion
- **Library stats** — total tracks, total value, genre breakdown, priciest unpurchased albums

### Chrome extension popup
- **Add current Bandcamp page** — click the extension on a Bandcamp track or album page to add it straight into the Hub
- **One-click Library add** — send the current page directly to your Library
- **Searchable playlist picker** — type to find the playlist you want, then add selected tracks
- **Album / EP selection** — choose all tracks or only specific tracks before adding

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

The extension handles cart operations and also adds the popup used to send the current Bandcamp page into your Hub.

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

### Adding from Bandcamp pages

While browsing Bandcamp, click the Chrome extension. On supported track and album pages you can:

- add the current page straight to your Library
- search for a playlist and add to that instead
- choose individual tracks from albums / EPs before adding

### Organising with folders

Click **+ Folder** in the sidebar to create a folder. Drag playlists into it to group them. Folders collapse to keep the sidebar tidy.

### Smart playlists

Smart playlists auto-populate based on criteria — genre, purchased state, price range, or how recently tracks were added. Three built-in views (Recently Added, Unpurchased, Free) are created automatically. Click **+ Smart Playlist** to define your own.

### Playing music

Click any track to play it. Use the player bar at the bottom for playback controls. Press **Space** to play/pause, **←/→** to seek, **Shift+←/→** to skip tracks. Click the queue icon to see and reorder what's up next.

### Pushing to cart

Select tracks (checkbox on hover) and click **Push Selected to Cart**, or use **Push to Cart** on a full playlist. The extension silently adds them to your Bandcamp cart in the background.

### New Releases

Open **New Releases** in the sidebar and click **Pull Releases**. The Hub derives tracked artists from your Library and regular playlists, fetches their Bandcamp discography, and drops unseen releases into a local inbox. From there you can open a release on Bandcamp, add it to Library, send it to a playlist, or archive it once handled.

### Library search and sorting

Use the header search bar to search within `Library`, `Purchased`, or `Wishlist`. In Library and playlist-style views, click the track-list headers to sort by the visible data. Price sorts high-to-low on first click, then low-to-high on the second.

### Wishlist

Open the **Wishlist** view in the sidebar and click **Pull from Bandcamp**. Albums appear as expandable groups. Click any track to add it to a playlist.

### Cart

Open the **Cart** view in the sidebar and click **Pull from Bandcamp** to read your current cart. From here you can remove individual items or clear the whole cart.

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

Everything is stored in `data.json` in the project root — playlists, Library membership, track metadata, tracked releases, settings, and your session cookie. This file is gitignored and never leaves your machine.

Stream URLs are fetched fresh on every play (Bandcamp tokens expire quickly) and are never stored.

---

## Tech stack

- **Server:** Node.js + Express (ESM), [`bandcamp-fetch`](https://www.npmjs.com/package/bandcamp-fetch) for Bandcamp API calls
- **Frontend:** Vanilla JS SPA, dark theme, no build step
- **Extension:** Chrome MV3 service worker, communicates with the Hub via `externally_connectable`
