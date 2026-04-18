const HUB_BASE = 'http://localhost:3000';

let popupState = {
  sourceUrl: '',
  lookup: null,
  data: null,
  playlists: [],
  filteredPlaylists: [],
  selectedPlaylistId: '',
  selectedKeys: new Set()
};

document.addEventListener('DOMContentLoaded', initPopup);

async function initPopup() {
  bindEvents();

  const url = await getActiveTabUrl();
  if (!isSupportedBandcampUrl(url)) {
    showUnsupported();
    return;
  }

  popupState.sourceUrl = url;

  try {
    const [targets, lookup, data] = await Promise.all([
      hubGet('/api/library/targets'),
      hubPost('/api/track/lookup', { url }),
      hubGet('/api/data')
    ]);

    popupState.lookup = lookup;
    popupState.data = data;
    popupState.playlists = (targets.playlists ?? []).map(pl => ({ ...pl, type: 'playlist' }));
    popupState.filteredPlaylists = [...popupState.playlists];
    popupState.selectedKeys = new Set(
      (lookup.items ?? [])
        .map(item => normalizeUrl(item.url))
        .filter(Boolean)
    );

    renderPlaylists();
    renderSourceSummary();
    renderItems();
    updateSelectionCopy();
    updatePlaylistSelectionUI();
    document.getElementById('popup-main').classList.remove('hidden');
  } catch (err) {
    showMessage(err.message.includes('fetch') ? 'Hub not reachable on localhost:3000.' : err.message, 'error');
    showUnsupported();
  }
}

function bindEvents() {
  document.getElementById('playlist-search').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    popupState.filteredPlaylists = popupState.playlists.filter(target =>
      target.name.toLowerCase().includes(q)
    );
    renderPlaylists();
    openPlaylistMenu();
  });
  document.getElementById('playlist-search').addEventListener('focus', () => {
    popupState.filteredPlaylists = [...popupState.playlists];
    renderPlaylists();
    openPlaylistMenu();
  });
  document.getElementById('playlist-search').addEventListener('keydown', e => {
    if (e.key === 'Escape') closePlaylistMenu();
  });
  document.getElementById('playlist-toggle').addEventListener('click', () => {
    const open = !document.getElementById('playlist-menu').classList.contains('hidden');
    if (open) closePlaylistMenu();
    else {
      popupState.filteredPlaylists = [...popupState.playlists];
      renderPlaylists();
      openPlaylistMenu();
      document.getElementById('playlist-search').focus();
    }
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.playlist-combobox')) closePlaylistMenu();
  });
  document.getElementById('select-all-btn').addEventListener('click', () => {
    popupState.selectedKeys = new Set((popupState.lookup?.items ?? []).map(item => normalizeUrl(item.url)).filter(Boolean));
    renderItems();
    updateSelectionCopy();
  });
  document.getElementById('select-none-btn').addEventListener('click', () => {
    popupState.selectedKeys.clear();
    renderItems();
    updateSelectionCopy();
  });
  document.getElementById('add-library-btn').addEventListener('click', () => handleAdd({ type: 'library' }, 'add-library-btn', 'Add to Global Library'));
  document.getElementById('add-playlist-btn').addEventListener('click', () => {
    if (!popupState.selectedPlaylistId) {
      showMessage('Choose a playlist first.', 'warn');
      return;
    }
    handleAdd({ type: 'playlist', playlistId: popupState.selectedPlaylistId }, 'add-playlist-btn', 'Add to Playlist');
  });
}

async function handleAdd(target, buttonId, idleLabel) {
  const selectedItemKeys = [...popupState.selectedKeys];
  if (!selectedItemKeys.length) {
    showMessage('Select at least one track to add.', 'warn');
    return;
  }

  const btn = document.getElementById(buttonId);
  btn.disabled = true;
  btn.textContent = 'Adding…';
  clearMessage();

  try {
    const res = await hubPost('/api/library/add', {
      target,
      sourceUrl: popupState.sourceUrl,
      selectedItemKeys
    });

    const duplicateCount = res.duplicates?.length ?? 0;
    const base = `Added ${res.addedCount} track${res.addedCount !== 1 ? 's' : ''}.`;
    const suffix = duplicateCount ? ` ${duplicateCount} duplicate${duplicateCount !== 1 ? 's were' : ' was'} also added.` : '';
    showMessage(base + suffix, duplicateCount ? 'warn' : 'success');
  } catch (err) {
    showMessage(err.message.includes('fetch') ? 'Hub not reachable on localhost:3000.' : err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = idleLabel;
  }
}

function renderPlaylists() {
  const menu = document.getElementById('playlist-menu');
  menu.innerHTML = '';

  if (!popupState.filteredPlaylists.length) {
    menu.innerHTML = '<div class="playlist-empty">No playlists match your search.</div>';
    return;
  }

  popupState.filteredPlaylists.forEach(pl => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'playlist-option' + (popupState.selectedPlaylistId === pl.id ? ' active' : '');
    btn.textContent = pl.name;
    btn.addEventListener('click', () => {
      popupState.selectedPlaylistId = pl.id;
      document.getElementById('playlist-search').value = pl.name;
      updatePlaylistSelectionUI();
      renderPlaylists();
      closePlaylistMenu();
      clearMessage();
    });
    menu.appendChild(btn);
  });
}

function renderSourceSummary() {
  const summary = document.getElementById('source-summary');
  const first = popupState.lookup?.items?.[0];
  const art = popupState.lookup?.albumArtwork ?? first?.artwork;
  const title = popupState.lookup?.type === 'album'
    ? (popupState.lookup.albumName ?? first?.albumTitle ?? 'Album')
    : (first?.title ?? 'Track');
  const subtitle = popupState.lookup?.type === 'album'
    ? `${first?.artist ?? 'Unknown Artist'} · ${(popupState.lookup.items ?? []).length} tracks`
    : `${first?.artist ?? 'Unknown Artist'}${first?.albumTitle ? ` · ${first.albumTitle}` : ''}`;

  summary.innerHTML = `
    ${art ? `<img class="source-art" src="${escapeHtml(art)}" alt="">` : '<div class="source-art placeholder">♪</div>'}
    <div>
      <div class="source-title">${escapeHtml(title)}</div>
      <div class="meta-line">${escapeHtml(subtitle)}</div>
    </div>
  `;

  document.getElementById('album-controls').classList.toggle('hidden', popupState.lookup?.type !== 'album');
}

function renderItems() {
  const list = document.getElementById('item-list');
  list.innerHTML = '';

  for (const item of popupState.lookup?.items ?? []) {
    const key = normalizeUrl(item.url);
    const duplicateLocations = findDuplicateLocations(item.url);
    const checked = popupState.selectedKeys.has(key);
    const li = document.createElement('li');
    li.className = 'item-row' + (duplicateLocations.length ? ' duplicate' : '');
    li.innerHTML = `
      <label class="item-label">
        <input type="checkbox" ${checked ? 'checked' : ''} data-key="${escapeHtml(key ?? '')}">
        <div>
          <div class="item-title">
            ${escapeHtml(item.title ?? 'Unknown Track')}
            ${duplicateLocations.length ? '<span class="badge">Duplicate</span>' : ''}
          </div>
          <div class="item-meta">${escapeHtml(item.artist ?? 'Unknown Artist')}${item.duration ? ` · ${formatDuration(item.duration)}` : ''}</div>
          ${duplicateLocations.length ? `<div class="item-dup">Already in ${escapeHtml(duplicateLocations.join(', '))}</div>` : ''}
        </div>
      </label>
    `;
    const checkbox = li.querySelector('input');
    checkbox.addEventListener('change', e => {
      const itemKey = e.target.dataset.key;
      if (!itemKey) return;
      if (e.target.checked) popupState.selectedKeys.add(itemKey);
      else popupState.selectedKeys.delete(itemKey);
      updateSelectionCopy();
    });
    list.appendChild(li);
  }
}

function updateSelectionCopy() {
  const count = popupState.selectedKeys.size;
  document.getElementById('selection-copy').textContent =
    count ? `${count} selected` : 'No tracks selected';
}

function updatePlaylistSelectionUI() {
  const selected = popupState.playlists.find(pl => pl.id === popupState.selectedPlaylistId);
  document.getElementById('playlist-selection-copy').textContent =
    selected ? `Selected: ${selected.name}` : 'No playlist selected';
  document.getElementById('add-playlist-btn').disabled = !selected;
}

function findDuplicateLocations(url) {
  const norm = normalizeUrl(url);
  if (!norm) return [];
  const locations = new Set();
  const data = popupState.data ?? {};

  for (const track of Object.values(data.tracks ?? {})) {
    if (normalizeUrl(track.url) !== norm) continue;
    if ((data.libraryTrackIds ?? []).includes(track.id)) locations.add('Global Library');
    for (const pl of data.playlists ?? []) {
      if (pl?.type === 'smart') continue;
      if (pl.trackIds?.includes(track.id)) locations.add(pl.name);
    }
    if (!locations.size) locations.add('library');
  }

  return [...locations];
}

function showUnsupported() {
  document.getElementById('popup-main').classList.add('hidden');
  document.getElementById('unsupported').classList.remove('hidden');
}

function openPlaylistMenu() {
  const input = document.getElementById('playlist-search');
  document.getElementById('playlist-menu').classList.remove('hidden');
  document.querySelector('.playlist-combobox').classList.add('open');
  input.setAttribute('aria-expanded', 'true');
}

function closePlaylistMenu() {
  const input = document.getElementById('playlist-search');
  document.getElementById('playlist-menu').classList.add('hidden');
  document.querySelector('.playlist-combobox').classList.remove('open');
  input.setAttribute('aria-expanded', 'false');
}

function showMessage(text, type) {
  const el = document.getElementById('message');
  el.textContent = text;
  el.className = `message ${type}`;
}

function clearMessage() {
  const el = document.getElementById('message');
  el.textContent = '';
  el.className = 'message hidden';
}

async function getActiveTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url ?? '';
}

function isSupportedBandcampUrl(url) {
  return /^https:\/\/[^/]*bandcamp\.com\/(track|album)\//.test(url ?? '');
}

async function hubGet(path) {
  const res = await fetch(HUB_BASE + path);
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

async function hubPost(path, body) {
  const res = await fetch(HUB_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

async function readError(res) {
  const text = await res.text();
  try {
    return JSON.parse(text).error ?? text;
  } catch {
    return text || `Request failed (${res.status})`;
  }
}

function normalizeUrl(url) {
  return url ? String(url).split('?')[0].replace(/\/$/, '') : null;
}

function formatDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
