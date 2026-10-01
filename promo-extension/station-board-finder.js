(function (root) {
  'use strict';

  const BOARD_PATH = /^\/station\/([A-Za-z0-9_-]+)\/board\/([A-Za-z0-9_-]+)\/?$/i;
  const EXCLUDED_TITLE = /공지|알림|방송\s*공지|운영\s*안내|규칙|스트리머\s*전용|스트리머만|방송인\s*전용|컨텐츠\s*제작|콘텐츠\s*제작|\bvod\b|다시보기/i;
  const STRONG_TITLE = /뻐꾸기|뻐꾸|추천|리퀘|request|recommend/i;
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

  function classifyBoardTitle(title) {
    const normalized = cleanText(title).normalize('NFKC');
    if (!normalized) return { kind: 'ignore', reason: '게시판 이름을 읽지 못함' };
    if (EXCLUDED_TITLE.test(normalized)) return { kind: 'exclude', reason: '공지·운영·VOD 또는 스트리머 전용으로 보이는 이름' };
    if (STRONG_TITLE.test(normalized)) return { kind: 'candidate', confidence: '높음', reason: '뻐꾸기·추천·리퀘스트 관련 이름' };
    if (MEDIUM_TITLE.test(normalized)) return { kind: 'candidate', confidence: '보통', reason: '제안·요청·의견 관련 이름 — 이용 대상 확인 필요' };
    if (GENERIC_CONTENT_TITLE.test(normalized)) return { kind: 'review', confidence: '낮음', reason: '콘텐츠·게임 관련 이름만으로는 시청자 작성 가능 여부를 판별할 수 없음' };
    return { kind: 'ignore', reason: '홍보 후보 의미를 이름에서 확인하지 못함' };
  }

  const api = { cleanText, stationIdFromPath, extractBoardLink, classifyBoardTitle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined' || !root || root.__soopPromoBoardFinder070) return;
  root.__soopPromoBoardFinder070 = true;

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

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function getBoardEntries(stationId) {
    const links = Array.from(document.querySelectorAll('a[href]'));
    const byPath = new Map();
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
    return { links: Array.from(byPath.values()), stationAnchors: stationAnchors, scannedAnchors: links.length };
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
        .summary{font-size:12px;color:#526078;margin:0 0 9px}.warning{background:#fff8e7;border:1px solid #f3dda0;padding:8px;border-radius:8px;color:#674d00;font-size:12px;margin:8px 0}
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

  function render(entries, stationId, scan) {
    const host = ensurePanel();
    const body = host.shadowRoot.querySelector('.body');
    const signature = stationId + '|' + entries.map((item) => item.boardId + ':' + item.title).join('|');
    if (signature === lastSignature && body.dataset.ready === 'true') return;
    lastSignature = signature;
    body.dataset.ready = 'true';

    const classified = entries.map((item) => Object.assign(item, classifyBoardTitle(item.title)));
    const candidates = classified.filter((item) => item.kind === 'candidate');
    const review = classified.filter((item) => item.kind === 'review');
    const safeItems = candidates.concat(review);
    log('board-scan-complete', {
      stationId: stationId,
      scannedAnchors: scan.scannedAnchors,
      stationBoardAnchors: scan.stationAnchors,
      uniqueBoards: entries.length,
      candidateCount: candidates.length,
      manualReviewCount: review.length,
      excludedCount: classified.filter((item) => item.kind === 'exclude').length,
      ignoredCount: classified.filter((item) => item.kind === 'ignore').length,
    });
    classified.forEach((item) => log('board-classified', {
      stationId: stationId, boardId: item.boardId, title: item.title,
      result: item.kind, confidence: item.confidence || '', reason: item.reason,
    }));

    if (!safeItems.length) {
      body.innerHTML = '<div class="empty">이름만으로 추천·요청 게시판 후보를 찾지 못했습니다.<br>왼쪽 게시판 목록이 펼쳐져 있는지 확인하거나 진단 로그를 확인해주세요.</div>' +
        '<div class="warning">게시판 이름만 보고 확정하지 않습니다. 발견되지 않은 게시판은 수동으로 찾아보세요.</div>';
      return;
    }
    const rows = safeItems.map((item) => {
      const low = item.kind === 'review';
      return '<article class="row"><div class="title">' + escapeHtml(item.title || '(이름 없음)') +
        '<span class="badge ' + (low ? 'low' : '') + '">' + (low ? '확인 필요' : item.confidence + ' 후보') + '</span></div>' +
        '<div class="meta">' + escapeHtml(item.reason) + ' · 게시판 ID ' + escapeHtml(item.boardId) + '</div>' +
        '<div class="actions"><a class="action" href="' + escapeHtml(item.boardUrl) + '">게시판 확인</a>' +
        (low ? '' : '<a class="action" href="' + escapeHtml(item.writeUrl) + '">글쓰기 화면 열기</a>') +
        '<button type="button" data-copy-url="' + escapeHtml(item.writeUrl) + '" data-board-id="' + escapeHtml(item.boardId) + '">글쓰기 주소 복사</button></div></article>';
    }).join('');
    body.innerHTML = '<p class="summary">방송국 ' + escapeHtml(stationId) + ' · 게시판 ' + entries.length + '개 확인 · 후보 ' + candidates.length + '개' +
      (review.length ? ' · 이름만으로 판별 불가 ' + review.length + '개' : '') + '</p>' +
      '<div class="warning">이름 기반 후보입니다. 열기 전에 게시판 용도와 작성 가능 여부를 확인하세요. 팬 전용/접근 제한 게시판은 자동으로 즐겨찾기하지 않습니다.</div>' + rows;
  }

  function scan() {
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
      log('station-route-detected', { stationId: stationId, path: location.pathname });
    }
    const result = getBoardEntries(stationId);
    if (!result.links.length) {
      const host = ensurePanel();
      const body = host.shadowRoot.querySelector('.body');
      if (body.dataset.ready !== 'empty') {
        body.dataset.ready = 'empty';
        body.innerHTML = '<div class="empty">아직 게시판 링크를 찾지 못했습니다. 게시판 목록이 로드되거나 펼쳐지면 자동으로 다시 확인합니다.</div>';
        log('no-board-links-found', { stationId: stationId, path: location.pathname, scannedAnchors: result.scannedAnchors });
      }
      return;
    }
    render(result.links, stationId, result);
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
