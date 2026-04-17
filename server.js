import express from 'express';
import bcfetch from 'bandcamp-fetch';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const DATA_FILE = path.join(__dirname, 'data.json');
const PORT = 3000;

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

const DEFAULT_DATA = {
  playlists: [],
  tracks: {},
  settings: { bandcampCookie: '', fanUsername: '' }
};

function readData() {
  if (!existsSync(DATA_FILE)) return structuredClone(DEFAULT_DATA);
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return structuredClone(DEFAULT_DATA);
  }
}

function writeData(data) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function applySettings(data) {
  if (data.settings?.bandcampCookie) {
    bcfetch.setCookie(data.settings.bandcampCookie);
  }
}

// ---------------------------------------------------------------------------
// Track formatting helpers
// ---------------------------------------------------------------------------

function getDigitalOffer(raw) {
  const basic = raw?.basic;
  if (!basic) return null;

  // Album page: releases at top level
  // Track page: releases nested under inAlbum
  const releases = basic.albumRelease ?? basic.inAlbum?.albumRelease ?? [];

  // For track pages, prefer the release with item_type='t' and type_name='Digital'
  const trackDigital = releases.find(r =>
    r.additionalProperty?.some(p => p.name === 'item_type' && p.value === 't') &&
    r.additionalProperty?.some(p => p.name === 'type_name' && p.value === 'Digital')
  );
  if (trackDigital?.offers) return trackDigital.offers;

  // For album pages, prefer item_type='a' Digital
  const albumDigital = releases.find(r =>
    r.additionalProperty?.some(p => p.name === 'item_type' && p.value === 'a') &&
    r.additionalProperty?.some(p => p.name === 'type_name' && p.value === 'Digital')
  );
  if (albumDigital?.offers) return albumDigital.offers;

  // Fallback: any Digital release with an offer
  const anyDigital = releases.find(r =>
    r.additionalProperty?.some(p => p.name === 'type_name' && p.value === 'Digital') &&
    r.offers?.price != null
  );
  return anyDigital?.offers ?? null;
}

function formatPrice(track) {
  if (!track) return null;
  try {
    const offer = getDigitalOffer(track.raw);
    if (offer?.price != null) return String(offer.price);
  } catch { /* ignore */ }
  return null;
}

function formatCurrency(track) {
  if (!track) return null;
  try {
    const offer = getDigitalOffer(track.raw);
    if (offer?.priceCurrency) return offer.priceCurrency;
  } catch { /* ignore */ }
  // Also check if the item itself has a currency field (from normalizeRawFanItem)
  if (track.currency) return track.currency;
  return null;
}

function extractBcIds(track) {
  try {
    if (track.raw?.basic) {
      const raw = JSON.parse(track.raw.basic);
      return {
        bcTrackId: raw.id ?? track.id ?? null,
        bcAlbumId: raw.current?.album_id ?? raw.album?.id ?? null,
        bcBandId:  raw.current?.band_id ?? raw.band_id ?? null
      };
    }
  } catch { /* ignore */ }
  return { bcTrackId: track.id ?? null, bcAlbumId: null, bcBandId: null };
}

function buildTrackRecord(track, albumInfo = null, trackPageInfo = null) {
  const { bcTrackId, bcAlbumId, bcBandId } = extractBcIds(track);

  // Tags: merge genre + keywords from album (deduped, titlecased)
  const keywords = albumInfo?.keywords ?? [];
  const genre = albumInfo?.genre ?? null;
  const tags = [...new Set([
    ...(genre ? [genre] : []),
    ...keywords
  ])].filter(Boolean);

  // A track is streamable if bcfetch returned a stream URL at fetch time.
  // null means unknown (e.g. added via wishlist without full track info).
  const hasStream = !!(track.streamUrl || track.streamUrlHQ);
  const streamable = (track.streamUrl !== undefined || track.streamUrlHQ !== undefined) ? hasStream : null;

  return {
    id: uuidv4(),
    url: track.url ?? null,
    albumUrl: albumInfo?.url ?? track.album?.url ?? null,
    albumTrackNum: track.position ?? null,
    title: track.name,
    artist: track.artist?.name ?? albumInfo?.artist?.name ?? track.publisher?.name ?? 'Unknown Artist',
    albumTitle: albumInfo?.name ?? track.album?.name ?? null,
    artwork: track.imageUrl ?? albumInfo?.imageUrl ?? null,
    price: formatPrice(trackPageInfo ?? track) ?? (albumInfo ? formatPrice(albumInfo) : null),
    albumPrice: albumInfo ? formatPrice(albumInfo) : null,
    currency: formatCurrency(trackPageInfo ?? track) ?? formatCurrency(albumInfo),
    duration: track.duration ?? null,
    releaseDate: albumInfo?.releaseDate ?? track.releaseDate ?? null,
    tags,
    genre,
    location: albumInfo?.location ?? null,
    description: albumInfo?.description ?? null,
    label: albumInfo?.label?.name ?? track.label?.name ?? null,
    bcTrackId,
    bcAlbumId,
    bcBandId,
    streamable,
    purchased: false,
    notes: '',
    addedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Data endpoints
// ---------------------------------------------------------------------------

app.get('/api/data', (req, res) => {
  res.json(readData());
});

app.post('/api/data', (req, res) => {
  writeData(req.body);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Track lookup (paste URL → metadata)
// ---------------------------------------------------------------------------

app.post('/api/track/lookup', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const data = readData();
  applySettings(data);

  try {
    if (url.includes('/track/')) {
      const track = await bcfetch.track.getInfo({ trackUrl: url, includeRawData: true });
      // If the track belongs to an album, also fetch album for richer metadata
      const albumUrl = track.raw?.basic?.inAlbum?.['@id'] ?? track.album?.url ?? null;
      if (albumUrl) {
        const album = await bcfetch.album.getInfo({ albumUrl, includeRawData: true });
        const t = album.tracks?.find(x => x.name === track.name) ?? track;
        res.json({ type: 'track', items: [buildTrackRecord(t, album, track)] });
      } else {
        res.json({ type: 'track', items: [buildTrackRecord(track)] });
      }
    } else {
      // Album URL
      const album = await bcfetch.album.getInfo({
        albumUrl: url,
        includeRawData: true
      });
      const items = (album.tracks ?? []).map(t => buildTrackRecord(t, album));
      res.json({ type: 'album', albumName: album.name, albumArtwork: album.imageUrl, items });
    }
  } catch (err) {
    console.error('lookup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Stream URL (fetched fresh each time because tokens expire)
// ---------------------------------------------------------------------------

app.get('/api/track/stream', async (req, res) => {
  const { trackId } = req.query;
  if (!trackId) return res.status(400).json({ error: 'trackId required' });

  const data = readData();
  applySettings(data);

  const track = data.tracks[trackId];
  if (!track) return res.status(404).json({ error: 'Track not found' });

  const useCookie = !!data.settings.bandcampCookie;

  try {
    let streamUrl = null;

    if (track.url?.includes('/track/')) {
      // Standalone track page
      const info = await bcfetch.track.getInfo({ trackUrl: track.url, includeRawData: false });
      streamUrl = useCookie ? (info.streamUrlHQ ?? info.streamUrl) : info.streamUrl;
    } else if (track.albumUrl) {
      // Album track — re-fetch album and find by position
      const albumInfo = await bcfetch.album.getInfo({ albumUrl: track.albumUrl, includeRawData: false });
      const t = track.albumTrackNum != null
        ? albumInfo.tracks?.find(x => x.position === track.albumTrackNum)
        : albumInfo.tracks?.find(x => x.name === track.title);
      if (t) {
        streamUrl = useCookie ? (t.streamUrlHQ ?? t.streamUrl) : t.streamUrl;
      }
    }

    if (!streamUrl) {
      // Confirmed no stream URL — mark track as non-streamable so the UI can block playback
      if (data.tracks[trackId]) {
        data.tracks[trackId].streamable = false;
        writeData(data);
      }
      return res.status(404).json({ error: 'No stream URL available for this track' });
    }

    res.json({ streamUrl });
  } catch (err) {
    console.error('stream error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Wishlist pull (uses bcfetch fan API)
// ---------------------------------------------------------------------------

// SSE helper
function sseSetup(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  return (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Direct Bandcamp fan collection/wishlist paginator (bypasses bcfetch count:20 limit)
// Uses bcfetch for first page parse, then POSTs directly with count:50 for continuations
async function fetchAllFanItemsDirect(apiType, username, cookie) {
  const BC_API = `https://bandcamp.com/api/fancollection/1/${apiType}_items`;
  const allRaw = [];
  let total = 0;

  // First page via bcfetch (parses fan page HTML to get first batch + fan_id + token)
  const firstResult = apiType === 'collection'
    ? await bcfetch.fan.getCollection({ target: username || undefined })
    : await bcfetch.fan.getWishlist({ target: username || undefined });

  allRaw.push(...(firstResult.items ?? []));
  let continuation = firstResult.continuation ?? null;
  if (continuation?.fanId) allRaw._fanId = continuation.fanId;

  // Try to get total from Bandcamp's item_count (not exposed by bcfetch, so estimate)
  total = continuation ? Math.max(allRaw.length + 1, allRaw.length) : allRaw.length;

  // Continuation pages via direct POST with count:50
  while (continuation) {
    const payload = {
      fan_id: continuation.fanId,
      older_than_token: continuation.token,
      count: 50
    };
    const response = await fetch(BC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify(payload)
    });
    const json = await response.json();
    const rawItems = json[apiType === 'collection' ? 'items' : 'wishlist_items'] ?? json.items ?? [];
    allRaw.push(...rawItems.map(item => normalizeRawFanItem(item, json.tracklists)));
    total = allRaw.length + (json.more_available ? 1 : 0);
    continuation = json.more_available && json.last_token
      ? { fanId: continuation.fanId, token: json.last_token }
      : null;
  }

  total = allRaw.length;
  return { items: allRaw, total, fanId: allRaw._fanId ?? null };
}

// Normalize raw Bandcamp API item (from direct POST) to match bcfetch item shape
function normalizeRawFanItem(raw, tracklists) {
  const tl = tracklists?.[raw.tralbum_type + raw.item_id] ?? null;
  // Bandcamp API may return price in sale_item_price or price, currency in currency_code or currency
  const price = raw.sale_item_price ?? raw.price ?? null;
  const currency = raw.currency_code ?? raw.currency ?? null;
  return {
    type: raw.item_type === 'a' ? 'album' : 'track',
    url: raw.item_url,
    name: raw.item_title,
    artist: { name: raw.band_name ?? raw.item_artist },
    imageUrl: raw.item_art_url ?? null,
    price: price != null ? String(price) : null,
    currency: currency,
    numTracks: tl?.tracks?.length ?? null,
    tracks: (tl?.tracks ?? []).map(t => ({
      type: 'track',
      url: t.file?.['mp3-128'] ? raw.item_url : null,
      name: t.title,
      artist: { name: raw.band_name },
      duration: t.duration ?? null,
      imageUrl: raw.item_art_url ?? null
    }))
  };
}

app.get('/api/wishlist/pull', async (req, res) => {
  const data = readData();
  if (!data.settings.bandcampCookie) {
    return res.status(400).json({ error: 'Bandcamp cookie required in Settings' });
  }
  applySettings(data);
  const send = sseSetup(res);

  try {
    const { items: allItems, total, fanId } = await fetchAllFanItemsDirect(
      'wishlist', data.settings.fanUsername, data.settings.bandcampCookie
    );
    if (fanId) { data.settings.fanId = fanId; }
    send({ progress: true, fetched: allItems.length, total });

    const items = allItems.map(item => {
      if (item.type === 'track') return buildTrackRecord(item);
      return {
        id: null, type: 'album',
        url: item.url, title: item.name,
        artist: item.artist?.name ?? 'Unknown',
        albumTitle: item.name, artwork: item.imageUrl ?? null,
        price: formatPrice(item), currency: formatCurrency(item),
        numTracks: item.numTracks ?? null,
        tracks: (item.tracks ?? []).map(t => buildTrackRecord(t, item))
      };
    });

    // First-page items from bcfetch often have no track listings.
    // Fetch missing tracks for album items so the wishlist can display
    // the same expandable album groups as the playlist view.
    const albums = items.filter(it => it.type === 'album' && !it.tracks?.length && it.url);
    for (const album of albums) {
      try {
        const albumData = await bcfetch.album.getInfo({ albumUrl: album.url });
        album.tracks   = (albumData.tracks ?? []).map(t => buildTrackRecord(t, { ...albumData, url: album.url }));
        album.numTracks = album.tracks.length || album.numTracks;
      } catch { /* leave tracks empty — album header still shows */ }
    }

    send({ done: true, items, total: items.length });
  } catch (err) {
    console.error('wishlist error:', err.message);
    send({ error: err.message });
  }
  res.end();
});

// ---------------------------------------------------------------------------
// Collection pull (purchased items, uses bcfetch fan API)
// ---------------------------------------------------------------------------

app.get('/api/collection/pull', async (req, res) => {
  const data = readData();
  if (!data.settings.bandcampCookie) {
    return res.status(400).json({ error: 'Bandcamp cookie required in Settings' });
  }
  applySettings(data);
  const send = sseSetup(res);

  try {
    const { items: allItems, total, fanId } = await fetchAllFanItemsDirect(
      'collection', data.settings.fanUsername, data.settings.bandcampCookie
    );
    if (fanId) { data.settings.fanId = fanId; }
    send({ progress: true, fetched: allItems.length, total });

    const items = allItems.map(item => {
      if (item.type === 'track') {
        const t = buildTrackRecord(item); t.purchased = true; return t;
      }
      return {
        id: null, type: 'album',
        url: item.url, title: item.name,
        artist: item.artist?.name ?? 'Unknown',
        albumTitle: item.name, artwork: item.imageUrl ?? null,
        price: formatPrice(item), currency: formatCurrency(item),
        numTracks: item.numTracks ?? null,
        tracks: (item.tracks ?? []).map(t => { const r = buildTrackRecord(t, item); r.purchased = true; return r; })
      };
    });

    // Upsert into data — albums with no embedded tracks stored as single purchased entries
    let added = 0, updated = 0;
    for (const item of items) {
      if (item.type === 'album' && item.tracks?.length) {
        for (const t of item.tracks) {
          const existing = Object.values(data.tracks).find(e => e.url === t.url);
          if (existing) { existing.purchased = true; updated++; }
          else { data.tracks[t.id] = t; added++; }
        }
      } else {
        // Single track or album without tracklist — store as one entry
        const entry = item.type === 'album'
          ? { ...buildTrackRecord({ name: item.title, artist: item.artist, imageUrl: item.artwork, url: item.url }), albumTitle: item.albumTitle, purchased: true }
          : item;
        const existing = Object.values(data.tracks).find(e => e.url === entry.url);
        if (existing) { existing.purchased = true; updated++; }
        else if (entry.id) { data.tracks[entry.id] = entry; added++; }
      }
    }
    writeData(data);
    send({ done: true, added, updated, total });
  } catch (err) {
    console.error('collection error:', err.message);
    send({ error: err.message });
  }
  res.end();
});

// ---------------------------------------------------------------------------
// Cart queue (bookmarklet communication)
// ---------------------------------------------------------------------------

app.get('/api/cart/queue', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const data = readData();
  res.json({ tracks: data.cartQueue ?? [], fanId: data.settings.fanId ?? '' });
});

app.post('/api/cart/queue', (req, res) => {
  const data = readData();
  data.cartQueue = req.body.tracks ?? [];
  writeData(data);
  res.json({ ok: true, count: data.cartQueue.length });
});

app.options('/api/cart/queue', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

app.delete('/api/cart/queue', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const data = readData();
  data.cartQueue = [];
  writeData(data);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Cart pull (fetches bandcamp.com/cart page with cookie)
// ---------------------------------------------------------------------------

app.get('/api/cart/pull', async (req, res) => {
  const data = readData();
  if (!data.settings.bandcampCookie) {
    return res.status(400).json({ error: 'Bandcamp cookie required in Settings' });
  }

  try {
    const response = await fetch('https://bandcamp.com/cart', {
      headers: {
        'Cookie': data.settings.bandcampCookie,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const html = await response.text();
    const items = parseCartItems(html);
    res.json({ items });
  } catch (err) {
    console.error('cart pull error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function parseCartItems(html) {
  const items = [];
  try {
    // Try to find embedded JSON in the cart page
    // Bandcamp embeds item data in various script tags / data attributes
    const cartJsonMatch = html.match(/var\s+ItemCache\s*=\s*(\{.*?\});/s)
      ?? html.match(/data-cart=["'](\{.*?\})["']/s)
      ?? html.match(/"cart_items"\s*:\s*(\[.*?\])/s);

    if (cartJsonMatch) {
      const parsed = JSON.parse(cartJsonMatch[1]);
      const rawItems = Array.isArray(parsed) ? parsed : Object.values(parsed.items ?? parsed);
      for (const item of rawItems) {
        items.push({
          id: uuidv4(),
          url: item.item_url ?? item.url ?? null,
          albumUrl: item.album_url ?? null,
          title: item.item_title ?? item.title ?? 'Unknown',
          artist: item.band_name ?? item.artist ?? 'Unknown',
          albumTitle: item.album_title ?? null,
          artwork: item.item_art ?? item.image_url ?? null,
          price: item.unit_price ?? item.price ?? null,
          currency: item.currency ?? 'USD',
          bcTrackId: item.id ?? null,
          bcAlbumId: item.album_id ?? null,
          purchased: false,
          notes: '',
          addedAt: new Date().toISOString()
        });
      }
    } else {
      // Fallback: parse cart item elements from HTML
      const itemMatches = html.matchAll(/class="[^"]*cart-item[^"]*"[^>]*data-track="([^"]+)"/g);
      for (const match of itemMatches) {
        try {
          const itemData = JSON.parse(decodeURIComponent(match[1]));
          items.push({
            id: uuidv4(),
            url: itemData.url ?? null,
            albumUrl: null,
            title: itemData.title ?? 'Unknown',
            artist: itemData.artist ?? 'Unknown',
            albumTitle: itemData.album ?? null,
            artwork: itemData.art ?? null,
            price: itemData.price ?? null,
            currency: 'USD',
            bcTrackId: itemData.id ?? null,
            bcAlbumId: null,
            purchased: false,
            notes: '',
            addedAt: new Date().toISOString()
          });
        } catch { /* skip malformed item */ }
      }
    }
  } catch (err) {
    console.error('cart parse error:', err.message);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Track refresh — re-fetch metadata from Bandcamp, preserve user data
// ---------------------------------------------------------------------------

app.post('/api/track/refresh', async (req, res) => {
  const { trackId } = req.body;
  if (!trackId) return res.status(400).json({ error: 'trackId required' });

  const data = readData();
  applySettings(data);

  const track = data.tracks[trackId];
  if (!track) return res.status(404).json({ error: 'Track not found' });

  const withTimeout = (p, ms = 15000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  try {
    let updated;
    if (track.url?.includes('/track/')) {
      // Fetch track page first — contains per-track price in inAlbum
      const info = await withTimeout(bcfetch.track.getInfo({ trackUrl: track.url, includeRawData: true }));
      if (track.albumUrl) {
        // Also fetch album for tags/metadata, but use `info` for price
        const albumInfo = await withTimeout(bcfetch.album.getInfo({ albumUrl: track.albumUrl, includeRawData: true }));
        const t = albumInfo.tracks?.find(x => x.position === track.albumTrackNum || x.name === track.title) ?? info;
        updated = buildTrackRecord(t, albumInfo, info);
      } else {
        updated = buildTrackRecord(info);
      }
    } else if (track.albumUrl) {
      // Album-only track: album page has the price
      const albumInfo = await withTimeout(bcfetch.album.getInfo({ albumUrl: track.albumUrl, includeRawData: true }));
      const t = albumInfo.tracks?.find(x => x.position === track.albumTrackNum || x.name === track.title);
      if (t) updated = buildTrackRecord(t, albumInfo);
    }

    if (!updated) return res.status(500).json({ error: 'Could not re-fetch track data' });

    // Preserve user-owned fields
    updated.id = trackId;
    updated.purchased = track.purchased;
    updated.notes = track.notes;
    updated.addedAt = track.addedAt;

    data.tracks[trackId] = updated;
    writeData(data);
    res.json({ track: updated });
  } catch (err) {
    console.error('refresh error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Bandcamp track/album lookup by ID (for cart items that lack a URL)
// ---------------------------------------------------------------------------

app.get('/api/track/lookup-bc-id', async (req, res) => {
  const { id, type = 't', band_id = '0' } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const r = await fetch(
      `https://bandcamp.com/api/tralbum/2/info?tralbum_id=${id}&tralbum_type=${type}&band_id=${band_id}`
    );
    if (!r.ok) throw new Error(`Bandcamp API ${r.status}`);
    const data = await r.json();
    // Return the fields we care about
    res.json({
      url:        data.url        ?? null,
      title:      data.title      ?? null,
      artist:     data.artist     ?? data.band_name ?? null,
      albumTitle: data.album_title ?? null,
      artwork:    data.art_id     ? `https://f4.bcbits.com/img/a${data.art_id}_2.jpg` : null,
      duration:   data.duration   ?? null,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Exchange rates proxy (avoids CORS when called from the browser)
// ---------------------------------------------------------------------------

app.get('/api/exchange-rates', async (req, res) => {
  try {
    const r = await fetch('https://api.frankfurter.app/latest?base=GBP');
    if (!r.ok) throw new Error(`frankfurter ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`\nBandcamp Hub running → http://localhost:${PORT}\n`);
});
