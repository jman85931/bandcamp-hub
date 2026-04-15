// Bandcamp Hub Cart Push — Background Service Worker

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message.action !== 'pushCart') return;
  handlePushCart(sendResponse);
  return true;
});

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

  let totalOk = 0, totalFail = 0;

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
        totalOk   += r.ok;
        totalFail += r.fail;
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

  sendResponse({ ok: totalOk, fail: totalFail, total: tracks.length });
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
  let ok = 0, fail = 0;
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
            if (data?.req === 'add') { ok++; resolve(); }
            else { fail++; resolve(); }
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

  return { ok, fail };
}
