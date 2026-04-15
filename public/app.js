// ── State ────────────────────────────────────────────────────────────────
let state = {
  playlists: [],
  tracks: {},
  settings: { bandcampCookie: '', fanUsername: '', fanId: '' },
  folders: [],
  sidebarOrder: [],
  cartItems: [],
  wishlistItems: []
};

let ui = {
  activePlaylistId: null,
  activeLibView: null,  // 'purchased' | 'cart' | 'wishlist' | null
  selectedTrackId: null,
  selectedTrackIds: new Set(),  // checkboxes (bulk operations)
  contextTrackId: null,
  contextPlaylistId: null,
  collapsedAlbums: new Set(),
  pendingPickerItems: [],
  cartPulledItems: [],
  playlistSearchQuery: '',
  detailPlaylistSearch: ''
};

let genreDropdownEl = null;
let dragState = { type: null, id: null, sourceItem: null }; // type: 'playlist'|'folder'|'track'
let fxRates = {}; // exchange rates relative to GBP (e.g. { EUR: 1.17, USD: 1.27 })

async function fetchExchangeRates() {
  try {
    const res = await fetch('https://api.frankfurter.app/latest?base=GBP');
    const data = await res.json();
    fxRates = { ...data.rates, GBP: 1 };
  } catch (e) {
    console.warn('Could not fetch exchange rates:', e.message);
  }
}

function toGBP(amount, currency) {
  if (!amount || isNaN(amount)) return 0;
  const cur = (currency ?? 'GBP').toUpperCase();
  if (cur === 'GBP') return amount;
  const rate = fxRates[cur];
  return rate ? amount / rate : amount; // fallback: unconverted if rate missing
}

function fmtGBP(amount) {
  return `£${amount.toFixed(2)}`;
}

let player = {
  trackId: null,
  playlistId: null,
  isPlaying: false,
  isLoading: false
};

// ── API helpers ──────────────────────────────────────────────────────────
const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const text = await r.text();
      let msg = text;
      try { msg = JSON.parse(text).error ?? text; } catch {}
      throw new Error(msg);
    }
    return r.json();
  }
};

// ── Persistence ──────────────────────────────────────────────────────────
let saveTimer = null;
function schedSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
async function saveNow() {
  try {
    await api.post('/api/data', {
      playlists: state.playlists, tracks: state.tracks,
      settings: state.settings, folders: state.folders,
      sidebarOrder: state.sidebarOrder,
      cartItems: state.cartItems, wishlistItems: state.wishlistItems
    });
  } catch (e) { toast('Save failed: ' + e.message, 'error'); }
}

// ── Boot ─────────────────────────────────────────────────────────────────
async function boot() {
  const tc = document.createElement('div');
  tc.id = 'toast-container';
  document.body.appendChild(tc);

  try {
    const data = await api.get('/api/data');
    state.playlists = data.playlists ?? [];
    state.tracks = data.tracks ?? {};
    state.settings = data.settings ?? { bandcampCookie: '', fanUsername: '', fanId: '' };
    state.folders = data.folders ?? [];
    state.sidebarOrder = data.sidebarOrder ??
      state.playlists.map(p => ({ type: 'playlist', id: p.id }));
    state.cartItems     = data.cartItems     ?? [];
    state.wishlistItems = data.wishlistItems ?? [];
  } catch (e) { toast('Could not load data: ' + e.message, 'error'); }

  await fetchExchangeRates();
  bindEvents();
  renderSidebar();
  if (state.playlists.length > 0) selectPlaylist(state.playlists[0].id);
  else renderContent();
}

// ── Helpers ──────────────────────────────────────────────────────────────
function fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtPrice(track) {
  if (track.purchased) return '✓ Owned';
  if (track.price == null || track.price === '') return '';
  const p = parseFloat(track.price);
  if (isNaN(p)) return '';
  if (p === 0) return 'Free';
  const currencySymbols = { USD: '$', GBP: '£', EUR: '€', CAD: 'CA$', AUD: 'A$', JPY: '¥', NZD: 'NZ$', CHF: 'CHF ', SEK: 'kr ', DKK: 'kr ', NOK: 'kr ' };
  const cur = (track.currency ?? 'USD').toUpperCase();
  const sym = currencySymbols[cur] ?? (cur + ' ');
  return `${sym}${p.toFixed(2)}`;
}

function fmtDate(str) {
  if (!str) return null;
  try {
    return new Date(str).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return str; }
}

function toast(msg, type = '') {
  const tc = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  tc.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getPlaylist(id) { return state.playlists.find(p => p.id === id); }
function getTrack(id)    { return state.tracks[id]; }

function playlistTrackIds(playlistId) {
  const pl = getPlaylist(playlistId);
  return pl ? pl.trackIds.filter(id => state.tracks[id]) : [];
}

// ── Album grouping ────────────────────────────────────────────────────────
// Returns ordered groups: [{type:'album', albumUrl, albumTitle, artwork, artist, releaseDate, trackIds[]}, {type:'track', trackId}]
function groupTracksByAlbum(trackIds) {
  const groups = [];
  const seen = new Map(); // albumUrl → group index

  for (const id of trackIds) {
    const t = state.tracks[id];
    if (!t) continue;

    if (t.albumUrl) {
      if (seen.has(t.albumUrl)) {
        groups[seen.get(t.albumUrl)].trackIds.push(id);
      } else {
        const idx = groups.length;
        seen.set(t.albumUrl, idx);
        groups.push({
          type: 'album',
          albumUrl: t.albumUrl,
          albumTitle: t.albumTitle ?? 'Unknown Album',
          artwork: t.artwork,
          artist: t.artist,
          releaseDate: t.releaseDate,
          trackIds: [id]
        });
      }
    } else {
      groups.push({ type: 'track', trackId: id });
    }
  }

  // Flatten single-track albums back to individual tracks
  return groups.map(g => {
    if (g.type === 'album' && g.trackIds.length === 1) {
      return { type: 'track', trackId: g.trackIds[0] };
    }
    return g;
  });
}

// ── Render: Library counts ───────────────────────────────────────────────
function renderLibraryCounts() {
  const purchasedCount = Object.values(state.tracks).filter(t => t.purchased).length;
  const cartCount      = state.cartItems.length;
  const wishlistCount  = state.wishlistItems.length;

  setLibCount('lib-purchased-count', purchasedCount);
  setLibCount('lib-cart-count',      cartCount);
  setLibCount('lib-wishlist-count',  wishlistCount);

  // Highlight active lib view
  document.querySelectorAll('.library-item').forEach(el => {
    el.classList.toggle('active', el.dataset.lib === ui.activeLibView);
  });
}

function setLibCount(id, n) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = n > 0 ? n : '';
  el.style.display = n > 0 ? '' : 'none';
}

// ── Render: Sidebar ──────────────────────────────────────────────────────
function renderSidebar() {
  renderLibraryCounts();
  const ul = document.getElementById('playlist-list');
  ul.innerHTML = '';
  const q = ui.playlistSearchQuery.toLowerCase();

  if (q) {
    const filtered = state.playlists.filter(p => p.name.toLowerCase().includes(q));
    for (const pl of filtered) ul.appendChild(buildPlaylistItem(pl, false));
    return;
  }

  for (const item of state.sidebarOrder) {
    if (item.type === 'folder') {
      const folder = state.folders.find(f => f.id === item.id);
      if (folder) ul.appendChild(buildFolderItem(folder));
    } else if (item.type === 'playlist') {
      const pl = getPlaylist(item.id);
      if (pl) ul.appendChild(buildPlaylistItem(pl, false));
    }
  }
}

function buildPlaylistItem(pl, inFolder) {
  const li = document.createElement('li');
  li.className = 'playlist-item' + (inFolder ? ' folder-child' : '');
  li.dataset.id = pl.id;
  li.dataset.type = 'playlist';
  li.draggable = true;
  if (pl.id === ui.activePlaylistId) li.classList.add('active');
  const count = pl.trackIds.filter(id => state.tracks[id]).length;
  li.innerHTML = `
    <span class="drag-handle" title="Drag to reorder">⠿</span>
    <span class="playlist-icon">♫</span>
    <span class="playlist-name">${esc(pl.name)}</span>
    <span class="playlist-count">${count}</span>`;

  li.addEventListener('click', () => selectPlaylist(pl.id));
  li.addEventListener('dblclick', e => {
    if (e.target.classList.contains('playlist-name')) startRename(pl.id, e.target);
  });

  li.addEventListener('dragstart', e => {
    dragState = { type: 'playlist', id: pl.id, inFolder };
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => li.classList.add('dragging'), 0);
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    clearDragOver();
  });
  li.addEventListener('dragover', e => {
    if (dragState.type === 'playlist') { e.preventDefault(); li.classList.add('drag-over'); }
    else if (dragState.type === 'track') { e.preventDefault(); li.classList.add('drag-over'); }
  });
  li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
  li.addEventListener('drop', e => {
    e.preventDefault(); li.classList.remove('drag-over');
    if (dragState.type === 'playlist' && dragState.id !== pl.id) {
      reorderPlaylistItem(dragState.id, pl.id, inFolder);
    } else if (dragState.type === 'track') {
      dropTrackOnPlaylist(dragState.id, pl.id);
    }
  });
  return li;
}

function buildFolderItem(folder) {
  const li = document.createElement('li');
  li.className = 'folder-item';
  li.dataset.id = folder.id;
  li.dataset.type = 'folder';

  const playlists = folder.playlistIds.map(id => getPlaylist(id)).filter(Boolean);

  li.innerHTML = `
    <div class="folder-header" draggable="true">
      <svg class="folder-chevron ${folder.collapsed ? 'collapsed' : ''}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
      <svg class="folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      <span class="folder-name">${esc(folder.name)}</span>
      <button class="folder-delete-btn" title="Delete folder">✕</button>
    </div>
    <ul class="folder-children ${folder.collapsed ? 'hidden' : ''}"></ul>`;

  const childUl = li.querySelector('.folder-children');
  for (const pl of playlists) childUl.appendChild(buildPlaylistItem(pl, true));

  const header = li.querySelector('.folder-header');

  header.querySelector('.folder-delete-btn').addEventListener('click', e => {
    e.stopPropagation();
    if (!confirm(`Delete folder "${folder.name}"? Playlists inside will be moved to root.`)) return;
    // Move contained playlists back to root
    folder.playlistIds.forEach(pid => {
      state.sidebarOrder.push({ type: 'playlist', id: pid });
    });
    state.folders = state.folders.filter(f => f.id !== folder.id);
    state.sidebarOrder = state.sidebarOrder.filter(o => !(o.type === 'folder' && o.id === folder.id));
    schedSave(); renderSidebar();
  });

  header.addEventListener('click', e => {
    if (e.target.closest('.folder-delete-btn')) return;
    if (e.target.classList.contains('folder-name') && e.detail === 2) {
      startFolderRename(folder.id, e.target); return;
    }
    folder.collapsed = !folder.collapsed;
    schedSave(); renderSidebar();
  });

  // Drag folder to reorder
  header.addEventListener('dragstart', e => {
    dragState = { type: 'folder', id: folder.id };
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => li.classList.add('dragging'), 0);
    e.stopPropagation();
  });
  header.addEventListener('dragend', () => { li.classList.remove('dragging'); clearDragOver(); });

  // Drop onto folder header: move playlist into folder
  header.addEventListener('dragover', e => {
    if (dragState.type === 'playlist' || dragState.type === 'folder') {
      e.preventDefault(); header.classList.add('drag-over');
    }
  });
  header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
  header.addEventListener('drop', e => {
    e.preventDefault(); header.classList.remove('drag-over');
    if (dragState.type === 'playlist') {
      movePlaylistToFolder(dragState.id, folder.id);
    } else if (dragState.type === 'folder' && dragState.id !== folder.id) {
      reorderFolderItem(dragState.id, folder.id);
    }
  });

  return li;
}

function clearDragOver() {
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
}

function startRename(playlistId, nameEl) {
  const pl = getPlaylist(playlistId);
  if (!pl) return;
  const inp = document.createElement('input');
  inp.className = 'playlist-name-input';
  inp.value = pl.name;
  nameEl.replaceWith(inp);
  inp.focus(); inp.select();
  const finish = () => {
    const val = inp.value.trim();
    if (val) { pl.name = val; schedSave(); }
    renderSidebar();
    if (ui.activePlaylistId === playlistId) document.getElementById('playlist-title').textContent = pl.name;
  };
  inp.addEventListener('blur', finish);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') inp.blur();
    if (e.key === 'Escape') { inp.value = pl.name; inp.blur(); }
  });
}

function startFolderRename(folderId, nameEl) {
  const folder = state.folders.find(f => f.id === folderId);
  if (!folder) return;
  const inp = document.createElement('input');
  inp.className = 'playlist-name-input';
  inp.value = folder.name;
  nameEl.replaceWith(inp);
  inp.focus(); inp.select();
  const finish = () => {
    const val = inp.value.trim();
    if (val) { folder.name = val; schedSave(); }
    renderSidebar();
  };
  inp.addEventListener('blur', finish);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') inp.blur();
    if (e.key === 'Escape') { inp.value = folder.name; inp.blur(); }
  });
}

// ── Drag-and-drop: sidebar reordering ─────────────────────────────────────
function reorderPlaylistItem(draggedId, targetId, targetInFolder) {
  if (targetInFolder) {
    // Dropping onto a playlist inside a folder
    const targetFolder = state.folders.find(f => f.playlistIds.includes(targetId));
    if (!targetFolder) return;

    const draggedFolder = state.folders.find(f => f.playlistIds.includes(draggedId));
    if (draggedFolder && draggedFolder.id === targetFolder.id) {
      // Reorder within the same folder
      const from = draggedFolder.playlistIds.indexOf(draggedId);
      const to   = targetFolder.playlistIds.indexOf(targetId);
      draggedFolder.playlistIds.splice(from, 1);
      draggedFolder.playlistIds.splice(to, 0, draggedId);
    } else {
      // Move into target's folder (from root or different folder)
      removePlaylistFromCurrentLocation(draggedId);
      const to = targetFolder.playlistIds.indexOf(targetId);
      targetFolder.playlistIds.splice(to, 0, draggedId);
      toast(`Moved into "${targetFolder.name}"`);
    }
  } else {
    // Dropping onto a root playlist — move dragged item to root
    const draggedInFolder = state.folders.find(f => f.playlistIds.includes(draggedId));
    if (draggedInFolder) {
      // Move out of folder to root, positioned near target
      removePlaylistFromCurrentLocation(draggedId);
      const to = state.sidebarOrder.findIndex(o => o.type === 'playlist' && o.id === targetId);
      state.sidebarOrder.splice(to, 0, { type: 'playlist', id: draggedId });
      toast(`Moved to root`);
    } else {
      // Reorder within root
      const from = state.sidebarOrder.findIndex(o => o.type === 'playlist' && o.id === draggedId);
      const to   = state.sidebarOrder.findIndex(o => o.type === 'playlist' && o.id === targetId);
      if (from < 0 || to < 0) return;
      const [item] = state.sidebarOrder.splice(from, 1);
      state.sidebarOrder.splice(to, 0, item);
    }
  }
  schedSave(); renderSidebar();
}

function removePlaylistFromCurrentLocation(playlistId) {
  const orderIdx = state.sidebarOrder.findIndex(o => o.type === 'playlist' && o.id === playlistId);
  if (orderIdx >= 0) state.sidebarOrder.splice(orderIdx, 1);
  state.folders.forEach(f => {
    const i = f.playlistIds.indexOf(playlistId);
    if (i >= 0) f.playlistIds.splice(i, 1);
  });
}

function reorderFolderItem(draggedFolderId, targetFolderId) {
  const from = state.sidebarOrder.findIndex(o => o.type === 'folder' && o.id === draggedFolderId);
  const to   = state.sidebarOrder.findIndex(o => o.type === 'folder' && o.id === targetFolderId);
  if (from < 0 || to < 0) return;
  const [item] = state.sidebarOrder.splice(from, 1);
  state.sidebarOrder.splice(to, 0, item);
  schedSave(); renderSidebar();
}

function movePlaylistToFolder(playlistId, folderId) {
  const folder = state.folders.find(f => f.id === folderId);
  if (!folder || folder.playlistIds.includes(playlistId)) return;
  removePlaylistFromCurrentLocation(playlistId);
  folder.playlistIds.push(playlistId);
  schedSave(); renderSidebar();
  toast(`Moved into "${folder.name}"`);
}

// ── Drag-and-drop: tracks onto playlists ──────────────────────────────────
function dropTrackOnPlaylist(trackId, playlistId) {
  const pl = getPlaylist(playlistId);
  if (!pl) return;

  // If the track isn't in state.tracks yet (e.g. from wishlist), upsert it first
  let t = state.tracks[trackId];
  if (!t && dragState.sourceItem) {
    t = { ...dragState.sourceItem };
    if (!t.id) t.id = crypto.randomUUID();
    trackId = t.id;
    state.tracks[trackId] = t;
  }
  if (!t) return;

  if (pl.trackIds.includes(trackId)) {
    if (!confirm(`"${t.title}" is already in "${pl.name}". Add a copy anyway?`)) return;
    const copy = { ...t, id: crypto.randomUUID(), addedAt: new Date().toISOString() };
    state.tracks[copy.id] = copy;
    pl.trackIds.push(copy.id);
  } else {
    pl.trackIds.push(trackId);
  }
  schedSave();
  renderSidebar();
  if (ui.activePlaylistId === playlistId) renderContent();
  toast(`Added to "${pl.name}"`);
}

// ── Render: Content ──────────────────────────────────────────────────────
function selectPlaylist(id) {
  ui.activePlaylistId = id;
  ui.activeLibView = null;
  ui.selectedTrackIds.clear();
  renderSidebar();
  renderContent();
}

function selectLibView(view) {
  ui.activeLibView = view;
  ui.activePlaylistId = null;
  ui.selectedTrackIds.clear();
  renderSidebar();
  renderLibContent(view);
}

function renderLibContent(view) {
  const titleEl   = document.getElementById('playlist-title');
  const actionsEl = document.getElementById('playlist-actions');
  const emptyEl   = document.getElementById('track-list-empty');
  const listEl    = document.getElementById('track-list');
  const colHdr    = document.getElementById('track-col-header');

  document.getElementById('add-track-bar').classList.add('hidden');
  actionsEl.classList.add('hidden');

  const pullActions = document.getElementById('lib-pull-actions');
  document.getElementById('pull-purchased-btn').classList.add('hidden');
  document.getElementById('pull-wishlist-header-btn').classList.add('hidden');
  pullActions.classList.remove('hidden');

  let items = [];
  if (view === 'purchased') {
    titleEl.textContent = 'Purchased';
    items = Object.values(state.tracks).filter(t => t.purchased);
    document.getElementById('pull-purchased-btn').classList.remove('hidden');
  } else if (view === 'cart') {
    titleEl.textContent = 'Cart';
    items = state.cartItems;
    pullActions.classList.add('hidden');
  } else if (view === 'wishlist') {
    titleEl.textContent = 'Wishlist';
    items = state.wishlistItems;
    document.getElementById('pull-wishlist-header-btn').classList.remove('hidden');
  }

  listEl.innerHTML = '';
  if (!items.length) {
    emptyEl.classList.remove('hidden');
    colHdr.classList.add('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  colHdr.classList.remove('hidden');

  if (view === 'purchased') {
    // Purchased: render as normal track rows (they're full track objects)
    const groups = groupTracksByAlbum(items.map(t => t.id));
    for (const group of groups) {
      if (group.type === 'track') listEl.appendChild(buildTrackRow(group.trackId, null));
      else listEl.appendChild(buildAlbumGroup(group, null));
    }
  } else {
    // Cart / Wishlist: simpler rows (items may be partial)
    items.forEach((item, idx) => {
      const li = document.createElement('li');
      li.className = 'track-item track-grid';
      const artHtml = item.artwork
        ? `<img class="track-art" src="${esc(item.artwork)}" alt="" loading="lazy">`
        : `<div class="track-art-placeholder">♪</div>`;
      li.innerHTML = `
        <div class="col-check"></div>
        <div class="col-num"><span class="col-num-static">${idx + 1}</span></div>
        ${artHtml}
        <div class="col-title"><div class="track-title">${esc(item.title ?? '')}</div></div>
        <div class="col-time">${fmtDuration(item.duration)}</div>
        <div class="col-artist">${esc(item.artist ?? '')}</div>
        <div class="col-album">${esc(item.albumTitle ?? '')}</div>
        <div class="col-genre"></div>
        <div class="col-price">${item.price ? fmtPrice(item) : ''}</div>
        <div></div>
        <button class="track-menu-btn" title="More options">⋯</button>`;
      li.querySelector('.track-menu-btn').addEventListener('click', e => {
        e.stopPropagation();
        if (item.url) window.open(item.url, '_blank');
      });

      // Drag to playlist
      if (view === 'wishlist') {
        li.draggable = true;
        li.title = 'Drag to a playlist';
        li.addEventListener('dragstart', e => {
          dragState = { type: 'track', id: item.id ?? null, sourceItem: item };
          e.dataTransfer.effectAllowed = 'copy';
          setTimeout(() => li.classList.add('dragging'), 0);
        });
        li.addEventListener('dragend', () => { li.classList.remove('dragging'); clearDragOver(); });
      }

      listEl.appendChild(li);
    });
  }

  if (view === 'purchased' || view === 'wishlist') {
    renderLibStats(view, items);
  } else {
    document.getElementById('playlist-stats').classList.add('hidden');
  }
}

function renderContent() {
  const pl = getPlaylist(ui.activePlaylistId);
  const titleEl   = document.getElementById('playlist-title');
  const actionsEl = document.getElementById('playlist-actions');
  const emptyEl   = document.getElementById('track-list-empty');
  const listEl    = document.getElementById('track-list');
  const colHdr    = document.getElementById('track-col-header');

  if (!pl) {
    titleEl.textContent = 'Select a playlist';
    actionsEl.classList.add('hidden');
    document.getElementById('add-track-bar').classList.add('hidden');
    emptyEl.classList.remove('hidden');
    listEl.innerHTML = '';
    colHdr.classList.add('hidden');
    return;
  }

  document.getElementById('add-track-bar').classList.remove('hidden');
  document.getElementById('lib-pull-actions').classList.add('hidden');
  titleEl.textContent = pl.name;
  actionsEl.classList.remove('hidden');

  const ids = pl.trackIds.filter(id => state.tracks[id]);
  const hasItems = ids.length > 0;
  emptyEl.classList.toggle('hidden', hasItems);
  colHdr.classList.toggle('hidden', !hasItems);
  listEl.innerHTML = '';

  const groups = groupTracksByAlbum(ids);
  for (const group of groups) {
    if (group.type === 'track') {
      listEl.appendChild(buildTrackRow(group.trackId, pl.id));
    } else {
      listEl.appendChild(buildAlbumGroup(group, pl.id));
    }
  }

  updateBulkActionsVisibility();
  renderPlaylistStats(ids);
  normaliseGenrePillWidths();
}

function calcPlaylistPriceGBP(ids) {
  // Sum unique album prices once + individual track prices, all converted to GBP
  const groups = groupTracksByAlbum(ids);
  let total = 0;
  for (const g of groups) {
    if (g.type === 'track') {
      const t = state.tracks[g.trackId];
      if (t?.price && !t.purchased) total += toGBP(parseFloat(t.price), t.currency);
    } else {
      const t = state.tracks[g.trackIds[0]];
      const albumP = t?.albumPrice ?? t?.price;
      if (albumP && !g.trackIds.every(id => state.tracks[id]?.purchased)) {
        total += toGBP(parseFloat(albumP), t.currency);
      }
    }
  }
  return total;
}

function renderLibStats(view, items) {
  const statsEl = document.getElementById('playlist-stats');
  const ownedEl = document.getElementById('stat-owned');
  const ownedSepEl = document.getElementById('stat-sep-owned');

  if (!items || !items.length) { statsEl.classList.add('hidden'); return; }
  statsEl.classList.remove('hidden');

  // Hide "owned" — redundant for Purchased, always 0 for Wishlist
  ownedEl.textContent = '';
  ownedEl.classList.add('hidden');
  ownedSepEl.classList.add('hidden');

  const trackCount = items.length;
  const totalDur   = items.reduce((s, t) => s + (t.duration ?? 0), 0);

  // Total price: for wishlist sum prices; for purchased sum what was paid
  let totalGBP = 0;
  for (const t of items) {
    if (t.price && parseFloat(t.price) > 0) {
      totalGBP += toGBP(parseFloat(t.price), t.currency);
    }
  }

  document.getElementById('stat-tracks').textContent = `${trackCount} track${trackCount !== 1 ? 's' : ''}`;
  document.getElementById('stat-duration').textContent = fmtDuration(totalDur);
  document.getElementById('stat-total-price').textContent = totalGBP > 0 ? `Total: ${fmtGBP(totalGBP)}` : 'Total: —';
  document.getElementById('stat-selected-price').classList.add('hidden');
}

function normaliseGenrePillWidths() {
  const pills = document.querySelectorAll('#track-list .genre-pill');
  if (!pills.length) return;
  // Reset so natural widths are measured
  pills.forEach(p => p.style.width = '');
  requestAnimationFrame(() => {
    let max = 0;
    pills.forEach(p => { max = Math.max(max, p.offsetWidth); });
    if (max > 0) pills.forEach(p => p.style.width = max + 'px');
  });
}

function renderPlaylistStats(ids) {
  const statsEl = document.getElementById('playlist-stats');
  if (!statsEl) return;

  // Restore owned stat visibility (may have been hidden by renderLibStats)
  document.getElementById('stat-owned').classList.remove('hidden');
  document.getElementById('stat-sep-owned').classList.remove('hidden');

  if (!ids || !ids.length) {
    statsEl.classList.add('hidden'); return;
  }
  statsEl.classList.remove('hidden');

  const tracks = ids.map(id => state.tracks[id]).filter(Boolean);
  const trackCount  = tracks.length;
  const totalDur    = tracks.reduce((s, t) => s + (t.duration ?? 0), 0);
  const ownedCount  = tracks.filter(t => t.purchased).length;
  const totalGBP = calcPlaylistPriceGBP(ids);

  document.getElementById('stat-tracks').textContent =
    `${trackCount} track${trackCount !== 1 ? 's' : ''}`;
  document.getElementById('stat-duration').textContent = fmtDuration(totalDur);
  document.getElementById('stat-owned').textContent =
    ownedCount > 0 ? `${ownedCount} owned` : '0 owned';
  document.getElementById('stat-total-price').textContent =
    totalGBP > 0 ? `Total: ${fmtGBP(totalGBP)}` : 'Total: —';

  updateSelectedStats(ids);
}

function updateSelectedStats(ids) {
  const selEl = document.getElementById('stat-selected-price');
  if (!selEl) return;
  const allIds = ids ?? getPlaylist(ui.activePlaylistId)?.trackIds ?? [];
  if (!ui.selectedTrackIds.size) { selEl.classList.add('hidden'); return; }

  // Mirror calcPlaylistPriceGBP but only for selected tracks/albums
  const groups = groupTracksByAlbum(allIds);
  let selGBP = 0;
  for (const g of groups) {
    if (g.type === 'track') {
      if (!ui.selectedTrackIds.has(g.trackId)) continue;
      const t = state.tracks[g.trackId];
      if (t?.price && !t.purchased) selGBP += toGBP(parseFloat(t.price), t.currency);
    } else {
      // Any track from album selected → count album price once
      if (!g.trackIds.some(id => ui.selectedTrackIds.has(id))) continue;
      const t = state.tracks[g.trackIds[0]];
      const albumP = t?.albumPrice ?? t?.price;
      if (albumP && !g.trackIds.every(id => state.tracks[id]?.purchased)) {
        selGBP += toGBP(parseFloat(albumP), t.currency);
      }
    }
  }

  selEl.classList.remove('hidden');
  selEl.textContent = `· Selected: ${fmtGBP(selGBP)}`;
}

function buildTrackRow(trackId, playlistId) {
  const t = state.tracks[trackId];
  const isPlaying = player.trackId === trackId;
  const isChecked = ui.selectedTrackIds.has(trackId);

  const li = document.createElement('li');
  li.className = 'track-item track-grid' +
    (isPlaying ? ' playing' : '') +
    (isChecked ? ' checked' : '');
  li.dataset.trackId = trackId;
  li.dataset.playlistId = playlistId;
  li.draggable = true;
  li.addEventListener('dragstart', e => {
    dragState = { type: 'track', id: trackId, sourceItem: null };
    e.dataTransfer.effectAllowed = 'copy';
  });
  li.addEventListener('dragend', clearDragOver);

  const artHtml = t.artwork
    ? `<img class="track-art" src="${esc(t.artwork)}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="track-art-placeholder">♪</div>`;

  const displayGenre = t.genre ?? t.tags?.[0] ?? '';
  const hasMoreTags  = (t.tags?.length ?? 0) > 1;
  const genreHtml = displayGenre
    ? `<span class="genre-pill${hasMoreTags ? ' clickable' : ''}" title="${hasMoreTags ? 'Change genre' : esc(displayGenre)}">${esc(displayGenre)}${hasMoreTags ? '<span class="genre-chevron">▾</span>' : ''}</span>`
    : `<span></span>`;

  li.innerHTML = `
    <div class="col-check">
      <input type="checkbox" class="track-cb" ${isChecked ? 'checked' : ''} title="Select">
    </div>
    <div class="col-num">
      <span class="col-num-static"></span>
      <div class="track-playing-indicator">
        <div class="bars"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>
      </div>
    </div>
    ${artHtml}
    <div class="col-title"><div class="track-title">${esc(t.title)}</div></div>
    <div class="col-time">${fmtDuration(t.duration)}</div>
    <div class="col-artist">${esc(t.artist)}</div>
    <div class="col-album">${esc(t.albumTitle ?? '')}</div>
    <div class="col-genre">${genreHtml}</div>
    <div class="col-price">${esc(fmtPrice(t))}</div>
    <button class="track-cart-btn" title="Add to Bandcamp cart">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
      </svg>
      Cart
    </button>
    <div class="col-actions">
      <button class="track-menu-btn" title="More options">⋯</button>
      ${playlistId ? `<button class="track-remove-btn" title="Remove from playlist">✕</button>` : ''}
    </div>`;

  // Checkbox: toggle selection, stop row click propagation
  const cb = li.querySelector('.track-cb');
  cb.addEventListener('click', e => e.stopPropagation());
  cb.addEventListener('change', () => toggleTrackCheck(trackId));

  // Cart button
  li.querySelector('.track-cart-btn').addEventListener('click', e => {
    e.stopPropagation();
    pushToCart(trackId);
  });

  // Remove button
  const removeBtn = li.querySelector('.track-remove-btn');
  if (removeBtn) {
    removeBtn.addEventListener('click', e => {
      e.stopPropagation();
      removeFromPlaylist(trackId, playlistId);
    });
  }

  // Genre edit button
  const genreBtn = li.querySelector('.genre-pill.clickable');
  if (genreBtn) {
    genreBtn.addEventListener('click', e => {
      e.stopPropagation();
      openGenreEdit(trackId, genreBtn);
    });
  }

  // Row click: play + detail (ignore checkbox/cart/genre/menu targets)
  li.addEventListener('click', e => {
    if (e.target.closest('.col-check') ||
        e.target.closest('.track-cart-btn') ||
        e.target.closest('.track-remove-btn') ||
        e.target.closest('.col-genre') ||
        e.target.classList.contains('track-menu-btn')) return;
    playTrack(trackId, playlistId);
    selectTrack(trackId);
  });

  // Context menu button
  li.querySelector('.track-menu-btn').addEventListener('click', e => {
    e.stopPropagation();
    showContextMenu(e, trackId, playlistId);
  });

  return li;
}

function buildAlbumGroup(group, playlistId) {
  const key = group.albumUrl;
  const collapsed = ui.collapsedAlbums.has(key);

  const li = document.createElement('li');
  li.className = 'album-group' + (collapsed ? ' collapsed' : '');
  li.dataset.albumUrl = key;

  // Totals
  const totalDur = group.trackIds.reduce((s, id) => s + (state.tracks[id]?.duration ?? 0), 0);
  const durStr = totalDur > 0 ? fmtDuration(totalDur) : '';
  const countStr = `${group.trackIds.length} track${group.trackIds.length !== 1 ? 's' : ''}`;
  const dateStr = group.releaseDate ? fmtDate(group.releaseDate) : '';
  // Album price: prefer stored albumPrice field, fall back to track price
  const firstTrack = state.tracks[group.trackIds[0]];
  const albumPriceVal = firstTrack?.albumPrice ?? firstTrack?.price ?? null;
  const albumPriceTrack = albumPriceVal ? { price: albumPriceVal, currency: firstTrack?.currency, purchased: false } : null;
  const albumPriceStr = albumPriceTrack ? fmtPrice(albumPriceTrack) : '';
  const metaParts = [countStr, durStr, dateStr].filter(Boolean);

  const artHtml = group.artwork
    ? `<img class="album-group-art" src="${esc(group.artwork)}" alt="" loading="lazy">`
    : `<div class="album-group-art-placeholder">♪</div>`;

  li.innerHTML = `
    <div class="album-group-header">
      <input type="checkbox" class="album-select-cb track-cb" title="Select all tracks in album">
      ${artHtml}
      <div class="album-group-info">
        <div class="album-group-title">${esc(group.albumTitle)}</div>
        <div class="album-group-meta">${esc(group.artist)} · ${metaParts.join(' · ')}</div>
      </div>
      ${albumPriceStr ? `<span class="album-group-price">${esc(albumPriceStr)}</span>` : ''}
      <button class="album-group-play-btn">▶ Play</button>
      <div class="album-group-actions">
        ${playlistId ? `<button class="track-remove-btn album-remove-btn" title="Remove album from playlist">✕</button>` : ''}
      </div>
    </div>
    <ul class="album-group-tracks"></ul>`;

  const tracksUl = li.querySelector('.album-group-tracks');
  group.trackIds.forEach((tid, idx) => {
    const row = buildTrackRow(tid, playlistId);
    const numEl = row.querySelector('.col-num-static');
    if (numEl) numEl.textContent = idx + 1;
    tracksUl.appendChild(row);
  });

  // Album select-all checkbox
  const albumCb = li.querySelector('.album-select-cb');
  albumCb.addEventListener('click', e => e.stopPropagation());
  albumCb.addEventListener('change', () => {
    const allSelected = group.trackIds.every(id => ui.selectedTrackIds.has(id));
    if (allSelected) {
      group.trackIds.forEach(id => ui.selectedTrackIds.delete(id));
    } else {
      group.trackIds.forEach(id => ui.selectedTrackIds.add(id));
    }
    renderContent();
  });

  // Album remove button
  const albumRemoveBtn = li.querySelector('.album-remove-btn');
  if (albumRemoveBtn) {
    albumRemoveBtn.addEventListener('click', e => {
      e.stopPropagation();
      group.trackIds.forEach(tid => removeFromPlaylist(tid, playlistId));
    });
  }

  // Toggle collapse on header click (not play button, not select checkbox, not remove btn)
  li.querySelector('.album-group-header').addEventListener('click', e => {
    if (e.target.closest('.album-group-play-btn')) {
      playAlbumGroup(group, playlistId);
    } else if (!e.target.classList.contains('album-select-cb') && !e.target.closest('.album-remove-btn')) {
      toggleAlbumGroup(key, li);
    }
  });

  return li;
}

function toggleAlbumGroup(albumUrl, liEl) {
  if (ui.collapsedAlbums.has(albumUrl)) {
    ui.collapsedAlbums.delete(albumUrl);
    liEl.classList.remove('collapsed');
  } else {
    ui.collapsedAlbums.add(albumUrl);
    liEl.classList.add('collapsed');
  }
}

function playAlbumGroup(group, playlistId) {
  if (group.trackIds.length === 0) return;
  playTrack(group.trackIds[0], playlistId);
  selectTrack(group.trackIds[0]);
}

// ── Detail panel ──────────────────────────────────────────────────────────
function selectTrack(trackId) {
  ui.selectedTrackId = trackId;
  renderDetailPanel();
}

function renderDetailPanel() {
  const t = state.tracks[ui.selectedTrackId];
  const panel = document.getElementById('detail-panel');
  const layout = document.getElementById('body-layout');

  if (!t) {
    panel.classList.add('hidden');
    layout.classList.remove('detail-open');
    return;
  }

  panel.classList.remove('hidden');
  layout.classList.add('detail-open');

  const content = document.getElementById('detail-content');

  const artHtml = t.artwork
    ? `<div class="detail-art-wrap"><img src="${esc(t.artwork)}" alt="" onerror="this.parentElement.innerHTML='<div class=detail-art-placeholder>♪</div>'"></div>`
    : `<div class="detail-art-wrap"><div class="detail-art-placeholder">♪</div></div>`;

  const infoRow = [
    fmtDuration(t.duration),
    fmtDate(t.releaseDate)
  ].filter(Boolean);

  const tagsHtml = (t.tags?.length)
    ? `<div class="detail-tags tag-list">${t.tags.map(tag => `<span class="tag-pill">${esc(tag)}</span>`).join('')}</div>`
    : '';

  const priceDisplay = fmtPrice(t) || 'Name your price';

  content.innerHTML = `
    ${artHtml}
    <div class="detail-meta">
      <div class="detail-title">${esc(t.title)}</div>
      <div class="detail-artist">${esc(t.artist)}</div>
      ${t.albumTitle ? `<div class="detail-album">${esc(t.albumTitle)}</div>` : ''}
      ${infoRow.length ? `<div class="detail-info-row">${infoRow.map(x => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
      ${tagsHtml}
    </div>

    <!-- Sources -->
    <div class="detail-section" id="ds-sources">
      <div class="detail-section-header">
        <span class="detail-section-title">SOURCES</span>
        <span class="detail-section-chevron">▾</span>
      </div>
      <div class="detail-section-body">
        <div class="detail-source-row">
          <div class="detail-source-logo">Bandcamp</div>
          <div class="detail-source-price">${esc(priceDisplay)}</div>
          <div class="detail-source-actions">
            <button class="detail-action-btn" id="detail-cart-btn" title="Push to Cart">🛒 Cart</button>
            <button class="detail-action-btn" id="detail-bc-btn" title="Open on Bandcamp">↗</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Playlists -->
    <div class="detail-section" id="ds-playlists">
      <div class="detail-section-header">
        <span class="detail-section-title">PLAYLISTS</span>
        <span class="detail-section-chevron">▾</span>
      </div>
      <div class="detail-section-body">
        <input type="text" class="detail-playlist-search" id="detail-pl-search" placeholder="Search playlists…" value="${esc(ui.detailPlaylistSearch)}">
        <div id="detail-pl-list"></div>
      </div>
    </div>

    <!-- Metadata -->
    <div class="detail-section" id="ds-meta">
      <div class="detail-section-header">
        <span class="detail-section-title">METADATA</span>
        <span class="detail-section-chevron">▾</span>
      </div>
      <div class="detail-section-body">
        ${buildMetaTable(t)}
      </div>
    </div>

    ${t.description ? `
    <!-- Description -->
    <div class="detail-section" id="ds-desc">
      <div class="detail-section-header">
        <span class="detail-section-title">DESCRIPTION</span>
        <span class="detail-section-chevron">▾</span>
      </div>
      <div class="detail-section-body">
        <div class="detail-description" id="detail-desc-text">${esc(t.description)}</div>
        <span class="detail-desc-more" id="detail-desc-more">Show more</span>
      </div>
    </div>` : ''}

    <!-- Actions -->
    <div class="detail-section">
      <div class="detail-section-header">
        <span class="detail-section-title">ACTIONS</span>
        <span class="detail-section-chevron">▾</span>
      </div>
      <div class="detail-section-body">
        <div class="detail-actions-row">
          <button class="detail-action-btn" id="detail-refresh-btn">↺ Refresh</button>
          <button class="detail-action-btn" id="detail-purchased-btn">${t.purchased ? '✓ Purchased' : '○ Mark Purchased'}</button>
        </div>
      </div>
    </div>`;

  // Render playlist membership list
  renderDetailPlaylists();

  // Bind section toggles
  content.querySelectorAll('.detail-section-header').forEach(header => {
    header.addEventListener('click', () => {
      header.closest('.detail-section').classList.toggle('collapsed');
    });
  });

  // Source action buttons
  document.getElementById('detail-cart-btn')?.addEventListener('click', () => pushToCart(ui.selectedTrackId));
  document.getElementById('detail-bc-btn')?.addEventListener('click', () => window.open(t.url ?? t.albumUrl, '_blank'));

  // Playlist search
  document.getElementById('detail-pl-search')?.addEventListener('input', e => {
    ui.detailPlaylistSearch = e.target.value;
    renderDetailPlaylists();
  });

  // Description toggle
  document.getElementById('detail-desc-more')?.addEventListener('click', e => {
    const desc = document.getElementById('detail-desc-text');
    const expanded = desc.classList.toggle('expanded');
    e.target.textContent = expanded ? 'Show less' : 'Show more';
  });

  // Refresh button
  document.getElementById('detail-refresh-btn')?.addEventListener('click', () => refreshTrack(ui.selectedTrackId));

  // Purchased toggle
  document.getElementById('detail-purchased-btn')?.addEventListener('click', () => {
    const track = state.tracks[ui.selectedTrackId];
    if (!track) return;
    track.purchased = !track.purchased;
    schedSave();
    renderContent();
    renderDetailPanel();
  });
}

function buildMetaTable(t) {
  const rows = [
    ['Release', fmtDate(t.releaseDate)],
    ['Genre', t.genre],
    ['Label', t.label],
    ['Location', t.location],
    ['Artist', t.artist],
    ['Album', t.albumTitle],
    ['Duration', fmtDuration(t.duration)],
    ['Price', t.price ? `$${parseFloat(t.price).toFixed(2)} ${t.currency ?? ''}` : 'Name your price'],
  ].filter(([, v]) => v);

  if (!rows.length) return '<span style="color:var(--text3);font-size:11px">No metadata — click Refresh to fetch from Bandcamp</span>';

  return `<table class="detail-meta-table">${rows.map(([k, v]) =>
    `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`
  ).join('')}</table>`;
}

function renderDetailPlaylists() {
  const container = document.getElementById('detail-pl-list');
  if (!container) return;
  const trackId = ui.selectedTrackId;
  const q = ui.detailPlaylistSearch.toLowerCase();
  const filtered = q ? state.playlists.filter(p => p.name.toLowerCase().includes(q)) : state.playlists;

  container.innerHTML = '';
  for (const pl of filtered) {
    const inPl = pl.trackIds.includes(trackId);
    const div = document.createElement('div');
    div.className = 'detail-playlist-item';
    div.innerHTML = `
      <span class="detail-playlist-name ${inPl ? 'in-playlist' : ''}">${esc(pl.name)}</span>
      <button class="detail-playlist-toggle ${inPl ? 'in' : ''}" data-pl="${esc(pl.id)}">${inPl ? '✓' : '+'}</button>`;
    div.querySelector('button').addEventListener('click', () => {
      toggleTrackInPlaylist(trackId, pl.id);
    });
    container.appendChild(div);
  }
  if (!filtered.length) {
    container.innerHTML = '<span style="color:var(--text3);font-size:11px">No playlists</span>';
  }
}

function toggleTrackInPlaylist(trackId, playlistId) {
  const pl = getPlaylist(playlistId);
  if (!pl) return;
  if (pl.trackIds.includes(trackId)) {
    pl.trackIds = pl.trackIds.filter(id => id !== trackId);
    // Check if track is now orphaned
    const inUse = state.playlists.some(p => p.trackIds.includes(trackId));
    if (!inUse) delete state.tracks[trackId];
  } else {
    pl.trackIds.push(trackId);
  }
  schedSave();
  renderSidebar();
  if (ui.activePlaylistId === playlistId) renderContent();
  renderDetailPlaylists();
}

// ── Track refresh ─────────────────────────────────────────────────────────

// ── Player ────────────────────────────────────────────────────────────────
const audioEl = document.getElementById('audio-el');

audioEl.addEventListener('timeupdate', onTimeUpdate);
audioEl.addEventListener('ended', onTrackEnded);
audioEl.addEventListener('error', onAudioError);

function onTimeUpdate() {
  const cur = audioEl.currentTime;
  const dur = audioEl.duration || 0;
  document.getElementById('current-time').textContent = fmtDuration(cur);
  document.getElementById('total-time').textContent = fmtDuration(dur);
  const pct = dur > 0 ? (cur / dur) * 100 : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-input').value = dur > 0 ? Math.round((cur / dur) * 1000) : 0;
}

function onTrackEnded() { setPlaying(false); playNext(); }
function onAudioError(e) {
  setLoading(false); setPlaying(false);
  toast('Stream error — track may be unavailable', 'error');
}

function setLoading(v) {
  player.isLoading = v;
  document.getElementById('loading-indicator').classList.toggle('hidden', !v);
}
function setPlaying(v) {
  player.isPlaying = v;
  document.getElementById('play-icon').classList.toggle('hidden', v);
  document.getElementById('pause-icon').classList.toggle('hidden', !v);
}

async function playTrack(trackId, playlistId) {
  const t = state.tracks[trackId];
  if (!t) return;

  player.trackId = trackId;
  player.playlistId = playlistId;

  document.querySelectorAll('.track-item').forEach(el => {
    el.classList.toggle('playing', el.dataset.trackId === trackId);
  });

  document.getElementById('player-title').textContent = t.title;
  document.getElementById('player-artist').textContent = t.artist;
  const artEl = document.getElementById('player-art');
  if (t.artwork) { artEl.src = t.artwork; artEl.style.display = ''; }
  else artEl.style.display = 'none';
  document.getElementById('player-bc-link').href = t.url ?? t.albumUrl ?? '#';

  setLoading(true);
  audioEl.pause();
  audioEl.src = '';

  try {
    const res = await api.get(`/api/track/stream?trackId=${encodeURIComponent(trackId)}`);
    audioEl.src = res.streamUrl;
    audioEl.load();
    await audioEl.play();
    setPlaying(true);
  } catch (e) {
    setPlaying(false);
    toast('Could not load stream: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
}

function playNext() {
  const ids = playlistTrackIds(player.playlistId);
  if (!ids.length) return;
  const idx = ids.indexOf(player.trackId);
  const next = ids[(idx + 1) % ids.length];
  if (next !== player.trackId) playTrack(next, player.playlistId);
}

function playPrev() {
  const ids = playlistTrackIds(player.playlistId);
  if (!ids.length) return;
  const idx = ids.indexOf(player.trackId);
  const prev = ids[(idx - 1 + ids.length) % ids.length];
  playTrack(prev, player.playlistId);
}

function togglePlayPause() {
  if (!player.trackId) return;
  if (audioEl.paused) { audioEl.play().then(() => setPlaying(true)).catch(() => {}); }
  else { audioEl.pause(); setPlaying(false); }
}

// ── Context menu ──────────────────────────────────────────────────────────
function showContextMenu(e, trackId, playlistId) {
  e.stopPropagation();
  ui.contextTrackId = trackId;
  ui.contextPlaylistId = playlistId;
  const t = state.tracks[trackId];
  const menu = document.getElementById('context-menu');

  buildPlaylistSubmenu('ctx-move-submenu', playlistId, targetId => {
    moveTrack(trackId, playlistId, targetId); hideContextMenu();
  }, true);
  buildPlaylistSubmenu('ctx-copy-submenu', playlistId, targetId => {
    copyTrack(trackId, targetId); hideContextMenu();
  }, false);

  menu.querySelector('[data-action="toggle-purchased"]').textContent =
    t.purchased ? 'Unmark Purchased' : 'Mark as Purchased';

  menu.classList.remove('hidden');
  const x = Math.min(e.clientX, window.innerWidth - 220);
  const y = Math.min(e.clientY, window.innerHeight - 280);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function buildPlaylistSubmenu(subId, currentPlaylistId, onSelect, excludeCurrent) {
  const sub = document.getElementById(subId);
  sub.innerHTML = '';
  const others = excludeCurrent
    ? state.playlists.filter(p => p.id !== currentPlaylistId)
    : state.playlists;
  if (!others.length) {
    const item = document.createElement('div');
    item.className = 'ctx-item';
    item.style.color = 'var(--text3)';
    item.textContent = 'No playlists';
    sub.appendChild(item);
    return;
  }
  for (const pl of others) {
    const item = document.createElement('div');
    item.className = 'ctx-item';
    item.textContent = pl.name;
    item.addEventListener('click', e => { e.stopPropagation(); onSelect(pl.id); });
    sub.appendChild(item);
  }
}

function hideContextMenu() {
  document.getElementById('context-menu').classList.add('hidden');
}

function handleContextAction(action) {
  const trackId = ui.contextTrackId;
  const playlistId = ui.contextPlaylistId;
  const t = state.tracks[trackId];
  hideContextMenu();
  switch (action) {
    case 'play':          playTrack(trackId, playlistId); selectTrack(trackId); break;
    case 'play-next':     queueNext(trackId); break;
    case 'open-bc':       window.open(t.url ?? t.albumUrl, '_blank'); break;
    case 'refresh-track': refreshTrack(trackId); break;
    case 'push-cart':     pushToCart(trackId); break;
    case 'toggle-purchased':
      t.purchased = !t.purchased; schedSave(); renderContent(); renderLibraryCounts();
      if (ui.selectedTrackId === trackId) renderDetailPanel(); break;
    case 'remove':        removeFromPlaylist(trackId, playlistId); break;
  }
}

function queueNext(trackId) {
  if (!player.playlistId) return;
  const pl = getPlaylist(player.playlistId);
  if (!pl) return;
  const curIdx = pl.trackIds.indexOf(player.trackId);
  const insertAt = curIdx >= 0 ? curIdx + 1 : pl.trackIds.length;
  const existing = pl.trackIds.indexOf(trackId);
  if (existing >= 0) pl.trackIds.splice(existing, 1);
  pl.trackIds.splice(insertAt, 0, trackId);
  schedSave(); renderContent(); toast('Playing next');
}

// ── Track management ──────────────────────────────────────────────────────
function addTracksToPlaylist(tracks, playlistId) {
  const pl = getPlaylist(playlistId);
  if (!pl) return;
  let added = 0;
  for (const t of tracks) {
    if (!state.tracks[t.id]) state.tracks[t.id] = t;
    if (!pl.trackIds.includes(t.id)) { pl.trackIds.push(t.id); added++; }
  }
  schedSave(); renderSidebar();
  if (ui.activePlaylistId === playlistId) renderContent();
  toast(`Added ${added} track${added !== 1 ? 's' : ''} to "${pl.name}"`);
}

async function refreshTrack(trackId) {
  toast('Refreshing track data…');
  try {
    const res = await api.post('/api/track/refresh', { trackId });
    if (res.track) {
      state.tracks[trackId] = res.track;
      schedSave();
      renderContent();
      renderLibraryCounts();
      if (ui.selectedTrackId === trackId) renderDetailPanel();
      toast('Track refreshed', 'success');
    }
  } catch (e) {
    toast('Refresh failed: ' + e.message, 'error');
  }
}

function removeFromPlaylist(trackId, playlistId) {
  const pl = getPlaylist(playlistId);
  if (!pl) return;
  pl.trackIds = pl.trackIds.filter(id => id !== trackId);
  const inUse = state.playlists.some(p => p.trackIds.includes(trackId));
  if (!inUse) delete state.tracks[trackId];
  schedSave(); renderSidebar(); renderContent();
  if (ui.selectedTrackId === trackId) {
    ui.selectedTrackId = null;
    renderDetailPanel();
  }
}

function moveTrack(trackId, fromPlaylistId, toPlaylistId) {
  const from = getPlaylist(fromPlaylistId);
  const to   = getPlaylist(toPlaylistId);
  if (!from || !to) return;
  from.trackIds = from.trackIds.filter(id => id !== trackId);
  if (!to.trackIds.includes(trackId)) to.trackIds.push(trackId);
  schedSave(); renderSidebar(); renderContent();
  toast(`Moved to "${to.name}"`);
}

function copyTrack(trackId, toPlaylistId) {
  const to = getPlaylist(toPlaylistId);
  const orig = state.tracks[trackId];
  if (!to || !orig) return;
  const copy = { ...orig, id: crypto.randomUUID(), addedAt: new Date().toISOString() };
  state.tracks[copy.id] = copy;
  if (!to.trackIds.includes(copy.id)) to.trackIds.push(copy.id);
  schedSave(); renderSidebar(); toast(`Copied to "${to.name}"`);
}

// ── Add track flow ────────────────────────────────────────────────────────
async function handleAddTrack() {
  const input = document.getElementById('track-url-input');
  const url = input.value.trim();
  if (!url) return;
  if (!url.includes('bandcamp.com')) { toast('Please enter a Bandcamp URL', 'error'); return; }
  if (!ui.activePlaylistId) { toast('Select or create a playlist first', 'error'); return; }

  const btn = document.getElementById('add-track-btn');
  btn.disabled = true; btn.textContent = '…';

  try {
    const result = await api.post('/api/track/lookup', { url });
    input.value = '';
    if (result.type === 'track' && result.items.length === 1) {
      addTracksToPlaylist(result.items, ui.activePlaylistId);
    } else {
      showPicker(result);
    }
  } catch (e) {
    toast('Lookup failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Add';
  }
}

// ── Track picker ──────────────────────────────────────────────────────────
function showPicker(result) {
  ui.pendingPickerItems = result.items;
  document.getElementById('picker-title').textContent =
    result.type === 'album' ? `Album: ${result.albumName}` : 'Add Tracks';

  const albumRow = document.getElementById('picker-album-art-row');
  if (result.type === 'album' && result.albumArtwork) {
    document.getElementById('picker-album-art').src = result.albumArtwork;
    document.getElementById('picker-album-name').textContent = result.albumName;
    albumRow.classList.remove('hidden');
  } else { albumRow.classList.add('hidden'); }

  populatePlaylistSelect('picker-playlist-select', ui.activePlaylistId);

  const ul = document.getElementById('picker-track-list');
  ul.innerHTML = '';
  result.items.forEach((t, i) => {
    const li = document.createElement('li');
    const artHtml = t.artwork
      ? `<img class="picker-track-art" src="${esc(t.artwork)}" alt="" loading="lazy">`
      : `<div class="picker-track-art" style="background:var(--bg4)"></div>`;
    li.innerHTML = `
      <label>
        <input type="checkbox" checked data-idx="${i}">
        ${artHtml}
        <div class="picker-track-info">
          <div class="picker-track-title">${esc(t.title)}</div>
          <div class="picker-track-meta">${esc(t.artist)}</div>
        </div>
      </label>
      <span class="picker-track-dur">${fmtDuration(t.duration)}</span>`;
    ul.appendChild(li);
  });
  document.getElementById('picker-modal').classList.remove('hidden');
}

function confirmPicker() {
  const checkboxes = document.querySelectorAll('#picker-track-list input[type=checkbox]');
  const selected = Array.from(checkboxes)
    .filter(cb => cb.checked)
    .map(cb => ui.pendingPickerItems[parseInt(cb.dataset.idx)]);
  if (!selected.length) { toast('No tracks selected'); return; }
  const targetId = document.getElementById('picker-playlist-select').value;
  addTracksToPlaylist(selected, targetId);
  closePicker();
}

function closePicker() { document.getElementById('picker-modal').classList.add('hidden'); }

// ── Playlist management ───────────────────────────────────────────────────
function createPlaylist(name = 'New Playlist') {
  const pl = { id: crypto.randomUUID(), name, trackIds: [] };
  state.playlists.push(pl);
  state.sidebarOrder.push({ type: 'playlist', id: pl.id });
  schedSave(); renderSidebar(); selectPlaylist(pl.id);
  setTimeout(() => {
    const nameEl = document.querySelector(`#playlist-list .playlist-item[data-id="${pl.id}"] .playlist-name`);
    if (nameEl) startRename(pl.id, nameEl);
  }, 50);
}

function createFolder(name = 'New Folder') {
  const folder = { id: crypto.randomUUID(), name, collapsed: false, playlistIds: [] };
  state.folders.push(folder);
  state.sidebarOrder.push({ type: 'folder', id: folder.id });
  schedSave(); renderSidebar();
  setTimeout(() => {
    const nameEl = document.querySelector(`.folder-item[data-id="${folder.id}"] .folder-name`);
    if (nameEl) startFolderRename(folder.id, nameEl);
  }, 50);
}

function deleteActivePlaylist() {
  if (!ui.activePlaylistId) return;
  const pl = getPlaylist(ui.activePlaylistId);
  if (!confirm(`Delete playlist "${pl.name}"?`)) return;
  const id = ui.activePlaylistId;
  state.playlists = state.playlists.filter(p => p.id !== id);
  state.sidebarOrder = state.sidebarOrder.filter(o => !(o.type === 'playlist' && o.id === id));
  state.folders.forEach(f => { f.playlistIds = f.playlistIds.filter(pid => pid !== id); });
  ui.activePlaylistId = state.playlists[0]?.id ?? null;
  schedSave(); renderSidebar(); renderContent();
}

function populatePlaylistSelect(selectId, selectedId) {
  const sel = document.getElementById(selectId);
  sel.innerHTML = '';
  for (const pl of state.playlists) {
    const opt = document.createElement('option');
    opt.value = pl.id; opt.textContent = pl.name;
    if (pl.id === selectedId) opt.selected = true;
    sel.appendChild(opt);
  }
}

// ── Cart / Wishlist ───────────────────────────────────────────────────────
async function pullCart() {
  setCartStatus('Fetching cart…'); clearCartItems();
  try {
    const res = await api.get('/api/cart/pull');
    if (!res.items?.length) { setCartStatus('Cart appears empty or could not be parsed.'); return; }
    setCartStatus(`Found ${res.items.length} item(s) in cart`);
    renderCartItems(res.items);
    state.cartItems = res.items;
    schedSave(); renderLibraryCounts();
  } catch (e) { setCartStatus(e.message, true); }
}

async function pullWishlist() {
  setCartStatus('Fetching wishlist…'); clearCartItems();
  try {
    const res = await api.get('/api/wishlist/pull');
    if (!res.items?.length) { setCartStatus('Wishlist is empty.'); return; }
    const flat = [];
    for (const item of res.items) {
      if (item.type === 'album' && item.tracks?.length) flat.push(...item.tracks);
      else flat.push(item);
    }
    setCartStatus(`Found ${flat.length} item(s) in wishlist`);
    renderCartItems(flat);
    state.wishlistItems = flat;
    schedSave(); renderLibraryCounts();
  } catch (e) { setCartStatus(e.message, true); }
}

function openPullProgress(title) {
  document.getElementById('pull-progress-title').textContent = title;
  document.getElementById('pull-progress-fill').style.width = '0%';
  document.getElementById('pull-progress-label').textContent = 'Starting…';
  document.getElementById('pull-progress-modal').classList.remove('hidden');
}
function updatePullProgress(fetched, total) {
  const pct = total > 0 ? Math.round((fetched / total) * 100) : 0;
  document.getElementById('pull-progress-fill').style.width = pct + '%';
  document.getElementById('pull-progress-label').textContent = `${fetched} of ${total} items…`;
}
function closePullProgress() {
  document.getElementById('pull-progress-modal').classList.add('hidden');
}

function streamSSE(url) {
  return new Promise((resolve, reject) => {
    const es = new EventSource(url);
    es.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.error) { es.close(); reject(new Error(msg.error)); }
      else if (msg.done) { es.close(); resolve(msg); }
      else if (msg.progress) { updatePullProgress(msg.fetched, msg.total); }
    };
    es.onerror = () => { es.close(); reject(new Error('Connection lost')); };
  });
}

async function pullCollection() {
  const btn = document.getElementById('pull-purchased-btn');
  btn.disabled = true;
  openPullProgress('Pulling Purchased from Bandcamp…');
  try {
    const res = await streamSSE('/api/collection/pull');
    const data = await api.get('/api/data');
    state.tracks = data.tracks;
    renderLibContent('purchased');
    renderLibraryCounts();
    toast(`Synced ${res.total} purchased item(s) — ${res.added} new, ${res.updated} updated`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    closePullProgress();
    btn.disabled = false;
  }
}

async function pullWishlistDirect() {
  const btn = document.getElementById('pull-wishlist-header-btn');
  btn.disabled = true;
  openPullProgress('Pulling Wishlist from Bandcamp…');
  try {
    const res = await streamSSE('/api/wishlist/pull');
    if (!res.items?.length) { toast('Wishlist is empty.'); return; }
    const flat = [];
    for (const item of res.items) {
      if (item.type === 'album' && item.tracks?.length) flat.push(...item.tracks);
      else flat.push(item);
    }
    state.wishlistItems = flat;
    schedSave();
    renderLibContent('wishlist');
    renderLibraryCounts();
    toast(`Synced ${flat.length} wishlist item(s)`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    closePullProgress();
    btn.disabled = false;
  }
}

function setCartStatus(msg, isError = false) {
  const el = document.getElementById('cart-status');
  el.textContent = msg;
  el.className = 'cart-status' + (isError ? ' error' : '');
}

function clearCartItems() {
  document.getElementById('cart-items-list').innerHTML = '';
  document.getElementById('cart-modal-footer').style.display = 'none';
  ui.cartPulledItems = [];
}

function renderCartItems(items) {
  ui.cartPulledItems = items;
  const ul = document.getElementById('cart-items-list');
  ul.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'cart-item';
    const artHtml = item.artwork
      ? `<img class="cart-item-art" src="${esc(item.artwork)}" alt="" loading="lazy">`
      : `<div class="cart-item-art"></div>`;
    const price = item.price ? `$${parseFloat(item.price).toFixed(2)}` : '';
    const album = item.albumTitle ? ` · ${item.albumTitle}` : '';
    li.innerHTML = `
      ${artHtml}
      <div class="cart-item-info">
        <div class="cart-item-title">${esc(item.title)}</div>
        <div class="cart-item-meta">${esc(item.artist)}${esc(album)}</div>
      </div>
      <div class="cart-item-price">${price}</div>
      <button class="cart-item-add" data-item-id="${esc(item.id)}">+ Add</button>`;
    li.querySelector('.cart-item-add').addEventListener('click', e => {
      const btn = e.currentTarget;
      if (btn.classList.contains('added')) return;
      const targetId = document.getElementById('cart-target-playlist')?.value ?? ui.activePlaylistId;
      if (!targetId) { toast('Select a playlist first', 'error'); return; }
      addTracksToPlaylist([item], targetId);
      btn.textContent = '✓ Added'; btn.classList.add('added');
    });
    ul.appendChild(li);
  }
  populatePlaylistSelect('cart-target-playlist', ui.activePlaylistId);
  document.getElementById('cart-modal-footer').style.display = '';
}

function pushToCart(trackId) {
  pushTracksViaExtension([trackId]);
}

function pushPlaylistToCart(playlistId) {
  const pl = getPlaylist(playlistId);
  if (!pl) return;
  pushTracksViaExtension(pl.trackIds);
}

// ── Extension cart push ───────────────────────────────────────────────────

function getExtensionId() {
  const meta = document.querySelector('meta[name="bchub-extension-id"]');
  return meta?.content ?? null;
}

async function pushTracksViaExtension(trackIds) {
  const tracks = trackIds
    .map(id => state.tracks[id])
    .filter(t => t && (t.bcTrackId || t.bcAlbumId));

  if (!tracks.length) {
    toast('No tracks with Bandcamp IDs found', 'error');
    return;
  }

  const queueTracks = tracks.map(t => {
    const url = t.url ?? t.albumUrl ?? '';
    const origin = url.match(/^(https?:\/\/[^/]+)/)?.[1] ?? '';
    return {
      origin,
      itemId:   String(t.bcTrackId ?? t.bcAlbumId),
      itemType: t.bcTrackId ? 't' : 'p',
      price:    t.price ? String(parseFloat(t.price)) : '1'
    };
  }).filter(t => t.origin && t.itemId);

  if (!queueTracks.length) {
    toast('No tracks with valid URLs found', 'error');
    return;
  }

  const extId = getExtensionId();
  if (!extId) {
    toast('Extension not installed — see Settings to set it up', 'error');
    return;
  }

  // Queue tracks on server
  try {
    await api.post('/api/cart/queue', { tracks: queueTracks });
  } catch (err) {
    toast('Failed to queue tracks: ' + err.message, 'error');
    return;
  }

  toast(`Pushing ${queueTracks.length} track${queueTracks.length !== 1 ? 's' : ''} to cart…`);

  // Send message to extension background worker
  chrome.runtime.sendMessage(extId, { action: 'pushCart' }, response => {
    if (chrome.runtime.lastError) {
      toast('Extension error: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    if (!response) {
      toast('No response from extension — is it installed?', 'error');
      return;
    }
    if (response.error) {
      toast('Cart push failed: ' + response.error, 'error');
      return;
    }
    const { ok, fail, total } = response;
    if (fail === 0) {
      toast(`${ok} of ${total} tracks added to cart!`, 'success');
    } else if (ok > 0) {
      toast(`${ok} added, ${fail} failed`, 'error');
    } else {
      toast(`Cart push failed for all ${total} tracks`, 'error');
    }
  });
}

// ── Multi-select ──────────────────────────────────────────────────────────
function toggleTrackCheck(trackId) {
  if (ui.selectedTrackIds.has(trackId)) {
    ui.selectedTrackIds.delete(trackId);
  } else {
    ui.selectedTrackIds.add(trackId);
  }
  const row = document.querySelector(`.track-item[data-track-id="${trackId}"]`);
  if (row) {
    row.classList.toggle('checked', ui.selectedTrackIds.has(trackId));
    const cb = row.querySelector('.track-cb');
    if (cb) cb.checked = ui.selectedTrackIds.has(trackId);
  }
  updateBulkActionsVisibility();
}

function updateBulkActionsVisibility() {
  const count = ui.selectedTrackIds.size;
  const pushSelBtn = document.getElementById('push-selected-cart-btn');
  if (pushSelBtn) {
    pushSelBtn.classList.toggle('hidden', count === 0);
    if (count > 0) pushSelBtn.textContent = `Push Selected (${count}) to Cart`;
  }
  // Update album-level select dots
  document.querySelectorAll('.album-group').forEach(groupEl => {
    const cb = groupEl.querySelector('.album-select-cb');
    if (!cb) return;
    const trackIds = [...groupEl.querySelectorAll('.track-item')].map(r => r.dataset.trackId);
    if (!trackIds.length) return;
    const allChecked = trackIds.every(id => ui.selectedTrackIds.has(id));
    const anyChecked = trackIds.some(id => ui.selectedTrackIds.has(id));
    cb.checked = allChecked;
    cb.indeterminate = anyChecked && !allChecked;
  });
  updateSelectedStats();
}

// ── Refresh all tracks ────────────────────────────────────────────────────
async function refreshAllTracks() {
  const pl = getPlaylist(ui.activePlaylistId);
  if (!pl) return;
  const ids = pl.trackIds.filter(id => state.tracks[id]);
  if (!ids.length) return;

  const btn = document.getElementById('refresh-all-btn');
  btn.disabled = true;

  let ok = 0, fail = 0;
  try {
    for (let i = 0; i < ids.length; i++) {
      const trackId = ids[i];
      btn.textContent = `↻ ${i + 1}/${ids.length}…`;
      try {
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000));
        const res = await Promise.race([api.post('/api/track/refresh', { trackId }), timeout]);
        if (res.track) { state.tracks[trackId] = res.track; ok++; }
        else fail++;
      } catch { fail++; }
    }
    schedSave();
    renderContent();
    renderLibraryCounts();
    toast(`Refreshed ${ok} track${ok !== 1 ? 's' : ''}${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
  } finally {
    btn.disabled = false; btn.textContent = '↻ Refresh All';
  }
}

// ── Bulk cart push ─────────────────────────────────────────────────────────
function pushSelectedToCart() {
  pushTracksViaExtension([...ui.selectedTrackIds]);
}

// ── Genre inline editing ───────────────────────────────────────────────────
function openGenreEdit(trackId, anchorEl) {
  closeGenreEdit();
  const t = state.tracks[trackId];
  const tags = t?.tags ?? [];
  if (!tags.length) return;

  // If this track is part of a multi-selection, apply to all selected; otherwise just this track
  const applyTo = (ui.selectedTrackIds.size > 1 && ui.selectedTrackIds.has(trackId))
    ? [...ui.selectedTrackIds]
    : [trackId];

  genreDropdownEl = document.createElement('div');
  genreDropdownEl.className = 'genre-dropdown';
  genreDropdownEl.innerHTML = tags.map(tag =>
    `<div class="genre-option${tag === t.genre ? ' active' : ''}" data-tag="${esc(tag)}">${esc(tag)}</div>`
  ).join('');

  genreDropdownEl.addEventListener('click', e => {
    const opt = e.target.closest('.genre-option');
    if (!opt) return;
    const newGenre = opt.dataset.tag;
    applyTo.forEach(tid => { if (state.tracks[tid]) state.tracks[tid].genre = newGenre; });
    schedSave();
    closeGenreEdit();
    renderContent();
  });

  document.body.appendChild(genreDropdownEl);
  const rect = anchorEl.getBoundingClientRect();
  const ddW = 150;
  const left = Math.min(rect.left, window.innerWidth - ddW - 8);
  genreDropdownEl.style.left = left + 'px';
  genreDropdownEl.style.top  = (rect.bottom + 4) + 'px';

  requestAnimationFrame(() => {
    document.addEventListener('click', closeGenreEdit, { once: true });
  });
}

function closeGenreEdit() {
  genreDropdownEl?.remove();
  genreDropdownEl = null;
}

// ── Settings ──────────────────────────────────────────────────────────────
function openSettings() {
  document.getElementById('cookie-input').value = state.settings.bandcampCookie ?? '';
  document.getElementById('fan-username-input').value = state.settings.fanUsername ?? '';
  document.getElementById('fan-id-input').value = state.settings.fanId ?? '';
  document.getElementById('settings-modal').classList.remove('hidden');
  updateExtensionStatusBadge();
}

function updateExtensionStatusBadge() {
  const badge = document.getElementById('ext-status-badge');
  const details = document.getElementById('ext-install-details');
  if (!badge) return;
  const installed = !!getExtensionId();
  badge.textContent = installed ? 'Installed' : 'Not installed';
  badge.style.background = installed ? 'rgba(34,197,94,0.15)' : 'var(--bg1)';
  badge.style.color = installed ? '#22c55e' : 'var(--text3)';
  if (details) details.open = !installed;
}

function saveSettings() {
  state.settings.bandcampCookie = document.getElementById('cookie-input').value.trim();
  state.settings.fanUsername = document.getElementById('fan-username-input').value.trim();
  state.settings.fanId = document.getElementById('fan-id-input').value.trim();
  schedSave(); closeModal('settings-modal'); toast('Settings saved', 'success');
}

function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// ── Event bindings ────────────────────────────────────────────────────────
function bindEvents() {
  // Header
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('cart-btn').addEventListener('click', () => {
    populatePlaylistSelect('cart-target-playlist', ui.activePlaylistId);
    document.getElementById('cart-modal').classList.remove('hidden');
  });

  // Library items
  document.querySelectorAll('.library-item').forEach(el => {
    el.addEventListener('click', () => selectLibView(el.dataset.lib));
  });

  // Sidebar
  document.getElementById('new-playlist-btn').addEventListener('click', () => createPlaylist());
  document.getElementById('new-folder-btn').addEventListener('click', () => createFolder());
  document.getElementById('delete-playlist-btn').addEventListener('click', deleteActivePlaylist);
  document.getElementById('push-all-cart-btn').addEventListener('click', () => pushPlaylistToCart(ui.activePlaylistId));
  document.getElementById('push-selected-cart-btn').addEventListener('click', pushSelectedToCart);
  document.getElementById('refresh-all-btn').addEventListener('click', refreshAllTracks);
  document.getElementById('playlist-search').addEventListener('input', e => {
    ui.playlistSearchQuery = e.target.value;
    renderSidebar();
  });

  // Add track bar
  document.getElementById('add-track-btn').addEventListener('click', handleAddTrack);
  document.getElementById('track-url-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleAddTrack();
  });

  // Player controls
  document.getElementById('play-btn').addEventListener('click', togglePlayPause);
  document.getElementById('next-btn').addEventListener('click', playNext);
  document.getElementById('prev-btn').addEventListener('click', () => {
    if (audioEl.currentTime > 3) { audioEl.currentTime = 0; return; }
    playPrev();
  });
  document.getElementById('progress-input').addEventListener('input', e => {
    const dur = audioEl.duration;
    if (!dur) return;
    audioEl.currentTime = (e.target.value / 1000) * dur;
  });
  document.getElementById('volume-input').addEventListener('input', e => {
    audioEl.volume = e.target.value / 100;
  });
  audioEl.volume = 0.8;

  // Detail panel close
  document.getElementById('detail-close').addEventListener('click', () => {
    ui.selectedTrackId = null;
    renderDetailPanel();
  });

  // Context menu
  document.getElementById('context-menu').addEventListener('click', e => {
    const item = e.target.closest('.ctx-item');
    if (item?.dataset.action) handleContextAction(item.dataset.action);
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#context-menu') && !e.target.classList.contains('track-menu-btn')) hideContextMenu();
  });

  // Picker modal
  document.getElementById('picker-confirm-btn').addEventListener('click', confirmPicker);
  document.getElementById('picker-cancel-btn').addEventListener('click', closePicker);
  document.getElementById('picker-select-all').addEventListener('click', () => {
    document.querySelectorAll('#picker-track-list input[type=checkbox]').forEach(cb => cb.checked = true);
  });
  document.getElementById('picker-select-none').addEventListener('click', () => {
    document.querySelectorAll('#picker-track-list input[type=checkbox]').forEach(cb => cb.checked = false);
  });

  // Lib view pull buttons
  document.getElementById('pull-purchased-btn').addEventListener('click', pullCollection);
  document.getElementById('pull-wishlist-header-btn').addEventListener('click', pullWishlistDirect);

  // Cart modal
  document.getElementById('pull-cart-btn').addEventListener('click', pullCart);
  document.getElementById('pull-wishlist-btn').addEventListener('click', pullWishlist);
  document.getElementById('cart-add-all-btn').addEventListener('click', () => {
    const targetId = document.getElementById('cart-target-playlist').value;
    if (!targetId) { toast('Select a playlist', 'error'); return; }
    addTracksToPlaylist(ui.cartPulledItems, targetId);
    document.querySelectorAll('.cart-item-add').forEach(btn => { btn.textContent = '✓ Added'; btn.classList.add('added'); });
  });

  // Settings
  document.getElementById('save-settings-btn').addEventListener('click', saveSettings);

  // Close buttons
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => { const id = btn.dataset.modal; if (id) closeModal(id); });
  });
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });
  });

  // Keyboard
  document.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === ' ')          { e.preventDefault(); togglePlayPause(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); audioEl.currentTime += 10; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); audioEl.currentTime -= 10; }
    if (e.key === 'Escape') {
      hideContextMenu();
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
    }
  });
}

// ── Sidebar resize ────────────────────────────────────────────────────────
(function initSidebarResize() {
  const handle = document.getElementById('sidebar-resize-handle');
  const app    = document.getElementById('app');
  const MIN_W  = 140;
  const MAX_W  = 480;

  let startX, startW;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startX = e.clientX;
    startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10);
    handle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(e) {
      const w = Math.min(MAX_W, Math.max(MIN_W, startW + e.clientX - startX));
      document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    }
    function onUp() {
      handle.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Persist width
      localStorage.setItem('sidebarWidth', parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10));
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Restore persisted width
  const saved = localStorage.getItem('sidebarWidth');
  if (saved) document.documentElement.style.setProperty('--sidebar-w', saved + 'px');
})();

// ── Init ──────────────────────────────────────────────────────────────────
boot();
