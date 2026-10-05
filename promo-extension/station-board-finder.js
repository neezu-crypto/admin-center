(function (root) {
  'use strict';

  const BOARD_PATH = /^\/station\/([A-Za-z0-9_-]+)\/board\/([A-Za-z0-9_-]+)\/?$/i;
  const WRITE_PATH = /^\/station\/([A-Za-z0-9_-]+)\/post\/write\/([A-Za-z0-9_-]+)\/?$/i;
  const EXCLUDED_TITLE = /공지|알림|방송\s*공지|운영\s*안내|규칙|스트리머\s*전용|스트리머만|방송인\s*전용|컨텐츠\s*제작|콘텐츠\s*제작|\bvod\b|다시보기/i;
  // 게임 추천 게시판은 이모지·장식 문자와 다른 문구 사이에 있어도 찾는다.
  // 아래 compactTitle은 문구 경계를 제거해 `게임🎮 추천`, `오늘의 게임 추천 게시판`도 매칭한다.
  const STRONG_TITLE = /뻐꾸기|뻐꾸|뻐꾹|뻐꾺|뻐구기|추천|리퀘|request|recommend/i;
  const MEDIUM_TITLE = /제안|요청|의뢰|건의|의견|아이디어|컨텐츠\s*공유|콘텐츠\s*공유/i;
  const GENERIC_CONTENT_TITLE = /컨텐츠|콘텐츠|게임/i;
  const ROOT_ID = 'soop-promo-board-finder';

  function cleanText(value) {
    return String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  }

  function stationIdFromPath(pathname) {
    const match = /^\/station\/([A-Za-z0-9_-]+)(?:\/|$)/i.exec(String(pathname || ''));
    return match ? match[1] : '';
  }

  function extractBoardLink(href, currentStationId, baseUrl) {
    let url;
    try { url = new URL(href, baseUrl || 'https://www.sooplive.com/'); } catch (_) { return null; }
    if (!/(^|\.)sooplive\.com$/i.test(url.hostname)) return null;
    const match = BOARD_PATH.exec(url.pathname);
    if (!match || match[1].toLowerCase() !== String(currentStationId || '').toLowerCase()) return null;
    const stationId = match[1];
    const boardId = match[2];
    return {
      stationId: stationId,
      boardId: boardId,
      boardUrl: 'https://www.sooplive.com/station/' + encodeURIComponent(stationId) + '/board/' + encodeURIComponent(boardId),
      writeUrl: 'https://www.sooplive.com/station/' + encodeURIComponent(stationId) + '/post/write/' + encodeURIComponent(boardId),
    };
  }

  function extractCurrentBoard(pathname, currentStationId) {
    const match = BOARD_PATH.exec(String(pathname || ''));
    if (!match || match[1].toLowerCase() !== String(currentStationId || '').toLowerCase()) return null;
    return extractBoardLink('https://www.sooplive.com' + match[0], currentStationId);
  }

  function extractWriteRoute(pathname) {
    const match = WRITE_PATH.exec(String(pathname || ''));
    return match ? { stationId: match[1], boardId: match[2] } : null;
  }

  function stationNicknameFromTitles(pageTitle, socialTitle) {
    const candidates = [socialTitle, pageTitle].map(cleanText).filter(Boolean);
    for (const candidate of candidates) {
      const normalized = candidate.replace(/\s*[|·-]\s*SOOP.*$/i, '').trim();
      const match = normalized.match(/^(.+?)\s*의\s*방송국$/);
      if (match && cleanText(match[1])) return cleanText(match[1]);
    }
    return '';
  }

  function sortCandidatesByConfidence(items) {
    const rank = { 높음: 3, 보통: 2, 낮음: 1 };
    return items.map((item, index) => ({ item: item, index: index }))
      .sort((a, b) => (rank[b.item.confidence] || 0) - (rank[a.item.confidence] || 0) || a.index - b.index)
      .map((entry) => entry.item);
  }

  function shortcutIndexFromKey(key) {
    const match = /^(?:Digit|Numpad)([0-9])$/.exec(String(key || ''));
    if (!match) return -1;
    return match[1] === '0' ? 9 : Number(match[1]) - 1;
  }

  function classifyBoardTitle(title) {
    const normalized = cleanText(title).normalize('NFKC');
    if (!normalized) return { kind: 'ignore', reason: '게시판 이름을 읽지 못함' };
    if (EXCLUDED_TITLE.test(normalized)) return { kind: 'exclude', reason: '공지·운영·VOD 또는 스트리머 전용으로 보이는 이름' };
    if (/^현재 게시판/.test(normalized)) return { kind: 'review', confidence: '낮음', reason: '현재 게시판 주소는 확인했지만 용도는 수동 확인 필요' };
    const compactTitle = normalized.replace(/[^\p{L}\p{N}]/gu, '').toLocaleLowerCase();
    if (compactTitle.includes('노래추천')) return { kind: 'exclude', reason: '노래 추천 게시판은 홍보 후보에서 제외' };
    if (compactTitle.includes('게임추천')) return { kind: 'candidate', confidence: '높음', reason: '게임 추천 문구가 포함된 이름' };
    if (STRONG_TITLE.test(compactTitle)) return { kind: 'candidate', confidence: '높음', reason: '뻐꾸기 유사 표기·추천·리퀘스트 관련 이름' };
    if (MEDIUM_TITLE.test(normalized)) return { kind: 'candidate', confidence: '보통', reason: '제안·요청·의견 관련 이름 — 이용 대상 확인 필요' };
    if (GENERIC_CONTENT_TITLE.test(normalized)) return { kind: 'review', confidence: '낮음', reason: '콘텐츠·게임 관련 이름만으로는 시청자 작성 가능 여부를 판별할 수 없음' };
    return { kind: 'ignore', reason: '홍보 후보 의미를 이름에서 확인하지 못함' };
  }

  const api = { cleanText, stationIdFromPath, extractBoardLink, extractCurrentBoard, extractWriteRoute, stationNicknameFromTitles, sortCandidatesByConfidence, classifyBoardTitle, shortcutIndexFromKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined' || !root || root.__soopPromoBoardFinder073) return;
  root.__soopPromoBoardFinder073 = true;

  const scanId = 'finder-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const log = (stage, details) => {
    try {
      console.info('[SOOP 홍보 게시판 진단]', JSON.stringify({
        scanId: scanId,
        stage: stage,
        at: new Date().toISOString(),
        details: details || {},
      }));
    } catch (_) { /* 진단 로그 실패가 페이지 동작에 영향을 주지 않게 한다. */ }
  };

  let lastRoute = '';
  let lastSignature = '';
  let scanTimer = 0;
  let mutationObserver = null;
  let activeButtonEntries = [];
  let activeShortcutEntries = [];
  let lastCurrentBoardLog = '';
  let attemptedWriteCopyPath = '';
  let duplicateLookupKey = '';
  let duplicateLookupState = { state: 'idle', nickname: '', reason: '' };
  const currentBoardTitles = new Map();
  const pendingBoardStorageKey = 'soopPromoBoardFinder.pendingBoard.' + location.hostname;
  const keyboardBoardStorageKey = 'soopPromoBoardFinder.keyboardBoard.' + location.hostname;
  const pendingWriteClipboardKey = 'soopPromoBoardFinder.pendingWriteClipboard.' + location.hostname;
  const PENDING_WRITE_MAX_AGE_MS = 15 * 60 * 1000;

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function getBoardEntries(stationId) {
    const links = Array.from(document.querySelectorAll('a[href]'));
    const byPath = new Map();
    const buttonEntries = [];
    let stationAnchors = 0;
    links.forEach((anchor) => {
      const parsed = extractBoardLink(anchor.getAttribute('href'), stationId, location.href);
      if (!parsed) return;
      stationAnchors += 1;
      const title = cleanText(anchor.innerText || anchor.textContent || anchor.getAttribute('aria-label') || anchor.title);
      const key = parsed.stationId.toLowerCase() + '/' + parsed.boardId.toLowerCase();
      const prior = byPath.get(key);
      if (!prior || title.length > prior.title.length) byPath.set(key, Object.assign(parsed, { title: title, element: anchor }));
    });

    const currentBoard = extractCurrentBoard(location.pathname, stationId);
    if (currentBoard) {
      let pending = null;
      try { pending = JSON.parse(sessionStorage.getItem(pendingBoardStorageKey) || 'null'); } catch (_) { /* ignore malformed temporary state */ }
      let keyboardPending = null;
      try { keyboardPending = JSON.parse(sessionStorage.getItem(keyboardBoardStorageKey) || 'null'); } catch (_) { /* ignore malformed temporary state */ }
      const routeKey = stationId.toLowerCase() + '/' + currentBoard.boardId.toLowerCase();
      const selectedTitle = pending && pending.stationId === stationId && Date.now() - pending.at < 120000
        ? pending.title : (currentBoardTitles.get(routeKey) || '');
      if (selectedTitle) currentBoardTitles.set(routeKey, selectedTitle);
      byPath.set(stationId.toLowerCase() + '/' + currentBoard.boardId.toLowerCase(), Object.assign(currentBoard, {
        title: selectedTitle || '현재 게시판 (용도 확인 필요)', currentRoute: true,
      }));
      if (selectedTitle) {
        try { sessionStorage.removeItem(pendingBoardStorageKey); } catch (_) { /* session storage may be unavailable */ }
      }
      if (lastCurrentBoardLog !== routeKey) {
        lastCurrentBoardLog = routeKey;
        log('current-board-route-detected', { stationId: stationId, boardId: currentBoard.boardId, title: selectedTitle });
      }
      const socialTitle = document.querySelector('meta[property="og:title"]')?.content || '';
      const nickname = stationNicknameFromTitles(document.title, socialTitle);
      if (keyboardPending && keyboardPending.viaKeyboard === true &&
          String(keyboardPending.stationId || '').toLowerCase() === stationId.toLowerCase() &&
          Date.now() - Number(keyboardPending.at || 0) < 5 * 60 * 1000 &&
          (!keyboardPending.boardId || String(keyboardPending.boardId).toLowerCase() === currentBoard.boardId.toLowerCase()) &&
          (!keyboardPending.title || !selectedTitle || keyboardPending.title === selectedTitle)) {
        keyboardPending.boardId = currentBoard.boardId;
        keyboardPending.writeUrl = currentBoard.writeUrl;
        keyboardPending.nickname = keyboardPending.nickname || nickname;
        keyboardPending.at = Date.now();
        try { sessionStorage.setItem(keyboardBoardStorageKey, JSON.stringify(keyboardPending)); }
        catch (_) { /* Space shortcut simply remains unavailable without session storage. */ }
        log('keyboard-board-route-confirmed', { stationId: stationId, boardId: currentBoard.boardId, nicknameFound: Boolean(keyboardPending.nickname) });
      }
      const pendingWrite = {
        stationId: stationId,
        boardId: currentBoard.boardId,
        nickname: nickname,
        writeUrl: currentBoard.writeUrl,
        at: Date.now(),
      };
      try {
        sessionStorage.setItem(pendingWriteClipboardKey, JSON.stringify(pendingWrite));
        log('write-page-clipboard-armed', { stationId: stationId, boardId: currentBoard.boardId, nicknameFound: Boolean(nickname) });
      } catch (error) {
        log('write-page-clipboard-arm-failed', { stationId: stationId, boardId: currentBoard.boardId, error: String(error && error.message || error) });
      }
    }

    const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
    const seenButtonTitles = new Set();
    buttons.forEach((button) => {
      const title = cleanText(button.innerText || button.textContent || button.getAttribute('aria-label') || button.title);
      if (!title) return;
      const classification = classifyBoardTitle(title);
      if (classification.kind !== 'candidate' && classification.kind !== 'review') return;
      const key = title.normalize('NFKC').toLocaleLowerCase();
      if (seenButtonTitles.has(key)) return;
      seenButtonTitles.add(key);
      buttonEntries.push({ title: title, element: button });
    });
    return {
      links: Array.from(byPath.values()),
      buttons: buttonEntries,
      stationAnchors: stationAnchors,
      scannedAnchors: links.length,
      scannedButtons: buttons.length,
    };
  }

  function ensurePanel() {
    let host = document.getElementById(ROOT_ID);
    if (host) return host;
    host = document.createElement('div');
    host.id = ROOT_ID;
    host.style.cssText = 'position:fixed;z-index:2147483646;right:18px;bottom:18px;width:min(420px,calc(100vw - 28px));font:14px/1.45 system-ui,-apple-system,sans-serif;color:#172033;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        *{box-sizing:border-box} .panel{background:#fff;border:1px solid #d6deea;border-radius:14px;box-shadow:0 10px 35px #15203938;overflow:hidden}
        header{display:flex;align-items:center;justify-content:space-between;background:#f4f8ff;padding:11px 13px;border-bottom:1px solid #e1e8f2}
        h2{font-size:14px;margin:0;font-weight:750} button{font:inherit;cursor:pointer;border:1px solid #cbd5e1;background:#fff;color:#1e293b;border-radius:8px;padding:6px 9px}
        button:hover,a.action:hover{background:#eff6ff} .close{font-size:17px;line-height:1;padding:3px 8px} .body{padding:10px 12px;max-height:min(62vh,470px);overflow:auto}
        .summary{font-size:12px;color:#526078;margin:0 0 9px}.duplicate-status{background:#f1f5f9;border:1px solid #dbe3ec;padding:8px;border-radius:8px;color:#475569;font-size:12px;margin:0 0 9px}.duplicate-status.found{background:#fff1f0;border-color:#ffc9c3;color:#9b2419;font-weight:700}.duplicate-status.clear{background:#ecfdf3;border-color:#bbf7d0;color:#166534}.duplicate-status button{margin-left:6px;padding:2px 6px;font-size:11px}.warning{background:#fff8e7;border:1px solid #f3dda0;padding:8px;border-radius:8px;color:#674d00;font-size:12px;margin:8px 0}
        .row{border:1px solid #e1e7ef;border-radius:10px;padding:9px;margin:8px 0}.title{font-weight:700;overflow-wrap:anywhere}.meta{font-size:11px;color:#5b6679;margin:3px 0 8px}
        .actions{display:flex;gap:6px;flex-wrap:wrap}.action{display:inline-block;text-decoration:none;color:#0755b8;border:1px solid #cbd5e1;background:white;border-radius:8px;padding:6px 9px;font-size:12px}
        .badge{display:inline-block;font-size:10px;padding:2px 6px;border-radius:999px;margin-left:5px;background:#e9f2ff;color:#0755b8}.badge.low{background:#fff2d6;color:#805400}.hotkey{display:inline-flex;align-items:center;justify-content:center;min-width:19px;height:19px;margin-right:6px;border:1px solid #b8c9e4;border-radius:5px;background:#f4f8ff;color:#0755b8;font-size:11px;font-weight:750;vertical-align:1px}
        .empty{padding:14px 8px;color:#596579;font-size:13px}.footer{font-size:10px;color:#718096;padding:7px 12px;border-top:1px solid #edf0f5}
      </style>
      <section class="panel" aria-label="SOOP 홍보 게시판 찾기">
        <header><h2>📣 홍보 게시판 후보 찾기</h2><button class="close" type="button" aria-label="접기">−</button></header>
        <div class="body"><p class="empty">방송국 게시판 목록을 살펴보는 중…</p></div>
        <div class="footer">후보 검색만 수행합니다. 글 게시·즐겨찾기·알림 설정은 자동 변경하지 않습니다.</div>
      </section>`;
    document.documentElement.appendChild(host);
    const body = shadow.querySelector('.body');
    shadow.querySelector('.close').addEventListener('click', () => {
      const isClosed = host.dataset.closed === 'true';
      host.dataset.closed = isClosed ? 'false' : 'true';
      body.style.display = isClosed ? '' : 'none';
      shadow.querySelector('.close').textContent = isClosed ? '−' : '+';
      log('panel-toggled', { collapsed: !isClosed });
    });
    shadow.addEventListener('click', async (event) => {
      const addPromoButton = event.target.closest('[data-add-promo-candidate]');
      if (addPromoButton) {
        const nickname = addPromoButton.getAttribute('data-nickname') || '';
        const writeUrl = addPromoButton.getAttribute('data-write-url') || '';
        addPromoButton.disabled = true;
        addPromoButton.textContent = '추가 중…';
        log('promo-candidate-add-from-panel-requested', { stationId: stationIdFromPath(location.pathname), boardId: addPromoButton.getAttribute('data-board-id') || '', nicknameLength: nickname.length });
        try {
          const result = await root.chrome.runtime.sendMessage({
            type: 'addPromoCandidateFromConfirmedPage',
            nickname: nickname,
            pageUrl: location.href,
            writeUrl: writeUrl,
          });
          if (result && result.ok) {
            addPromoButton.textContent = '홍보 리스트에 추가됨';
            log('promo-candidate-add-from-panel-succeeded', { stationId: stationIdFromPath(location.pathname), boardId: addPromoButton.getAttribute('data-board-id') || '' });
          } else {
            addPromoButton.disabled = false;
            addPromoButton.textContent = '홍보 리스트에 추가';
            log('promo-candidate-add-from-panel-failed', { stationId: stationIdFromPath(location.pathname), boardId: addPromoButton.getAttribute('data-board-id') || '', reason: String(result && result.reason || 'unknown') });
            showWriteCopyNotice(String(result && result.message || '홍보 리스트에 추가하지 못했습니다.'), true);
          }
        } catch (error) {
          addPromoButton.disabled = false;
          addPromoButton.textContent = '홍보 리스트에 추가';
          log('promo-candidate-add-from-panel-failed', { stationId: stationIdFromPath(location.pathname), reason: 'extension-message-failed', error: String(error && error.message || error) });
          showWriteCopyNotice('관리자 센터 연결에 실패했습니다. 센터 탭과 확장 프로그램을 확인해주세요.', true);
        }
        return;
      }
      const openButton = event.target.closest('[data-open-board-index]');
      if (openButton) {
        const index = Number(openButton.getAttribute('data-open-board-index'));
        const item = activeButtonEntries[index];
        if (!item || !item.element || !item.element.isConnected) {
          log('board-button-open-failed', { index: index, reason: 'source-button-unavailable' });
          openButton.textContent = '항목을 다시 확인해주세요';
          return;
        }
        try {
          sessionStorage.setItem(pendingBoardStorageKey, JSON.stringify({ stationId: stationIdFromPath(location.pathname), title: item.title, at: Date.now() }));
          log('board-button-open-requested', { title: item.title, sourceTag: item.element.tagName });
          item.element.click();
        } catch (error) {
          log('board-button-open-failed', { title: item.title, error: String(error && error.message || error) });
          openButton.textContent = '열기 실패';
        }
        return;
      }
      const copyButton = event.target.closest('[data-copy-url]');
      if (!copyButton) return;
      const value = copyButton.getAttribute('data-copy-url') || '';
      log('write-url-copy-requested', { boardId: copyButton.getAttribute('data-board-id') || '' });
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(value);
        else {
          const input = document.createElement('textarea');
          input.value = value; input.style.cssText = 'position:fixed;left:-9999px;top:0';
          document.body.appendChild(input); input.select();
          const copied = document.execCommand('copy'); input.remove();
          if (!copied) throw new Error('clipboard-unavailable');
        }
        copyButton.textContent = '복사됨';
        log('write-url-copy-succeeded', { boardId: copyButton.getAttribute('data-board-id') || '' });
      } catch (error) {
        log('write-url-copy-failed', { boardId: copyButton.getAttribute('data-board-id') || '', error: String(error && error.message || error) });
        copyButton.textContent = '복사 실패';
      }
    });
    return host;
  }

  function showWriteCopyNotice(message, failed, addDetails) {
    let notice = document.getElementById('soop-promo-write-copy-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'soop-promo-write-copy-notice';
      notice.style.cssText = 'position:fixed;z-index:2147483647;top:18px;left:50%;transform:translateX(-50%);padding:11px 16px;border-radius:10px;background:#172033;color:#fff;font:14px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 5px 24px #0004;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 28px);';
      document.documentElement.appendChild(notice);
    }
    notice.replaceChildren(document.createTextNode(message));
    notice.style.background = failed ? '#9b1c1c' : '#166534';
    if (addDetails) {
      const addButton = document.createElement('button');
      addButton.type = 'button';
      addButton.textContent = '홍보 리스트에 추가';
      addButton.style.cssText = 'flex:none;border:1px solid #ffffffaa;border-radius:7px;padding:5px 8px;background:#fff;color:#14532d;font:600 12px system-ui;cursor:pointer;';
      addButton.addEventListener('click', function () {
        addButton.disabled = true;
        addButton.textContent = '추가 중…';
        if (!root.chrome || !root.chrome.runtime || !root.chrome.runtime.sendMessage) {
          showWriteCopyNotice('확장 프로그램에 연결할 수 없습니다. 새로고침 후 다시 시도해주세요.', true);
          return;
        }
        root.chrome.runtime.sendMessage({
          type: 'addPromoCandidateFromConfirmedPage',
          nickname: addDetails.nickname,
          pageUrl: location.href,
          writeUrl: addDetails.writeUrl,
        }).then(function (result) {
          if (result && result.ok) {
            log('promo-candidate-add-succeeded', { stationId: addDetails.stationId, nicknameLength: addDetails.nickname.length });
            showWriteCopyNotice('통합 관리 센터 홍보 리스트에 추가했습니다: ' + addDetails.nickname, false);
          } else {
            const reason = String(result && result.reason || 'unknown');
            log('promo-candidate-add-failed', { stationId: addDetails.stationId, reason: reason });
            showWriteCopyNotice(String(result && result.message || '홍보 리스트에 추가하지 못했습니다.'), true);
          }
        }).catch(function (error) {
          log('promo-candidate-add-failed', { stationId: addDetails.stationId, reason: 'extension-message-failed', error: String(error && error.message || error) });
          showWriteCopyNotice('관리자 센터 연결에 실패했습니다. 센터 탭을 새로고침해주세요.', true);
        });
      });
      notice.appendChild(addButton);
    }
    clearTimeout(notice.__removeTimer);
    notice.__removeTimer = setTimeout(() => notice.remove(), 5500);
  }

  function renderDuplicateStatus() {
    const host = document.getElementById(ROOT_ID);
    const status = host && host.shadowRoot && host.shadowRoot.querySelector('.duplicate-status');
    if (!status) return;
    const item = duplicateLookupState;
    Array.from(status.parentElement.children).forEach((child) => {
      if (child !== status) child.hidden = item.state === 'found' || item.state === 'excluded';
    });
    status.className = 'duplicate-status' + (item.state === 'found' || item.state === 'excluded' ? ' found' : item.state === 'clear' ? ' clear' : '');
    status.replaceChildren();
    if (item.state === 'checking') status.textContent = '홍보 리스트에서 닉네임 중복을 확인하는 중…';
    else if (item.state === 'found') status.textContent = '⚠ 이미 홍보 리스트에 등록된 닉네임입니다' + (item.nickname ? ': ' + item.nickname : '') + '.';
    else if (item.state === 'excluded') status.textContent = '⛔ 홍보 후보 제외 목록에 등록된 스트리머입니다' + (item.nickname ? ': ' + item.nickname : '') + '.';
    else if (item.state === 'clear') status.textContent = '홍보 리스트에서 이 닉네임을 찾지 못했습니다.';
    else if (item.state === 'unavailable') {
      status.appendChild(document.createTextNode('홍보 리스트 중복 확인을 할 수 없습니다. 관리자 센터 탭을 열고 로그인한 뒤 다시 확인해주세요.'));
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '다시 확인';
      retry.addEventListener('click', () => {
        duplicateLookupKey = '';
        checkPromoDuplicate(stationIdFromPath(location.pathname), item.requestNickname || '');
      });
      status.appendChild(retry);
    } else status.textContent = '홍보 리스트 중복 여부를 확인할 수 있는 닉네임을 읽는 중…';
  }

  function checkPromoDuplicate(stationId, nickname) {
    const cleanNickname = cleanText(nickname);
    if (!stationId || !cleanNickname) return;
    const key = stationId.toLowerCase() + '|' + cleanNickname.normalize('NFC').toLocaleLowerCase();
    if (key === duplicateLookupKey) return;
    duplicateLookupKey = key;
    duplicateLookupState = { state: 'checking', nickname: '', requestNickname: cleanNickname, reason: '' };
    renderDuplicateStatus();
    const requestId = 'duplicate-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    log('promo-duplicate-lookup-requested', { requestId: requestId, stationId: stationId, nicknameLength: cleanNickname.length });
    if (!root.chrome || !root.chrome.runtime || !root.chrome.runtime.sendMessage) {
      duplicateLookupState = { state: 'unavailable', requestNickname: cleanNickname, reason: 'extension-context-unavailable' };
      log('promo-duplicate-lookup-failed', { requestId: requestId, stationId: stationId, reason: 'extension-context-unavailable' });
      renderDuplicateStatus();
      return;
    }
    root.chrome.runtime.sendMessage({
      type: 'checkPromoListDuplicate', requestId: requestId, stationId: stationId, nickname: cleanNickname,
    }).then((result) => {
      if (key !== duplicateLookupKey) return;
      if (!result || result.ok !== true || typeof result.found !== 'boolean') {
        duplicateLookupState = { state: 'unavailable', requestNickname: cleanNickname, reason: String(result && result.reason || 'no-result') };
        log('promo-duplicate-lookup-failed', { requestId: requestId, stationId: stationId, reason: duplicateLookupState.reason });
      } else {
        duplicateLookupState = { state: result.found ? 'found' : result.excluded === true ? 'excluded' : 'clear', nickname: String(result.nickname || ''), requestNickname: cleanNickname, reason: '' };
        log('promo-duplicate-lookup-succeeded', { requestId: requestId, stationId: stationId, found: result.found, matchMethod: String(result.matchMethod || '') });
      }
      renderDuplicateStatus();
    }).catch((error) => {
      if (key !== duplicateLookupKey) return;
      duplicateLookupState = { state: 'unavailable', requestNickname: cleanNickname, reason: 'extension-message-failed' };
      log('promo-duplicate-lookup-failed', { requestId: requestId, stationId: stationId, reason: 'extension-message-failed', error: String(error && error.message || error) });
      renderDuplicateStatus();
    });
  }

  async function copyWritePageDetails(stationId, boardId, pathname) {
    if (attemptedWriteCopyPath === pathname) return;
    attemptedWriteCopyPath = pathname;
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(pendingWriteClipboardKey) || 'null'); }
    catch (error) {
      log('write-page-clipboard-read-failed', { error: String(error && error.message || error) });
    }
    if (!pending || pending.stationId !== stationId || pending.boardId !== boardId || Date.now() - pending.at > PENDING_WRITE_MAX_AGE_MS) {
      log('write-page-clipboard-skipped', {
        stationId: stationId,
        boardId: boardId,
        reason: !pending ? 'no-board-context' : 'board-context-mismatch-or-expired',
      });
      return;
    }

    const socialTitle = document.querySelector('meta[property="og:title"]')?.content || '';
    const nickname = pending.nickname || stationNicknameFromTitles(document.title, socialTitle);
    if (!nickname) {
      log('write-page-clipboard-failed', { stationId: stationId, boardId: boardId, reason: 'station-nickname-not-found' });
      showWriteCopyNotice('방송국 닉네임을 확인하지 못해 자동 복사하지 못했습니다.', true);
      return;
    }
    const writeUrl = 'https://www.sooplive.com/station/' + encodeURIComponent(stationId) + '/post/write/' + encodeURIComponent(boardId);
    const clipboardText = nickname + '\n' + writeUrl;
    log('write-page-clipboard-started', { stationId: stationId, boardId: boardId, nicknameLength: nickname.length });
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(clipboardText);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = clipboardText;
        textarea.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('clipboard-unavailable');
      }
      try { sessionStorage.removeItem(pendingWriteClipboardKey); } catch (_) { /* clipboard has already succeeded */ }
      log('write-page-clipboard-succeeded', { stationId: stationId, boardId: boardId, nicknameLength: nickname.length, url: writeUrl });
      showWriteCopyNotice('방송국 닉네임과 글쓰기 URL을 클립보드에 복사했습니다.', false, {
        nickname: nickname,
        stationId: stationId,
        writeUrl: writeUrl,
      });
    } catch (error) {
      log('write-page-clipboard-failed', { stationId: stationId, boardId: boardId, reason: 'clipboard-write-failed', error: String(error && error.message || error) });
      showWriteCopyNotice('자동 복사에 실패했습니다. 진단 로그를 확인해주세요.', true);
    }
  }

  function render(entries, stationId, scan) {
    const host = ensurePanel();
    const body = host.shadowRoot.querySelector('.body');
    const signature = stationId + '|' + entries.links.map((item) => item.boardId + ':' + item.title).join('|') + '|buttons|' + entries.buttons.map((item) => item.title).join('|');
    if (signature === lastSignature && body.dataset.ready === 'true') return;
    lastSignature = signature;
    body.dataset.ready = 'true';

    const classified = entries.links.map((item) => Object.assign(item, classifyBoardTitle(item.title)));
    const candidates = classified.filter((item) => item.kind === 'candidate');
    const review = classified.filter((item) => item.kind === 'review');
    const safeItems = candidates.concat(review);
    activeButtonEntries = entries.buttons;
    const buttonClassifications = entries.buttons.map((item, index) => Object.assign({}, item, classifyBoardTitle(item.title), { buttonIndex: index }));
    const safeButtons = buttonClassifications.filter((item) => item.kind === 'candidate' || item.kind === 'review');
    log('board-scan-complete', {
      stationId: stationId,
      scannedAnchors: scan.scannedAnchors,
      stationBoardAnchors: scan.stationAnchors,
      scannedButtons: scan.scannedButtons,
      uniqueBoards: entries.links.length,
      candidateCount: candidates.length,
      clickableBoardCandidateCount: safeButtons.length,
      manualReviewCount: review.length,
      excludedCount: classified.filter((item) => item.kind === 'exclude').length,
      ignoredCount: classified.filter((item) => item.kind === 'ignore').length,
    });
    classified.forEach((item) => log('board-classified', {
      stationId: stationId, boardId: item.boardId, title: item.title,
      result: item.kind, confidence: item.confidence || '', reason: item.reason,
    }));
    safeButtons.forEach((item) => log('board-button-classified', {
      stationId: stationId, title: item.title, result: item.kind,
      confidence: item.confidence || '', reason: item.reason,
    }));

    if (!safeItems.length && !safeButtons.length) {
      body.innerHTML = '<div class="duplicate-status" role="status"></div><div class="empty">이름만으로 추천·요청 게시판 후보를 찾지 못했습니다.<br>왼쪽 게시판 목록이 펼쳐져 있는지 확인하거나 진단 로그를 확인해주세요.</div>' +
        '<div class="warning">게시판 이름만 보고 확정하지 않습니다. 발견되지 않은 게시판은 수동으로 찾아보세요.</div>';
      renderDuplicateStatus();
      return;
    }
    const orderedItems = sortCandidatesByConfidence(
      safeItems.map((item) => Object.assign({}, item, { entryType: 'link' }))
        .concat(safeButtons.map((item) => Object.assign({}, item, { entryType: 'menu-button' })))
    );
    activeShortcutEntries = orderedItems;
    const rows = orderedItems.map((item, shortcutIndex) => {
      const shortcutNumber = shortcutIndex === 9 ? '0' : String(shortcutIndex + 1);
      const shortcutBadge = '<span class="hotkey">' + shortcutNumber + '</span>';
      const low = item.kind === 'review';
      if (item.entryType === 'menu-button') {
      return '<article class="row"><div class="title">' + shortcutBadge + escapeHtml(item.title) + '<span class="badge ' + (low ? 'low' : '') + '">' + (low ? '확인 필요' : item.confidence + ' 후보') + '</span></div>' +
        '<div class="meta">' + escapeHtml(item.reason) + ' · 메뉴 버튼에서 게시판 주소 확인 전</div>' +
        '<div class="actions"><button type="button" data-open-board-index="' + item.buttonIndex + '">게시판 확인</button></div></article>';
      }
      const hasWriteUrl = Boolean(item.writeUrl);
      const panelNickname = item.currentRoute ? stationNicknameFromTitles(
        document.title,
        document.querySelector('meta[property="og:title"]')?.content || ''
      ) : '';
      const addToPromoAction = item.currentRoute && hasWriteUrl && panelNickname
        ? '<button type="button" data-add-promo-candidate="true" data-nickname="' + escapeHtml(panelNickname) + '" data-write-url="' + escapeHtml(item.writeUrl) + '" data-board-id="' + escapeHtml(item.boardId) + '">홍보 리스트에 추가</button>'
        : '';
      return '<article class="row"><div class="title">' + shortcutBadge + escapeHtml(item.title || '(이름 없음)') +
        '<span class="badge ' + (low ? 'low' : '') + '">' + (low ? '확인 필요' : item.confidence + ' 후보') + '</span></div>' +
        '<div class="meta">' + escapeHtml(item.reason) + (hasWriteUrl ? ' · 게시판 ID ' + escapeHtml(item.boardId) : '') + '</div>' +
        '<div class="actions">' + (hasWriteUrl ? '<a class="action" href="' + escapeHtml(item.boardUrl) + '">게시판 확인</a>' : '') +
        (low || !hasWriteUrl ? '' : '<a class="action" data-open-write-url="' + escapeHtml(item.writeUrl) + '" href="' + escapeHtml(item.writeUrl) + '">글쓰기 화면 열기</a>') +
        (hasWriteUrl ? '<button type="button" data-copy-url="' + escapeHtml(item.writeUrl) + '" data-board-id="' + escapeHtml(item.boardId) + '">글쓰기 주소 복사</button>' : '') +
        addToPromoAction + '</div></article>';
    }).join('');
    body.innerHTML = '<div class="duplicate-status" role="status"></div><p class="summary">방송국 ' + escapeHtml(stationId) + ' · 링크 게시판 ' + entries.links.length + '개 확인 · 후보 ' + candidates.length + '개 · 메뉴 후보 ' + safeButtons.length + '개 · 높은 후보 우선 정렬' +
      (review.length ? ' · 이름만으로 판별 불가 ' + review.length + '개' : '') + '</p>' +
      '<div class="warning">이름 기반 후보입니다. 메뉴형 후보는 게시판 확인을 눌러 이동한 후 ID를 읽습니다. 글쓰기 화면이 열리면 닉네임과 URL을 클립보드에 복사합니다.</div>' + rows;
    renderDuplicateStatus();
  }

  function scan() {
    const writeRoute = extractWriteRoute(location.pathname);
    if (writeRoute) {
      const route = location.pathname.toLowerCase();
      if (route !== lastRoute) {
        lastRoute = route;
        lastSignature = '';
        log('write-page-route-detected', { stationId: writeRoute.stationId, boardId: writeRoute.boardId, path: location.pathname });
      }
      void copyWritePageDetails(writeRoute.stationId, writeRoute.boardId, location.pathname);
      const oldPanel = document.getElementById(ROOT_ID);
      if (oldPanel) oldPanel.remove();
      return;
    }
    const stationId = stationIdFromPath(location.pathname);
    if (!stationId || /\/post\//i.test(location.pathname)) {
      const oldPanel = document.getElementById(ROOT_ID);
      if (oldPanel) oldPanel.remove();
      lastRoute = '';
      lastSignature = '';
      return;
    }
    const route = location.pathname.toLowerCase();
    if (route !== lastRoute) {
      lastRoute = route;
      lastSignature = '';
      duplicateLookupKey = '';
      log('station-route-detected', { stationId: stationId, path: location.pathname });
    }
    const socialTitle = document.querySelector('meta[property="og:title"]')?.content || '';
    checkPromoDuplicate(stationId, stationNicknameFromTitles(document.title, socialTitle));
    const result = getBoardEntries(stationId);
    if (!result.links.length && !result.buttons.length) {
      const host = ensurePanel();
      const body = host.shadowRoot.querySelector('.body');
      if (body.dataset.ready !== 'empty') {
        body.dataset.ready = 'empty';
        body.innerHTML = '<div class="duplicate-status" role="status"></div><div class="empty">아직 게시판 링크를 찾지 못했습니다. 게시판 목록이 로드되거나 펼쳐지면 자동으로 다시 확인합니다.</div>';
        renderDuplicateStatus();
        log('no-board-navigation-items-found', { stationId: stationId, path: location.pathname, scannedAnchors: result.scannedAnchors, scannedButtons: result.scannedButtons });
      }
      return;
    }
    render(result, stationId, result);
  }

  function scheduleScan(reason) {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      try { scan(); }
      catch (error) { log('scan-failed', { reason: reason, error: String(error && error.stack || error) }); }
    }, 450);
  }

  function isTypingTarget(target) {
    if (!target || !target.closest) return false;
    return Boolean(target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'));
  }

  function openShortcutCandidate(index) {
    const item = activeShortcutEntries[index];
    if (!item) return false;
    const stationId = stationIdFromPath(location.pathname);
    const nickname = stationNicknameFromTitles(document.title, document.querySelector('meta[property="og:title"]')?.content || '');
    const marker = {
      stationId: stationId,
      boardId: item.entryType === 'link' ? item.boardId : '',
      title: item.title || '',
      nickname: nickname,
      writeUrl: item.entryType === 'link' ? item.writeUrl : '',
      at: Date.now(),
      viaKeyboard: true,
    };
    try {
      sessionStorage.setItem(keyboardBoardStorageKey, JSON.stringify(marker));
      sessionStorage.setItem(pendingBoardStorageKey, JSON.stringify({ stationId: stationId, title: item.title, at: Date.now() }));
    } catch (error) {
      log('keyboard-board-open-failed', { reason: 'session-storage-unavailable', error: String(error && error.message || error) });
      return false;
    }
    log('keyboard-board-open-requested', { index: index, key: index === 9 ? '0' : String(index + 1), stationId: stationId, boardId: marker.boardId, title: marker.title });
    if (item.entryType === 'link') {
      location.href = item.boardUrl;
      return true;
    }
    if (!item.element || !item.element.isConnected) {
      log('keyboard-board-open-failed', { index: index, reason: 'source-button-unavailable' });
      return false;
    }
    item.element.click();
    return true;
  }

  async function addKeyboardConfirmedBoard() {
    const current = extractCurrentBoard(location.pathname, stationIdFromPath(location.pathname));
    if (!current) return false;
    let marker = null;
    try { marker = JSON.parse(sessionStorage.getItem(keyboardBoardStorageKey) || 'null'); } catch (_) { /* ignore malformed temporary state */ }
    if (!marker || marker.viaKeyboard !== true ||
        String(marker.stationId || '').toLowerCase() !== current.stationId.toLowerCase() ||
        String(marker.boardId || '').toLowerCase() !== current.boardId.toLowerCase() ||
        Date.now() - Number(marker.at || 0) > 5 * 60 * 1000 || !marker.nickname || !marker.writeUrl) return false;
    log('keyboard-promo-add-requested', { stationId: current.stationId, boardId: current.boardId });
    try {
      const result = await root.chrome.runtime.sendMessage({
        type: 'addPromoCandidateFromConfirmedPage',
        nickname: marker.nickname,
        pageUrl: location.href,
        writeUrl: marker.writeUrl,
      });
      if (result && result.ok) {
        sessionStorage.removeItem(keyboardBoardStorageKey);
        showWriteCopyNotice('홍보 리스트에 추가했습니다.', false);
        log('keyboard-promo-add-succeeded', { stationId: current.stationId, boardId: current.boardId });
      } else {
        showWriteCopyNotice(String(result && result.message || '홍보 리스트에 추가하지 못했습니다.'), true);
        log('keyboard-promo-add-failed', { stationId: current.stationId, boardId: current.boardId, reason: String(result && result.reason || 'unknown') });
      }
    } catch (error) {
      showWriteCopyNotice('관리자 센터 연결에 실패했습니다. 센터 탭과 확장 프로그램을 확인해주세요.', true);
      log('keyboard-promo-add-failed', { stationId: current.stationId, boardId: current.boardId, reason: 'extension-message-failed', error: String(error && error.message || error) });
    }
    return true;
  }

  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isTypingTarget(event.target)) return;
    const shortcutIndex = shortcutIndexFromKey(event.code || event.key);
    if (shortcutIndex >= 0 && stationIdFromPath(location.pathname)) {
      const host = document.getElementById(ROOT_ID);
      if (!host || host.dataset.closed === 'true' || duplicateLookupState.state === 'found' || duplicateLookupState.state === 'excluded' || !activeShortcutEntries[shortcutIndex]) return;
      event.preventDefault();
      event.stopPropagation();
      openShortcutCandidate(shortcutIndex);
      return;
    }
    if ((event.code === 'Space' || event.key === ' ') && extractCurrentBoard(location.pathname, stationIdFromPath(location.pathname))) {
      let marker = null;
      try { marker = JSON.parse(sessionStorage.getItem(keyboardBoardStorageKey) || 'null'); } catch (_) { /* ignore malformed temporary state */ }
      if (!marker || marker.viaKeyboard !== true || Date.now() - Number(marker.at || 0) > 5 * 60 * 1000) return;
      event.preventDefault();
      event.stopPropagation();
      void addKeyboardConfirmedBoard();
    }
  }, true);

  window.addEventListener('message', (event) => {
    const data = event.data;
    const stationId = stationIdFromPath(location.pathname);
    if (event.source !== window || event.origin !== location.origin || !data ||
        data.__soopPromoExclusionChanged !== true || !stationId ||
        String(data.stationId || '').toLowerCase() !== stationId.toLowerCase()) return;
    duplicateLookupKey = '';
    duplicateLookupState = { state: 'idle', nickname: '', reason: '' };
    checkPromoDuplicate(stationId, String(data.nickname || ''));
    log('promo-exclusion-status-refreshed', { stationId: stationId, excluded: data.excluded === true });
  });

  log('scanner-initialized', { href: location.origin + location.pathname });
  window.addEventListener('pointerdown', () => {
    try {
      const marker = JSON.parse(sessionStorage.getItem(keyboardBoardStorageKey) || 'null');
      if (marker && marker.viaKeyboard === true) {
        sessionStorage.removeItem(keyboardBoardStorageKey);
        log('keyboard-board-shortcut-expired-by-pointer', { stationId: marker.stationId, boardId: marker.boardId || '' });
      }
    } catch (_) { /* keyboard-only add remains disabled if session storage is unavailable */ }
  }, true);
  scheduleScan('initial');
  mutationObserver = new MutationObserver(() => scheduleScan('dom-mutation'));
  if (document.documentElement) mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', () => scheduleScan('popstate'));
  setInterval(() => {
    if (location.pathname.toLowerCase() !== lastRoute) scheduleScan('route-poll');
  }, 1400);
})(typeof globalThis !== 'undefined' ? globalThis : window);
