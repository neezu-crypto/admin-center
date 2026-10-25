(function () {
  'use strict';

  const activeWatches = new Map();
  let observer = null;
  let scanTimer = 0;

  function normalizeText(value) {
    return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  }

  function stationIdFromLink(anchor) {
    let url;
    try { url = new URL(anchor.href, location.href); } catch (_) { return ''; }
    if (url.protocol !== 'https:' || !['sooplive.com', 'www.sooplive.com'].includes(url.hostname)) return '';
    const match = url.pathname.match(/^\/station\/([a-z0-9]{2,20})(?:\/|$)/i);
    return match ? match[1].toLowerCase() : '';
  }

  function findCodeAndReport(anchor, requestId, watch) {
    let node = anchor;
    for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
      const text = normalizeText(node.innerText || node.textContent);
      if (!text) continue;
      if (text.length > 1400) break;
      const match = text.match(/(?:^|[^A-F0-9])([A-F0-9]{10})(?=$|[^A-F0-9])/i);
      if (!match) continue;
      const code = match[1].toUpperCase();
      if (watch.reportedCodes.has(code)) return;
      watch.reportedCodes.add(code);
      chrome.runtime.sendMessage({
        type: 'fanpageSubscriptionCommentCandidate',
        requestId,
        code,
        soopId: watch.soopId,
        postUrl: location.href,
      }).catch(() => {});
      return;
    }
  }

  function scanComments() {
    scanTimer = 0;
    if (!activeWatches.size) return;
    activeWatches.forEach((watch, requestId) => {
      if (watch.expiresAt <= Date.now()) activeWatches.delete(requestId);
    });
    stopObserverIfIdle();
    if (!activeWatches.size) return;
    const anchors = Array.from(document.querySelectorAll('a[href*="/station/"]'));
    if (!anchors.length) return;
    activeWatches.forEach((watch, requestId) => {
      anchors.forEach((anchor) => {
        if (stationIdFromLink(anchor) === watch.soopId) findCodeAndReport(anchor, requestId, watch);
      });
    });
  }

  function scheduleScan() {
    if (!scanTimer) scanTimer = setTimeout(scanComments, 250);
  }

  function startObserver() {
    if (observer || !document.documentElement || typeof MutationObserver !== 'function') return;
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  function stopObserverIfIdle() {
    if (activeWatches.size || !observer) return;
    observer.disconnect();
    observer = null;
    clearTimeout(scanTimer);
    scanTimer = 0;
  }

  function applyWatch(message, sendResponse) {
    const requestId = String(message.requestId || '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
      sendResponse({ ok: false, reason: 'invalid-request-id' });
      return;
    }
    if (message.active === true) {
      const soopId = String(message.soopId || '').trim().toLowerCase();
      if (!/^[a-z0-9]{2,20}$/.test(soopId) || !location.pathname.includes('/post/')) {
        sendResponse({ ok: false, reason: 'invalid-post-watch' });
        return;
      }
      const expiresAt = Number(message.expiresAt) || 0;
      if (expiresAt <= Date.now() || expiresAt > Date.now() + 30 * 60 * 1000 + 5000) {
        sendResponse({ ok: false, reason: 'invalid-watch-expiry' });
        return;
      }
      activeWatches.set(requestId, { soopId, expiresAt, reportedCodes: new Set() });
      startObserver();
      scheduleScan();
      setTimeout(() => {
        const current = activeWatches.get(requestId);
        if (current && current.expiresAt === expiresAt) {
          activeWatches.delete(requestId);
          stopObserverIfIdle();
        }
      }, Math.max(0, expiresAt - Date.now() + 50));
      sendResponse({ ok: true });
      return;
    }
    activeWatches.delete(requestId);
    stopObserverIfIdle();
    sendResponse({ ok: true });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'setFanpageSubscriptionCommentWatch') return false;
    applyWatch(message, sendResponse);
    return false;
  });

  chrome.runtime.sendMessage({ type: 'getFanpageSubscriptionCommentWatches' }).then((result) => {
    if (!result || !Array.isArray(result.watches)) return;
    result.watches.forEach((watch) => applyWatch({
      type: 'setFanpageSubscriptionCommentWatch',
      active: true,
      requestId: watch.requestId,
      soopId: watch.soopId,
      expiresAt: watch.expiresAt,
    }, () => {}));
  }).catch(() => {});
})();
