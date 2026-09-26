const ADMIN_PAGE_PREFIX = 'https://neezu-crypto.github.io/admin-center/';
const PENDING_KEY_PREFIX = 'soopPromoDraft:';
const SOOP_WRITE_PATH = /^\/station\/[A-Za-z0-9]+\/post\/write\/\d+\/?$/;

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
        typeof draft.html !== 'string' || draft.html.length > 40000) {
      sendResponse({ ok: false, error: '글쓰기 링크 또는 생성된 내용이 올바르지 않습니다.' });
      return false;
    }

    chrome.tabs.create({ url: 'about:blank', active: true }).then(async (tab) => {
      const key = PENDING_KEY_PREFIX + tab.id;
      await chrome.storage.session.set({ [key]: {
        nickname: draft.nickname,
        title: draft.title,
        body: draft.body,
        html: draft.html,
        createdAt: Date.now(),
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

  return false;
});
