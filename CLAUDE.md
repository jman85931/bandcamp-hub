# Bandcamp Hub — Claude Notes

## What this project is
A local Node.js/Express web app that replaces trackden.org as a personal Bandcamp library manager. Lets you build playlists, keep a standalone Library, review new releases, manage a wishlist, and push/pull the Bandcamp cart — all from localhost:3000.

## How to run
```
node server.js
```
Then open http://localhost:3000. The Chrome extension must also be loaded (see README).

## Architecture

### Server (`server.js`)
Express + ESM. Uses `bandcamp-fetch` (v3.1.0) for all Bandcamp API calls. Flat JSON store at `data.json` — never commit this, it contains the Bandcamp session cookie.

All `bcfetch` calls are wrapped with `withTimeout(p, ms = 20000)` — a `Promise.race` against a 20s rejection — so slow Bandcamp responses surface a clear error instead of hanging.

`writeData()` is atomic: writes to `data.json.tmp` then `renameSync` to `data.json` to prevent corruption on crash.

Important persisted root fields now include:
- `libraryTrackIds` — standalone Library membership, separate from playlists
- `trackedReleases` — inbox items for the New Releases view
- `wishlistItems`, `cartItems` — locally stored sync results from Bandcamp/extension
- `tracks`, `playlists`, `folders`, `sidebarOrder`, `settings` — the main app model

### Frontend (`public/`)
Vanilla JS SPA (`app.js` + `index.html` + `style.css`). Dark theme. No build step.

Key state shape:
- `state.playlists` — array of playlist/folder objects. Playlist: `{ id, name, type, trackIds, criteria? }`. Folder: `{ id, name, type: 'folder' }`. Smart playlist: `{ id, name, type: 'smart', criteria: { genre?, purchased?, price?, addedWithin? } }`.
- `state.tracks` — flat map `{ [id]: trackRecord }`. Track records have `streamable: null|true|false` (null = unknown).
- `state.libraryTrackIds` — track ids added directly to Library. Library membership is `libraryTrackIds` plus track ids referenced by regular playlists.
- `state.trackedReleases` — locally persisted release inbox items `{ id, url, artistName, artistUrl, title, artwork, releaseDate, type, state, discoveredAt, addedTrackIds? }`
- `state.sidebarOrder` — ordered array of `{ type: 'playlist'|'folder', id }` entries for drag-to-reorder. Smart playlists are NOT in sidebarOrder; they render in a separate `#smart-playlist-list`.
- `state.folders` — map `{ [folderId]: { trackIds: [playlistId, ...] } }` — which playlists live inside each folder.
- `state.cartItems`, `state.wishlistItems` — ephemeral lists from extension/sync.

SSE streams use a `streamSSE(url)` helper that returns a cancellable promise (`promise.cancel()`). The active SSE is stored in `let activeSSE = null` so the cancel button and `beforeunload` can abort it.

### Chrome Extension (`extension/`)
MV3 service worker (`background.js`). Loaded unpacked from `extension/` in `chrome://extensions`.  
The extension now also ships a popup (`popup.html` / `popup.js` / `popup.css`) for adding the current Bandcamp page into the Hub.

Background handles three messages via `externally_connectable`:
- `pushCart` — opens background tabs per artist, calls `window.Sidecart.add_to_cart()`
- `getCart` — opens `bandcamp.com/cart`, reads `window.Sidecart.cart_items`
- `removeCart` — opens `bandcamp.com/cart` to read live `sync_num`, then service worker POSTs `/cart/cb` directly

After any extension code change: reload the extension in `chrome://extensions`, then click "Refresh Cart" in the Hub before removing items (stale in-memory IDs won't work).

`getExtensionId()` in `app.js` guards against non-Chrome browsers by checking `typeof chrome !== 'undefined' && chrome.runtime` before reading the meta tag. All extension calls are gated through this function, so a missing extension always surfaces a friendly toast rather than a crash.

Popup behavior:
- Works on Bandcamp track and album pages
- Has a one-click Library add and a searchable playlist picker
- Album/EP pages expose per-track selection
- Duplicate warnings are evaluated when opening the popup, not immediately after a successful add in the same popup session

## Bandcamp cart API — hard-won knowledge

### /cart/cb delete format (confirmed working)
```
POST https://bandcamp.com/cart/cb
Content-Type: application/x-www-form-urlencoded

req=del&id=<cart_slot_id>&client_id=<val>&sync_num=<N>&req_id=<random_float>
```

### KO viewmodel cart item properties
Bandcamp uses KnockoutJS. Cart items in `window.Sidecart.cart_items` have:
- `id` — **integer cart slot ID** — this is the `id` param for del requests
- `item_id` — Bandcamp track/album ID
- `local_id` — **random float, KO internal identifier** — looks like an ID but is useless for API calls; sending it as `id` to /cart/cb wipes the entire cart
- `item_type`, `item_title`, `unit_price`, `currency`, `quantity`, `art_id`, `band_id`

### sync_num
- Must match the current server value exactly — sending a stale/wrong value clears the entire cart
- NOT present in static HTML; set dynamically by page JS after Sidecart initialises
- Read from `window.Sidecart.sync_num` only after `sc.initing` is false
- Server increments it by 1 after each successful operation

### client_id
- Typically empty string — that's normal and matches what the real browser sends

## Smart playlists
`type: 'smart'` playlists have a `criteria` object instead of a `trackIds` array. `smartPlaylistTrackIds(criteria)` in `app.js` computes members dynamically from `Object.values(state.tracks)`. Criteria fields: `genre` (string), `purchased` (`'owned'|'unowned'` in older data; the UI now labels these Purchased/Unpurchased), `price` (`'free'|'paid'`), `addedWithin` (number of days).

Built-in smart playlists (Recently Added, Unpurchased, Free) are created by `ensureBuiltInSmartPlaylists()` on boot if not present. Smart playlists are never added to `state.sidebarOrder` — they render in a separate `#smart-playlist-list` section in the sidebar.

## Library model
Library is not a hidden playlist anymore.

- Tracks can belong directly to Library via `libraryTrackIds`
- Tracks can also appear in Library because they are referenced by regular playlists
- Smart playlists do not contribute to Library membership
- A track should only be removed from `state.tracks` when it is referenced by neither any regular playlist nor `libraryTrackIds`

This matters whenever editing delete/remove flows.

## Purchased sync and sample packs
- Purchased sync tries to match both tracks and album/package-style purchases back onto existing library rows
- Sample-pack demo entries may play the demo track locally but still need to resolve to the album/product URL and album/product cart target for Bandcamp actions
- In Library and playlist views there are separate `Purchased` and `Purchase Date` columns
- In the Purchased view, the status column is intentionally suppressed to avoid redundancy

## New Releases inbox
- Sidebar view: `New Releases`
- Pull path: `GET /api/releases/pull`
- State updates:
  - `POST /api/releases/:id/archive`
  - `POST /api/releases/:id/unarchive`
- Artists are derived automatically from Library plus regular playlists, using track metadata already in the local store
- Release discovery is currently inbox-first and manual-refresh only
- Added-to-library or added-to-playlist releases should move to `state: 'added'`, not disappear entirely
- The sidebar badge should reflect `state === 'new'`

If release dates are missing, that is usually due to Bandcamp discography metadata being sparse for that item rather than a frontend rendering issue.

## Non-streamable tracks
Tracks carry `streamable: null|true|false`. `null` means unknown (legacy/wishlist import). `false` means confirmed no stream URL — the track row gets `.unstreamable` styling and `playTrack()` blocks it with a toast. The server sets `streamable: false` in `/api/track/stream` when `bcfetch` returns no stream URL.

## Common pitfalls
- `local_id` on KO cart items is a random float, not the cart slot ID — use `id` instead
- `sync_num` is not in page HTML; must open a real tab and wait for Sidecart init
- Page-injected script fetches can be intercepted by Bandcamp's own JS; service worker fetches bypass this
- Chrome MV3 service workers cache aggressively — after code changes, click reload in `chrome://extensions` and verify old tabs are closed
- Smart playlists must NOT be added to `sidebarOrder` — they have their own render section and the drag-reorder system does not apply to them
- `data.json` is local, stateful, and often the reason a behavior looks odd; when debugging purchased/release state, check the persisted values before assuming the renderer is wrong
- Release pulls can be slow if the tracked-artist set is large; keep the UX manual and explicit unless the project later adds queueing/background jobs
