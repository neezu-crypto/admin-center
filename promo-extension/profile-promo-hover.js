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

  const api = { stationIdFromProfileHref, cleanText, plausibleNickname, nicknameFromProfileAnchor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined' || !root || root.__soopPromoProfileHover099) return;
  root.__soopPromoProfileHover099 = true;

  const cache = new Map();
  let activeAnchor = null;
  let activeToken = 0;
  let activeProfile = null;
  let pointer = { x: 0, y: 0 };
  let hideTimer = 0;
  let host = null;
  let tooltip = null;
  let statusLabel = null;
  let actionButton = null;
  let currentStatus = null;
  const CACHE_TTL_MS = 30000;

  function ensureTooltip() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'soop-promo-profile-hover';
    host.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:auto;left:0;top:0;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div style="display:none;max-width:300px;padding:8px 10px;border:1px solid #cbd5e1;border-radius:9px;background:#fff;color:#172033;box-shadow:0 6px 22px #17203330;font:600 13px/1.4 system-ui,-apple-system,sans-serif;white-space:normal;align-items:center;gap:9px"><span></span><button type="button" style="display:none;flex:none;border:1px solid #cbd5e1;border-radius:7px;background:#f8fafc;color:#0755b8;padding:4px 7px;font:600 11px system-ui,-apple-system,sans-serif;cursor:pointer"></button></div>';
    tooltip = shadow.querySelector('div');
    statusLabel = shadow.querySelector('span');
    actionButton = shadow.querySelector('button');
    actionButton.addEventListener('click', () => { void toggleExclusion(); });
    host.addEventListener('pointerenter', () => clearTimeout(hideTimer));
    host.addEventListener('pointerleave', () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 90);
    });
    document.documentElement.appendChild(host);
  }

  function placeTooltip() {
    if (!tooltip || tooltip.style.display === 'none') return;
    const rect = tooltip.getBoundingClientRect();
    const margin = 8;
    let x = pointer.x + 14;
    let y = pointer.y + 16;
    if (x + rect.width > window.innerWidth - margin) x = pointer.x - rect.width - 14;
    if (y + rect.height > window.innerHeight - margin) y = pointer.y - rect.height - 16;
    host.style.left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)) + 'px';
    host.style.top = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin)) + 'px';
  }

  function show(text, color, action) {
    ensureTooltip();
    statusLabel.textContent = text;
    tooltip.style.color = color || '#172033';
    tooltip.style.display = 'flex';
    if (action) {
      actionButton.textContent = action.label;
      actionButton.style.display = 'inline-block';
      actionButton.disabled = action.disabled === true;
      actionButton.style.color = action.color || '#0755b8';
    } else {
      actionButton.style.display = 'none';
      actionButton.disabled = false;
    }
    placeTooltip();
  }

  function findProfileAnchor(target) {
    const anchor = target && target.closest ? target.closest('a[href]') : null;
    if (!anchor || !anchor.querySelector('img')) return null;
    const stationId = stationIdFromProfileHref(anchor.getAttribute('href'), location.href);
    return stationId ? { anchor: anchor, stationId: stationId } : null;
  }

  function hide() {
    activeAnchor = null;
    activeProfile = null;
    activeToken += 1;
    currentStatus = null;
    if (tooltip) tooltip.style.display = 'none';
  }

  function presentLookupStatus(status, nickname) {
    currentStatus = status;
    if (status === 'registered') {
      show('✅ 홍보 리스트 등록됨' + (nickname ? ': ' + nickname : ''), '#166534');
    } else if (status === 'excluded') {
      show('⛔ 제외된 리스트' + (nickname ? ': ' + nickname : ''), '#9b2419', { label: '제외 취소', color: '#9b2419' });
    } else if (status === 'unregistered') {
      show('홍보 리스트 미등록', '#526078', { label: '후보에서 제외' });
    } else {
      show('홍보 리스트를 확인할 수 없습니다.', '#9b2419');
    }
  }

  async function toggleExclusion() {
    if (!activeProfile || (currentStatus !== 'excluded' && currentStatus !== 'unregistered')) return;
    const profile = activeProfile;
    const nextExcluded = currentStatus !== 'excluded';
    const cacheKey = profile.stationId.toLowerCase() + '|' + profile.nickname.normalize('NFC').toLocaleLowerCase();
    const token = activeToken;
    show(nextExcluded ? '제외 목록에 저장 중…' : '제외 해제 중…', '#526078', { label: '저장 중…', disabled: true });
    try {
      const result = await root.chrome.runtime.sendMessage({
        type: 'setStreamerPromoExclusion',
        lookupContext: 'profile-hover',
        requestId: 'promo-exclude-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
        stationId: profile.stationId,
        nickname: profile.nickname,
        excluded: nextExcluded,
      });
      if (!result || result.ok !== true) throw new Error(result && result.message || '제외 상태를 저장하지 못했습니다.');
      const status = result.excluded ? 'excluded' : 'unregistered';
      cache.set(cacheKey, { at: Date.now(), status: status, nickname: profile.nickname });
      window.postMessage({
        __soopPromoExclusionChanged: true,
        stationId: profile.stationId,
        nickname: profile.nickname,
        excluded: result.excluded === true,
      }, location.origin);
      if (token === activeToken && activeAnchor && activeAnchor.isConnected) presentLookupStatus(status, profile.nickname);
    } catch (error) {
      if (token === activeToken) show(String(error && error.message || '제외 상태를 저장하지 못했습니다.'), '#9b2419', { label: nextExcluded ? '다시 시도' : '다시 시도' });
    }
  }

  function lookupProfile(stationId, nickname, token) {
    const key = stationId.toLowerCase() + '|' + nickname.normalize('NFC').toLocaleLowerCase();
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      if (token === activeToken) presentLookupStatus(cached.status, cached.nickname || nickname);
      return;
    }
    show('홍보 리스트 등록 여부 확인 중…', '#526078');
    if (!root.chrome || !root.chrome.runtime || !root.chrome.runtime.sendMessage) {
      show('확장 프로그램 연결을 확인할 수 없습니다.', '#9b2419');
      return;
    }
    root.chrome.runtime.sendMessage({
      type: 'checkPromoListDuplicate',
      lookupContext: 'profile-hover',
      requestId: 'profile-hover-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      stationId: stationId,
      nickname: nickname,
    }).then((result) => {
      let status;
      if (!result || result.ok !== true || typeof result.found !== 'boolean') {
        status = 'unavailable';
      } else if (result.found) {
        status = 'registered';
      } else if (result.excluded === true) {
        status = 'excluded';
      } else {
        status = 'unregistered';
      }
      const matchedNickname = result && result.nickname || nickname;
      cache.set(key, { at: Date.now(), status: status, nickname: matchedNickname });
      if (token === activeToken && activeAnchor && activeAnchor.isConnected) presentLookupStatus(status, matchedNickname);
    }).catch(() => {
      cache.set(key, { at: Date.now(), status: 'unavailable', nickname: nickname });
      if (token === activeToken && activeAnchor && activeAnchor.isConnected) presentLookupStatus('unavailable', nickname);
    });
  }

  document.addEventListener('pointerover', (event) => {
    pointer = { x: event.clientX, y: event.clientY };
    const profile = findProfileAnchor(event.target);
    if (!profile || profile.anchor === activeAnchor) return;
    clearTimeout(hideTimer);
    activeAnchor = profile.anchor;
    const token = ++activeToken;
    const nickname = nicknameFromProfileAnchor(profile.anchor);
    activeProfile = { stationId: profile.stationId, nickname: nickname };
    if (!nickname) {
      show('스트리머 닉네임을 확인할 수 없습니다.', '#9b2419');
      return;
    }
    lookupProfile(profile.stationId, nickname, token);
  }, true);

  document.addEventListener('pointermove', (event) => {
    pointer = { x: event.clientX, y: event.clientY };
    placeTooltip();
  }, { passive: true, capture: true });

  document.addEventListener('pointerout', (event) => {
    if (!activeAnchor) return;
    if (event.relatedTarget && activeAnchor.contains(event.relatedTarget)) return;
    if (host && event.relatedTarget && (event.relatedTarget === host || host.contains(event.relatedTarget))) return;
    if (event.target === activeAnchor || activeAnchor.contains(event.target)) {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 90);
    }
  }, true);
})(typeof globalThis !== 'undefined' ? globalThis : window);
