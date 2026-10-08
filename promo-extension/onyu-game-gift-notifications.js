(function () {
  const WATCH_KEY = 'soopOnyuGameGiftNotificationWatch';
  const ATTEMPT_KEY = 'soopOnyuGameGiftNotificationAttempts';
  const REFRESH_MS = 10000;
  const RETRY_MS = 30000;
  let refreshTimer = null;
  let scanning = false;

  function trace(stage, details) {
    console.info('[SOOP 온이유 이용권 자동 확인]', JSON.stringify({
      stage,
      at: new Date().toISOString(),
      details: details || {},
    }));
  }

  function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function normalizeText(value) { return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim(); }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  }

  function labelOf(element) {
    return normalizeText([
      element.getAttribute('aria-label'), element.getAttribute('title'),
      element.getAttribute('data-tooltip'), element.innerText, element.textContent,
    ].filter(Boolean).join(' '));
  }

  function findNotificationBell() {
    const elements = Array.from(document.querySelectorAll('button,[role="button"],[aria-label],[title],[data-tooltip]'));
    const candidates = [];
    elements.forEach((element) => {
      if (!isVisible(element)) return;
      const text = labelOf(element);
      if (!/알림|notification/i.test(text)) return;
      const button = element.closest('button,[role="button"]') || element;
      if (!isVisible(button) || candidates.includes(button)) return;
      const label = labelOf(button);
      const rect = button.getBoundingClientRect();
      const score = (/^(알림|알림 열기|notifications?|view notifications)$/i.test(label) ? 100 : 0) +
        (rect.top < 150 ? 20 : 0) + (rect.width < 100 && rect.height < 100 ? 10 : 0) - label.length / 100;
      candidates.push({ button, score });
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].button : null;
  }

  function getBellExpanded(bell) {
    if (!bell) return null;
    const value = bell.getAttribute('aria-expanded');
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
  }

  function hasNotificationPanelOpen(bell) {
    if (getBellExpanded(bell) === true) return true;
    const tabs = Array.from(document.querySelectorAll('[role="tab"],button,[role="button"]'))
      .filter(isVisible).map(labelOf);
    const hasTabs = ['전체', '소식', '활동', '혜택'].every((label) => tabs.some((text) => text === label || text.includes(label)));
    if (hasTabs) return true;
    const panels = Array.from(document.querySelectorAll('[role="dialog"],[role="menu"],[role="tabpanel"],[class*="notification"],[class*="alarm"]'))
      .filter(isVisible);
    return panels.some((panel) => {
      const text = normalizeText(panel.innerText || panel.textContent);
      return text.includes('시간순') && text.includes('오늘') && /소식|활동|혜택/.test(text) && text.length < 20000;
    });
  }

  function stationIdFromLink(anchor) {
    let url;
    try { url = new URL(anchor.href, location.href); } catch (_) { return ''; }
    if (url.protocol !== 'https:' || !['sooplive.com', 'www.sooplive.com'].includes(url.hostname)) return '';
    const match = url.pathname.match(/^\/station\/([a-z0-9]{2,20})(?:\/|$)/i);
    return match ? match[1].toLowerCase() : '';
  }

  function findDonationRow(anchor, senderSoopId) {
    let node = anchor;
    for (let depth = 0; node && depth < 18; depth += 1, node = node.parentElement) {
      const text = normalizeText(node.innerText || node.textContent);
      if (!text || text.length > 900 || !/별풍선/.test(text) || !/선물\s*받았/.test(text)) continue;
      const stationLinks = Array.from(node.querySelectorAll('a[href*="/station/"]')).map(stationIdFromLink).filter(Boolean);
      if (stationLinks.length === 1 && stationLinks[0] === senderSoopId) return { element: node, text, depth };
    }
    return null;
  }

  function parseAgeRange(text) {
    const normalized = normalizeText(text);
    if (/방금\s*전|방금/.test(normalized)) return { minMs: 0, maxMs: 60000 };
    const match = normalized.match(/(\d+)\s*(초|분|시간|일)\s*전/);
    if (!match) return null;
    const value = Number(match[1]);
    const unit = { 초: 1000, 분: 60000, 시간: 3600000, 일: 86400000 }[match[2]];
    if (!Number.isFinite(value) || !unit || value < 0) return null;
    return { minMs: value * unit, maxMs: (value + 1) * unit };
  }

  function exactTimestampFromRow(row) {
    const nodes = [row, ...Array.from(row.querySelectorAll('time[datetime],[datetime],[data-timestamp],[data-time],[data-created-at]'))];
    for (const node of nodes) {
      const values = [
        node.getAttribute && node.getAttribute('datetime'),
        node.getAttribute && node.getAttribute('title'),
        node.getAttribute && node.getAttribute('aria-label'),
        node.getAttribute && node.getAttribute('data-timestamp'),
        node.getAttribute && node.getAttribute('data-time'),
        node.getAttribute && node.getAttribute('data-created-at'),
      ].filter(Boolean);
      for (const rawValue of values) {
        const raw = String(rawValue).trim();
        if (/^\d{10,13}$/.test(raw)) {
          const numeric = Number(raw);
          const timestamp = raw.length === 10 ? numeric * 1000 : numeric;
          if (timestamp > 946684800000 && timestamp < Date.now() + 60000) return timestamp;
        }
        const parsed = Date.parse(raw);
        if (Number.isFinite(parsed) && parsed > 946684800000 && parsed < Date.now() + 60000) return parsed;
      }
    }
    return 0;
  }

  function stableRowIdentifier(row) {
    let node = row;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      for (const name of ['data-notification-id', 'data-notice-id', 'data-alert-id', 'data-id', 'data-no']) {
        const value = node.getAttribute && node.getAttribute(name);
        if (value && /^[a-z0-9_-]{1,100}$/i.test(value)) return name + ':' + value;
      }
      if (node.id && /^[a-z0-9_-]{1,100}$/i.test(node.id)) return 'id:' + node.id;
    }
    return '';
  }

  async function fingerprint(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function parseDonationCandidate(anchor) {
    if (!isVisible(anchor)) return null;
    const senderSoopId = stationIdFromLink(anchor);
    if (!senderSoopId) return null;
    const found = findDonationRow(anchor, senderSoopId);
    if (!found) return null;
    const receiptText = found.text;
    const amountMatch = receiptText.match(/별풍선\s*([\d,]+)\s*개/);
    if (!amountMatch) return null;
    const balloons = Number(amountMatch[1].replace(/,/g, ''));
    if (!Number.isSafeInteger(balloons) || balloons !== 50) return null;
    const observedAt = Date.now();
    const exactTimestamp = exactTimestampFromRow(found.element);
    const age = parseAgeRange(receiptText);
    if (!exactTimestamp && !age) return null;
    const eventAtMin = exactTimestamp || observedAt - age.maxMs;
    const eventAtMax = exactTimestamp || observedAt - age.minMs;
    const stableId = stableRowIdentifier(found.element);
    const withoutAge = receiptText.replace(/\d+\s*(?:초|분|시간|일)\s*전|방금\s*전|방금/g, '').trim();
    return {
      senderSoopId,
      balloons,
      observedAt,
      eventAtMin,
      eventAtMax,
      exactTimestamp: !!exactTimestamp,
      candidateText: (stableId || '') + '|' + withoutAge,
    };
  }

  function showNotice(message) {
    let notice = document.getElementById('soop-onyu-game-gift-status');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'soop-onyu-game-gift-status';
      notice.setAttribute('role', 'status');
      notice.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:12px 16px;border-radius:10px;background:#171a20;color:#fff;font:600 13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.25);max-width:min(420px,calc(100vw - 36px));border:1px solid #3fb689;';
      document.body.appendChild(notice);
    }
    notice.textContent = message;
    clearTimeout(notice._hideTimer);
    notice._hideTimer = setTimeout(() => notice.remove(), 9000);
  }

  async function scanNotifications() {
    if (scanning) return;
    scanning = true;
    try {
      const state = await chrome.storage.local.get([WATCH_KEY, ATTEMPT_KEY]);
      const watch = state[WATCH_KEY] || {};
      if (!watch.active || Number(watch.expiresAt) <= Date.now()) {
        await chrome.storage.local.remove(WATCH_KEY);
        return;
      }
      const bell = findNotificationBell();
      if (!bell) {
        trace('notification-bell-not-found', { path: location.pathname });
        return;
      }
      if (!hasNotificationPanelOpen(bell)) {
        bell.click();
        await wait(1100);
      }

      const attemptTimes = state[ATTEMPT_KEY] && typeof state[ATTEMPT_KEY] === 'object' ? state[ATTEMPT_KEY] : {};
      const now = Date.now();
      Object.keys(attemptTimes).forEach((key) => {
        if (!Number.isFinite(Number(attemptTimes[key])) || now - Number(attemptTimes[key]) > 24 * 60 * 60 * 1000) delete attemptTimes[key];
      });
      const candidates = [];
      for (const anchor of Array.from(document.querySelectorAll('a[href*="/station/"]'))) {
        const candidate = parseDonationCandidate(anchor);
        if (candidate) candidates.push(candidate);
      }
      const unique = new Map();
      for (const candidate of candidates) {
        const candidateFingerprint = await fingerprint(candidate.senderSoopId + '|' + candidate.balloons + '|' + candidate.candidateText);
        unique.set(candidateFingerprint, Object.assign({}, candidate, { candidateFingerprint }));
      }
      let sent = 0;
      for (const candidate of Array.from(unique.values()).slice(0, 20)) {
        const key = candidate.senderSoopId + ':' + candidate.candidateFingerprint;
        if (Number(attemptTimes[key]) && now - Number(attemptTimes[key]) < RETRY_MS) continue;
        attemptTimes[key] = now;
        await chrome.storage.local.set({ [ATTEMPT_KEY]: attemptTimes });
        sent += 1;
        let result;
        try {
          result = await chrome.runtime.sendMessage(Object.assign({ type: 'confirmOnyuGameGiftNotification' }, candidate));
        } catch (error) {
          trace('candidate-forward-failed', { reason: String(error && error.message || error).slice(0, 120) });
          continue;
        }
        if (result && result.ok) {
          showNotice('별풍선 후원이 확인되어 ' + (result.targetNickname || '온이유 이용권') + ' 신청이 자동 승인됐어요.');
          trace('donation-notification-approved', { balloons: candidate.balloons });
          break;
        }
      }
      trace('notification-scan-complete', { stationLinksScanned: document.querySelectorAll('a[href*="/station/"]').length, donationCandidatesSent: sent });
    } catch (error) {
      trace('notification-scan-failed', { error: String(error && error.message || error).slice(0, 160) });
    } finally {
      scanning = false;
    }
  }

  async function scheduleNextScan() {
    clearTimeout(refreshTimer);
    const state = await chrome.storage.local.get(WATCH_KEY);
    const watch = state[WATCH_KEY] || {};
    if (!watch.active) return;
    if (Number(watch.expiresAt) <= Date.now()) {
      await chrome.storage.local.remove(WATCH_KEY);
      trace('notification-watch-expired', {});
      return;
    }
    refreshTimer = setTimeout(async () => {
      await scanNotifications();
      await scheduleNextScan();
    }, REFRESH_MS);
  }

  async function applyWatch(active, expiresAt, tabId) {
    clearTimeout(refreshTimer);
    if (!active || Number(expiresAt) <= Date.now()) {
      await chrome.storage.local.remove(WATCH_KEY);
      trace('notification-watch-stopped', {});
      return;
    }
    await chrome.storage.local.set({ [WATCH_KEY]: {
      active: true,
      expiresAt: Number(expiresAt),
      tabId: Number.isInteger(tabId) ? tabId : null,
    } });
    trace('notification-watch-started', { expiresAt: Number(expiresAt) });
    await scanNotifications();
    await scheduleNextScan();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'setOnyuGameGiftNotificationWatch') return false;
    applyWatch(message.active === true, Number(message.expiresAt) || 0, Number.isInteger(message.tabId) ? message.tabId : sender.tab && sender.tab.id)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, reason: String(error && error.message || error) }));
    return true;
  });

  chrome.runtime.sendMessage({ type: 'getOnyuGameGiftNotificationWatch' }).then((watch) => {
    if (!watch || watch.active !== true) return;
    applyWatch(true, Number(watch.expiresAt) || 0, Number.isInteger(watch.tabId) ? watch.tabId : null)
      .catch((error) => trace('watch-resume-failed', { error: String(error && error.message || error).slice(0, 120) }));
  }).catch((error) => trace('watch-state-query-failed', { error: String(error && error.message || error).slice(0, 120) }));
})();
