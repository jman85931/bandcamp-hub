// Bandcamp Hub Cart Push — Background Service Worker

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message.action === 'pushCart')   { handlePushCart(sendResponse);                              return true; }
  if (message.action === 'getCart')    { handleGetCart(sendResponse);                               return true; }
  if (message.action === 'removeCart') { handleRemoveCart(message.removeItems, sendResponse);       return true; }
  if (message.action === 'getCookie')  { handleGetCookie(sendResponse);                             return true; }
});

async function handleGetCookie(sendResponse) {
  try {
    const cookies = await chrome.cookies.getAll({ domain: 'bandcamp.com' });
    if (!cookies.length) { sendResponse({ ok: false, error: 'No Bandcamp cookies found — make sure you are logged in to bandcamp.com' }); return; }
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    sendResponse({ ok: true, cookie: cookieStr });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function handleGetCart(sendResponse) {
  // Must use the /cart page specifically — Sidecart only populates cart_items there
  let tab;
  try {
    tab = await chrome.tabs.create({ url: 'https://bandcamp.com/cart', active: false });
    await waitForTabLoad(tab.id);

    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world:  'MAIN',
      func:   readCartScript
    });

    if (injected[0]?.error) throw new Error(injected[0].error.message);
    const items = injected[0]?.result ?? [];
    sendResponse({ ok: true, items });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Reads the current cart items from Bandcamp's Sidecart module.
function readCartScript() {
  const sc = window.Sidecart;
  if (!sc) return [];
  // cart_items may be a KnockoutJS observableArray (call it) or a plain array
  const raw = typeof sc.cart_items === 'function' ? sc.cart_items() : sc.cart_items;
  if (!Array.isArray(raw)) return [];

  // Bandcamp uses KnockoutJS — item properties may be observable functions; unwrap them
  const ko = v => typeof v === 'function' ? v() : v;

  return raw.map(item => {
    // Unwrap every key so we don't miss anything
    const d = {};
    Object.keys(item).forEach(k => { try { d[k] = ko(item[k]); } catch {} });

    const imageId = d.image_id ?? d.imageId ?? null;
    const artwork = d.item_art ?? d.art_url ?? d.artwork_url
      ?? (imageId ? `https://f4.bcbits.com/img/a${imageId}_2.jpg` : null);

    return {
      id:         d.id         ?? null,   // cart slot ID — what Bandcamp's del request uses as 'id'
      itemId:     d.item_id    ?? null,
      bandId:     d.band_id    ?? null,
      itemType:   d.item_type  ?? 't',
      title:      d.item_title ?? d.title          ?? 'Unknown',
      artist:     d.band_name  ?? d.artist_name    ?? d.artist ?? 'Unknown',
      albumTitle: d.album_title ?? null,
      url:        d.item_url   ?? d.url            ?? null,
      artwork,
      price:      d.unit_price ?? d.price          ?? null,
      currency:   d.currency   ?? 'GBP'
    };
  });
}

async function handleRemoveCart(removeItems, sendResponse) {
  if (!removeItems?.length) { sendResponse({ ok: 0, fail: 0 }); return; }

  let tab;
  try {
    // Open a background cart tab just to read the live sync_num and client_id from Sidecart.
    // We don't do the delete fetches from the injected script — we read state only, close the
    // tab, then POST /cart/cb from the service worker so page JS cannot interfere.
    tab = await chrome.tabs.create({ url: 'https://bandcamp.com/cart', active: false });
    await waitForTabLoad(tab.id);

    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world:  'MAIN',
      func:   readSyncStateScript
    });

    if (injected[0]?.error) throw new Error(injected[0].error.message);
    const state = injected[0]?.result ?? {};
    if (state.syncNum == null) throw new Error('Could not read sync_num from Sidecart');

    let syncNum = state.syncNum;
    const clientId = state.clientId ?? '';

    // Tab served its purpose — close it before making requests
    chrome.tabs.remove(tab.id).catch(() => {});
    tab = null;

    let ok = 0, fail = 0;

    for (const { localId, itemId } of removeItems) {
      // Only use localId (cart slot id from d.id) — itemId is the Bandcamp item/track id
      // and is NOT valid as the del request's id parameter; using it causes a cart wipe.
      if (localId == null) { fail++; continue; }

      // Guard: reject non-integer IDs — sending a float to Bandcamp wipes the cart
      const intId = Math.round(Number(localId));
      if (!Number.isFinite(intId) || intId <= 0 || Math.abs(intId - Number(localId)) > 0.001) {
        fail++;
        continue;
      }

      const body = new URLSearchParams({
        req:       'del',
        id:        String(intId),
        client_id: clientId,
        sync_num:  String(syncNum),
        req_id:    String(Math.random())
      });

      const res = await fetch('https://bandcamp.com/cart/cb', {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:        body.toString()
      });

      if (!res.ok) { fail++; continue; }
      const data = await res.json().catch(() => null);

      if (data?.req === 'del') {
        ok++;
        syncNum++; // server increments sync_num on each successful operation
      } else {
        fail++;
      }
    }

    sendResponse({ ok, fail });
  } catch (err) {
    sendResponse({ ok: 0, fail: removeItems.length, error: err.message });
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Injected into bandcamp.com/cart — reads sync state only, no mutations.
// Waits for Sidecart's async server sync so sync_num is the real current value.
async function readSyncStateScript() {
  const sc = window.Sidecart;
  if (!sc) return { syncNum: null, clientId: null };

  const unwrap = v => typeof v === 'function' ? v() : v;

  await new Promise(resolve => {
    const deadline = Date.now() + 8000;
    const check = () => {
      if (!unwrap(sc.initing)) return resolve();
      if (Date.now() >= deadline) return resolve();
      setTimeout(check, 200);
    };
    check();
  });

  return {
    syncNum:  unwrap(sc.sync_num)  ?? 0,
    clientId: unwrap(sc.client_id) ?? ''
  };
}


async function handlePushCart(sendResponse) {
  // 1. Fetch the queue from Hub server
  let tracks, fanId;
  try {
    const res = await fetch('http://localhost:3000/api/cart/queue');
    const data = await res.json();
    tracks = data.tracks;
    fanId  = data.fanId;
  } catch (err) {
    sendResponse({ ok: 0, fail: 0, error: 'Hub server not reachable' });
    return;
  }

  if (!tracks || tracks.length === 0) {
    sendResponse({ ok: 0, fail: 0, error: 'Queue is empty' });
    return;
  }

  // 2. Group tracks by artist origin — one background tab per artist keeps the
  //    cart/cb request same-origin so window.Sidecart is available and authenticated.
  const byOrigin = new Map();
  for (const t of tracks) {
    if (!byOrigin.has(t.origin)) byOrigin.set(t.origin, []);
    byOrigin.get(t.origin).push(t);
  }

  let totalOk = 0, totalFail = 0, totalSubtotal = null;

  for (const [origin, originTracks] of byOrigin) {
    let tab;
    try {
      tab = await chrome.tabs.create({ url: origin + '/', active: false });
      await waitForTabLoad(tab.id);

      const injected = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world:  'MAIN',
        func:   cartPushScript,
        args:   [originTracks, String(fanId ?? '0')]
      });

      if (injected[0]?.error) {
        totalFail += originTracks.length;
      } else {
        const r = injected[0]?.result ?? { ok: 0, fail: originTracks.length };
        totalOk      += r.ok;
        totalFail    += r.fail;
        if (r.subtotal != null) totalSubtotal = r.subtotal;
      }
    } catch (err) {
      totalFail += originTracks.length;
    } finally {
      if (tab) setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 2000);
    }
  }

  // 3. Clear the queue
  try {
    await fetch('http://localhost:3000/api/cart/queue', { method: 'DELETE' });
  } catch { /* best effort */ }

  sendResponse({ ok: totalOk, fail: totalFail, total: tracks.length, subtotal: totalSubtotal });
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Tab load timeout')), 15000);
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) { clearTimeout(timeout); reject(chrome.runtime.lastError); return; }
      if (tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      } else {
        chrome.tabs.onUpdated.addListener(listener);
      }
    });
  });
}

// Injected into the artist's own page (MAIN world).
// Uses window.Sidecart.add_to_cart() — Bandcamp's own cart module — which handles
// sync_num, client_id, and session state internally.
async function cartPushScript(tracks, storedFanId) {
  let ok = 0, fail = 0, subtotal = null;
  const sc = window.Sidecart;

  // Prefer fan_id from the page's own BandFollowData (already verified correct)
  let fanId = storedFanId || '0';
  try {
    if (window.BandFollowData?.fan_id) fanId = String(window.BandFollowData.fan_id);
  } catch {}

  for (const t of tracks) {
    try {
      if (typeof sc?.add_to_cart === 'function') {
        // Let Bandcamp's Sidecart handle everything. Intercept resp_add to await the result.
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('add_to_cart timeout')), 12000);
          const origResp = sc.resp_add?.bind(sc);
          sc.resp_add = function(data) {
            clearTimeout(timer);
            sc.resp_add = origResp;
            if (origResp) origResp.call(sc, ...arguments);
            if (data?.req === 'add') {
              ok++;
              if (data.subtotal != null) subtotal = data.subtotal;
              resolve();
            } else { fail++; resolve(); }
          };
          try {
            sc.add_to_cart({
              item_id:       Number(t.itemId),
              item_type:     t.itemType || 't',
              unit_price:    Number(t.price) || 1,
              quantity:      1,
              option_id:     null,
              discount_id:   null,
              purchase_note: '',
              fan_id:        Number(fanId) || 0
            });
          } catch (e) {
            clearTimeout(timer);
            sc.resp_add = origResp;
            reject(e);
          }
        });
      } else {
        fail++;
      }
    } catch {
      fail++;
    }
  }

  return { ok, fail, subtotal };
}
