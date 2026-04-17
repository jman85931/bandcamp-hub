// ── State ────────────────────────────────────────────────────────────────
let state = {
  playlists: [],
  tracks: {},
  settings: { bandcampCookie: '', fanUsername: '', fanId: '' },
  folders: [],
  sidebarOrder: [],
  cartItems: [],
  wishlistItems: [],
  libQueue: []   // runtime queue for playing wishlist/cart albums (not persisted)
};

let ui = {
  activePlaylistId: null,
  activeLibView: null,  // 'purchased' | 'cart' | 'wishlist' | null
  selectedTrackId: null,
  selectedTrackIds: new Set(),  // checkboxes (bulk operations)
  selectedCartIds:  new Set(),  // cart item selection
  contextTrackId: null,
  contextPlaylistId: null,
  collapsedAlbums: new Set(),
  pendingPickerItems: [],
  cartPulledItems: [],
  playlistSearchQuery: '',
  detailPlaylistSearch: '',
  sortBy: 'default'  // 'default' | 'artist' | 'album' | 'price-asc' | 'price-desc' | 'duration' | 'release'
};

let genreDropdownEl = null;
let dragState = { type: null, id: null, sourceItem: null }; // type: 'playlist'|'folder'|'track'
let globalSearchQuery = '';
let activeFilters = { genre: '', purchased: 'all', price: 'all' }; // purchased: 'all'|'owned'|'unowned'; price: 'all'|'free'|'paid'
let fxRates = {}; // exchange rates relative to GBP (e.g. { EUR: 1.17, USD: 1.27 })

async function fetchExchangeRates() {
  try {
    const res = await fetch('/api/exchange-rates');
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
  isLoading: false,
  shuffle: false,
  repeat: 'none'   // 'none' | 'all' | 'one'
};

// Shuffle order: regenerated each time shuffle is toggled on
let shuffleOrder = [];

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
    state.cartItems     = (data.cartItems     ?? []).filter(Boolean);
    state.wishlistItems = (data.wishlistItems ?? []).filter(Boolean);
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
  if (!track) return '';
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

  li.addEventListener('click', e => {
    if (e.target.classList.contains('playlist-name') && pl.id === ui.activePlaylistId) {
      startRename(pl.id, e.target);
    } else {
      selectPlaylist(pl.id);
    }
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
    if (dragState.type === 'playlist' || dragState.type === 'track' || dragState.type === 'album') {
      e.preventDefault(); li.classList.add('drag-over');
    }
  });
  li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
  li.addEventListener('drop', e => {
    e.preventDefault(); li.classList.remove('drag-over');
    if (dragState.type === 'playlist' && dragState.id !== pl.id) {
      reorderPlaylistItem(dragState.id, pl.id, inFolder);
    } else if (dragState.type === 'track') {
      dropTrackOnPlaylist(dragState.id, pl.id);
    } else if (dragState.type === 'album') {
      dropAlbumOnPlaylist(pl.id);
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

function startTitleRename(playlistId) {
  const pl = getPlaylist(playlistId);
  if (!pl) return;
  const titleEl = document.getElementById('playlist-title');
  if (titleEl.querySelector('input')) return; // already editing

  const inp = document.createElement('input');
  inp.id = 'playlist-title-input';
  inp.value = pl.name;
  titleEl.textContent = '';
  titleEl.appendChild(inp);
  inp.focus(); inp.select();

  const finish = (save) => {
    const val = inp.value.trim();
    if (save && val && val !== pl.name) {
      pl.name = val;
      schedSave();
      renderSidebar();
    }
    titleEl.textContent = pl.name;
  };
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') { inp.value = pl.name; finish(false); }
  });
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

function dropAlbumOnPlaylist(playlistId) {
  const pl = getPlaylist(playlistId);
  if (!pl) return;

  let added = 0;
  if (dragState.trackIds) {
    // Dragging from another playlist — tracks already in state.tracks
    for (const tid of dragState.trackIds) {
      if (pl.trackIds.includes(tid)) continue;
      pl.trackIds.push(tid);
      added++;
    }
  } else if (dragState.sourceItems) {
    // Dragging from cart/wishlist — upsert raw items into state.tracks
    for (const item of dragState.sourceItems) {
      const id = crypto.randomUUID();
      const track = { ...item, id, addedAt: new Date().toISOString() };
      state.tracks[id] = track;
      pl.trackIds.push(id);
      added++;
    }
  }

  if (!added) { toast('All tracks already in playlist'); return; }
  schedSave();
  renderSidebar();
  if (ui.activePlaylistId === playlistId) renderContent();
  toast(`Added ${added} track${added !== 1 ? 's' : ''} to "${pl.name}"`);
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
  ui.selectedTrackId = null;
  ui.selectedTrackIds.clear();
  ui.selectedCartIds.clear();
  renderSidebar();
  renderLibContent(view);
  renderDetailPanel();
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
  document.getElementById('pull-cart-header-btn').classList.add('hidden');
  document.getElementById('refresh-cart-btn').classList.add('hidden');
  document.getElementById('remove-selected-cart-btn').classList.add('hidden');
  document.getElementById('clear-cart-btn').classList.add('hidden');
  document.getElementById('pull-wishlist-header-btn').classList.add('hidden');
  document.getElementById('wishlist-collapse-all-btn').classList.add('hidden');
  document.getElementById('wishlist-expand-all-btn').classList.add('hidden');
  pullActions.classList.remove('hidden');

  let items = [];
  if (view === 'purchased') {
    titleEl.textContent = 'Purchased';
    items = Object.values(state.tracks).filter(t => t.purchased);
    document.getElementById('pull-purchased-btn').classList.remove('hidden');
  } else if (view === 'cart') {
    titleEl.textContent = 'Cart';
    items = state.cartItems;
    document.getElementById('pull-cart-header-btn').classList.remove('hidden');
    const hasCart = state.cartItems.length > 0;
    document.getElementById('refresh-cart-btn').classList.toggle('hidden', !hasCart);
    document.getElementById('clear-cart-btn').classList.toggle('hidden', !hasCart);
  } else if (view === 'wishlist') {
    titleEl.textContent = 'Wishlist';
    items = state.wishlistItems;
    document.getElementById('pull-wishlist-header-btn').classList.remove('hidden');
    const hasWishlistAlbums = state.wishlistItems.some(it => it.albumTitle || it.type === 'album');
    document.getElementById('wishlist-collapse-all-btn').classList.toggle('hidden', !hasWishlistAlbums);
    document.getElementById('wishlist-expand-all-btn').classList.toggle('hidden', !hasWishlistAlbums);
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
    // Cart / Wishlist: group by album where possible
    const groups = groupLibItems(items.filter(Boolean));
    let trackNum = 0;
    groups.forEach(group => {
      if (group.type === 'album') {
        listEl.appendChild(buildLibAlbumGroup(group, view));
      } else {
        trackNum++;
        listEl.appendChild(buildLibTrackRow(group.item, trackNum, view));
      }
    });
  }

  if (view === 'purchased' || view === 'wishlist' || view === 'cart') {
    renderLibStats(view, items);
  } else {
    document.getElementById('playlist-stats').classList.add('hidden');
  }
}

// ── Global search ─────────────────────────────────────────────────────────
function handleGlobalSearch(query) {
  globalSearchQuery = query.trim().toLowerCase();
  document.getElementById('global-search-clear').classList.toggle('hidden', !globalSearchQuery);

  if (!globalSearchQuery) {
    // Return to previous view
    renderContent();
    return;
  }

  const titleEl   = document.getElementById('playlist-title');
  const actionsEl = document.getElementById('playlist-actions');
  const libEl     = document.getElementById('lib-pull-actions');
  const emptyEl   = document.getElementById('track-list-empty');
  const listEl    = document.getElementById('track-list');
  const colHdr    = document.getElementById('track-col-header');
  const addBar    = document.getElementById('add-track-bar');

  titleEl.textContent = `Search: "${query.trim()}"`;
  actionsEl.classList.add('hidden');
  libEl.classList.add('hidden');
  addBar.classList.add('hidden');
  colHdr.classList.remove('hidden');
  listEl.innerHTML = '';

  const results = Object.values(state.tracks).filter(t => {
    const hay = `${t.title} ${t.artist} ${t.albumTitle ?? ''} ${(t.tags ?? []).join(' ')}`.toLowerCase();
    return hay.includes(globalSearchQuery);
  });

  if (!results.length) {
    emptyEl.classList.remove('hidden');
    emptyEl.textContent = 'No tracks found.';
    return;
  }
  emptyEl.classList.add('hidden');
  emptyEl.textContent = 'No tracks in this playlist yet.';

  // Show results as plain track rows (no playlist context)
  results.forEach(t => {
    const row = buildTrackRow(t.id, null);
    listEl.appendChild(row);
  });
}

function clearGlobalSearch() {
  globalSearchQuery = '';
  document.getElementById('global-search').value = '';
  document.getElementById('global-search-clear').classList.add('hidden');
  renderContent();
}

function populateGenreFilter() {
  const pl = getPlaylist(ui.activePlaylistId);
  const ids = pl ? pl.trackIds.filter(id => state.tracks[id]) : Object.keys(state.tracks);
  const genres = [...new Set(ids.flatMap(id => state.tracks[id]?.tags ?? []))].sort();
  const sel = document.getElementById('filter-genre');
  sel.innerHTML = '<option value="">All genres</option>';
  genres.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g; opt.textContent = g;
    if (g === activeFilters.genre) opt.selected = true;
    sel.appendChild(opt);
  });
}

function updateFilterBtn() {
  const active = activeFilters.genre !== '' || activeFilters.purchased !== 'all' || activeFilters.price !== 'all';
  document.getElementById('filter-btn').classList.toggle('active-filter', active);
  document.getElementById('filter-btn').textContent = active ? '⊟ Filter ●' : '⊟ Filter';
}

function filterTrackIds(ids) {
  const { genre, purchased, price } = activeFilters;
  if (genre === '' && purchased === 'all' && price === 'all') return ids;
  return ids.filter(id => {
    const t = state.tracks[id];
    if (!t) return false;
    if (genre && !(t.tags ?? []).includes(genre) && t.genre !== genre) return false;
    if (purchased === 'owned'   && !t.purchased) return false;
    if (purchased === 'unowned' &&  t.purchased) return false;
    const p = parseFloat(t.price);
    if (price === 'free' && (p > 0 || isNaN(p))) return false;
    if (price === 'paid' && !(p > 0)) return false;
    return true;
  });
}

function sortTrackIds(ids) {
  if (ui.sortBy === 'default') return ids;
  const tracks = ids.map(id => state.tracks[id]).filter(Boolean);
  const cmp = {
    artist:      (a, b) => (a.artist ?? '').localeCompare(b.artist ?? ''),
    album:       (a, b) => (a.albumTitle ?? '').localeCompare(b.albumTitle ?? ''),
    'price-asc': (a, b) => (parseFloat(a.price) || 0) - (parseFloat(b.price) || 0),
    'price-desc':(a, b) => (parseFloat(b.price) || 0) - (parseFloat(a.price) || 0),
    duration:    (a, b) => (a.duration || 0) - (b.duration || 0),
    release:     (a, b) => (a.releaseDate ?? '').localeCompare(b.releaseDate ?? '')
  }[ui.sortBy];
  return [...tracks].sort(cmp).map(t => t.id);
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

  const rawIds = pl.trackIds.filter(id => state.tracks[id]);
  const ids = sortTrackIds(filterTrackIds(rawIds));
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
  renderPlaylistStats(rawIds);
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

function groupLibItems(items) {
  const groups = [];
  const albumMap = new Map();
  for (const item of items) {
    // Prefer albumUrl as key (unique per album, same as playlist grouping).
    // Fall back to artist|||albumTitle for cart items which don't carry albumUrl.
    const key = item.albumUrl
      ? item.albumUrl
      : (item.albumTitle ? `${item.artist ?? ''}|||${item.albumTitle}` : null);
    if (key) {
      if (albumMap.has(key)) {
        groups[albumMap.get(key)].items.push(item);
      } else {
        albumMap.set(key, groups.length);
        groups.push({ type: 'album', key, albumTitle: item.albumTitle, artist: item.artist ?? '', artwork: item.artwork, items: [item] });
      }
    } else {
      groups.push({ type: 'track', item });
    }
  }
  // Demote single-item album groups to plain rows — same as playlists.
  // Exception: if the item itself is a whole album/EP (type === 'album'), keep its header —
  // it's a genuinely wishlisted album, not a lone track that happens to have an albumTitle.
  return groups.map(g => {
    if (g.type === 'album' && g.items.length === 1 && g.items[0].type !== 'album') {
      return { type: 'track', item: g.items[0] };
    }
    return g;
  });
}

function buildLibTrackRow(item, num, view) {
  const itemKey = String(item.id ?? item.title);
  const isChecked = view === 'cart' && ui.selectedCartIds.has(itemKey);
  const li = document.createElement('li');
  li.className = 'track-item track-grid' + (isChecked ? ' checked' : '');
  li.dataset.cartKey = itemKey;
  const artHtml = item.artwork
    ? `<img class="track-art" src="${esc(item.artwork)}" alt="" loading="lazy">`
    : `<div class="track-art-placeholder">♪</div>`;
  li.innerHTML = `
    <div class="col-check">${view === 'cart' ? `<input type="checkbox" class="track-cb"${isChecked ? ' checked' : ''}>` : ''}</div>
    <div class="col-num"><span class="col-num-static">${num}</span></div>
    ${artHtml}
    <div class="col-title"><div class="track-title">${esc(item.title ?? '')}</div></div>
    <div class="col-time">${fmtDuration(item.duration)}</div>
    <div class="col-artist">${esc(item.artist ?? '')}</div>
    <div class="col-album">${esc(item.albumTitle ?? '')}</div>
    <div class="col-genre"></div>
    <div class="col-price">${item.price ? fmtPrice(item) : ''}</div>
    <div></div>
    <button class="track-menu-btn" title="Open on Bandcamp">⋯</button>`;
  li.querySelector('.track-menu-btn').addEventListener('click', e => {
    e.stopPropagation();
    if (item.url) window.open(item.url, '_blank');
  });
  if (view === 'cart') {
    const cb = li.querySelector('.track-cb');
    cb.addEventListener('change', e => { e.stopPropagation(); toggleCartItemCheck(itemKey, li, cb); });
    li.addEventListener('click', e => {
      if (e.target.closest('.track-cb') || e.target.closest('.track-menu-btn')) return;
      toggleCartItemCheck(itemKey, li, cb);
    });
  }
  if (view === 'wishlist' || view === 'cart') {
    li.draggable = true;
    li.title = 'Drag to a playlist';
    li.addEventListener('dragstart', e => {
      dragState = { type: 'track', id: item.id ?? null, sourceItem: item };
      e.dataTransfer.effectAllowed = 'copy';
      setTimeout(() => li.classList.add('dragging'), 0);
    });
    li.addEventListener('dragend', () => { li.classList.remove('dragging'); clearDragOver(); });
  }
  return li;
}

function buildLibAlbumGroup(group, view) {
  const key = group.key;
  const collapsed = ui.collapsedAlbums.has(key);
  const li = document.createElement('li');
  li.className = 'album-group' + (collapsed ? ' collapsed' : '');
  li.dataset.albumUrl = key;

  const isAlbumItem = group.items.length === 1 && group.items[0].type === 'album';
  const albumItem   = isAlbumItem ? group.items[0] : null;
  const innerTracks = isAlbumItem ? (albumItem.tracks ?? []) : group.items;

  const totalDur = innerTracks.reduce((s, t) => s + (t.duration ?? 0), 0);
  const durStr   = totalDur > 0 ? fmtDuration(totalDur) : '';
  const n        = isAlbumItem ? (albumItem.numTracks ?? innerTracks.length) : group.items.length;
  const countStr = `${n} track${n !== 1 ? 's' : ''}`;
  const metaParts = [countStr, durStr].filter(Boolean);

  // Album price: from album item price or sum of inner track prices
  let albumPrice = 0;
  if (isAlbumItem && albumItem.price) {
    albumPrice = toGBP(parseFloat(albumItem.price), albumItem.currency);
  } else {
    innerTracks.forEach(t => { if (t.price) albumPrice += toGBP(parseFloat(t.price), t.currency); });
  }
  const albumPriceStr = albumPrice > 0 ? fmtGBP(albumPrice) : '';

  const artHtml = group.artwork
    ? `<img class="album-group-art" src="${esc(group.artwork)}" alt="" loading="lazy">`
    : `<div class="album-group-art-placeholder">♪</div>`;

  const allKeys = group.items.map(t => String(t.id ?? t.title));
  const allChecked = view === 'cart' && allKeys.length > 0 && allKeys.every(k => ui.selectedCartIds.has(k));
  li.innerHTML = `
    <div class="album-group-header">
      <div class="col-check">${view === 'cart' ? `<input type="checkbox" class="album-select-cb track-cb"${allChecked ? ' checked' : ''}>` : ''}</div>
      ${artHtml}
      <div class="album-group-info">
        <div class="album-group-title">${esc(group.albumTitle)}</div>
        <div class="album-group-meta">${esc(group.artist)} · ${metaParts.join(' · ')}</div>
      </div>
      ${albumPriceStr ? `<span class="album-group-price">${esc(albumPriceStr)}</span>` : ''}
      <button class="album-group-play-btn">▶ Play</button>
      <div class="album-group-actions"></div>
    </div>
    <ul class="album-group-tracks"></ul>`;

  const tracksUl = li.querySelector('.album-group-tracks');
  innerTracks.forEach((t, idx) => tracksUl.appendChild(buildLibTrackRow(t, idx + 1, view)));

  if (view === 'cart') {
    const albumCb = li.querySelector('.album-select-cb');
    albumCb.addEventListener('click', e => e.stopPropagation());
    albumCb.addEventListener('change', () => {
      const areAllSelected = allKeys.every(k => ui.selectedCartIds.has(k));
      allKeys.forEach(k => areAllSelected ? ui.selectedCartIds.delete(k) : ui.selectedCartIds.add(k));
      renderLibContent('cart');
      updateCartSelectionUI();
    });
  }

  // Drag whole album to a playlist
  const libHeader = li.querySelector('.album-group-header');
  libHeader.draggable = true;
  libHeader.title = 'Drag to a playlist';
  libHeader.addEventListener('dragstart', e => {
    dragState = { type: 'album', sourceItems: group.items };
    e.dataTransfer.effectAllowed = 'copy';
    setTimeout(() => li.classList.add('dragging'), 0);
  });
  libHeader.addEventListener('dragend', () => li.classList.remove('dragging'));

  li.querySelector('.album-group-header').addEventListener('click', e => {
    if (e.target.closest('.album-group-play-btn')) {
      const playable = innerTracks.filter(t => t.id);
      if (playable.length) playLibQueue(playable);
    } else if (!e.target.closest('.album-select-cb') && innerTracks.length > 0) {
      toggleAlbumGroup(key, li);
    }
  });

  return li;
}

function toggleCartItemCheck(key, li, cb) {
  if (ui.selectedCartIds.has(key)) {
    ui.selectedCartIds.delete(key);
  } else {
    ui.selectedCartIds.add(key);
  }
  const checked = ui.selectedCartIds.has(key);
  li.classList.toggle('checked', checked);
  if (cb) cb.checked = checked;
  updateCartSelectionUI();
}

function updateCartSelectionUI() {
  const count = ui.selectedCartIds.size;
  const btn = document.getElementById('remove-selected-cart-btn');
  if (!btn) return;
  btn.classList.toggle('hidden', count === 0);
  if (count > 0) btn.textContent = `✕ Remove Selected (${count})`;
}

async function removeSelectedCartItems() {
  if (!ui.selectedCartIds.size) return;

  // Collect the items being removed
  const toRemove = state.cartItems.filter(item => ui.selectedCartIds.has(String(item.id ?? item.title)));

  // Sort: individual tracks first, then album/EP packages — safer ordering for sequential del requests
  const typeOrder = t => (t === 't' ? 0 : 1);
  const removeItems = toRemove
    .filter(item => item.id != null || item.itemId != null)
    .map(item => ({ localId: item.id ?? null, itemId: item.itemId ?? null, itemType: item.itemType ?? 't' }))
    .sort((a, b) => typeOrder(a.itemType) - typeOrder(b.itemType));

  // Remove locally immediately
  state.cartItems = state.cartItems.filter(item => !ui.selectedCartIds.has(String(item.id ?? item.title)));
  ui.selectedCartIds.clear();
  schedSave();
  renderLibContent('cart');
  renderLibraryCounts();
  updateCartSelectionUI();
  const hasItems = state.cartItems.length > 0;
  document.getElementById('refresh-cart-btn').classList.toggle('hidden', !hasItems);
  document.getElementById('clear-cart-btn').classList.toggle('hidden', !hasItems);

  // Also remove from Bandcamp via extension
  const extId = getExtensionId();
  if (extId && removeItems.length) {
    toast(`Removing ${removeItems.length} item(s) from Bandcamp cart…`);
    chrome.runtime.sendMessage(extId, { action: 'removeCart', removeItems }, response => {
      if (chrome.runtime.lastError || !response) return;
      if (response.error) toast(`Bandcamp removal: ${response.error}`, 'error');
      else if (response.fail > 0) toast(`Removed ${response.ok} from Bandcamp, ${response.fail} failed`, 'error');
      else toast(`Removed ${response.ok} item(s) from Bandcamp cart`, 'success');
    });
  }
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

  const safeItems  = items.filter(Boolean);
  const trackCount = safeItems.length;
  const totalDur   = safeItems.reduce((s, t) => s + (t.duration ?? 0), 0);

  // Total price: for wishlist sum prices; for purchased sum what was paid
  let totalGBP = 0;
  for (const t of safeItems) {
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

  // Drag whole album to another playlist
  const header = li.querySelector('.album-group-header');
  header.draggable = true;
  header.addEventListener('dragstart', e => {
    dragState = { type: 'album', trackIds: group.trackIds };
    e.dataTransfer.effectAllowed = 'copy';
    setTimeout(() => li.classList.add('dragging'), 0);
  });
  header.addEventListener('dragend', () => li.classList.remove('dragging'));

  // Toggle collapse on header click (not play button, not select checkbox, not remove btn)
  header.addEventListener('click', e => {
    if (e.target.closest('.album-group-play-btn')) {
      playAlbumGroup(group, playlistId);
    } else if (!e.target.classList.contains('album-select-cb') && !e.target.closest('.album-remove-btn') && !e.target.closest('.drag-handle')) {
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

function collapseAllAlbums() {
  document.querySelectorAll('#track-list .album-group').forEach(li => {
    const key = li.dataset.albumUrl;
    if (key) ui.collapsedAlbums.add(key);
    li.classList.add('collapsed');
  });
}

function expandAllAlbums() {
  document.querySelectorAll('#track-list .album-group').forEach(li => {
    const key = li.dataset.albumUrl;
    if (key) ui.collapsedAlbums.delete(key);
    li.classList.remove('collapsed');
  });
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

function onTrackEnded() { setPlaying(false); playNext(true); }
function onAudioError(e) {
  // Ignore spurious errors fired when src is changed/aborted mid-load
  if (player.isLoading) return;
  if (!audioEl.error) return;
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
  if (!document.getElementById('queue-panel').classList.contains('hidden')) renderQueuePanel();
}

function queueTrackIds() {
  if (player.playlistId === '__lib__') return state.libQueue.map(t => t.id).filter(Boolean);
  return playlistTrackIds(player.playlistId);
}

function effectiveIds() {
  const ids = queueTrackIds();
  if (!player.shuffle || ids.length <= 1) return ids;
  // Keep shuffleOrder in sync with current ids
  const valid = shuffleOrder.filter(id => ids.includes(id));
  const missing = ids.filter(id => !valid.includes(id));
  // Insert missing ids at random positions
  missing.forEach(id => valid.splice(Math.floor(Math.random() * (valid.length + 1)), 0, id));
  if (valid.length !== shuffleOrder.length || valid.some((id, i) => id !== shuffleOrder[i])) shuffleOrder = valid;
  return shuffleOrder;
}

function playNext(fromEnded = false) {
  if (fromEnded && player.repeat === 'one') { audioEl.currentTime = 0; audioEl.play().catch(() => {}); return; }
  const ids = effectiveIds();
  if (!ids.length) return;
  const idx = ids.indexOf(player.trackId);
  const isLast = idx === ids.length - 1;
  if (fromEnded && isLast && player.repeat === 'none') { setPlaying(false); return; }
  const next = ids[(idx + 1) % ids.length];
  playTrack(next, player.playlistId);
}

function playPrev() {
  if (audioEl.currentTime > 3) { audioEl.currentTime = 0; return; }
  const ids = effectiveIds();
  if (!ids.length) return;
  const idx = ids.indexOf(player.trackId);
  const prev = ids[(idx - 1 + ids.length) % ids.length];
  playTrack(prev, player.playlistId);
}

function toggleShuffle() {
  player.shuffle = !player.shuffle;
  if (player.shuffle) {
    // Build a fresh shuffle order, current track first
    const ids = queueTrackIds();
    shuffleOrder = [player.trackId, ...ids.filter(id => id !== player.trackId).sort(() => Math.random() - 0.5)];
  }
  document.getElementById('shuffle-btn').classList.toggle('active', player.shuffle);
}

function toggleRepeat() {
  const next = { none: 'all', all: 'one', one: 'none' };
  player.repeat = next[player.repeat];
  const btn = document.getElementById('repeat-btn');
  btn.classList.toggle('active', player.repeat !== 'none');
  btn.title = { none: 'Repeat: Off', all: 'Repeat: All', one: 'Repeat: One' }[player.repeat];
  const icon = btn.querySelector('.repeat-one-indicator');
  if (icon) icon.classList.toggle('hidden', player.repeat !== 'one');
}

function togglePlayPause() {
  if (!player.trackId) return;
  if (audioEl.paused) { audioEl.play().then(() => setPlaying(true)).catch(() => {}); }
  else { audioEl.pause(); setPlaying(false); }
}

function playLibQueue(tracks) {
  if (!tracks?.length) return;
  state.libQueue = tracks;
  // Register tracks in state.tracks in-memory so playTrack can look them up via stream API
  tracks.forEach(t => { if (t.id) state.tracks[t.id] = t; });
  playTrack(tracks[0].id, '__lib__');
}

// ── Queue panel ───────────────────────────────────────────────────────────
let queueDrag = { fromIdx: null };

function toggleQueuePanel() {
  const panel = document.getElementById('queue-panel');
  const isHidden = panel.classList.contains('hidden');
  if (isHidden) { renderQueuePanel(); panel.classList.remove('hidden'); }
  else panel.classList.add('hidden');
}

function renderQueuePanel() {
  const list = document.getElementById('queue-list');
  list.innerHTML = '';

  const ids = queueTrackIds();
  if (!ids.length) {
    list.innerHTML = '<li class="queue-empty">Nothing queued — play a track first</li>';
    return;
  }

  const curIdx = ids.indexOf(player.trackId);

  ids.forEach((tid, i) => {
    const t = state.tracks[tid];
    if (!t) return;

    const li = document.createElement('li');
    li.className = 'queue-row' + (i === curIdx ? ' queue-current' : '');
    li.draggable = true;
    li.dataset.idx = i;

    li.innerHTML = `
      <span class="queue-drag-handle" title="Drag to reorder">⠿</span>
      ${t.artwork ? `<img class="queue-art" src="${t.artwork}" alt="">` : '<span class="queue-art-placeholder"></span>'}
      <span class="queue-track-info">
        <span class="queue-title">${t.title}</span>
        <span class="queue-artist">${t.artist}</span>
      </span>
      <span class="queue-duration">${t.duration ? fmtDuration(t.duration) : ''}</span>
    `;

    li.addEventListener('click', e => {
      if (e.target.closest('.queue-drag-handle')) return;
      playTrack(tid, player.playlistId);
    });

    li.addEventListener('dragstart', e => {
      queueDrag.fromIdx = i;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => li.classList.add('dragging'), 0);
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      document.querySelectorAll('.queue-row.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    li.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.queue-row.drag-over').forEach(el => el.classList.remove('drag-over'));
      li.classList.add('drag-over');
    });
    li.addEventListener('drop', e => {
      e.preventDefault();
      li.classList.remove('drag-over');
      const fromIdx = queueDrag.fromIdx;
      const toIdx = i;
      if (fromIdx === null || fromIdx === toIdx) return;
      queueDrag.fromIdx = null;

      if (player.playlistId === '__lib__') {
        const moved = state.libQueue.splice(fromIdx, 1)[0];
        state.libQueue.splice(toIdx, 0, moved);
      } else {
        const pl = getPlaylist(player.playlistId);
        if (!pl) return;
        const allIds = [...pl.trackIds];
        const movedId = allIds.splice(fromIdx, 1)[0];
        allIds.splice(toIdx, 0, movedId);
        pl.trackIds = allIds;
        schedSave();
        if (ui.activePlaylistId === player.playlistId) renderContent();
      }
      renderQueuePanel();
    });

    list.appendChild(li);
  });
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
  if (!player.playlistId) { toast('Start playing a track first', 'warn'); return; }
  const pl = getPlaylist(player.playlistId);
  if (!pl) return;
  const curIdx = pl.trackIds.indexOf(player.trackId);
  const insertAt = curIdx >= 0 ? curIdx + 1 : pl.trackIds.length;
  const existing = pl.trackIds.indexOf(trackId);
  if (existing >= 0) pl.trackIds.splice(existing, 1);
  pl.trackIds.splice(insertAt, 0, trackId);
  schedSave(); renderContent();
  if (!document.getElementById('queue-panel').classList.contains('hidden')) renderQueuePanel();
  toast('Playing next');
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

function duplicateActivePlaylist() {
  if (!ui.activePlaylistId) return;
  const src = getPlaylist(ui.activePlaylistId);
  if (!src) return;
  const copy = { id: crypto.randomUUID(), name: `${src.name} (copy)`, trackIds: [...src.trackIds] };
  state.playlists.push(copy);
  state.sidebarOrder.push({ type: 'playlist', id: copy.id });
  schedSave(); renderSidebar(); selectPlaylist(copy.id);
  toast(`Duplicated "${src.name}"`, 'success');
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

function enrichCartItems(items) {
  // Build a URL→track lookup from the Hub library for cross-referencing
  const byUrl = {};
  for (const t of Object.values(state.tracks)) {
    if (t.url) byUrl[t.url] = t;
  }

  return items.filter(Boolean).map(item => {
    // Cross-reference with Hub track by URL for full metadata
    const match = item.url ? byUrl[item.url] : null;
    if (match) {
      return {
        ...item,
        artist:     match.artist     ?? item.artist,
        albumTitle: match.albumTitle ?? item.albumTitle,
        artwork:    match.artwork    ?? item.artwork,
        duration:   match.duration   ?? item.duration,
        // Keep the cart's own price/currency
        price:    item.price,
        currency: item.currency,
      };
    }

    // Fallback: derive artist from URL subdomain (e.g. artistname.bandcamp.com)
    let { artist, ...rest } = item;
    if ((!artist || artist === 'Unknown') && item.url) {
      const m = item.url.match(/https?:\/\/([^.]+)\.bandcamp\.com/);
      if (m) artist = m[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
    return { ...rest, artist };
  });
}

async function pullCartDirect() {
  const btn = document.getElementById('pull-cart-header-btn');
  btn.disabled = true;
  btn.textContent = '⟳ Pulling…';
  try {
    const extId = getExtensionId();
    let items;
    if (extId) {
      items = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(extId, { action: 'getCart' }, response => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!response?.ok) return reject(new Error(response?.error ?? 'Extension error'));
          resolve(response.items ?? []);
        });
      });
    } else {
      const res = await api.get('/api/cart/pull');
      items = res.items ?? [];
    }
    state.cartItems = enrichCartItems(items);
    schedSave();
    renderLibContent('cart');
    renderLibraryCounts();
    const hasItems = items.length > 0;
    document.getElementById('refresh-cart-btn').classList.toggle('hidden', !hasItems);
    document.getElementById('clear-cart-btn').classList.toggle('hidden', !hasItems);
    if (!items.length) toast('Cart is empty.');
    else toast(`Found ${items.length} item(s) in cart`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '⬇ Pull from Bandcamp';
  }
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
      if (item.type === 'album' && item.tracks?.length > 1) {
        // Multi-track album: flatten so tracks group under a shared header
        flat.push(...item.tracks);
      } else {
        // Single-track EP, trackless album, or individual track: keep as-is so
        // album items retain type:'album' and get an album group header
        flat.push(item);
      }
    }
    state.wishlistItems = flat.filter(Boolean);
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

async function refreshCartItems() {
  const items = state.cartItems.filter(t => t?.url || t?.itemId);
  if (!items.length) { toast('No items to refresh', 'error'); return; }

  const btn = document.getElementById('refresh-cart-btn');
  btn.disabled = true;

  let ok = 0, fail = 0;
  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      btn.textContent = `↻ ${i + 1}/${items.length}…`;
      try {
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000));
        let fetched = null;

        if (item.url) {
          // Preferred: look up by URL
          const res = await Promise.race([api.post('/api/track/lookup', { url: item.url }), timeout]);
          fetched = res.items?.[0] ?? res.track ?? null;
        } else if (item.itemId) {
          // Fallback: look up by Bandcamp track ID
          const res = await Promise.race([
            api.get(`/api/track/lookup-bc-id?id=${item.itemId}&type=${item.itemType ?? 't'}&band_id=${item.bandId ?? 0}`),
            timeout
          ]);
          if (!res.error) fetched = res;
        }

        if (fetched) {
          const idx = state.cartItems.findIndex(c => c.id === item.id);
          if (idx !== -1) {
            state.cartItems[idx] = {
              ...state.cartItems[idx],
              url:        fetched.url        ?? state.cartItems[idx].url,
              artist:     fetched.artist     ?? state.cartItems[idx].artist,
              albumTitle: fetched.albumTitle ?? fetched.album?.name ?? state.cartItems[idx].albumTitle,
              artwork:    fetched.artwork    ?? fetched.imageUrl    ?? state.cartItems[idx].artwork,
              duration:   fetched.duration   ?? state.cartItems[idx].duration,
            };
          }
          ok++;
        } else { fail++; }
      } catch { fail++; }
    }
    schedSave();
    renderLibContent('cart');
    renderLibraryCounts();
    toast(`Refreshed ${ok} track${ok !== 1 ? 's' : ''}${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
  } finally {
    btn.disabled = false; btn.textContent = '↻ Refresh All';
  }
}

function clearCartItems() {
  const typeOrder = t => (t === 't' ? 0 : 1);
  const removeItems = state.cartItems
    .filter(item => item.id != null || item.itemId != null)
    .map(item => ({ localId: item.id ?? null, itemId: item.itemId ?? null, itemType: item.itemType ?? 't' }))
    .sort((a, b) => typeOrder(a.itemType) - typeOrder(b.itemType));

  state.cartItems = [];
  ui.selectedCartIds.clear();
  schedSave();
  renderLibContent('cart');
  renderLibraryCounts();
  document.getElementById('refresh-cart-btn').classList.add('hidden');
  document.getElementById('clear-cart-btn').classList.add('hidden');
  document.getElementById('remove-selected-cart-btn').classList.add('hidden');

  const extId = getExtensionId();
  if (extId && removeItems.length) {
    toast(`Clearing ${removeItems.length} item(s) from Bandcamp cart…`);
    chrome.runtime.sendMessage(extId, { action: 'removeCart', removeItems }, response => {
      if (chrome.runtime.lastError || !response) return;
      if (response.error) toast(`Bandcamp clear: ${response.error}`, 'error');
      else if (response.fail > 0) toast(`Cleared ${response.ok} from Bandcamp, ${response.fail} failed`, 'error');
      else toast(`Bandcamp cart cleared`, 'success');
    });
  }
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
    const { ok, fail, total, subtotal } = response;
    const priceStr = subtotal != null ? ` — £${subtotal.toFixed(2)} cart total` : '';
    if (fail === 0) {
      toast(`${ok} of ${total} tracks added to cart!${priceStr}`, 'success');
    } else if (ok > 0) {
      toast(`${ok} added, ${fail} failed${priceStr}`, 'error');
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

function exportData() {
  api.get('/api/data').then(data => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bandcamp-hub-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }).catch(e => toast('Export failed: ' + e.message, 'error'));
}

function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    let parsed;
    try { parsed = JSON.parse(e.target.result); } catch { toast('Invalid JSON file', 'error'); return; }
    if (!parsed.playlists || !parsed.tracks) { toast('File does not look like a Bandcamp Hub backup', 'error'); return; }
    if (!confirm('This will replace all your current playlists and tracks. Are you sure?')) return;
    try {
      await api.post('/api/data', parsed);
      toast('Import successful — reloading…', 'success');
      setTimeout(() => location.reload(), 1200);
    } catch (err) { toast('Import failed: ' + err.message, 'error'); }
  };
  reader.readAsText(file);
}

function fetchCookieFromExtension() {
  const extId = getExtensionId();
  if (!extId) { toast('Extension not installed — load it in chrome://extensions first', 'error'); return; }
  const btn = document.getElementById('fetch-cookie-btn');
  btn.disabled = true; btn.textContent = '⟳ Fetching…';
  chrome.runtime.sendMessage(extId, { action: 'getCookie' }, response => {
    btn.disabled = false; btn.textContent = '⬇ Fetch from Extension';
    if (chrome.runtime.lastError || !response?.ok) {
      toast(response?.error ?? chrome.runtime.lastError?.message ?? 'Could not fetch cookie', 'error');
      return;
    }
    document.getElementById('cookie-input').value = response.cookie;
    toast('Cookie fetched — click Save Settings to apply', 'success');
  });
}

function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// ── Event bindings ────────────────────────────────────────────────────────
function bindEvents() {
  // Header
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('playlist-title').addEventListener('click', () => {
    if (ui.activePlaylistId) startTitleRename(ui.activePlaylistId);
  });
  document.getElementById('cart-btn').addEventListener('click', () => {
    selectLibView('cart');
  });

  // Library items
  document.querySelectorAll('.library-item').forEach(el => {
    el.addEventListener('click', () => selectLibView(el.dataset.lib));
  });

  // Sidebar
  document.getElementById('new-playlist-btn').addEventListener('click', () => createPlaylist());
  document.getElementById('new-folder-btn').addEventListener('click', () => createFolder());
  // Sort
  document.getElementById('sort-select').addEventListener('change', e => {
    ui.sortBy = e.target.value;
    renderContent();
  });

  // Filter panel
  document.getElementById('filter-btn').addEventListener('click', e => {
    e.stopPropagation();
    const panel = document.getElementById('filter-panel');
    const isOpen = !panel.classList.contains('hidden');
    if (!isOpen) populateGenreFilter();
    panel.classList.toggle('hidden', isOpen);
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.filter-wrap')) document.getElementById('filter-panel').classList.add('hidden');
  });
  document.getElementById('filter-genre').addEventListener('change', e => {
    activeFilters.genre = e.target.value; updateFilterBtn(); renderContent();
  });
  document.getElementById('filter-purchased').addEventListener('change', e => {
    activeFilters.purchased = e.target.value; updateFilterBtn(); renderContent();
  });
  document.getElementById('filter-price').addEventListener('change', e => {
    activeFilters.price = e.target.value; updateFilterBtn(); renderContent();
  });
  document.getElementById('filter-clear-btn').addEventListener('click', () => {
    activeFilters = { genre: '', purchased: 'all', price: 'all' };
    document.getElementById('filter-genre').value = '';
    document.getElementById('filter-purchased').value = 'all';
    document.getElementById('filter-price').value = 'all';
    updateFilterBtn(); renderContent();
  });

  // Global search
  const globalSearchEl = document.getElementById('global-search');
  globalSearchEl.addEventListener('input', e => handleGlobalSearch(e.target.value));
  globalSearchEl.addEventListener('keydown', e => { if (e.key === 'Escape') clearGlobalSearch(); });
  document.getElementById('global-search-clear').addEventListener('click', clearGlobalSearch);

  document.getElementById('duplicate-playlist-btn').addEventListener('click', duplicateActivePlaylist);
  document.getElementById('delete-playlist-btn').addEventListener('click', deleteActivePlaylist);
  document.getElementById('push-all-cart-btn').addEventListener('click', () => pushPlaylistToCart(ui.activePlaylistId));
  document.getElementById('push-selected-cart-btn').addEventListener('click', pushSelectedToCart);
  document.getElementById('refresh-all-btn').addEventListener('click', refreshAllTracks);
  document.getElementById('playlist-collapse-all-btn').addEventListener('click', collapseAllAlbums);
  document.getElementById('playlist-expand-all-btn').addEventListener('click', expandAllAlbums);
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
  document.getElementById('queue-btn').addEventListener('click', toggleQueuePanel);
  document.getElementById('queue-close-btn').addEventListener('click', toggleQueuePanel);
  document.getElementById('play-btn').addEventListener('click', togglePlayPause);
  document.getElementById('next-btn').addEventListener('click', () => playNext(false));
  document.getElementById('prev-btn').addEventListener('click', playPrev);
  document.getElementById('shuffle-btn').addEventListener('click', toggleShuffle);
  document.getElementById('repeat-btn').addEventListener('click', toggleRepeat);
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
  document.getElementById('wishlist-collapse-all-btn').addEventListener('click', collapseAllAlbums);
  document.getElementById('wishlist-expand-all-btn').addEventListener('click', expandAllAlbums);

  // Cart / Wishlist header pull buttons
  document.getElementById('pull-cart-header-btn').addEventListener('click', pullCartDirect);
  document.getElementById('refresh-cart-btn').addEventListener('click', refreshCartItems);
  document.getElementById('remove-selected-cart-btn').addEventListener('click', removeSelectedCartItems);
  document.getElementById('clear-cart-btn').addEventListener('click', clearCartItems);

  // Settings
  document.getElementById('save-settings-btn').addEventListener('click', saveSettings);
  document.getElementById('fetch-cookie-btn').addEventListener('click', fetchCookieFromExtension);
  document.getElementById('export-data-btn').addEventListener('click', exportData);
  document.getElementById('import-data-input').addEventListener('change', e => { importData(e.target.files[0]); e.target.value = ''; });

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
    if (e.key === '/')          { e.preventDefault(); document.getElementById('global-search').focus(); }
    if (e.key === ' ')          { e.preventDefault(); togglePlayPause(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); audioEl.currentTime += 10; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); audioEl.currentTime -= 10; }
    if (e.key === 'Escape') {
      hideContextMenu();
      document.getElementById('queue-panel').classList.add('hidden');
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
