const ADMIN_PAGE_PREFIX = 'https://neezu-crypto.github.io/admin-center/';
const PENDING_KEY_PREFIX = 'soopPromoDraft:';
const PENDING_POST_PREFIX = 'soopPromoPendingPost:';
const SOOP_WRITE_PATH = /^\/station\/[A-Za-z0-9]+\/post\/write\/\d+\/?$/;
const SOOP_POST_PATH = /^\/station\/([A-Za-z0-9]+)\/post\/(\d+)\/?$/;
const PROMO_PENDING_TTL_MS = 2 * 60 * 60 * 1000;
const COMPLETION_RETRY_MS = 5000;

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

  if (message.type === 'openPromoDraft') {
    if (!isAllowedAdminSender(sender)) {
      sendResponse({ ok: false, error: '관리자 센터에서 시작한 요청만 처리할 수 있습니다.' });
      return false;
    }

    const draft = message.draft || {};
    if (!isAllowedWriteUrl(draft.writeUrl) ||
        typeof draft.nickname !== 'string' || draft.nickname.length > 100 ||
        typeof draft.title !== 'string' || draft.title.length > 200 ||
        typeof draft.body !== 'string' || draft.body.length > 10000 ||
        typeof draft.html !== 'string' || draft.html.length > 40000 ||
        typeof draft.promoKey !== 'string' || !draft.promoKey || draft.promoKey.length > 160 ||
        typeof draft.soopId !== 'string' || draft.soopId.length > 20) {
      sendResponse({ ok: false, error: '글쓰기 링크 또는 생성된 내용이 올바르지 않습니다.' });
      return false;
    }

    chrome.tabs.create({ url: 'about:blank', active: true }).then(async (tab) => {
      const key = PENDING_KEY_PREFIX + tab.id;
      const pendingKey = PENDING_POST_PREFIX + tab.id;
      const createdAt = Date.now();
      await chrome.storage.session.set({ [key]: {
        nickname: draft.nickname,
        title: draft.title,
        body: draft.body,
        html: draft.html,
        createdAt: createdAt,
      }, [pendingKey]: {
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
      await chrome.tabs.update(tab.id, { url: draft.writeUrl, active: true });
      sendResponse({ ok: true });
    }).catch((error) => {
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
    chrome.storage.session.get(key).then(async (result) => {
      const draft = result[key] || null;
      if (draft) await chrome.storage.session.remove(key);
      sendResponse({ ok: true, draft: draft });
    }).catch((error) => {
      console.error('홍보글 임시 데이터 조회 실패:', error);
      sendResponse({ ok: false, error: '홍보글 데이터를 가져오지 못했습니다.' });
    });
    return true;
  }

  if (message.type === 'confirmPromoPost') {
    confirmPromoPost(message, sender).then(sendResponse).catch((error) => {
      console.error('홍보 게시 성공 확인 실패:', error);
      sendResponse({ ok: false, reason: 'confirmation-error' });
    });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([
    PENDING_KEY_PREFIX + tabId,
    PENDING_POST_PREFIX + tabId,
  ]).catch((error) => console.warn('홍보 탭 임시 상태 정리 실패:', error));
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
  let url;
  try { url = new URL(sender.url || (sender.tab && sender.tab.url) || ''); }
  catch (error) { return { ok: false, reason: 'invalid-url' }; }
  const match = SOOP_POST_PATH.exec(url.pathname);
  if (!Number.isInteger(tabId) || !match ||
      (url.hostname !== 'sooplive.com' && url.hostname !== 'www.sooplive.com')) {
    return { ok: false, reason: 'not-post-detail' };
  }

  const pendingKey = PENDING_POST_PREFIX + tabId;
  const result = await chrome.storage.session.get(pendingKey);
  const pending = result[pendingKey];
  if (!pending) return { ok: false, reason: 'no-pending-promo' };
  const now = Date.now();
  if (now - pending.createdAt > PROMO_PENDING_TTL_MS) {
    await chrome.storage.session.remove(pendingKey);
    return { ok: false, reason: 'expired' };
  }
  if (match[1].toLowerCase() !== pending.stationId) return { ok: false, reason: 'different-station' };

  const visibleText = normalizeText(message.visibleText).slice(0, 30000);
  const expectedTitle = normalizeText(pending.title);
  const expectedBody = normalizeText(pending.body);
  const bodySignature = expectedBody.slice(0, Math.min(32, expectedBody.length));
  if (!expectedTitle || !bodySignature || !visibleText.includes(expectedTitle) || !visibleText.includes(bodySignature)) {
    return { ok: false, reason: 'post-content-not-confirmed' };
  }
  if (pending.completionRequested || now - (pending.lastAttemptAt || 0) < COMPLETION_RETRY_MS) {
    return { ok: false, reason: 'completion-in-progress' };
  }

  const adminTab = await findAdminTab(pending.adminTabId);
  if (!adminTab) return { ok: false, reason: 'admin-tab-unavailable' };

  const requestId = 'promo-' + tabId + '-' + now;
  pending.completionRequested = true;
  pending.lastAttemptAt = now;
  await chrome.storage.session.set({ [pendingKey]: pending });
  try {
    const response = await chrome.tabs.sendMessage(adminTab.id, {
      type: 'markPromoCompleted',
      requestId: requestId,
      promoKey: pending.promoKey,
      soopId: pending.soopId,
    });
    if (!response || response.ok !== true) {
      pending.completionRequested = false;
      await chrome.storage.session.set({ [pendingKey]: pending });
      return { ok: false, reason: 'admin-save-failed' };
    }
    await chrome.storage.session.remove(pendingKey);
    return { ok: true, completed: true, articleId: match[2] };
  } catch (error) {
    pending.completionRequested = false;
    await chrome.storage.session.set({ [pendingKey]: pending });
    console.error('관리 센터 홍보 완료 저장 실패:', error);
    return { ok: false, reason: 'admin-save-failed' };
  }
}
