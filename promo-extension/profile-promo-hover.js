(function (root) {
  'use strict';

  function stationIdFromProfileHref(href, baseUrl) {
    let url;
    try { url = new URL(href, baseUrl || 'https://www.sooplive.com/'); } catch (_) { return ''; }
    if (!/(^|\.)sooplive\.com$/i.test(url.hostname)) return '';
    const match = /^\/station\/([A-Za-z0-9_-]+)(?:\/|$)/i.exec(url.pathname);
    return match ? match[1] : '';
  }

  function cleanText(value) {
    return String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function plausibleNickname(value) {
    const text = cleanText(value).split(/[\r\n]/)[0]
      .replace(/\s*(?:의\s*방송국|방송국\s*바로가기|방송국\s*가기|프로필\s*보기).*$/i, '').trim();
    if (!text || text.length > 40 || /^(soop|방송국|프로필|다시보기|vod|live)$/i.test(text)) return '';
    return text;
  }

  function nicknameFromProfileAnchor(anchor) {
    if (!anchor) return '';
    const image = anchor.querySelector && anchor.querySelector('img');
    const direct = [
      anchor.getAttribute && anchor.getAttribute('aria-label'),
      anchor.getAttribute && anchor.getAttribute('title'),
      image && image.getAttribute('alt'),
      image && image.getAttribute('title'),
      anchor.innerText || anchor.textContent,
    ];
    for (const value of direct) {
      const nickname = plausibleNickname(value);
      if (nickname) return nickname;
    }

    let ancestor = anchor.parentElement;
    for (let depth = 0; ancestor && depth < 4; depth += 1, ancestor = ancestor.parentElement) {
      const children = Array.from(ancestor.children || []);
      const siblings = [];
      const ownIndex = children.findIndex((child) => child === anchor || child.contains(anchor));
      if (ownIndex >= 0) siblings.push(children[ownIndex + 1], children[ownIndex - 1]);
      for (const sibling of siblings) {
        if (!sibling || sibling.contains(anchor)) continue;
        const nodes = [sibling].concat(Array.from(sibling.querySelectorAll ? sibling.querySelectorAll('span,strong,b,[aria-label],[title]') : []));
        for (const node of nodes) {
          const nickname = plausibleNickname(node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('title')) || node.innerText || node.textContent);
          if (nickname) return nickname;
        }
      }
    }
    return '';
  }

  function isUnconfirmedStatusIcon(button) {
    return !!button && button.dataset && button.dataset.soopPromoProfileStatusIcon === 'true' &&
      cleanText(button.textContent) === '？';
  }

  function modifierPressed(event, property, name) {
    if (event[property]) return true;
    try { return typeof event.getModifierState === 'function' && event.getModifierState(name); }
    catch (_) { return false; }
  }

  function isFindUnconfirmedShortcut(event) {
    if (!event) return false;
    const control = modifierPressed(event, 'ctrlKey', 'Control');
    const shift = modifierPressed(event, 'shiftKey', 'Shift');
    const alt = modifierPressed(event, 'altKey', 'Alt');
    const meta = modifierPressed(event, 'metaKey', 'Meta');
    const space = event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar' || event.key === 'Space' || event.keyCode === 32;
    return control && shift && !alt && !meta && space;
  }

  const api = { stationIdFromProfileHref, cleanText, plausibleNickname, nicknameFromProfileAnchor, isUnconfirmedStatusIcon, isFindUnconfirmedShortcut };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined' || !root || root.__soopPromoProfileStatusIcons015) return;
  root.__soopPromoProfileStatusIcons015 = true;

  const DIAGNOSTIC_VERSION = '0.9.21';
  const CACHE_TTL_MS = 30000;
  const cache = new Map();
  const pendingLookups = new Map();
  const records = new Set();
  let layer = null;
  let scanTimer = 0;
  let lastFoundButton = null;
  let noticeTimer = 0;

  function logShortcut(stage, details) {
    try {
      const diagnostic = Object.assign({ version: DIAGNOSTIC_VERSION, stage: stage, at: new Date().toISOString() }, details || {});
      console.info('[SOOP 홍보 단축키 진단]', JSON.stringify(diagnostic));
      if (root.chrome && root.chrome.runtime && typeof root.chrome.runtime.sendMessage === 'function') {
        try {
          const result = root.chrome.runtime.sendMessage({ type: 'promoShortcutDiagnostic', diagnostic: diagnostic });
          if (result && typeof result.catch === 'function') result.catch(function () {});
        } catch (_) { /* Service-worker diagnostics are best-effort. */ }
      }
    } catch (_) { /* Diagnostics must never interrupt the page. */ }
  }

  function cacheKey(stationId, nickname) {
    return stationId.toLowerCase() + '|' + nickname.normalize('NFC').toLocaleLowerCase();
  }

  function ensureLayer() {
    if (layer && layer.isConnected) return;
    layer = document.createElement('div');
    layer.id = 'soop-promo-profile-status-icons';
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(layer);
  }

  function describe(record, status, detail) {
    record.status = status;
    const labels = {
      registered: ['✅', '홍보 리스트 등록됨'],
      excluded: ['🚫', '제외된 리스트. 클릭하면 제외를 해제합니다'],
      unregistered: ['？', '홍보 리스트 미등록. 클릭하면 후보에서 제외합니다'],
      checking: ['？', '홍보 리스트 확인 중'],
      unavailable: ['？', '홍보 리스트 확인 불가'],
      saving: ['？', '제외 상태 저장 중'],
      error: ['？', '제외 상태 저장 실패'],
    };
    const state = labels[status] || labels.unavailable;
    record.button.textContent = state[0];
    record.button.setAttribute('aria-label', detail ? state[1] + ': ' + detail : state[1]);
    record.button.disabled = status !== 'unregistered' && status !== 'excluded';
    record.button.style.cursor = record.button.disabled ? 'default' : 'pointer';
    record.button.style.background = status === 'registered' ? '#e9f8ef' : status === 'excluded' ? '#fff0ef' : '#fff';
    record.button.style.borderColor = status === 'registered' ? '#86d3a0' : status === 'excluded' ? '#f0aaa4' : '#cbd5e1';
  }

  function position(record) {
    if (!record.img.isConnected || !record.button.isConnected) return;
    const rect = record.img.getBoundingClientRect();
    const visible = record.started && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    record.button.style.display = visible ? 'grid' : 'none';
    if (!visible) return;
    const size = 20;
    const left = Math.max(2, Math.min(window.innerWidth - size - 2, rect.right - size * 0.72));
    const top = Math.max(2, Math.min(window.innerHeight - size - 2, rect.top - size * 0.28));
    record.button.style.left = left + 'px';
    record.button.style.top = top + 'px';
  }

  function positionAll() {
    for (const record of records) position(record);
  }

  function showFindNotice(message) {
    ensureLayer();
    let notice = document.getElementById('soop-promo-profile-find-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'soop-promo-profile-find-notice';
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      notice.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2;padding:10px 14px;border:1px solid #b8c9e4;border-radius:10px;background:#fff;color:#172033;box-shadow:0 4px 18px #17203330;font:600 13px/1.4 system-ui,-apple-system,sans-serif;pointer-events:none;max-width:calc(100vw - 32px);';
      layer.appendChild(notice);
    }
    notice.textContent = message;
    notice.style.display = 'block';
    clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => { notice.style.display = 'none'; }, 2200);
  }

  function findNextUnconfirmed() {
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = 0;
    }
    scan();
    const candidates = Array.from(records).filter((record) =>
      record.started && record.img.isConnected && record.button.isConnected && isUnconfirmedStatusIcon(record.button));
    candidates.sort((left, right) => {
      const position = left.img.compareDocumentPosition(right.img);
      if (position & 4) return -1; // DOCUMENT_POSITION_FOLLOWING
      if (position & 2) return 1; // DOCUMENT_POSITION_PRECEDING
      return 0;
    });
    if (!candidates.length) {
      lastFoundButton = null;
      logShortcut('shortcut-no-candidate', { records: records.size });
      showFindNotice('현재 페이지에 미확인(？) 스트리머가 없습니다.');
      return;
    }
    let index = candidates.findIndex((record) => record.button === lastFoundButton);
    index = (index + 1) % candidates.length;
    const record = candidates[index];
    lastFoundButton = record.button;
    logShortcut('shortcut-candidate-found', { count: candidates.length, index: index + 1, stationId: record.stationId, nickname: record.nickname || '' });
    logShortcut('shortcut-station-open-requested', { stationId: record.stationId });
    root.chrome.runtime.sendMessage({ type: 'openUnconfirmedStationInNewTab', stationId: record.stationId })
      .then((result) => {
        if (!result || result.ok !== true) showFindNotice('방송국 새 탭 열기에 실패했습니다. 웨일 로그를 확인해주세요.');
      })
      .catch(() => showFindNotice('방송국 새 탭 열기에 실패했습니다. 확장 프로그램 상태를 확인해주세요.'));
  }

  window.addEventListener('keydown', (event) => {
    const space = event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar' || event.key === 'Space' || event.keyCode === 32;
    const hasModifier = modifierPressed(event, 'ctrlKey', 'Control') || modifierPressed(event, 'shiftKey', 'Shift') ||
      modifierPressed(event, 'altKey', 'Alt') || modifierPressed(event, 'metaKey', 'Meta');
    if (space && hasModifier) {
      logShortcut('modified-space-keydown', {
        code: event.code || '', key: event.key || '', keyCode: event.keyCode || 0,
        ctrlKey: modifierPressed(event, 'ctrlKey', 'Control'), shiftKey: modifierPressed(event, 'shiftKey', 'Shift'),
        altKey: modifierPressed(event, 'altKey', 'Alt'), metaKey: modifierPressed(event, 'metaKey', 'Meta'),
        targetTag: event.target && event.target.tagName || '', isTrusted: event.isTrusted === true,
      });
    }
    if (!isFindUnconfirmedShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    logShortcut('shortcut-accepted', {});
    findNextUnconfirmed();
  }, true);

  root.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'findUnconfirmedPromoProfile') return false;
    logShortcut('browser-command-received', {});
    findNextUnconfirmed();
    if (typeof sendResponse === 'function') sendResponse({ ok: true });
    return false;
  });

  function refreshKey(key, status) {
    for (const record of records) {
      if (record.key === key) describe(record, status, record.nickname);
    }
  }

  async function toggleExclusion(record) {
    if (record.status !== 'unregistered' && record.status !== 'excluded') return;
    const previous = record.status;
    const nextExcluded = previous !== 'excluded';
    describe(record, 'saving');
    try {
      if (!root.chrome || !root.chrome.runtime || !root.chrome.runtime.sendMessage) throw new Error('확장 프로그램 연결을 확인할 수 없습니다.');
      const result = await root.chrome.runtime.sendMessage({
        type: 'setStreamerPromoExclusion',
        lookupContext: 'profile-hover',
        requestId: 'promo-exclude-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
        stationId: record.stationId,
        nickname: record.nickname,
        excluded: nextExcluded,
      });
      if (!result || result.ok !== true) throw new Error(result && result.message || '제외 상태를 저장하지 못했습니다.');
      const status = result.excluded ? 'excluded' : 'unregistered';
      cache.set(record.key, { at: Date.now(), status: status, nickname: record.nickname });
      refreshKey(record.key, status);
      window.postMessage({
        __soopPromoExclusionChanged: true,
        stationId: record.stationId,
        nickname: record.nickname,
        excluded: result.excluded === true,
      }, location.origin);
    } catch (error) {
      describe(record, 'error', String(error && error.message || '저장하지 못했습니다'));
      record.button.disabled = false;
      record.button.style.cursor = 'pointer';
      record.button.setAttribute('aria-label', '제외 상태 저장 실패. 다시 클릭해 재시도');
      record.status = previous;
    }
  }

  function lookup(record) {
    const cached = cache.get(record.key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      describe(record, cached.status, cached.nickname || record.nickname);
      return;
    }
    if (!root.chrome || !root.chrome.runtime || !root.chrome.runtime.sendMessage) {
      describe(record, 'unavailable');
      return;
    }
    if (pendingLookups.has(record.key)) {
      pendingLookups.get(record.key).then((item) => describe(record, item.status, item.nickname));
      return;
    }
    describe(record, 'checking');
    const request = root.chrome.runtime.sendMessage({
      type: 'checkPromoListDuplicate',
      lookupContext: 'profile-hover',
      requestId: 'profile-status-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      stationId: record.stationId,
      nickname: record.nickname,
    }).then((result) => {
      let status = 'unavailable';
      if (result && result.ok === true && typeof result.found === 'boolean') {
        status = result.found ? 'registered' : result.excluded === true ? 'excluded' : 'unregistered';
      }
      const item = { at: Date.now(), status: status, nickname: result && result.nickname || record.nickname };
      cache.set(record.key, item);
      refreshKey(record.key, item.status);
      return item;
    }).catch(() => {
      const item = { at: Date.now(), status: 'unavailable', nickname: record.nickname };
      cache.set(record.key, item);
      refreshKey(record.key, item.status);
      return item;
    }).finally(() => pendingLookups.delete(record.key));
    pendingLookups.set(record.key, request);
  }

  function startRecord(img) {
    const anchor = img.closest('a[href]');
    if (!anchor) return;
    const stationId = stationIdFromProfileHref(anchor.getAttribute('href'), location.href);
    if (!stationId) return;
    let record = Array.from(records).find((item) => item.img === img);
    if (record) return;
    ensureLayer();
    const nickname = nicknameFromProfileAnchor(anchor);
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.soopPromoProfileStatusIcon = 'true';
    button.setAttribute('aria-label', nickname ? '홍보 리스트 상태 확인 중' : '스트리머 닉네임을 확인할 수 없습니다');
    button.style.cssText = 'position:fixed;display:none;place-items:center;width:20px;height:20px;padding:0;border:1px solid #cbd5e1;border-radius:50%;box-shadow:0 1px 4px #17203330;color:#172033;font:700 12px/1 system-ui,-apple-system,sans-serif;pointer-events:auto;z-index:1;';
    record = { img: img, anchor: anchor, stationId: stationId, nickname: nickname, key: nickname ? cacheKey(stationId, nickname) : '', button: button, status: 'checking', started: false };
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void toggleExclusion(record);
    });
    records.add(record);
    layer.appendChild(button);
    position(record);
    const onLoaded = () => {
      if (record.started || !img.naturalWidth) return;
      record.started = true;
      position(record);
      if (!nickname) {
        describe(record, 'unavailable');
        return;
      }
      lookup(record);
    };
    img.addEventListener('load', onLoaded);
    img.addEventListener('error', () => {
      describe(record, 'unavailable');
      record.button.style.display = 'none';
    }, { once: true });
    if (img.complete && img.naturalWidth > 0) onLoaded();
  }

  function scan() {
    scanTimer = 0;
    for (const record of Array.from(records)) {
      if (!record.img.isConnected) {
        record.button.remove();
        records.delete(record);
      }
    }
    document.querySelectorAll('a[href] img').forEach(startRecord);
    positionAll();
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = window.setTimeout(scan, 180);
  }

  window.addEventListener('resize', positionAll, { passive: true });
  document.addEventListener('scroll', positionAll, { passive: true, capture: true });
  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  logShortcut('listener-ready', { href: location.origin + location.pathname });
  scan();
})(typeof globalThis !== 'undefined' ? globalThis : window);
