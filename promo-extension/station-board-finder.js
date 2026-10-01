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

  function classifyBoardTitle(title) {
    const normalized = cleanText(title).normalize('NFKC');
    if (!normalized) return { kind: 'ignore', reason: '게시판 이름을 읽지 못함' };
    if (EXCLUDED_TITLE.test(normalized)) return { kind: 'exclude', reason: '공지·운영·VOD 또는 스트리머 전용으로 보이는 이름' };
    const compactTitle = normalized.replace(/[^\p{L}\p{N}]/gu, '').toLocaleLowerCase();
    if (compactTitle.includes('노래추천')) return { kind: 'exclude', reason: '노래 추천 게시판은 홍보 후보에서 제외' };
    if (compactTitle.includes('게임추천')) return { kind: 'candidate', confidence: '높음', reason: '게임 추천 문구가 포함된 이름' };
    if (STRONG_TITLE.test(compactTitle)) return { kind: 'candidate', confidence: '높음', reason: '뻐꾸기 유사 표기·추천·리퀘스트 관련 이름' };
    if (MEDIUM_TITLE.test(normalized)) return { kind: 'candidate', confidence: '보통', reason: '제안·요청·의견 관련 이름 — 이용 대상 확인 필요' };
    if (GENERIC_CONTENT_TITLE.test(normalized)) return { kind: 'review', confidence: '낮음', reason: '콘텐츠·게임 관련 이름만으로는 시청자 작성 가능 여부를 판별할 수 없음' };
    return { kind: 'ignore', reason: '홍보 후보 의미를 이름에서 확인하지 못함' };
  }

  const api = { cleanText, stationIdFromPath, extractBoardLink, extractCurrentBoard, extractWriteRoute, stationNicknameFromTitles, sortCandidatesByConfidence, classifyBoardTitle };
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
  let lastCurrentBoardLog = '';
  let attemptedWriteCopyPath = '';
  let duplicateLookupKey = '';
  let duplicateLookupState = { state: 'idle', nickname: '', reason: '' };
  const currentBoardTitles = new Map();
  const pendingBoardStorageKey = 'soopPromoBoardFinder.pendingBoard.' + location.hostname;
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
        .badge{display:inline-block;font-size:10px;padding:2px 6px;border-radius:999px;margin-left:5px;background:#e9f2ff;color:#0755b8}.badge.low{background:#fff2d6;color:#805400}
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

  function showWriteCopyNotice(message, failed) {
    let notice = document.getElementById('soop-promo-write-copy-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'soop-promo-write-copy-notice';
      notice.style.cssText = 'position:fixed;z-index:2147483647;top:18px;left:50%;transform:translateX(-50%);padding:11px 16px;border-radius:10px;background:#172033;color:#fff;font:14px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 5px 24px #0004;';
      document.documentElement.appendChild(notice);
    }
    notice.textContent = message;
    notice.style.background = failed ? '#9b1c1c' : '#166534';
    clearTimeout(notice.__removeTimer);
    notice.__removeTimer = setTimeout(() => notice.remove(), 5500);
  }

  function renderDuplicateStatus() {
    const host = document.getElementById(ROOT_ID);
    const status = host && host.shadowRoot && host.shadowRoot.querySelector('.duplicate-status');
    if (!status) return;
    const item = duplicateLookupState;
    Array.from(status.parentElement.children).forEach((child) => {
      if (child !== status) child.hidden = item.state === 'found';
    });
    status.className = 'duplicate-status' + (item.state === 'found' ? ' found' : item.state === 'clear' ? ' clear' : '');
    status.replaceChildren();
    if (item.state === 'checking') status.textContent = '홍보 리스트에서 닉네임 중복을 확인하는 중…';
    else if (item.state === 'found') status.textContent = '⚠ 이미 홍보 리스트에 등록된 닉네임입니다' + (item.nickname ? ': ' + item.nickname : '') + '.';
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
        duplicateLookupState = { state: result.found ? 'found' : 'clear', nickname: String(result.nickname || ''), requestNickname: cleanNickname, reason: '' };
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
      showWriteCopyNotice('방송국 닉네임과 글쓰기 URL을 클립보드에 복사했습니다.', false);
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
    const rows = orderedItems.map((item) => {
      const low = item.kind === 'review';
      if (item.entryType === 'menu-button') {
      return '<article class="row"><div class="title">' + escapeHtml(item.title) + '<span class="badge ' + (low ? 'low' : '') + '">' + (low ? '확인 필요' : item.confidence + ' 후보') + '</span></div>' +
        '<div class="meta">' + escapeHtml(item.reason) + ' · 메뉴 버튼에서 게시판 주소 확인 전</div>' +
        '<div class="actions"><button type="button" data-open-board-index="' + item.buttonIndex + '">게시판 확인</button></div></article>';
      }
      const hasWriteUrl = Boolean(item.writeUrl);
      return '<article class="row"><div class="title">' + escapeHtml(item.title || '(이름 없음)') +
        '<span class="badge ' + (low ? 'low' : '') + '">' + (low ? '확인 필요' : item.confidence + ' 후보') + '</span></div>' +
        '<div class="meta">' + escapeHtml(item.reason) + (hasWriteUrl ? ' · 게시판 ID ' + escapeHtml(item.boardId) : '') + '</div>' +
        '<div class="actions">' + (hasWriteUrl ? '<a class="action" href="' + escapeHtml(item.boardUrl) + '">게시판 확인</a>' : '') +
        (low || !hasWriteUrl ? '' : '<a class="action" data-open-write-url="' + escapeHtml(item.writeUrl) + '" href="' + escapeHtml(item.writeUrl) + '">글쓰기 화면 열기</a>') +
        (hasWriteUrl ? '<button type="button" data-copy-url="' + escapeHtml(item.writeUrl) + '" data-board-id="' + escapeHtml(item.boardId) + '">글쓰기 주소 복사</button>' : '') + '</div></article>';
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

  log('scanner-initialized', { href: location.origin + location.pathname });
  scheduleScan('initial');
  mutationObserver = new MutationObserver(() => scheduleScan('dom-mutation'));
  if (document.documentElement) mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', () => scheduleScan('popstate'));
  setInterval(() => {
    if (location.pathname.toLowerCase() !== lastRoute) scheduleScan('route-poll');
  }, 1400);
})(typeof globalThis !== 'undefined' ? globalThis : window);
