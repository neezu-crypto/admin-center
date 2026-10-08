const ADMIN_PAGE_PREFIX = 'https://neezu-crypto.github.io/admin-center/';
const PENDING_KEY_PREFIX = 'soopPromoDraft:';
const PENDING_POST_PREFIX = 'soopPromoPendingPost:';
const SOOP_WRITE_PATH = /^\/station\/[A-Za-z0-9]+\/post\/write\/\d+\/?$/;
const SOOP_POST_PATH = /^\/station\/([A-Za-z0-9]+)\/post\/(\d+)\/?$/;
const PROMO_PENDING_TTL_MS = 2 * 60 * 60 * 1000;
const COMPLETION_RETRY_MS = 5000;
const CONTENT_CONFIRMATION_STABILITY_MS = 500;
const PROMO_BATCH_KEY = 'soopPromoBatchRun';
const PROMO_BATCH_NEXT_ALARM = 'soopPromoBatchNext';
const PROMO_BATCH_TIMEOUT_ALARM = 'soopPromoBatchTimeout';
const PROMO_BATCH_MAX_ITEMS = 10;
const PROMO_BATCH_MIN_DELAY_MS = 10000;
const PROMO_BATCH_MAX_DELAY_MS = 10 * 60 * 1000;
const PROMO_BATCH_PUBLISH_TIMEOUT_MS = 2 * 60 * 1000;
const diagnosticCheckLogKeys = new Set();
const ONYU_GIFT_WATCH_KEY = 'soopOnyuGameGiftNotificationWatch';
const ONYU_GIFT_MONITOR_SESSION_KEY = 'onyuGiftBackgroundMonitorSession';
const ONYU_GIFT_MONITOR_ALARM = 'onyuGiftBackgroundMonitorReconnect';
const ONYU_GIFT_MONITOR_API_KEY = 'AIzaSyAZcjQPHphENs-Bb7IfdL2qTtOMhJrRP54';
const ONYU_GIFT_MONITOR_AUTH_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=' + ONYU_GIFT_MONITOR_API_KEY;
const ONYU_GIFT_MONITOR_REFRESH_URL = 'https://securetoken.googleapis.com/v1/token?key=' + ONYU_GIFT_MONITOR_API_KEY;
const ONYU_GIFT_MONITOR_FEED_URL = 'https://us-central1-soop-stock-market.cloudfunctions.net/onyuGiftBackgroundFeed';
const ONYU_GIFT_MONITOR_CONFIRM_URL = 'https://us-central1-soop-stock-market.cloudfunctions.net/onyuConfirmStreamerGameGiftFromNotification';
let onyuGiftFeedController = null;
let onyuGiftFeedConnecting = false;
let onyuGiftFeedConnected = false;
let onyuGiftFeedRunId = 0;
let onyuGiftWatchTabQueue = Promise.resolve();
let onyuGiftMonitorStatusTabId = null;

function logOnyuGiftBackground(stage, details) {
  trace('', 'onyu-gift-background-' + stage, details || {});
}

function reportOnyuGiftMonitorStatus(state, reason) {
  if (!Number.isInteger(onyuGiftMonitorStatusTabId)) return;
  chrome.tabs.sendMessage(onyuGiftMonitorStatusTabId, {
    type: 'onyuGiftBackgroundMonitorStatus', state, reason: reason || '',
  }).catch(() => {});
}

async function onyuGiftMonitorSession() {
  const state = await chrome.storage.session.get(ONYU_GIFT_MONITOR_SESSION_KEY);
  return state[ONYU_GIFT_MONITOR_SESSION_KEY] || null;
}

async function refreshOnyuGiftMonitorIdToken(session) {
  if (!session || !session.refreshToken) throw new Error('monitor-session-missing');
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', session.refreshToken);
  const response = await fetch(ONYU_GIFT_MONITOR_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.id_token || !result.refresh_token) {
    throw new Error('monitor-token-refresh-failed-' + response.status);
  }
  const nextSession = Object.assign({}, session, {
    idToken: result.id_token,
    refreshToken: result.refresh_token,
    idTokenExpiresAt: Date.now() + Math.max(60, Number(result.expires_in) || 3600) * 1000,
  });
  await chrome.storage.session.set({ [ONYU_GIFT_MONITOR_SESSION_KEY]: nextSession });
  return nextSession;
}

async function ensureFreshOnyuGiftMonitorSession() {
  let session = await onyuGiftMonitorSession();
  if (!session) return null;
  if (!session.idToken || Number(session.idTokenExpiresAt) <= Date.now() + 90000) {
    session = await refreshOnyuGiftMonitorIdToken(session);
  }
  return session;
}

function readFirebaseIdTokenClaims(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3 || !parts[1]) throw new Error('monitor-id-token-invalid');
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const paddedPayload = payload + '='.repeat((4 - payload.length % 4) % 4);
  let claims;
  try {
    claims = JSON.parse(atob(paddedPayload));
  } catch (_) {
    throw new Error('monitor-id-token-invalid');
  }
  if (!claims || typeof claims !== 'object') throw new Error('monitor-id-token-invalid');
  const subject = String(claims.sub || '');
  const userId = String(claims.user_id || '');
  if (subject && userId && subject !== userId) throw new Error('monitor-id-token-uid-mismatch');
  return claims;
}

async function exchangeOnyuGiftMonitorCustomToken(customToken, adminUid) {
  const response = await fetch(ONYU_GIFT_MONITOR_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.idToken || !result.refreshToken) {
    throw new Error('monitor-token-exchange-failed-' + response.status);
  }
  // signInWithCustomToken returns idToken/refreshToken/expiresIn, not localId.
  // Firebase's signed ID token carries the authenticated UID in sub/user_id.
  const claims = readFirebaseIdTokenClaims(result.idToken);
  const tokenUid = String(claims.user_id || claims.sub || claims.uid || '');
  const monitorUid = String(result.localId || tokenUid);
  if (result.localId && tokenUid && String(result.localId) !== tokenUid) {
    throw new Error('monitor-id-token-uid-mismatch');
  }
  if (!monitorUid) throw new Error('monitor-token-exchange-uid-missing');
  if (claims.onyuGiftMonitor !== true || String(claims.onyuGiftAdminUid || '') !== String(adminUid || '')) {
    throw new Error('monitor-id-token-claims-invalid');
  }
  const session = {
    monitorUid,
    adminUid: String(adminUid || ''),
    idToken: result.idToken,
    refreshToken: result.refreshToken,
    idTokenExpiresAt: Date.now() + Math.max(60, Number(result.expiresIn) || 3600) * 1000,
  };
  await chrome.storage.session.set({ [ONYU_GIFT_MONITOR_SESSION_KEY]: session });
  return session;
}

async function notifyOnyuGiftWatchTabs(active, expiresAt) {
  const tabs = await chrome.tabs.query({ url: ['https://sooplive.com/*', 'https://www.sooplive.com/*'] });
  const validTabs = tabs.filter((tab) => Number.isInteger(tab.id));
  if (!active) {
    await chrome.storage.local.remove(ONYU_GIFT_WATCH_KEY);
    await Promise.all(validTabs.map((tab) => chrome.tabs.sendMessage(tab.id, {
      type: 'setOnyuGameGiftNotificationWatch', active: false, expiresAt: 0, tabId: null,
    }).catch(() => null)));
    return { soopTabCount: 0, selectedTabId: null };
  }

  const saved = await chrome.storage.local.get(ONYU_GIFT_WATCH_KEY);
  const previous = saved[ONYU_GIFT_WATCH_KEY] || {};
  let selected = validTabs.find((tab) => tab.id === previous.tabId) ||
    validTabs.find((tab) => tab.active) || validTabs[0] || null;
  const watch = { active: true, expiresAt: Number(expiresAt) || Date.now() + 60000, tabId: selected ? selected.id : null };
  await chrome.storage.local.set({ [ONYU_GIFT_WATCH_KEY]: watch });
  await Promise.all(validTabs.map((tab) => chrome.tabs.sendMessage(tab.id, {
    type: 'setOnyuGameGiftNotificationWatch',
    active: !!(selected && tab.id === selected.id),
    expiresAt: selected && tab.id === selected.id ? watch.expiresAt : 0,
    tabId: selected && tab.id === selected.id ? selected.id : null,
  }).catch(() => null)));
  return { soopTabCount: selected ? 1 : 0, selectedTabId: selected ? selected.id : null };
}

async function applyOnyuGiftMonitorFeedEvent(eventName, data) {
  if (eventName === 'auth-revoked') {
    logOnyuGiftBackground('admin-access-revoked', {});
    await stopOnyuGiftBackgroundMonitor(true);
    reportOnyuGiftMonitorStatus('failed', 'admin-access-revoked');
    return;
  }
  if (eventName === 'stream-error') {
    logOnyuGiftBackground('feed-error', { reason: String(data && data.reason || '') });
    return;
  }
  if (eventName !== 'watch-state' && eventName !== 'heartbeat') return;
  const active = data && data.active === true;
  const expiresAt = active ? Number(data.expiresAt) || Date.now() + 60000 : 0;
  await notifyOnyuGiftWatchTabs(active, expiresAt);
  // A Chrome extension service worker is suspendable. Touch extension storage for
  // each server heartbeat so the live stream can remain attached while the browser runs.
  await chrome.storage.session.set({ onyuGiftMonitorLastHeartbeatAt: Date.now() });
}

async function runOnyuGiftBackgroundFeed() {
  if (onyuGiftFeedConnecting || onyuGiftFeedConnected) return;
  const runId = ++onyuGiftFeedRunId;
  onyuGiftFeedConnecting = true;
  let controller = null;
  try {
    const session = await ensureFreshOnyuGiftMonitorSession();
    if (!session) {
      await chrome.alarms.clear(ONYU_GIFT_MONITOR_ALARM);
      return;
    }
    controller = new AbortController();
    onyuGiftFeedController = controller;
    const response = await fetch(ONYU_GIFT_MONITOR_FEED_URL, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + session.idToken, Accept: 'text/event-stream' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      if (response.status === 401 || response.status === 403) {
        await chrome.storage.session.remove([ONYU_GIFT_MONITOR_SESSION_KEY, 'onyuGiftMonitorLastHeartbeatAt']);
        await notifyOnyuGiftWatchTabs(false, 0);
        const rejection = await response.clone().json().catch(() => ({}));
        const reason = String(rejection.reason || 'access-rejected').slice(0, 80);
        logOnyuGiftBackground('feed-auth-rejected', { status: response.status, reason });
        reportOnyuGiftMonitorStatus('failed', 'feed-' + reason);
      } else {
        logOnyuGiftBackground('feed-connect-failed', { status: response.status });
        reportOnyuGiftMonitorStatus('reconnecting', 'feed-connect-failed');
      }
      return;
    }
    onyuGiftFeedConnected = true;
    logOnyuGiftBackground('feed-connected', {});
    reportOnyuGiftMonitorStatus('connected');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (runId === onyuGiftFeedRunId) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buffer.slice(0, boundary);
        const delimiter = buffer.slice(boundary).match(/^\r?\n\r?\n/)[0];
        buffer = buffer.slice(boundary + delimiter.length);
        let eventName = 'message';
        const dataLines = [];
        frame.split(/\r?\n/).forEach((line) => {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        });
        if (dataLines.length) {
          try { await applyOnyuGiftMonitorFeedEvent(eventName, JSON.parse(dataLines.join('\n'))); }
          catch (error) { logOnyuGiftBackground('feed-event-failed', { event: eventName, error: String(error && error.message || error).slice(0, 100) }); }
        }
      }
    }
    try { await reader.cancel(); } catch (_) { /* The feed may have closed already. */ }
  } catch (error) {
    if (!controller || !controller.signal.aborted) {
      logOnyuGiftBackground('feed-disconnected', { error: String(error && error.message || error).slice(0, 120) });
      reportOnyuGiftMonitorStatus('reconnecting', 'feed-disconnected');
    }
  } finally {
    if (runId === onyuGiftFeedRunId) {
      onyuGiftFeedConnected = false;
      onyuGiftFeedConnecting = false;
      onyuGiftFeedController = null;
      const session = await onyuGiftMonitorSession().catch(() => null);
      if (session) chrome.alarms.create(ONYU_GIFT_MONITOR_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
    }
  }
}

async function startOnyuGiftBackgroundMonitor(customToken, adminUid, statusTabId) {
  if (typeof customToken !== 'string' || customToken.length > 5000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(customToken)) {
    throw new Error('invalid-monitor-token');
  }
  const current = await onyuGiftMonitorSession();
  onyuGiftMonitorStatusTabId = Number.isInteger(statusTabId) ? statusTabId : null;
  if (current && current.adminUid === String(adminUid || '') && current.refreshToken) {
    await chrome.alarms.create(ONYU_GIFT_MONITOR_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
    runOnyuGiftBackgroundFeed();
    reportOnyuGiftMonitorStatus('starting');
    return { ok: true, reused: true };
  }
  await stopOnyuGiftBackgroundMonitor(false);
  const session = await exchangeOnyuGiftMonitorCustomToken(customToken, adminUid);
  if (String(session.monitorUid).indexOf('onyu_gift_monitor_') !== 0) {
    await stopOnyuGiftBackgroundMonitor(false);
    throw new Error('monitor-identity-mismatch');
  }
  await chrome.alarms.create(ONYU_GIFT_MONITOR_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
  logOnyuGiftBackground('session-started', {});
  runOnyuGiftBackgroundFeed();
  reportOnyuGiftMonitorStatus('starting');
  return { ok: true, reused: false };
}

async function stopOnyuGiftBackgroundMonitor(clearWatch) {
  onyuGiftFeedRunId += 1;
  onyuGiftFeedConnected = false;
  onyuGiftFeedConnecting = false;
  if (onyuGiftFeedController) onyuGiftFeedController.abort();
  onyuGiftFeedController = null;
  await chrome.alarms.clear(ONYU_GIFT_MONITOR_ALARM).catch(() => null);
  await chrome.storage.session.remove([ONYU_GIFT_MONITOR_SESSION_KEY, 'onyuGiftMonitorLastHeartbeatAt']).catch(() => null);
  if (clearWatch !== false) await notifyOnyuGiftWatchTabs(false, 0).catch(() => null);
  reportOnyuGiftMonitorStatus('stopped');
}

async function confirmOnyuGiftNotificationInBackground(message) {
  const senderSoopId = String(message.senderSoopId || '').trim().toLowerCase();
  const balloons = Number(message.balloons);
  const observedAt = Number(message.observedAt);
  const eventAtMin = Number(message.eventAtMin);
  const eventAtMax = Number(message.eventAtMax);
  const candidateFingerprint = String(message.candidateFingerprint || '').toLowerCase();
  if (!/^[a-z0-9]{2,20}$/.test(senderSoopId) || balloons !== 50 ||
      !Number.isFinite(observedAt) || !Number.isFinite(eventAtMin) || !Number.isFinite(eventAtMax) ||
      !/^[a-f0-9]{32,64}$/.test(candidateFingerprint)) return { ok: false, reason: 'invalid-notification-candidate' };
  const session = await ensureFreshOnyuGiftMonitorSession();
  if (!session) return { ok: false, reason: 'background-monitor-not-active' };
  const response = await fetch(ONYU_GIFT_MONITOR_CONFIRM_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + session.idToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: {
      senderSoopId, balloons, observedAt, eventAtMin, eventAtMax,
      exactTimestamp: message.exactTimestamp === true, candidateFingerprint,
    } }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) {
    const reason = String(result.error && (result.error.status || result.error.message) || 'callable-request-failed');
    if (response.status === 401 || response.status === 403) {
      await stopOnyuGiftBackgroundMonitor(true);
    }
    return { ok: false, reason: reason.slice(0, 100) };
  }
  return result.result || result.data || { ok: false, reason: 'empty-callable-response' };
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'find-unconfirmed-profile') return;
  chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const tab = tabs && tabs[0];
    let tabUrl;
    try { tabUrl = new URL(tab && tab.url || ''); } catch (_) { tabUrl = null; }
    if (!tab || !Number.isInteger(tab.id) || !tabUrl || tabUrl.protocol !== 'https:' ||
        !['sooplive.com', 'www.sooplive.com'].includes(tabUrl.hostname)) {
      console.info('[SOOP 홍보 단축키 진단]', JSON.stringify({
        version: '0.9.26', stage: 'browser-command-ignored', at: new Date().toISOString(),
        details: { reason: 'active-tab-is-not-soop', host: tabUrl && tabUrl.hostname || 'unknown', path: tabUrl && tabUrl.pathname || '' },
      }));
      return;
    }
    console.info('[SOOP 홍보 단축키 진단]', JSON.stringify({
      version: '0.9.26', stage: 'browser-command-fired', at: new Date().toISOString(),
      details: { tabId: tab.id, path: tabUrl.pathname },
    }));
    chrome.tabs.sendMessage(tab.id, { type: 'findUnconfirmedPromoProfile' }).catch((error) => {
      console.info('[SOOP 홍보 단축키 진단]', JSON.stringify({
        version: '0.9.26', stage: 'browser-command-delivery-failed', at: new Date().toISOString(),
        details: { error: String(error && error.message || error).slice(0, 120) },
      }));
    });
  }).catch((error) => {
    console.info('[SOOP 홍보 단축키 진단]', JSON.stringify({
      version: '0.9.26', stage: 'browser-command-query-failed', at: new Date().toISOString(),
      details: { error: String(error && error.message || error).slice(0, 120) },
    }));
  });
});

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

function isAllowedPromoWriterSender(sender) {
  const value = sender.url || (sender.tab && sender.tab.url) || '';
  try {
    const url = new URL(value);
    return Number.isInteger(sender.tab && sender.tab.id) && url.protocol === 'https:' &&
      ['sooplive.com', 'www.sooplive.com'].includes(url.hostname) &&
      /^\/station\/[A-Za-z0-9]+\/post\/(?:write\/\d+|\d+)\/?$/.test(url.pathname);
  } catch (_) { return false; }
}

function publicPromoBatchState(state) {
  if (!state) return { status: 'idle' };
  return {
    runId: state.runId || '',
    status: state.status || 'idle',
    currentIndex: Number(state.currentIndex) || 0,
    total: Array.isArray(state.items) ? state.items.length : 0,
    completedCount: Number(state.completedCount) || 0,
    currentNickname: String(state.currentNickname || ''),
    delayMs: Number(state.delayMs) || 0,
    testOnly: state.testOnly === true,
    unresolvedPublish: state.status === 'failed' && state.publishDispatched === true,
    message: String(state.message || ''),
  };
}

function isActivePromoBatch(state) {
  return !!state && ['starting', 'preparing', 'countdown', 'publishing', 'verifying', 'waiting', 'cancelling', 'stopping-after-current'].includes(state.status);
}

async function notifyPromoBatchState(state) {
  const previousSaved = await chrome.storage.local.get(PROMO_BATCH_KEY);
  const previous = previousSaved[PROMO_BATCH_KEY];
  if (previous && previous.runId === state.runId && previous.cancelRequested === true && state.cancelRequested !== true) {
    state.cancelRequested = true;
    state.status = previous.status;
    state.currentTabId = previous.currentTabId;
    state.publishDispatched = previous.publishDispatched === true;
    state.message = previous.message || '관리자 요청으로 중단했습니다.';
  }
  await chrome.storage.local.set({ [PROMO_BATCH_KEY]: state });
  const adminTab = await findAdminTab(state && state.adminTabId).catch(() => null);
  if (adminTab && Number.isInteger(adminTab.id)) {
    chrome.tabs.sendMessage(adminTab.id, {
      type: 'promoBatchStatusUpdate',
      state: publicPromoBatchState(state),
    }).catch(() => null);
  }
  if (state && Number.isInteger(state.currentTabId)) {
    chrome.tabs.sendMessage(state.currentTabId, {
      type: 'promoBatchCurrentState',
      state: publicPromoBatchState(state),
    }).catch(() => null);
  }
  trace(state && state.runId, 'promo-batch-state-updated', {
    status: state && state.status || 'idle',
    currentIndex: Number(state && state.currentIndex) || 0,
    total: Array.isArray(state && state.items) ? state.items.length : 0,
    completedCount: Number(state && state.completedCount) || 0,
  });
}

function promoBatchItemStationId(item) {
  try { return new URL(item.writeUrl).pathname.match(/^\/station\/([A-Za-z0-9]+)\//i)?.[1]?.toLowerCase() || ''; }
  catch (_) { return ''; }
}

function promoWriterSenderStationId(sender) {
  try {
    const url = new URL(sender.url || (sender.tab && sender.tab.url) || '');
    return url.pathname.match(/^\/station\/([A-Za-z0-9]+)\//i)?.[1]?.toLowerCase() || '';
  } catch (_) { return ''; }
}

function validatePromoBatchItems(rawItems, repeatCount, testOnly) {
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > PROMO_BATCH_MAX_ITEMS ||
      !Number.isInteger(repeatCount) || repeatCount !== rawItems.length || repeatCount < 1 || repeatCount > PROMO_BATCH_MAX_ITEMS) {
    return { ok: false, reason: 'invalid-repeat-count', message: '한 번 실행할 대상은 1~10건으로 설정해주세요.' };
  }
  if (testOnly && rawItems.length !== 1) {
    return { ok: false, reason: 'test-mode-count-invalid', message: '입력 테스트는 한 건만 가능합니다.' };
  }
  const promoKeys = new Set();
  const stationIds = new Set();
  const items = [];
  for (const raw of rawItems) {
    const item = raw && typeof raw === 'object' ? raw : {};
    const stringsValid = typeof item.promoKey === 'string' && item.promoKey.length > 0 && item.promoKey.length <= 160 &&
      typeof item.nickname === 'string' && item.nickname.trim().length > 0 && item.nickname.length <= 100 &&
      typeof item.soopId === 'string' && /^[A-Za-z0-9_-]{2,40}$/.test(item.soopId) &&
      typeof item.title === 'string' && item.title.length > 0 && item.title.length <= 200 &&
      typeof item.body === 'string' && item.body.length > 0 && item.body.length <= 10000 &&
      typeof item.html === 'string' && item.html.length > 0 && item.html.length <= 40000 &&
      typeof item.writeUrl === 'string' && isAllowedWriteUrl(item.writeUrl);
    if (!stringsValid) return { ok: false, reason: 'invalid-item', message: '대상 정보나 SOOP 글쓰기 링크가 유효하지 않습니다.' };
    const stationId = promoBatchItemStationId(item);
    if (!stationId || stationId !== item.soopId.toLowerCase()) {
      return { ok: false, reason: 'station-id-mismatch', message: 'SOOP 아이디와 글쓰기 주소의 방송국이 일치하지 않는 항목이 있습니다.' };
    }
    if (promoKeys.has(item.promoKey) || stationIds.has(stationId)) {
      return { ok: false, reason: 'duplicate-target', message: '중복된 홍보 대상이 포함되어 있습니다.' };
    }
    if (!item.title.includes(item.nickname.trim()) || !item.body.includes('neezu-crypto.github.io/streamer-life-game') ||
        !item.html.includes('neezu-crypto.github.io/streamer-life-game')) {
      return { ok: false, reason: 'unexpected-promo-content', message: '홍보글 제목 또는 게임 링크를 확인할 수 없습니다.' };
    }
    promoKeys.add(item.promoKey);
    stationIds.add(stationId);
    items.push({
      promoKey: item.promoKey,
      nickname: item.nickname.trim(),
      soopId: item.soopId,
      writeUrl: item.writeUrl,
      title: item.title,
      body: item.body,
      html: item.html,
    });
  }
  return { ok: true, items: items };
}

async function startPromoBatch(message, sender) {
  const saved = await chrome.storage.local.get(PROMO_BATCH_KEY);
  if (isActivePromoBatch(saved[PROMO_BATCH_KEY]) ||
      (saved[PROMO_BATCH_KEY] && saved[PROMO_BATCH_KEY].status === 'failed' && saved[PROMO_BATCH_KEY].publishDispatched === true)) {
    return { ok: false, reason: 'batch-already-active', message: '이미 자동 게시 작업이 진행 중입니다.', state: publicPromoBatchState(saved[PROMO_BATCH_KEY]) };
  }
  const repeatCount = Number(message.repeatCount);
  const delayMs = Number(message.delayMs);
  const testOnly = message.testOnly === true;
  const validated = validatePromoBatchItems(message.items, repeatCount, testOnly);
  if (!validated.ok) return validated;
  if (!Number.isInteger(delayMs) || delayMs < PROMO_BATCH_MIN_DELAY_MS || delayMs > PROMO_BATCH_MAX_DELAY_MS) {
    return { ok: false, reason: 'invalid-delay', message: '사이클 대기시간은 10초~10분으로 설정해주세요.' };
  }
  const currentStorage = await chrome.storage.local.get(null);
  const currentTime = Date.now();
  for (const item of validated.items) {
    const stationId = promoBatchItemStationId(item);
    const existing = Object.entries(currentStorage).find(([key, pending]) =>
      key.startsWith(PENDING_POST_PREFIX) && pending && pending.stationId === stationId &&
      currentTime - Number(pending.createdAt || 0) <= PROMO_PENDING_TTL_MS
    );
    if (existing) {
      return { ok: false, reason: 'existing-pending-post', message: item.nickname + ' 방송국에 미완료 게시 확인이 있어 자동 게시를 시작하지 않았습니다.' };
    }
  }
  await chrome.alarms.clear(PROMO_BATCH_NEXT_ALARM);
  await chrome.alarms.clear(PROMO_BATCH_TIMEOUT_ALARM);
  const state = {
    runId: 'promo-batch-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
    status: 'starting',
    adminTabId: sender.tab.id,
    items: validated.items,
    currentIndex: -1,
    nextIndex: 0,
    currentTabId: null,
    currentNickname: '',
    completedCount: 0,
    delayMs: delayMs,
    testOnly: testOnly,
    cancelRequested: false,
    publishDispatched: false,
    startedAt: currentTime,
    message: '',
  };
  await notifyPromoBatchState(state);
  if (testOnly) trace(state.runId, 'promo-batch-test-started', { itemCount: 1 });
  else trace(state.runId, 'promo-batch-started', { itemCount: validated.items.length, delayMs: delayMs });
  await launchPromoBatchItem(state.runId);
  const latest = await chrome.storage.local.get(PROMO_BATCH_KEY);
  const latestState = latest[PROMO_BATCH_KEY] || state;
  return { ok: true, state: publicPromoBatchState(latestState) };
}

async function launchPromoBatchItem(runId) {
  const saved = await chrome.storage.local.get(PROMO_BATCH_KEY);
  const state = saved[PROMO_BATCH_KEY];
  if (!state || state.runId !== runId || state.cancelRequested || !isActivePromoBatch(state)) return;
  if (state.nextIndex >= state.items.length) {
    state.status = 'complete';
    state.currentTabId = null;
    state.message = '';
    await notifyPromoBatchState(state);
    return;
  }
  const index = state.nextIndex;
  const item = state.items[index];
  const attemptId = runId + '-' + (index + 1);
  let tab = null;
  try {
    state.currentIndex = index;
    state.currentNickname = item.nickname;
    state.currentTabId = null;
    state.publishDispatched = false;
    state.status = 'preparing';
    state.message = '';
    await notifyPromoBatchState(state);
    // Prepare draft/storage before activating the writer tab. This removes the
    // focused about:blank gap where an immediate Esc could otherwise be lost.
    tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    let latestState = (await chrome.storage.local.get(PROMO_BATCH_KEY))[PROMO_BATCH_KEY];
    if (!latestState || latestState.runId !== runId || latestState.cancelRequested || !isActivePromoBatch(latestState)) {
      await chrome.tabs.remove(tab.id).catch(() => null);
      return;
    }
    const createdAt = Date.now();
    const draftKey = PENDING_KEY_PREFIX + tab.id;
    const pendingKey = PENDING_POST_PREFIX + tab.id;
    await chrome.storage.local.set({
      [draftKey]: {
        attemptId: attemptId,
        nickname: item.nickname,
        title: item.title,
        body: item.body,
        html: item.html,
        autoPublish: !state.testOnly,
        testOnly: state.testOnly,
        batchRunId: runId,
        batchIndex: index,
        createdAt: createdAt,
      },
      [pendingKey]: {
        attemptId: attemptId,
        adminTabId: state.adminTabId,
        promoKey: item.promoKey,
        soopId: item.soopId,
        stationId: promoBatchItemStationId(item),
        title: item.title,
        body: item.body,
        batchRunId: runId,
        batchIndex: index,
        createdAt: createdAt,
        lastAttemptAt: 0,
        completionRequested: false,
      },
    });
    latestState = (await chrome.storage.local.get(PROMO_BATCH_KEY))[PROMO_BATCH_KEY];
    if (!latestState || latestState.runId !== runId || latestState.cancelRequested || !isActivePromoBatch(latestState)) {
      await chrome.storage.local.remove([draftKey, pendingKey]);
      await chrome.tabs.remove(tab.id).catch(() => null);
      return;
    }
    latestState.currentIndex = index;
    latestState.currentNickname = item.nickname;
    latestState.currentTabId = tab.id;
    latestState.publishDispatched = false;
    latestState.status = 'preparing';
    latestState.message = '';
    await notifyPromoBatchState(latestState);
    latestState = (await chrome.storage.local.get(PROMO_BATCH_KEY))[PROMO_BATCH_KEY];
    if (!latestState || latestState.runId !== runId || latestState.cancelRequested || latestState.currentTabId !== tab.id) {
      await chrome.storage.local.remove([draftKey, pendingKey]);
      await chrome.tabs.remove(tab.id).catch(() => null);
      return;
    }
    trace(attemptId, 'promo-batch-write-tab-opening', { soopTabId: tab.id, batchIndex: index + 1 });
    await chrome.tabs.update(tab.id, { url: item.writeUrl, active: true });
    await chrome.alarms.create(PROMO_BATCH_TIMEOUT_ALARM, { when: Date.now() + 90000 });
  } catch (error) {
    if (tab && Number.isInteger(tab.id)) {
      chrome.storage.local.remove([PENDING_KEY_PREFIX + tab.id, PENDING_POST_PREFIX + tab.id]).catch(() => null);
    }
    const latest = await chrome.storage.local.get(PROMO_BATCH_KEY);
    const current = latest[PROMO_BATCH_KEY];
    if (current && current.runId === runId) {
      current.status = 'failed';
      current.currentTabId = null;
      current.message = 'SOOP 글쓰기 탭을 열지 못해 다음 게시를 중단했습니다.';
      await notifyPromoBatchState(current);
    }
    trace(attemptId, 'promo-batch-write-tab-open-failed', { error: String(error && error.message || error).slice(0, 120) });
  }
}

async function stopPromoBatch(reason) {
  const saved = await chrome.storage.local.get(PROMO_BATCH_KEY);
  const state = saved[PROMO_BATCH_KEY];
  if (!state || !isActivePromoBatch(state)) {
    return { ok: false, reason: 'batch-not-active', message: '진행 중인 자동 게시가 없습니다.', state: publicPromoBatchState(state) };
  }
  await chrome.alarms.clear(PROMO_BATCH_NEXT_ALARM);
  state.cancelRequested = true;
  if (state.publishDispatched) {
    state.status = 'stopping-after-current';
    state.message = '현재 게시 결과를 확인한 뒤 다음 사이클은 시작하지 않습니다.';
  } else {
    state.status = 'cancelled';
    state.message = '관리자 요청으로 중단했습니다.';
  }
  await notifyPromoBatchState(state);
  if (Number.isInteger(state.currentTabId)) {
    chrome.tabs.sendMessage(state.currentTabId, { type: 'cancelPromoBatchItem', runId: state.runId }).catch(() => null);
  }
  trace(state.runId, 'promo-batch-stop-requested', { afterCurrentPost: state.publishDispatched === true, reason: reason || 'manager-stop' });
  return { ok: true, state: publicPromoBatchState(state) };
}

async function withCurrentPromoBatch(runId, tabId) {
  const saved = await chrome.storage.local.get(PROMO_BATCH_KEY);
  const state = saved[PROMO_BATCH_KEY];
  if (!state || state.runId !== runId || !isActivePromoBatch(state) || state.currentTabId !== tabId) return null;
  return state;
}

async function advancePromoBatchAfterSuccess(pending, articleId) {
  if (!pending || !pending.batchRunId) return [];
  const saved = await chrome.storage.local.get(PROMO_BATCH_KEY);
  const state = saved[PROMO_BATCH_KEY];
  if (!state || state.runId !== pending.batchRunId || state.currentIndex !== pending.batchIndex) return [];
  const taskTabIds = Number.isInteger(state.currentTabId) ? [state.currentTabId] : [];
  await chrome.alarms.clear(PROMO_BATCH_TIMEOUT_ALARM);
  state.completedCount = (Number(state.completedCount) || 0) + 1;
  state.currentTabId = null;
  state.publishDispatched = false;
  state.cancelRequested = state.cancelRequested === true || state.status === 'stopping-after-current' || state.status === 'cancelled';
  trace(pending.attemptId, 'promo-batch-item-confirmed', { batchIndex: state.currentIndex + 1, articleId: String(articleId || '') });
  if (state.cancelRequested) {
    state.status = 'cancelled';
    state.message = '현재 게시를 확인했습니다. 이후 사이클은 중단했습니다.';
    await notifyPromoBatchState(state);
    return taskTabIds;
  }
  state.nextIndex = state.currentIndex + 1;
  if (state.nextIndex >= state.items.length) {
    state.status = 'complete';
    state.message = '';
    await notifyPromoBatchState(state);
    return taskTabIds;
  }
  state.status = 'waiting';
  state.message = '';
  await notifyPromoBatchState(state);
  await chrome.alarms.create(PROMO_BATCH_NEXT_ALARM, { when: Date.now() + state.delayMs });
  return taskTabIds;
}

async function failPromoBatchItem(runId, tabId, reason) {
  const state = await withCurrentPromoBatch(runId, tabId);
  if (!state) return { ok: false, reason: 'batch-item-not-current' };
  await chrome.alarms.clear(PROMO_BATCH_NEXT_ALARM);
  await chrome.alarms.clear(PROMO_BATCH_TIMEOUT_ALARM);
  state.status = 'failed';
  state.currentTabId = null;
  state.message = '게시를 안전하게 확인하지 못해 다음 대상으로 진행하지 않았습니다. (' + String(reason || 'unknown').slice(0, 80) + ')';
  state.cancelRequested = true;
  await notifyPromoBatchState(state);
  trace(runId, 'promo-batch-item-failed', { batchIndex: state.currentIndex + 1, reason: String(reason || 'unknown').slice(0, 80) });
  return { ok: true, state: publicPromoBatchState(state) };
}

async function handlePromoBatchWriterMessage(message, sender, sendResponse) {
  if (!isAllowedPromoWriterSender(sender) || !Number.isInteger(sender.tab && sender.tab.id)) {
    sendResponse({ ok: false, reason: 'writer-sender-rejected' });
    return true;
  }
  const runId = String(message.runId || '');
  if (message.type === 'getPromoBatchWriterState') {
    const saved = await chrome.storage.local.get(PROMO_BATCH_KEY);
    const state = saved[PROMO_BATCH_KEY];
    const currentItem = state && state.items && state.items[state.currentIndex];
    const senderStationId = promoWriterSenderStationId(sender);
    const sameCurrentStation = !!(currentItem && senderStationId && promoBatchItemStationId(currentItem) === senderStationId);
    const runMatches = !!(state && (!runId || state.runId === runId));
    sendResponse({
      ok: true,
      active: !!(runMatches && isActivePromoBatch(state) && (state.currentTabId === sender.tab.id || sameCurrentStation)),
      state: runMatches ? publicPromoBatchState(state) : { status: 'idle' },
    });
    return true;
  }
  if (message.type === 'cancelPromoBatchFromSoop') {
    const saved = await chrome.storage.local.get(PROMO_BATCH_KEY);
    const state = saved[PROMO_BATCH_KEY];
    const currentItem = state && state.items && state.items[state.currentIndex];
    const senderStationId = promoWriterSenderStationId(sender);
    const sameCurrentStation = !!(currentItem && senderStationId && promoBatchItemStationId(currentItem) === senderStationId);
    if (!state || (runId && state.runId !== runId) || !isActivePromoBatch(state) ||
        (state.currentTabId !== sender.tab.id && !sameCurrentStation)) {
      return sendResponse({ ok: false, reason: 'batch-item-not-current' }), true;
    }
    const result = await stopPromoBatch('escape-from-soop');
    sendResponse(result);
    return true;
  }
  if (message.type === 'promoBatchDraftReady') {
    const state = await withCurrentPromoBatch(runId, sender.tab.id);
    if (!state || state.cancelRequested) return sendResponse({ ok: false, reason: 'batch-cancelled' }), true;
    await chrome.alarms.clear(PROMO_BATCH_TIMEOUT_ALARM);
    state.status = 'countdown';
    state.message = '';
    await notifyPromoBatchState(state);
    sendResponse({ ok: true, state: publicPromoBatchState(state) });
    return true;
  }
  if (message.type === 'promoBatchTestReady') {
    const state = await withCurrentPromoBatch(runId, sender.tab.id);
    if (!state || !state.testOnly) return sendResponse({ ok: false, reason: 'test-mode-not-active' }), true;
    await chrome.alarms.clear(PROMO_BATCH_TIMEOUT_ALARM);
    await chrome.storage.local.remove(PENDING_POST_PREFIX + sender.tab.id);
    state.status = 'test-ready';
    state.currentTabId = null;
    state.message = '입력 테스트가 끝났으며 게시하지 않았습니다.';
    await notifyPromoBatchState(state);
    trace(runId, 'promo-batch-test-ready', { batchIndex: state.currentIndex + 1 });
    sendResponse({ ok: true, state: publicPromoBatchState(state) });
    return true;
  }
  if (message.type === 'authorizePromoBatchPublish') {
    const state = await withCurrentPromoBatch(runId, sender.tab.id);
    if (!state || state.cancelRequested || state.testOnly || state.status !== 'countdown') {
      sendResponse({ ok: false, reason: 'batch-not-authorized' });
      return true;
    }
    state.status = 'publishing';
    state.publishDispatched = false;
    await notifyPromoBatchState(state);
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'promoBatchPublishDispatched') {
    const state = await withCurrentPromoBatch(runId, sender.tab.id);
    if (!state || state.status !== 'publishing' || state.cancelRequested) return sendResponse({ ok: false, reason: 'batch-item-not-publishing' }), true;
    state.publishDispatched = true;
    state.status = 'verifying';
    await notifyPromoBatchState(state);
    await chrome.alarms.create(PROMO_BATCH_TIMEOUT_ALARM, { when: Date.now() + PROMO_BATCH_PUBLISH_TIMEOUT_MS });
    trace(runId, 'promo-batch-publish-dispatched', { batchIndex: state.currentIndex + 1 });
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'promoBatchItemFailed') {
    const result = await failPromoBatchItem(runId, sender.tab.id, String(message.reason || 'unknown'));
    sendResponse(result);
    return true;
  }
  return false;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'promoBatchControl') {
    if (!isAllowedAdminSender(sender)) return false;
    const action = String(message.action || '');
    if (action === 'status') {
      chrome.storage.local.get(PROMO_BATCH_KEY).then((saved) => {
        sendResponse({ ok: true, state: publicPromoBatchState(saved[PROMO_BATCH_KEY] || null) });
      }).catch((error) => sendResponse({ ok: false, reason: String(error && error.message || error) }));
      return true;
    }
    if (action === 'stop') {
      stopPromoBatch('manager-stop').then(sendResponse).catch((error) => sendResponse({ ok: false, reason: String(error && error.message || error) }));
      return true;
    }
    if (action === 'start') {
      startPromoBatch(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, reason: 'start-failed', message: String(error && error.message || error).slice(0, 120) }));
      return true;
    }
    sendResponse({ ok: false, reason: 'unknown-action', message: '지원하지 않는 자동 게시 요청입니다.' });
    return false;
  }

  if (['getPromoBatchWriterState', 'cancelPromoBatchFromSoop', 'promoBatchDraftReady', 'promoBatchTestReady', 'authorizePromoBatchPublish', 'promoBatchPublishDispatched', 'promoBatchItemFailed'].includes(message.type)) {
    handlePromoBatchWriterMessage(message, sender, sendResponse).catch((error) => {
      sendResponse({ ok: false, reason: String(error && error.message || error).slice(0, 100) });
    });
    return true;
  }

  if (message.type === 'startOnyuGiftBackgroundMonitor') {
    if (!isAllowedAdminSender(sender)) return false;
    startOnyuGiftBackgroundMonitor(message.customToken, message.adminUid, sender.tab && sender.tab.id)
      .then(sendResponse)
      .catch((error) => {
        logOnyuGiftBackground('session-start-failed', { error: String(error && error.message || error).slice(0, 120) });
        sendResponse({ ok: false, reason: String(error && error.message || 'monitor-start-failed').slice(0, 100) });
      });
    return true;
  }

  if (message.type === 'stopOnyuGiftBackgroundMonitor') {
    if (!isAllowedAdminSender(sender)) return false;
    stopOnyuGiftBackgroundMonitor(true)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, reason: String(error && error.message || 'monitor-stop-failed').slice(0, 100) }));
    return true;
  }

  if (message.type === 'watchOnyuGameGiftNotifications') {
    if (!isAllowedAdminSender(sender)) return false;
    const active = message.active === true;
    const expiresAt = active
      ? Math.max(Date.now(), Math.min(Number(message.expiresAt) || 0, Date.now() + 3 * 60 * 1000))
      : 0;
    const updateTabs = () => chrome.tabs.query({ url: ['https://sooplive.com/*', 'https://www.sooplive.com/*'] })
      .then((tabs) => {
        const validTabs = tabs.filter((tab) => Number.isInteger(tab.id));
        const selected = active ? validTabs.find((tab) => tab.active) || validTabs[0] : null;
        const watch = active && selected ? { active: true, expiresAt, tabId: selected.id } : null;
        const saved = watch ? chrome.storage.local.set({ [ONYU_GIFT_WATCH_KEY]: watch }) : chrome.storage.local.remove(ONYU_GIFT_WATCH_KEY);
        return saved.then(() => {
          return Promise.all(validTabs.map((tab) => chrome.tabs.sendMessage(tab.id, {
            type: 'setOnyuGameGiftNotificationWatch',
            active: !!(watch && tab.id === selected.id),
            expiresAt: watch && tab.id === selected.id ? expiresAt : 0,
            tabId: watch && tab.id === selected.id ? selected.id : null,
          }).catch(() => null))).then(() => ({ tabs: validTabs, selected }));
        });
      });
    updateTabs().then((result) => {
      const selectedTabId = result.selected && result.selected.id;
      trace('', 'onyu-gift-notification-watch-updated', { active: !!selectedTabId, soopTabCount: result.tabs.length, selectedTabId: selectedTabId || null, expiresAt: selectedTabId ? expiresAt : 0 });
      sendResponse({ ok: true, soopTabCount: selectedTabId ? 1 : 0 });
    }).catch((error) => {
      trace('', 'onyu-gift-notification-watch-update-failed', { error: String(error && error.message || error).slice(0, 120) });
      sendResponse({ ok: false, reason: 'soop-tab-search-failed' });
    });
    return true;
  }

  if (message.type === 'getOnyuGameGiftNotificationWatch') {
    chrome.storage.local.get(ONYU_GIFT_WATCH_KEY).then((state) => {
      const watch = state[ONYU_GIFT_WATCH_KEY] || {};
      const active = watch.active === true && Number(watch.expiresAt) > Date.now() &&
        Number.isInteger(sender.tab && sender.tab.id) && Number.isInteger(watch.tabId) && sender.tab.id === watch.tabId;
      sendResponse({ ok: true, active, expiresAt: active ? Number(watch.expiresAt) : 0, tabId: active ? sender.tab.id : null });
    }).catch(() => sendResponse({ ok: false, active: false }));
    return true;
  }

  if (message.type === 'confirmOnyuGameGiftNotification') {
    let sourceUrl;
    try { sourceUrl = new URL(sender.url || (sender.tab && sender.tab.url) || ''); } catch (_) { sourceUrl = null; }
    const senderSoopId = String(message.senderSoopId || '').trim().toLowerCase();
    const balloons = Number(message.balloons);
    const observedAt = Number(message.observedAt);
    const eventAtMin = Number(message.eventAtMin);
    const eventAtMax = Number(message.eventAtMax);
    const candidateFingerprint = String(message.candidateFingerprint || '').toLowerCase();
    const isSoopSender = Number.isInteger(sender.tab && sender.tab.id) && sourceUrl &&
      sourceUrl.protocol === 'https:' && ['sooplive.com', 'www.sooplive.com'].includes(sourceUrl.hostname);
    if (!isSoopSender || !/^[a-z0-9]{2,20}$/.test(senderSoopId) || balloons !== 50 ||
        !Number.isFinite(observedAt) || !Number.isFinite(eventAtMin) || !Number.isFinite(eventAtMax) ||
        !/^[a-f0-9]{32,64}$/.test(candidateFingerprint)) {
      sendResponse({ ok: false, reason: 'invalid-notification-candidate' });
      return false;
    }
    confirmOnyuGiftNotificationInBackground({
      senderSoopId, balloons, observedAt, eventAtMin, eventAtMax,
      exactTimestamp: message.exactTimestamp === true, candidateFingerprint,
    }).then(sendResponse).catch((error) => {
      logOnyuGiftBackground('confirmation-failed', { error: String(error && error.message || error).slice(0, 120) });
      sendResponse({ ok: false, reason: 'background-confirmation-failed' });
    });
    return true;
  }

  if (message.type === 'watchStreamerVerificationInbox') {
    if (!isAllowedAdminSender(sender)) return false;
    const active = message.active === true;
    const expiresAt = Math.max(Date.now(), Math.min(Number(message.expiresAt) || 0, Date.now() + 20 * 60 * 1000));
    chrome.tabs.query({ url: ['https://note.sooplive.com/app/*'] }).then((tabs) => {
      const inboxTabs = tabs.filter((tab) => {
        try { return new URL(tab.url || '').searchParams.get('page') === 'recv_list'; } catch (_) { return false; }
      });
      return Promise.all(inboxTabs.map((tab) => chrome.tabs.sendMessage(tab.id, {
        type: 'setStreamerVerificationInboxWatch', active: active, expiresAt: active ? expiresAt : 0,
      }).catch(() => null))).then(() => {
        trace('', 'verification-inbox-watch-updated', { active: active, inboxTabCount: inboxTabs.length, expiresAt: active ? expiresAt : 0 });
        sendResponse({ ok: true, inboxTabCount: inboxTabs.length });
      });
    }).catch((error) => {
      trace('', 'verification-inbox-watch-update-failed', { error: String(error && error.message || error).slice(0, 120) });
      sendResponse({ ok: false, reason: 'inbox-tab-search-failed' });
    });
    return true;
  }

  if (message.type === 'confirmStreamerVerificationNoteFromInbox') {
    let sourceUrl;
    try { sourceUrl = new URL(sender.url || (sender.tab && sender.tab.url) || ''); } catch (_) { sourceUrl = null; }
    const senderId = String(message.senderId || '').trim().toLowerCase();
    const code = String(message.code || '').trim().toUpperCase();
    const noteNo = String(message.noteNo || '').trim();
    const isInboxSender = Number.isInteger(sender.tab && sender.tab.id) && sourceUrl &&
      sourceUrl.protocol === 'https:' && sourceUrl.hostname === 'note.sooplive.com' &&
      sourceUrl.pathname === '/app/index.php' && sourceUrl.searchParams.get('page') === 'recv_list';
    if (!isInboxSender || !/^[a-z0-9]{2,20}$/.test(senderId) ||
        !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code) || !/^\d{1,20}$/.test(noteNo)) {
      sendResponse({ ok: false, reason: 'invalid-note-candidate' });
      return false;
    }
    findAdminTab().then((adminTab) => {
      if (!adminTab) {
        sendResponse({ ok: false, reason: 'admin-center-not-open' });
        return;
      }
      chrome.tabs.sendMessage(adminTab.id, {
        type: 'confirmStreamerVerificationNote', senderId: senderId, code: code, noteNo: noteNo,
      }).then(sendResponse).catch((error) => {
        sendResponse({ ok: false, reason: 'admin-bridge-unavailable', message: String(error && error.message || error) });
      });
    }).catch((error) => sendResponse({ ok: false, reason: 'admin-tab-search-failed', message: String(error && error.message || error) }));
    return true;
  }

  if (message.type === 'openUnconfirmedStationInNewTab') {
    let sourceUrl;
    try { sourceUrl = new URL(sender.url || (sender.tab && sender.tab.url) || ''); } catch (_) { sourceUrl = null; }
    const stationId = typeof message.stationId === 'string' ? message.stationId.trim() : '';
    const isSoopSender = Number.isInteger(sender.tab && sender.tab.id) && sourceUrl && sourceUrl.protocol === 'https:' &&
      ['sooplive.com', 'www.sooplive.com'].includes(sourceUrl.hostname);
    if (!isSoopSender || !/^[A-Za-z0-9_-]{2,40}$/.test(stationId)) {
      sendResponse({ ok: false, reason: 'invalid-request' });
      return false;
    }
    const url = 'https://www.sooplive.com/station/' + encodeURIComponent(stationId);
    chrome.tabs.create({ url: url, active: true }).then((tab) => {
      console.info('[SOOP 홍보 단축키 진단]', JSON.stringify({
        version: '0.9.26', stage: 'shortcut-station-tab-created', at: new Date().toISOString(),
        details: { stationId: stationId, tabId: tab && tab.id },
      }));
      sendResponse({ ok: true, tabId: tab && tab.id });
    }).catch((error) => {
      console.info('[SOOP 홍보 단축키 진단]', JSON.stringify({
        version: '0.9.26', stage: 'shortcut-station-tab-failed', at: new Date().toISOString(),
        details: { stationId: stationId, error: String(error && error.message || error).slice(0, 120) },
      }));
      sendResponse({ ok: false, reason: 'tab-create-failed' });
    });
    return true;
  }

  if (message.type === 'promoShortcutDiagnostic') {
    let sourceUrl;
    try { sourceUrl = new URL(sender.url || (sender.tab && sender.tab.url) || ''); } catch (_) { sourceUrl = null; }
    const allowedStages = new Set([
      'listener-ready', 'modified-space-keydown', 'shortcut-accepted',
      'shortcut-candidate-found', 'shortcut-no-candidate', 'browser-command-received',
      'shortcut-station-open-requested',
    ]);
    const payload = message.diagnostic && typeof message.diagnostic === 'object' ? message.diagnostic : {};
    const isSoopSender = Number.isInteger(sender.tab && sender.tab.id) && sourceUrl && sourceUrl.protocol === 'https:' &&
      ['sooplive.com', 'www.sooplive.com'].includes(sourceUrl.hostname);
    if (!isSoopSender || !allowedStages.has(payload.stage)) return false;
    const details = {};
    for (const key of ['code', 'key', 'targetTag']) {
      if (typeof payload[key] === 'string') details[key] = payload[key].slice(0, 32);
    }
    if (typeof payload.stationId === 'string' && /^[A-Za-z0-9_-]{2,40}$/.test(payload.stationId)) details.stationId = payload.stationId;
    for (const key of ['keyCode', 'count', 'index', 'records']) {
      if (Number.isFinite(payload[key])) details[key] = Math.max(0, Math.min(10000, Math.trunc(payload[key])));
    }
    for (const key of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'isTrusted']) {
      if (typeof payload[key] === 'boolean') details[key] = payload[key];
    }
    console.info('[SOOP 홍보 단축키 진단]', JSON.stringify({
      version: typeof payload.version === 'string' ? payload.version.slice(0, 16) : 'unknown',
      stage: payload.stage,
      at: new Date().toISOString(),
      details,
    }));
    return false;
  }

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

  if (message.type === 'setStreamerPromoExclusion') {
    let sourceUrl;
    try { sourceUrl = new URL(sender.url || ''); } catch (_) { sourceUrl = null; }
    const soopId = typeof message.stationId === 'string' ? message.stationId.trim() : '';
    const nickname = typeof message.nickname === 'string' ? message.nickname.trim() : '';
    const excluded = message.excluded === true;
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const validSender = Number.isInteger(sender.tab && sender.tab.id) && sourceUrl && sourceUrl.protocol === 'https:' &&
      (sourceUrl.hostname === 'sooplive.com' || sourceUrl.hostname === 'www.sooplive.com') &&
      message.lookupContext === 'profile-hover';
    if (!validSender || !/^[A-Za-z0-9]{2,20}$/.test(soopId) || !nickname || nickname.length > 100 ||
        typeof message.excluded !== 'boolean' || !requestId || requestId.length > 120) {
      trace(requestId, 'promo-exclusion-rejected', { validSender: !!validSender, soopIdValid: /^[A-Za-z0-9]{2,20}$/.test(soopId), nicknameLength: nickname.length });
      sendResponse({ ok: false, reason: 'invalid-request', message: '스트리머 정보를 확인할 수 없습니다.' });
      return false;
    }
    findAdminTab().then((adminTab) => {
      if (!adminTab) {
        trace(requestId, 'promo-exclusion-unavailable', { reason: 'admin-center-not-open', soopId: soopId });
        sendResponse({ ok: false, reason: 'admin-center-not-open', message: '관리자 센터를 열고 로그인한 뒤 다시 시도해주세요.' });
        return;
      }
      trace(requestId, 'promo-exclusion-forwarded', { soopId: soopId, excluded: excluded, adminTabId: adminTab.id });
      chrome.tabs.sendMessage(adminTab.id, {
        type: 'setStreamerPromoExclusion',
        requestId: requestId,
        nickname: nickname,
        soopId: soopId,
        excluded: excluded,
      }).then(sendResponse).catch((error) => {
        trace(requestId, 'promo-exclusion-failed', { reason: 'admin-bridge-unavailable', error: String(error && error.message || error) });
        sendResponse({ ok: false, reason: 'admin-bridge-unavailable', message: '관리자 센터를 새로고침한 뒤 다시 시도해주세요.' });
      });
    }).catch((error) => {
      trace(requestId, 'promo-exclusion-failed', { reason: 'admin-tab-search-failed', error: String(error && error.message || error) });
      sendResponse({ ok: false, reason: 'admin-tab-search-failed', message: '관리자 센터 연결을 확인해주세요.' });
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

    chrome.storage.local.get(PROMO_BATCH_KEY).then((batchSaved) => {
      if (isActivePromoBatch(batchSaved[PROMO_BATCH_KEY])) {
        sendResponse({ ok: false, error: '자동 게시 사이클이 진행 중입니다. 완료되거나 중단된 뒤 다시 시도해주세요.' });
        return null;
      }
      return chrome.tabs.create({ url: 'about:blank', active: true }).then(async (tab) => {
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
    }).catch((error) => {
      trace(attemptId, 'promo-batch-state-check-failed', { error: String(error && error.message || error).slice(0, 100) });
      sendResponse({ ok: false, error: '홍보 자동화 상태를 확인하지 못했습니다.' });
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
      if (!draft) {
        const batchSaved = await chrome.storage.local.get(PROMO_BATCH_KEY);
        const batch = batchSaved[PROMO_BATCH_KEY];
        if (batch && batch.currentTabId === tabId && isActivePromoBatch(batch)) {
          await failPromoBatchItem(batch.runId, tabId, 'draft-missing');
        }
      }
      if (draft && draft.batchRunId) {
        const batchState = await chrome.storage.local.get(PROMO_BATCH_KEY);
        const batch = batchState[PROMO_BATCH_KEY];
        if (!batch || batch.runId !== draft.batchRunId || batch.cancelRequested) {
          await chrome.storage.local.remove(key);
          sendResponse({ ok: false, error: '자동 게시가 이미 중단되어 입력을 시작하지 않았습니다.' });
          return;
        }
      }
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
    confirmPromoPost(message, sender).then((result) => {
      const closeTabIds = Array.isArray(result && result.closeTabIds) ? result.closeTabIds : [];
      if (result && Object.prototype.hasOwnProperty.call(result, 'closeTabIds')) delete result.closeTabIds;
      sendResponse(result);
      if (closeTabIds.length) {
        // Let the content script receive the successful confirmation before its tab closes.
        setTimeout(() => {
          Promise.all(closeTabIds.map((tabId) => chrome.tabs.remove(tabId).catch(() => null)))
            .then(() => trace(message.attemptId, 'promo-batch-success-tabs-closed', { tabIds: closeTabIds }));
        }, 300);
      }
    }).catch((error) => {
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
  onyuGiftWatchTabQueue = onyuGiftWatchTabQueue.then(async () => {
    const state = await chrome.storage.local.get(ONYU_GIFT_WATCH_KEY);
    const watch = state[ONYU_GIFT_WATCH_KEY] || {};
    if (!watch.active || Number(watch.expiresAt) <= Date.now() || watch.tabId !== tabId) return;
    const tabs = await chrome.tabs.query({ url: ['https://sooplive.com/*', 'https://www.sooplive.com/*'] });
    const next = tabs.find((tab) => Number.isInteger(tab.id)) || null;
    const nextWatch = Object.assign({}, watch, { tabId: next ? next.id : null });
    await chrome.storage.local.set({ [ONYU_GIFT_WATCH_KEY]: nextWatch });
    await Promise.all(tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => chrome.tabs.sendMessage(tab.id, {
      type: 'setOnyuGameGiftNotificationWatch',
      active: !!(next && next.id === tab.id),
      expiresAt: next && next.id === tab.id ? Number(watch.expiresAt) : 0,
      tabId: next && next.id === tab.id ? next.id : null,
    }).catch(() => null)));
  }).catch((error) => logOnyuGiftBackground('tab-reassign-failed', { error: String(error && error.message || error).slice(0, 100) }));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  let url;
  try { url = new URL(tab && tab.url || ''); } catch (_) { return; }
  if (changeInfo.status !== 'complete' || url.protocol !== 'https:' || !['sooplive.com', 'www.sooplive.com'].includes(url.hostname)) return;
  onyuGiftWatchTabQueue = onyuGiftWatchTabQueue.then(async () => {
    const state = await chrome.storage.local.get(ONYU_GIFT_WATCH_KEY);
    const watch = state[ONYU_GIFT_WATCH_KEY] || {};
    if (!watch.active || Number(watch.expiresAt) <= Date.now() || Number.isInteger(watch.tabId)) return;
    const nextWatch = Object.assign({}, watch, { tabId });
    await chrome.storage.local.set({ [ONYU_GIFT_WATCH_KEY]: nextWatch });
    await chrome.tabs.sendMessage(tabId, {
      type: 'setOnyuGameGiftNotificationWatch', active: true,
      expiresAt: Number(watch.expiresAt), tabId,
    }).catch(() => null);
    logOnyuGiftBackground('soop-tab-attached', { tabId });
  }).catch((error) => logOnyuGiftBackground('tab-attach-failed', { error: String(error && error.message || error).slice(0, 100) }));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm) return;
  if (alarm.name === PROMO_BATCH_NEXT_ALARM) {
    chrome.storage.local.get(PROMO_BATCH_KEY).then((saved) => {
      const state = saved[PROMO_BATCH_KEY];
      if (!state || state.status !== 'waiting' || state.cancelRequested) return;
      launchPromoBatchItem(state.runId).catch((error) => trace(state.runId, 'promo-batch-next-cycle-failed', { error: String(error && error.message || error).slice(0, 100) }));
    }).catch((error) => trace('', 'promo-batch-next-cycle-read-failed', { error: String(error && error.message || error).slice(0, 100) }));
    return;
  }
  if (alarm.name === PROMO_BATCH_TIMEOUT_ALARM) {
    chrome.storage.local.get(PROMO_BATCH_KEY).then(async (saved) => {
      const state = saved[PROMO_BATCH_KEY];
      if (!state || !isActivePromoBatch(state)) return;
      state.status = 'failed';
      state.cancelRequested = true;
      state.message = state.publishDispatched
        ? '게시 요청 뒤 2분 동안 실제 게시글을 확인하지 못해 다음 대상을 중단했습니다.'
        : '글쓰기 화면 준비에 90초 넘게 걸려 다음 대상을 중단했습니다.';
      state.currentTabId = null;
      await notifyPromoBatchState(state);
      trace(state.runId, state.publishDispatched ? 'promo-batch-publish-confirmation-timeout' : 'promo-batch-editor-timeout', { batchIndex: state.currentIndex + 1 });
    }).catch((error) => trace('', 'promo-batch-timeout-read-failed', { error: String(error && error.message || error).slice(0, 100) }));
    return;
  }
  if (alarm.name === ONYU_GIFT_MONITOR_ALARM && !onyuGiftFeedConnected && !onyuGiftFeedConnecting) runOnyuGiftBackgroundFeed();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.remove(ONYU_GIFT_WATCH_KEY).catch(() => null);
  chrome.alarms.clear(PROMO_BATCH_NEXT_ALARM).catch(() => null);
  chrome.alarms.clear(PROMO_BATCH_TIMEOUT_ALARM).catch(() => null);
  chrome.storage.local.get(null).then((allData) => {
    const batch = allData[PROMO_BATCH_KEY];
    if (batch && isActivePromoBatch(batch)) {
      batch.status = 'cancelled';
      batch.cancelRequested = true;
      batch.currentTabId = null;
      batch.message = '브라우저가 재시작되어 안전을 위해 자동 게시를 중단했습니다.';
      allData[PROMO_BATCH_KEY] = batch;
    }
    const sessionKeys = Object.keys(allData).filter((key) =>
      key.startsWith(PENDING_KEY_PREFIX) || key.startsWith(PENDING_POST_PREFIX));
    const batchSave = batch ? chrome.storage.local.set({ [PROMO_BATCH_KEY]: batch }) : Promise.resolve();
    if (sessionKeys.length) {
      const pendingPostKeys = sessionKeys.filter((key) => key.startsWith(PENDING_POST_PREFIX));
      trace('', 'unclosed-promo-state-cleared-on-browser-startup', {
        draftCount: sessionKeys.length - pendingPostKeys.length,
        pendingPostCount: pendingPostKeys.length,
        attemptIds: pendingPostKeys.map((key) => allData[key] && allData[key].attemptId || '').filter(Boolean),
      });
      return batchSave.then(() => chrome.storage.local.remove(sessionKeys));
    }
    trace('', 'browser-startup-no-pending-promo-state', {});
    return batchSave;
  }).catch((error) => console.warn('이전 브라우저 세션의 홍보 데이터 정리 실패:', error));
});

chrome.runtime.onInstalled.addListener(() => {
  // storage.session is cleared when the extension is reloaded or the browser restarts.
  // Remove an orphaned DOM-scanner watch so it cannot outlive its monitor credentials.
  onyuGiftMonitorSession().then((session) => {
    if (session) runOnyuGiftBackgroundFeed();
    else chrome.storage.local.remove(ONYU_GIFT_WATCH_KEY).catch(() => null);
  }).catch(() => null);
  chrome.storage.local.get(PROMO_BATCH_KEY).then(async (saved) => {
    const state = saved[PROMO_BATCH_KEY];
    if (!state || !isActivePromoBatch(state)) return;
    await chrome.alarms.clear(PROMO_BATCH_TIMEOUT_ALARM);
    await chrome.alarms.clear(PROMO_BATCH_NEXT_ALARM);
    await chrome.alarms.clear(PROMO_BATCH_TIMEOUT_ALARM);
    state.status = 'cancelled';
    state.cancelRequested = true;
    state.currentTabId = null;
    state.message = '확장 프로그램이 갱신되어 자동 게시를 안전하게 중단했습니다.';
    await notifyPromoBatchState(state);
  }).catch(() => null);
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
  const pendingUpdates = {};
  let waitingForStableContent = false;
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
      const sameArticle = pending.contentMatchArticleId === match[2];
      const matchedSince = sameArticle ? Number(pending.contentMatchSince || 0) : 0;
      if (matchedSince && now - matchedSince >= CONTENT_CONFIRMATION_STABILITY_MS) {
        confirmed.push({ key, pending });
      } else {
        pending.contentMatchArticleId = match[2];
        pending.contentMatchSince = matchedSince || now;
        pendingUpdates[key] = pending;
        waitingForStableContent = true;
      }
    } else if (pending.contentMatchArticleId || pending.contentMatchSince) {
      delete pending.contentMatchArticleId;
      delete pending.contentMatchSince;
      pendingUpdates[key] = pending;
    }
  });
  if (Object.keys(pendingUpdates).length) await chrome.storage.local.set(pendingUpdates);
  if (expiredKeys.length) await chrome.storage.local.remove(expiredKeys);
  if (expiredKeys.length) {
    trace('', 'expired-promo-state-cleared', { expiredCount: expiredKeys.length });
  }
  if (!confirmed.length) {
    const reason = waitingForStableContent
      ? 'content-confirmation-pending'
      : (sameStation.length ? 'post-content-not-confirmed' : 'no-pending-promo');
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
    const taskTabIds = await advancePromoBatchAfterSuccess(pending, match[2]);
    const closeTabIds = pending.batchRunId ? taskTabIds.slice() : [];
    if (pending.batchRunId && sender.tab &&
        (taskTabIds.includes(tabId) || taskTabIds.includes(sender.tab.openerTabId))) {
      closeTabIds.push(tabId);
    }
    const uniqueCloseTabIds = Array.from(new Set(closeTabIds));
    return { ok: true, completed: true, articleId: match[2], attemptId: pending.attemptId || '', closeTabIds: uniqueCloseTabIds };
  } catch (error) {
    pending.completionRequested = false;
    await chrome.storage.local.set({ [pendingKey]: pending });
    trace(pending.attemptId, 'admin-completion-message-error', { error: String(error && error.message || error) });
    console.error('관리 센터 홍보 완료 저장 실패:', error);
    return { ok: false, reason: 'admin-save-failed', attemptId: pending.attemptId || '' };
  }
}
