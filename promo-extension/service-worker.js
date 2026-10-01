const ADMIN_PAGE_PREFIX = 'https://neezu-crypto.github.io/admin-center/';
const PENDING_KEY_PREFIX = 'soopPromoDraft:';
const PENDING_POST_PREFIX = 'soopPromoPendingPost:';
const SOOP_WRITE_PATH = /^\/station\/[A-Za-z0-9]+\/post\/write\/\d+\/?$/;
const SOOP_POST_PATH = /^\/station\/([A-Za-z0-9]+)\/post\/(\d+)\/?$/;
const PROMO_PENDING_TTL_MS = 2 * 60 * 60 * 1000;
const COMPLETION_RETRY_MS = 5000;
const diagnosticCheckLogKeys = new Set();

function trace(attemptId, stage, details) {
  console.info('[SOOP 홍보 진단]', JSON.stringify({
    attemptId: attemptId || 'unassigned',
    stage: stage,
    at: new Date().toISOString(),
    details: details || {},
  }));
}

function traceContentCheckOnce(attemptId, state, details) {
  const key = String(attemptId || 'unassigned') + ':' + state;
  if (diagnosticCheckLogKeys.has(key)) return;
  if (diagnosticCheckLogKeys.size > 500) diagnosticCheckLogKeys.clear();
  diagnosticCheckLogKeys.add(key);
  trace(attemptId, 'published-post-content-checked', details);
}

function isAllowedWriteUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname === 'sooplive.com' || url.hostname === 'www.sooplive.com') &&
      SOOP_WRITE_PATH.test(url.pathname);
  } catch (error) {
    return false;
  }
}

function isAllowedAdminSender(sender) {
  return typeof sender.url === 'string' && sender.url.startsWith(ADMIN_PAGE_PREFIX) &&
    Number.isInteger(sender.tab && sender.tab.id);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'addPromoCandidateFromConfirmedPage') {
    let senderUrl;
    let pageUrl;
    let writeUrl;
    try { senderUrl = new URL(sender.url || (sender.tab && sender.tab.url) || ''); } catch (_) { senderUrl = null; }
    try { pageUrl = new URL(String(message.pageUrl || '')); } catch (_) { pageUrl = null; }
    try { writeUrl = new URL(String(message.writeUrl || '')); } catch (_) { writeUrl = null; }
    // SOOP SPA navigation can leave sender.url on the prior route. Validate the
    // content script's current board/write page against the same write URL.
    const pageWriteMatch = pageUrl && /^\/station\/([A-Za-z0-9]{2,20})\/post\/write\/([A-Za-z0-9_-]{1,80})\/?$/i.exec(pageUrl.pathname);
    const pageBoardMatch = pageUrl && /^\/station\/([A-Za-z0-9]{2,20})\/board\/([A-Za-z0-9_-]{1,80})\/?$/i.exec(pageUrl.pathname);
    const writeMatch = writeUrl && /^\/station\/([A-Za-z0-9]{2,20})\/post\/write\/([A-Za-z0-9_-]{1,80})\/?$/i.exec(writeUrl.pathname);
    const pageMatchesWriteUrl = !!(writeMatch && ((pageWriteMatch &&
      pageWriteMatch[1].toLowerCase() === writeMatch[1].toLowerCase() && pageWriteMatch[2] === writeMatch[2]) ||
      (pageBoardMatch && pageBoardMatch[1].toLowerCase() === writeMatch[1].toLowerCase() && pageBoardMatch[2] === writeMatch[2])));
    const nickname = typeof message.nickname === 'string' ? message.nickname.trim() : '';
    const sameSoopHost = (url) => url && url.protocol === 'https:' && ['sooplive.com', 'www.sooplive.com'].includes(url.hostname);
    if (!Number.isInteger(sender.tab && sender.tab.id) || !sameSoopHost(senderUrl) || !sameSoopHost(writeUrl) ||
        !sameSoopHost(pageUrl) || !pageMatchesWriteUrl || !writeMatch || writeUrl.search || writeUrl.hash || !nickname || nickname.length > 100) {
      trace('', 'promo-candidate-add-rejected', {
        reason: 'invalid-write-page-request', nicknameLength: nickname.length,
        senderHostValid: !!sameSoopHost(senderUrl), pageRouteValid: !!(pageWriteMatch || pageBoardMatch),
        writeUrlValid: !!writeMatch, pageMatchesWriteUrl: pageMatchesWriteUrl,
      });
      sendResponse({ ok: false, reason: 'invalid-request', message: '현재 게시판과 글쓰기 주소가 일치하는지 확인할 수 없습니다.' });
      return false;
    }
    findAdminTab().then((adminTab) => {
      if (!adminTab) {
        trace('', 'promo-candidate-add-unavailable', { reason: 'admin-center-not-open', stationId: writeMatch[1] });
        sendResponse({ ok: false, reason: 'admin-center-not-open', message: '관리자 센터 탭을 열고 로그인한 뒤 다시 시도해주세요.' });
        return;
      }
      trace('', 'promo-candidate-add-forwarded', { stationId: writeMatch[1], adminTabId: adminTab.id });
      chrome.tabs.sendMessage(adminTab.id, {
        type: 'addStreamerPromoCandidate',
        nickname: nickname,
        soopId: writeMatch[1],
        writeUrl: 'https://www.sooplive.com' + writeUrl.pathname,
      }).then(sendResponse).catch((error) => {
        trace('', 'promo-candidate-add-unavailable', { reason: 'admin-bridge-unavailable', error: String(error && error.message || error) });
        sendResponse({ ok: false, reason: 'admin-bridge-unavailable', message: '관리자 센터 탭을 새로고침한 뒤 다시 시도해주세요.' });
      });
    }).catch((error) => {
      trace('', 'promo-candidate-add-failed', { reason: 'admin-tab-search-failed', error: String(error && error.message || error) });
      sendResponse({ ok: false, reason: 'admin-tab-search-failed', message: '관리자 센터 연결을 확인해주세요.' });
    });
    return true;
  }

  if (message.type === 'checkPromoListDuplicate') {
    let sourceUrl;
    try { sourceUrl = new URL(sender.url || ''); } catch (_) { sourceUrl = null; }
    const sourceStation = sourceUrl && sourceUrl.pathname.match(/^\/station\/([A-Za-z0-9_-]+)(?:\/|$)/i);
    const stationId = typeof message.stationId === 'string' ? message.stationId : '';
    const nickname = typeof message.nickname === 'string' ? message.nickname.trim() : '';
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const isSoopSender = Number.isInteger(sender.tab && sender.tab.id) && sourceUrl && sourceUrl.protocol === 'https:' &&
      (sourceUrl.hostname === 'sooplive.com' || sourceUrl.hostname === 'www.sooplive.com');
    const isProfileHoverLookup = message.lookupContext === 'profile-hover';
    const validSender = isSoopSender && (isProfileHoverLookup ||
      (sourceStation && sourceStation[1].toLowerCase() === stationId.toLowerCase()));
    if (!validSender || !/^[A-Za-z0-9_-]{1,80}$/.test(stationId) || !nickname || nickname.length > 100 || !requestId || requestId.length > 120) {
      trace(requestId, 'promo-duplicate-lookup-rejected', { validSender: !!validSender, nicknameLength: nickname.length });
      sendResponse({ ok: false, reason: 'invalid-request' });
      return false;
    }
    findAdminTab().then((adminTab) => {
      if (!adminTab) {
        trace(requestId, 'promo-duplicate-lookup-unavailable', { reason: 'admin-center-not-open', stationId: stationId });
        sendResponse({ ok: false, reason: 'admin-center-not-open' });
        return;
      }
      trace(requestId, 'promo-duplicate-lookup-forwarded', { stationId: stationId, adminTabId: adminTab.id });
      chrome.tabs.sendMessage(adminTab.id, {
        type: 'lookupStreamerPromoDuplicate', requestId: requestId, stationId: stationId, nickname: nickname,
      }).then((result) => {
        trace(requestId, result && result.ok ? 'promo-duplicate-lookup-completed' : 'promo-duplicate-lookup-failed', {
          found: !!(result && result.found), reason: String(result && result.reason || ''),
        });
        sendResponse(result || { ok: false, reason: 'empty-admin-response' });
      }).catch((error) => {
        trace(requestId, 'promo-duplicate-lookup-unavailable', { reason: 'admin-bridge-unavailable', error: String(error && error.message || error) });
        sendResponse({ ok: false, reason: 'admin-bridge-unavailable' });
      });
    }).catch((error) => {
      trace(requestId, 'promo-duplicate-lookup-unavailable', { reason: 'admin-tab-search-failed', error: String(error && error.message || error) });
      sendResponse({ ok: false, reason: 'admin-tab-search-failed' });
    });
    return true;
  }

  if (message.type === 'openPromoDraft') {
    if (!isAllowedAdminSender(sender)) {
      trace(message.attemptId, 'open-request-sender-rejected', {
        senderUrl: sender.url || '',
        hasTab: Number.isInteger(sender.tab && sender.tab.id),
      });
      sendResponse({ ok: false, error: '관리자 센터에서 시작한 요청만 처리할 수 있습니다.' });
      return false;
    }

    const draft = message.draft || {};
    const attemptId = typeof message.attemptId === 'string' ? message.attemptId : '';
    if (!isAllowedWriteUrl(draft.writeUrl) ||
        typeof draft.nickname !== 'string' || draft.nickname.length > 100 ||
        typeof draft.title !== 'string' || draft.title.length > 200 ||
        typeof draft.body !== 'string' || draft.body.length > 10000 ||
        typeof draft.html !== 'string' || draft.html.length > 40000 ||
        typeof draft.promoKey !== 'string' || !draft.promoKey || draft.promoKey.length > 160 ||
        typeof draft.soopId !== 'string' || draft.soopId.length > 20) {
      trace(attemptId, 'open-request-data-rejected', {
        writeUrlValid: isAllowedWriteUrl(draft.writeUrl),
        nicknameValid: typeof draft.nickname === 'string' && draft.nickname.length <= 100,
        titleValid: typeof draft.title === 'string' && draft.title.length <= 200,
        bodyValid: typeof draft.body === 'string' && draft.body.length <= 10000,
        htmlValid: typeof draft.html === 'string' && draft.html.length <= 40000,
        promoKeyValid: typeof draft.promoKey === 'string' && !!draft.promoKey && draft.promoKey.length <= 160,
        soopIdValid: typeof draft.soopId === 'string' && draft.soopId.length <= 20,
      });
      sendResponse({ ok: false, error: '글쓰기 링크 또는 생성된 내용이 올바르지 않습니다.' });
      return false;
    }

    chrome.tabs.create({ url: 'about:blank', active: true }).then(async (tab) => {
      const key = PENDING_KEY_PREFIX + tab.id;
      const pendingKey = PENDING_POST_PREFIX + tab.id;
      const createdAt = Date.now();
      await chrome.storage.local.set({ [key]: {
        attemptId: attemptId,
        nickname: draft.nickname,
        title: draft.title,
        body: draft.body,
        html: draft.html,
        createdAt: createdAt,
      }, [pendingKey]: {
        attemptId: attemptId,
        adminTabId: sender.tab.id,
        promoKey: draft.promoKey,
        soopId: draft.soopId,
        stationId: new URL(draft.writeUrl).pathname.match(/^\/station\/([A-Za-z0-9]+)\//)[1].toLowerCase(),
        title: draft.title,
        body: draft.body,
        createdAt: createdAt,
        lastAttemptAt: 0,
        completionRequested: false,
      } });
      trace(attemptId, 'pending-created', {
        managerTabId: sender.tab.id,
        soopTabId: tab.id,
        stationId: new URL(draft.writeUrl).pathname.match(/^\/station\/([A-Za-z0-9]+)\//)[1].toLowerCase(),
        promoKey: draft.promoKey,
      });
      await chrome.tabs.update(tab.id, { url: draft.writeUrl, active: true });
      trace(attemptId, 'soop-write-tab-opened', { soopTabId: tab.id });
      sendResponse({ ok: true });
    }).catch((error) => {
      trace(attemptId, 'soop-write-tab-open-failed', { error: String(error && error.message || error) });
      console.error('SOOP 홍보글 탭 열기 실패:', error);
      sendResponse({ ok: false, error: 'SOOP 글쓰기 탭을 열지 못했습니다.' });
    });
    return true;
  }

  if (message.type === 'takePromoDraft') {
    const tabId = sender.tab && sender.tab.id;
    if (!Number.isInteger(tabId) || !sender.url || !isAllowedWriteUrl(sender.url)) {
      sendResponse({ ok: false, error: '허용된 SOOP 글쓰기 화면이 아닙니다.' });
      return false;
    }
    const key = PENDING_KEY_PREFIX + tabId;
    chrome.storage.local.get(key).then(async (result) => {
      const draft = result[key] || null;
      if (draft) await chrome.storage.local.remove(key);
      trace(draft && draft.attemptId, draft ? 'draft-delivered-to-soop' : 'draft-missing-on-soop', {
        soopTabId: tabId,
        stationId: (new URL(sender.url)).pathname.match(/^\/station\/([A-Za-z0-9]+)\//)?.[1]?.toLowerCase() || '',
        titleLength: draft && draft.title ? draft.title.length : 0,
        bodyLength: draft && draft.body ? draft.body.length : 0,
        htmlLength: draft && draft.html ? draft.html.length : 0,
      });
      sendResponse({ ok: true, draft: draft });
    }).catch((error) => {
      console.error('홍보글 임시 데이터 조회 실패:', error);
      sendResponse({ ok: false, error: '홍보글 데이터를 가져오지 못했습니다.' });
    });
    return true;
  }

  if (message.type === 'confirmPromoPost') {
    confirmPromoPost(message, sender).then(sendResponse).catch((error) => {
      trace(message.attemptId, 'post-confirmation-threw', { error: String(error && error.message || error) });
      console.error('홍보 게시 성공 확인 실패:', error);
      sendResponse({ ok: false, reason: 'confirmation-error', attemptId: message.attemptId || '' });
    });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // A successful post may open its detail page in a different tab. Keep the
  // short-lived completion record even if the compose tab closes; it expires
  // automatically after PROMO_PENDING_TTL_MS.
  chrome.storage.local.remove(PENDING_KEY_PREFIX + tabId)
    .catch((error) => console.warn('홍보 탭 임시 상태 정리 실패:', error));
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(null).then((allData) => {
    const sessionKeys = Object.keys(allData).filter((key) =>
      key.startsWith(PENDING_KEY_PREFIX) || key.startsWith(PENDING_POST_PREFIX));
    if (sessionKeys.length) {
      const pendingPostKeys = sessionKeys.filter((key) => key.startsWith(PENDING_POST_PREFIX));
      trace('', 'unclosed-promo-state-cleared-on-browser-startup', {
        draftCount: sessionKeys.length - pendingPostKeys.length,
        pendingPostCount: pendingPostKeys.length,
        attemptIds: pendingPostKeys.map((key) => allData[key] && allData[key].attemptId || '').filter(Boolean),
      });
      return chrome.storage.local.remove(sessionKeys);
    }
    trace('', 'browser-startup-no-pending-promo-state', {});
    return undefined;
  }).catch((error) => console.warn('이전 브라우저 세션의 홍보 데이터 정리 실패:', error));
});

async function findAdminTab(preferredTabId) {
  if (Number.isInteger(preferredTabId)) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (tab.url && tab.url.startsWith(ADMIN_PAGE_PREFIX)) return tab;
    } catch (error) { /* The original admin tab may have been closed. */ }
  }
  const tabs = await chrome.tabs.query({ url: [ADMIN_PAGE_PREFIX + '*'] });
  return tabs[0] || null;
}

function normalizeText(value) {
  return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

async function confirmPromoPost(message, sender) {
  const tabId = sender.tab && sender.tab.id;
  const senderUrl = sender.url || (sender.tab && sender.tab.url) || '';
  let senderOrigin;
  try { senderOrigin = new URL(senderUrl); }
  catch (error) { senderOrigin = null; }
  let tabUrlPath = '';
  try { tabUrlPath = (sender.tab && sender.tab.url) ? new URL(sender.tab.url).pathname : ''; }
  catch (error) { /* Diagnostic only; the explicit page URL is validated below. */ }
  let url;
  try { url = new URL(message.pageUrl || senderUrl); }
  catch (error) {
    trace(message.attemptId, 'post-confirmation-invalid-url', { error: String(error && error.message || error) });
    return { ok: false, reason: 'invalid-url', attemptId: message.attemptId || '' };
  }
  const match = SOOP_POST_PATH.exec(url.pathname);
  const isSoopHost = (hostname) => hostname === 'sooplive.com' || hostname === 'www.sooplive.com';
  if (!Number.isInteger(tabId) || !match || url.protocol !== 'https:' || !isSoopHost(url.hostname) ||
      !senderOrigin || senderOrigin.protocol !== 'https:' || !isSoopHost(senderOrigin.hostname)) {
    trace(message.attemptId, 'post-confirmation-wrong-route', {
      tabId: Number.isInteger(tabId) ? tabId : null,
      senderPath: senderOrigin && senderOrigin.pathname || '',
      tabPath: tabUrlPath,
      reportedPagePath: url.pathname,
      host: url.hostname,
      path: url.pathname,
    });
    return { ok: false, reason: 'not-post-detail', attemptId: message.attemptId || '' };
  }

  const now = Date.now();
  const allSessionData = await chrome.storage.local.get(null);
  const visibleText = normalizeText(message.visibleText).slice(0, 30000);
  const sameStation = [];
  const confirmed = [];
  const expiredKeys = [];
  const stationPendingCount = Object.entries(allSessionData).filter(([key, pending]) =>
    key.startsWith(PENDING_POST_PREFIX) && pending && pending.stationId === match[1].toLowerCase()
  ).length;
  const allPendingPostEntries = Object.entries(allSessionData).filter(([key, pending]) =>
    key.startsWith(PENDING_POST_PREFIX) && pending && pending.createdAt
  );
  Object.entries(allSessionData).forEach(([key, pending]) => {
    if (!key.startsWith(PENDING_POST_PREFIX) || !pending || !pending.createdAt) return;
    if (now - pending.createdAt > PROMO_PENDING_TTL_MS) {
      expiredKeys.push(key);
      return;
    }
    if (pending.stationId !== match[1].toLowerCase()) return;
    sameStation.push({ key, pending });
    const expectedTitle = normalizeText(pending.title);
    const expectedBody = normalizeText(pending.body);
    // The opening sentence is easy to edit or normalize in SOOP's editor.
    // Prefer the stable game URL embedded in this promo's body as its marker.
    const gameUrlMarker = 'neezu-crypto.github.io/streamer-life-game';
    const bodyMarker = expectedBody.includes(gameUrlMarker)
      ? gameUrlMarker
      : expectedBody.slice(0, Math.min(24, expectedBody.length));
    const titleMatched = !!expectedTitle && visibleText.includes(expectedTitle);
    const bodyMarkerMatched = !!bodyMarker && visibleText.includes(bodyMarker);
    traceContentCheckOnce(pending.attemptId, [titleMatched, bodyMarkerMatched].join('-'), {
      soopTabId: tabId,
      stationId: match[1].toLowerCase(),
      articleId: match[2],
      titleMatched: titleMatched,
      gameLinkMatched: bodyMarkerMatched,
      expectedTitleLength: expectedTitle.length,
      visibleTextLength: visibleText.length,
    });
    if (titleMatched && bodyMarkerMatched) {
      confirmed.push({ key, pending });
    }
  });
  if (expiredKeys.length) await chrome.storage.local.remove(expiredKeys);
  if (expiredKeys.length) {
    trace('', 'expired-promo-state-cleared', { expiredCount: expiredKeys.length });
  }
  if (!confirmed.length) {
    const reason = sameStation.length ? 'post-content-not-confirmed' : 'no-pending-promo';
    const attemptId = sameStation[0] && sameStation[0].pending.attemptId || message.attemptId || '';
    trace(attemptId, 'published-post-not-matched', {
      reason: reason,
      stationId: match[1].toLowerCase(),
      articleId: match[2],
      stationPendingCount: stationPendingCount,
      totalPendingPostCount: allPendingPostEntries.length,
      pendingStations: Array.from(new Set(allPendingPostEntries.map((item) => item[1].stationId).filter(Boolean))),
      expiredPendingCount: expiredKeys.length,
      visibleTextLength: visibleText.length,
    });
    return { ok: false, reason: reason, attemptId: attemptId };
  }
  const matchingPromoKeys = Array.from(new Set(confirmed.map((item) => item.pending.promoKey)));
  if (matchingPromoKeys.length > 1) {
    trace(confirmed[0].pending.attemptId, 'multiple-pending-promos-match', {
      candidateCount: confirmed.length,
      distinctPromoCount: matchingPromoKeys.length,
      stationId: match[1].toLowerCase(),
      articleId: match[2],
    });
    return { ok: false, reason: 'multiple-pending-promos', attemptId: confirmed[0].pending.attemptId || '' };
  }
  confirmed.sort((a, b) => b.pending.createdAt - a.pending.createdAt);
  const { pending } = confirmed[0];
  const matchingPendingKeys = confirmed.map((item) => item.key);
  const pendingKey = confirmed[0].key;
  if (pending.completionRequested || now - (pending.lastAttemptAt || 0) < COMPLETION_RETRY_MS) {
    trace(pending.attemptId, 'completion-attempt-skipped', {
      completionRequested: !!pending.completionRequested,
      withinRetryWindow: now - (pending.lastAttemptAt || 0) < COMPLETION_RETRY_MS,
    });
    return { ok: false, reason: 'completion-in-progress', attemptId: pending.attemptId || '' };
  }

  const adminTab = await findAdminTab(pending.adminTabId);
  if (!adminTab) {
    trace(pending.attemptId, 'admin-tab-not-found', { preferredAdminTabId: pending.adminTabId });
    return { ok: false, reason: 'admin-tab-unavailable', attemptId: pending.attemptId || '' };
  }

  const requestId = 'promo-' + tabId + '-' + now;
  pending.completionRequested = true;
  pending.lastAttemptAt = now;
  await chrome.storage.local.set({ [pendingKey]: pending });
  trace(pending.attemptId, 'admin-completion-request-sent', {
    managerTabId: adminTab.id,
    soopTabId: tabId,
    articleId: match[2],
    promoKey: pending.promoKey,
  });
  try {
    const response = await chrome.tabs.sendMessage(adminTab.id, {
      type: 'markPromoCompleted',
      requestId: requestId,
      promoKey: pending.promoKey,
      soopId: pending.soopId,
      attemptId: pending.attemptId || '',
    });
    if (!response || response.ok !== true) {
      pending.completionRequested = false;
      await chrome.storage.local.set({ [pendingKey]: pending });
      trace(pending.attemptId, 'admin-completion-request-rejected', {
        hasResponse: !!response,
        error: response && response.error || '',
      });
      return { ok: false, reason: 'admin-save-failed', attemptId: pending.attemptId || '' };
    }
    await chrome.storage.local.remove(matchingPendingKeys);
    trace(pending.attemptId, 'completion-flow-succeeded', { articleId: match[2] });
    return { ok: true, completed: true, articleId: match[2], attemptId: pending.attemptId || '' };
  } catch (error) {
    pending.completionRequested = false;
    await chrome.storage.local.set({ [pendingKey]: pending });
    trace(pending.attemptId, 'admin-completion-message-error', { error: String(error && error.message || error) });
    console.error('관리 센터 홍보 완료 저장 실패:', error);
    return { ok: false, reason: 'admin-save-failed', attemptId: pending.attemptId || '' };
  }
}
