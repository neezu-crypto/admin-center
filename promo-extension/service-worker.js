const ADMIN_PAGE_PREFIX = 'https://neezu-crypto.github.io/admin-center/';
const PENDING_KEY_PREFIX = 'soopPromoDraft:';
const PENDING_POST_PREFIX = 'soopPromoPendingPost:';
const SOOP_WRITE_PATH = /^\/station\/[A-Za-z0-9]+\/post\/write\/\d+\/?$/;
const SOOP_POST_PATH = /^\/station\/([A-Za-z0-9]+)\/post\/(\d+)\/?$/;
const PROMO_PENDING_TTL_MS = 2 * 60 * 60 * 1000;
const COMPLETION_RETRY_MS = 5000;
const CONTENT_CONFIRMATION_STABILITY_MS = 500;
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

async function exchangeOnyuGiftMonitorCustomToken(customToken, adminUid) {
  const response = await fetch(ONYU_GIFT_MONITOR_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.idToken || !result.refreshToken || !result.localId) {
    throw new Error('monitor-token-exchange-failed-' + response.status);
  }
  const session = {
    monitorUid: String(result.localId),
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
        logOnyuGiftBackground('feed-auth-rejected', { status: response.status });
        reportOnyuGiftMonitorStatus('failed', 'feed-auth-rejected');
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

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
  if (!alarm || alarm.name !== ONYU_GIFT_MONITOR_ALARM || onyuGiftFeedConnected || onyuGiftFeedConnecting) return;
  runOnyuGiftBackgroundFeed();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.remove(ONYU_GIFT_WATCH_KEY).catch(() => null);
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

chrome.runtime.onInstalled.addListener(() => {
  // storage.session is cleared when the extension is reloaded or the browser restarts.
  // Remove an orphaned DOM-scanner watch so it cannot outlive its monitor credentials.
  onyuGiftMonitorSession().then((session) => {
    if (session) runOnyuGiftBackgroundFeed();
    else chrome.storage.local.remove(ONYU_GIFT_WATCH_KEY).catch(() => null);
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
    return { ok: true, completed: true, articleId: match[2], attemptId: pending.attemptId || '' };
  } catch (error) {
    pending.completionRequested = false;
    await chrome.storage.local.set({ [pendingKey]: pending });
    trace(pending.attemptId, 'admin-completion-message-error', { error: String(error && error.message || error) });
    console.error('관리 센터 홍보 완료 저장 실패:', error);
    return { ok: false, reason: 'admin-save-failed', attemptId: pending.attemptId || '' };
  }
}
