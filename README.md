# Bandcamp Hub

A local web app for managing your Bandcamp library. Build playlists, play tracks, sync your wishlist, and push tracks directly to your Bandcamp cart — all from `localhost:3000`.

Built as a self-hosted alternative to trackden.org.

![Dark theme SPA with playlist and player](https://raw.githubusercontent.com/jman85931/bandcamp-hub/main/screenshot.png)

---

## Features

- **Playlists** — create multiple playlists, add tracks by pasting Bandcamp URLs (track or album)
- **Player** — plays tracks in order with next/prev, shows artwork and metadata
- **Wishlist sync** — pulls your full Bandcamp wishlist with album groupings
- **Cart push** — one-click push of any track or playlist to your Bandcamp cart (via Chrome extension)
- **Cart pull** — reads your live Bandcamp cart into the Hub
- **Cart removal** — remove individual tracks or clear the whole cart from within the Hub
- **Collection sync** — imports purchased items and marks them as bought
- **Price display** — shows per-track and album prices with GBP conversion
- **Tags & filtering** — filter library by genre/tag

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

Open Settings (top-right) and:

- Click **⬇ Fetch from Extension** to automatically grab your Bandcamp session cookie (requires the extension and being logged in to bandcamp.com)
- Enter your **Bandcamp username** (from your profile URL, e.g. `bandcamp.com/yourusername`)

Save settings. That's it.

> **Cookie note:** The session cookie is stored locally in `data.json` (gitignored). It's needed for wishlist/collection sync and high-quality audio streams. It is never sent anywhere except back to Bandcamp's own API.

---

## Usage

### Adding tracks

Paste any Bandcamp track or album URL into the input at the top of a playlist. Album URLs open a picker so you can add individual tracks or all at once.

### Pushing to cart

Select tracks (checkbox on hover) or use the **Push to Cart** button on a playlist — the extension silently adds them to your Bandcamp cart in the background.

### Wishlist

Click **Cart / Wishlist** (top-right) → **Wishlist** tab → **Pull from Bandcamp**. Albums appear as expandable groups.

### Cart

Click **Cart / Wishlist** → **Cart** tab → **Pull from Bandcamp** to read your current cart. From here you can remove individual items or clear the whole cart.

---

## Data

Everything is stored in `data.json` in the project root — playlists, track metadata, settings, and your session cookie. This file is gitignored and never leaves your machine.

Stream URLs are fetched fresh on every play (Bandcamp tokens expire quickly) and are never stored.

---

## Tech stack

- **Server:** Node.js + Express (ESM), [`bandcamp-fetch`](https://www.npmjs.com/package/bandcamp-fetch) for Bandcamp API calls
- **Frontend:** Vanilla JS SPA, dark theme, no build step
- **Extension:** Chrome MV3 service worker, communicates with the Hub via `externally_connectable`
