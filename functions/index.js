const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onValueCreated, onValueUpdated, onValueWritten } = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabase } = require('firebase-admin/database');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const { ServerValue } = require('firebase-admin/database');
const {
  fanPageViewerSubscriptionDonationCanMatch,
  fanPageViewerSubscriptionHasEligibleBackgroundRequest,
  fanPageSponsorAdDonationCanMatch,
  describeFanPageSponsorDonationCandidate,
  fanPageSponsorAdHasEligibleBackgroundRequest,
  lifeGameSponsorHasEligibleBackgroundRequest,
  notificationFallsInDonationRequestWindow,
} = require('./donation-verification');

initializeApp();

// 07번 — 주식시장·배팅시장과 같은 관리자 이메일. uid 위변조 검증 원칙(그 두 저장소와 동일):
// 대상 uid는 항상 request.auth.uid에서만 가져오고, 클라이언트가 보낸 값은 신뢰하지 않는다.
//
// 09번 마이그레이션 — 관리자 판별을 이메일 문자열 비교에서 adminCenter/adminUids
// uid 조회로 옮긴다. 다만 한 번에 완전히 스위치를 끊지 않고(그러면 아직 uid가
// 안 등록된 상태에서 실수로 배포될 경우 관리자 본인이 잠길 위험이 있다),
// uid 등록을 우선 확인하고 없으면 기존 이메일 비교로 폴백한다. 폴백이 실제로
// 쓰이면 로그를 남겨, 이후 이 폴백을 완전히 제거해도 안전한 시점을 판단한다.
const ADMIN_EMAIL = 'skftodwocks2@gmail.com'; // 폴백 전용으로만 유지 — 새 코드에서 직접 비교하지 말 것

// 공개 홍보 링크 페이지의 정적 파일은 복사되어도 서버에서 현재 허용한 버전만
// 기능을 사용할 수 있게 버전 게이트를 둔다. 이 공개 callable은 읽기 전용이며,
// 허용 버전은 관리자가 새 버전을 방송국에 게시한 뒤 RTDB에서 갱신한다.
const getPublicPromoPageVersion = onCall(async (request) => {
  const requestedVersion = String((request.data || {}).version || '');
  if (!/^[a-f0-9]{32}$/.test(requestedVersion)) {
    throw new HttpsError('invalid-argument', '페이지 버전 정보가 올바르지 않습니다.');
  }
  const current = (await getDatabase().ref('adminCenter/publicPromoPage/currentVersion').get()).val();
  const activeVersion = typeof current === 'string' ? current : String((current || {}).version || '');
  const updateUrl = typeof current === 'object' && current && typeof current.postUrl === 'string'
    ? current.postUrl
    : 'https://www.sooplive.com/station/skftodwocks2/board/128562829';
  return { active: activeVersion === requestedVersion, updateUrl };
});

const PUBLIC_PROMO_DIRECTORY_PAGE_SIZE = 30;
const PUBLIC_PROMO_DIRECTORY_ORIGIN = 'https://neezu-crypto.github.io';
const PUBLIC_PROMO_ANALYTICS_EVENTS = new Set(['view', 'search', 'click', 'sponsorImpression', 'sponsorClick']);
const PUBLIC_PROMO_RATE_LIMITS = Object.freeze({ analytics: 600, directory: 120, resolve: 300 });

function getKoreaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(date);
}

async function incrementPromoAnalytics(ref) {
  await ref.transaction((value) => (Number(value) || 0) + 1, undefined, false);
}

// 공개 페이지 이벤트는 집계값만 보관한다. 검색어·계정 ID·IP 원문은 기록하지 않고,
// 스트리머별 클릭은 key의 SHA-256 해시로만 묶는다.
const recordPublicPromoEvent = onRequest(async (request, response) => {
  response.set('Cache-Control', 'no-store');
  response.set('Vary', 'Origin');
  const origin = String(request.get('Origin') || '');
  if (origin !== PUBLIC_PROMO_DIRECTORY_ORIGIN) {
    response.status(403).json({ message: '허용된 페이지에서만 요청할 수 있습니다.' });
    return;
  }
  response.set('Access-Control-Allow-Origin', PUBLIC_PROMO_DIRECTORY_ORIGIN);
  if (request.method === 'OPTIONS') {
    response.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.set('Access-Control-Allow-Headers', 'Content-Type');
    response.status(204).send('');
    return;
  }
  if (request.method !== 'POST') {
    response.status(405).json({ message: 'POST 요청만 허용됩니다.' });
    return;
  }
  try {
    let body = request.body;
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if ((body === undefined || body === null || body === '') && request.rawBody) body = request.rawBody.toString('utf8');
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    if (!body || typeof body !== 'object') body = {};
    const version = String(body.version || '');
    const eventName = String(body.event || '');
    const entryKey = String(body.key || '');
    if (!/^[a-f0-9]{32}$/.test(version) || !PUBLIC_PROMO_ANALYTICS_EVENTS.has(eventName)) {
      response.status(400).json({ message: '이벤트 정보가 올바르지 않습니다.' });
      return;
    }
    if (eventName === 'click' && (!entryKey || entryKey.length > 200 || ['.', '#', '$', '/', '[', ']'].some((character) => entryKey.includes(character)))) {
      response.status(400).json({ message: '항목 정보가 올바르지 않습니다.' });
      return;
    }
    const db = getDatabase();
    const current = (await db.ref('adminCenter/publicPromoPage/currentVersion').get()).val();
    const activeVersion = typeof current === 'string' ? current : String((current || {}).version || '');
    if (activeVersion !== version) {
      response.status(410).json({ active: false });
      return;
    }
    if (!await takePublicPromoRateLimit(request, 'analytics', PUBLIC_PROMO_RATE_LIMITS.analytics)) {
      const retryAfterSeconds = publicPromoRetryAfterSeconds();
      response.set('Retry-After', String(retryAfterSeconds));
      response.status(429).json({ message: publicPromoRateLimitMessage(retryAfterSeconds) });
      return;
    }
    const dateKey = getKoreaDateKey();
    const dayRef = db.ref(`adminCenter/publicPromoPage/analytics/daily/${dateKey}`);
    if (eventName === 'click') {
      const digest = require('node:crypto').createHash('sha256').update(entryKey).digest('hex');
      const linkExists = await db.ref(`adminCenter/publicPromoPage/linkMaps/${version}/${digest}`).get();
      if (!linkExists.exists()) {
        response.status(404).json({ message: '등록된 링크를 찾을 수 없습니다.' });
        return;
      }
      await incrementPromoAnalytics(dayRef.child(`linkClicksByStreamer/${digest}`));
      await incrementPromoAnalytics(dayRef.child('linkClicks'));
    } else if (eventName === 'sponsorClick' || eventName === 'sponsorImpression') {
      const sponsor = (await db.ref('lifeGame/currentSponsor').get()).val();
      if (sponsor && Number(sponsor.startAt) <= Date.now() && Number(sponsor.endAt) > Date.now()) {
        await incrementPromoAnalytics(dayRef.child(eventName === 'sponsorClick' ? 'sponsorStationClicks' : 'sponsorImpressions'));
      }
    } else {
      await incrementPromoAnalytics(dayRef.child(eventName === 'view' ? 'pageViews' : 'searches'));
    }
    response.status(204).send('');
  } catch (error) {
    console.error('recordPublicPromoEvent failed:', error);
    response.status(500).json({ message: '통계를 기록하지 못했습니다.' });
  }
});

const getPublicPromoPageStats = onCall(async (request) => {
  await requireAdmin(request);
  const requestedDays = Math.floor(Number((request.data || {}).days) || 30);
  const days = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;
  const db = getDatabase();
  const analyticsRef = db.ref('adminCenter/publicPromoPage/analytics/daily');
  const todayKey = getKoreaDateKey();
  const startCursor = new Date(`${todayKey}T12:00:00Z`);
  startCursor.setUTCDate(startCursor.getUTCDate() - (days - 1));
  const startKey = getKoreaDateKey(startCursor);
  const [analyticsSnap, currentSnap] = await Promise.all([
    analyticsRef.orderByKey().startAt(startKey).endAt(todayKey).get(),
    db.ref('adminCenter/publicPromoPage/currentVersion').get(),
  ]);
  const current = currentSnap.val();
  const activeVersion = typeof current === 'string' ? current : String((current || {}).version || '');
  const directorySnap = activeVersion
    ? await db.ref(`adminCenter/publicPromoPage/directories/${activeVersion}/pages`).get()
    : null;
  const allDays = analyticsSnap.val() || {};
  const directoryPages = directorySnap && directorySnap.val() || {};
  const dateCursor = new Date(`${todayKey}T12:00:00Z`);
  const daily = [];
  const clicksByStreamer = {};
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(dateCursor);
    day.setUTCDate(day.getUTCDate() - offset);
    const date = getKoreaDateKey(day);
    const item = allDays[date] || {};
    const clicks = Math.max(0, Number(item.linkClicks) || 0);
    const sponsorClicks = Math.max(0, Number(item.sponsorStationClicks) || 0);
    const sponsorImpressions = Math.max(0, Number(item.sponsorImpressions) || 0);
    daily.push({
      date,
      pageViews: Math.max(0, Number(item.pageViews) || 0),
      searches: Math.max(0, Number(item.searches) || 0),
      linkClicks: clicks,
      sponsorImpressions,
      sponsorStationClicks: sponsorClicks,
    });
    Object.entries(item.linkClicksByStreamer || {}).forEach(([hash, count]) => {
      clicksByStreamer[hash] = (clicksByStreamer[hash] || 0) + Math.max(0, Number(count) || 0);
    });
  }
  const namesByHash = {};
  Object.values(directoryPages).forEach((page) => {
    Object.values(page || {}).forEach((entry) => {
      if (!entry || !entry.key) return;
      const hash = require('node:crypto').createHash('sha256').update(String(entry.key)).digest('hex');
      namesByHash[hash] = { nickname: String(entry.nickname || ''), soopId: String(entry.soopId || '') };
    });
  });
  const topStreamers = Object.entries(clicksByStreamer)
    .map(([hash, clicks]) => ({ ...(namesByHash[hash] || { nickname: '현재 목록에 없는 항목', soopId: '' }), clicks }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 20);
  const totals = daily.reduce((sum, item) => ({
    pageViews: sum.pageViews + item.pageViews,
    searches: sum.searches + item.searches,
    linkClicks: sum.linkClicks + item.linkClicks,
    sponsorImpressions: sum.sponsorImpressions + item.sponsorImpressions,
    sponsorStationClicks: sum.sponsorStationClicks + item.sponsorStationClicks,
  }), { pageViews: 0, searches: 0, linkClicks: 0, sponsorImpressions: 0, sponsorStationClicks: 0 });
  return { days, totals, daily, topStreamers };
});

async function takePublicPromoRateLimit(request, bucket, maxRequests) {
  const ip = String(request.ip || request.rawRequest && request.rawRequest.ip || 'unknown');
  const key = require('node:crypto').createHash('sha256').update(ip).digest('hex').slice(0, 40);
  const windowId = Math.floor(Date.now() / (60 * 60 * 1000));
  const ref = getDatabase().ref(`adminCenter/publicPromoPage/rateLimits/${bucket}/${key}`);
  const result = await ref.transaction((current) => {
    const count = current && Number(current.windowId) === windowId ? Number(current.count) || 0 : 0;
    if (count >= maxRequests) return;
    return { windowId, count: count + 1, expiresAt: (windowId + 2) * 60 * 60 * 1000 };
  }, undefined, false);
  if (!result.committed) return false;
  return true;
}

function publicPromoRetryAfterSeconds() {
  const hourMs = 60 * 60 * 1000;
  return Math.max(1, Math.ceil(((Math.floor(Date.now() / hourMs) + 1) * hourMs - Date.now()) / 1000));
}

function publicPromoRateLimitMessage(retryAfterSeconds) {
  const minutes = Math.max(1, Math.ceil(Number(retryAfterSeconds) / 60));
  return `요청 한도를 초과했습니다. 약 ${minutes}분 후 다시 이용해 주세요.`;
}

function sendPublicPromoRateLimitPage(response, version, retryAfterSeconds) {
  const minutes = Math.max(1, Math.ceil(Number(retryAfterSeconds) / 60));
  const pageUrl = `${PUBLIC_PROMO_DIRECTORY_ORIGIN}/admin-center/releases/${encodeURIComponent(version)}.html`;
  response.set('Retry-After', String(retryAfterSeconds));
  response.set('Content-Type', 'text/html; charset=utf-8');
  response.status(429).send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>잠시 후 다시 이용해 주세요</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:#eee9dd;color:#24211c;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}.card{width:min(480px,100%);padding:30px;background:#fffdf8;border:1px solid #cfc3ad;border-top:5px double #29251f;box-shadow:0 14px 44px #322a1d18}.eyebrow{margin:0 0 10px;color:#795a2d;font-size:11px;font-weight:800;letter-spacing:.15em}.card h1{margin:0 0 10px;font-family:Georgia,"Batang",serif;font-size:26px;line-height:1.25}.card p{margin:0;color:#625b50}.wait{margin-top:18px;padding:12px 14px;background:#f2eadb;border-left:3px solid #795a2d;color:#494238;font-weight:700}.back{display:inline-block;margin-top:20px;padding:10px 15px;background:#29251f;color:#fffdf8;text-decoration:none;font-size:13px;font-weight:700}</style></head><body><main class="card"><p class="eyebrow">CUCKOO BOARD DIRECTORY</p><h1>잠시 후 다시 이용해 주세요</h1><p>짧은 시간 동안 링크를 많이 열어 잠시 제한됐어요. 목록 이용에는 영향이 없으며, 아래 시간이 지난 뒤 다시 시도할 수 있습니다.</p><div class="wait">약 ${minutes}분 후 다시 시도해 주세요.</div><a class="back" href="${pageUrl}">목록 페이지로 돌아가기</a></main></body></html>`);
}

// The public page requests small slices rather than embedding the complete
// directory in a downloadable HTML file. This is an anti-bulk-extraction
// measure, not access control: publicly visible records can still be copied.
const getPublicPromoDirectory = onRequest(async (request, response) => {
  response.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  response.set('Referrer-Policy', 'no-referrer');
  response.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  response.set('Vary', 'Origin');
  const origin = String(request.get('Origin') || '');
  if (origin !== PUBLIC_PROMO_DIRECTORY_ORIGIN) {
    response.status(403).json({ message: '허용된 페이지에서만 목록을 요청할 수 있습니다.' });
    return;
  }
  response.set('Access-Control-Allow-Origin', PUBLIC_PROMO_DIRECTORY_ORIGIN);
  if (request.method === 'OPTIONS') {
    response.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.set('Access-Control-Allow-Headers', 'Content-Type');
    response.status(204).send('');
    return;
  }
  if (request.method !== 'POST') {
    response.status(405).json({ message: 'POST 요청만 허용됩니다.' });
    return;
  }
  try {
    let body = request.body;
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if ((body === undefined || body === null || body === '') && request.rawBody) body = request.rawBody.toString('utf8');
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    if (!body || typeof body !== 'object') body = {};
    const version = String(body.version || '');
    if (!/^[a-f0-9]{32}$/.test(version)) {
      response.status(400).json({ message: '페이지 버전 정보가 올바르지 않습니다.' });
      return;
    }
    const current = (await getDatabase().ref('adminCenter/publicPromoPage/currentVersion').get()).val();
    const activeVersion = typeof current === 'string' ? current : String((current || {}).version || '');
    if (activeVersion !== version) {
      response.status(410).json({ active: false, message: '새 업데이트가 있어 이전 목록은 사용할 수 없습니다.' });
      return;
    }
    if (!await takePublicPromoRateLimit(request, 'directory', PUBLIC_PROMO_RATE_LIMITS.directory)) {
      const retryAfterSeconds = publicPromoRetryAfterSeconds();
      response.set('Retry-After', String(retryAfterSeconds));
      response.status(429).json({ message: publicPromoRateLimitMessage(retryAfterSeconds) });
      return;
    }
    const offset = Math.max(0, Math.min(100000, Math.floor(Number(body.offset) || 0)));
    const limit = Math.max(1, Math.min(PUBLIC_PROMO_DIRECTORY_PAGE_SIZE, Math.floor(Number(body.limit) || PUBLIC_PROMO_DIRECTORY_PAGE_SIZE)));
    const query = String(body.query || '').trim().toLocaleLowerCase().slice(0, 80);
    const directoryRef = getDatabase().ref(`adminCenter/publicPromoPage/directories/${version}`);
    const meta = (await directoryRef.child('total').get()).val();
    const total = Math.max(0, Math.floor(Number(meta) || 0));
    let rows;
    let matchingTotal;
    if (query) {
      const allPages = (await directoryRef.child('pages').get()).val() || {};
      const matches = Object.keys(allPages).sort((a, b) => Number(a) - Number(b))
        .flatMap((page) => Object.values(allPages[page] || {})).filter((entry) =>
        (String(entry.nickname || '') + ' ' + String(entry.soopId || '')).toLocaleLowerCase().includes(query));
      matchingTotal = matches.length;
      rows = matches.slice(offset, offset + limit);
    } else {
      matchingTotal = total;
      const pageIndex = Math.floor(offset / PUBLIC_PROMO_DIRECTORY_PAGE_SIZE);
      const inPageOffset = offset % PUBLIC_PROMO_DIRECTORY_PAGE_SIZE;
      const first = Object.values((await directoryRef.child('pages').child(String(pageIndex)).get()).val() || {});
      rows = first.slice(inPageOffset, inPageOffset + limit);
      if (rows.length < limit && offset + rows.length < total) {
        const next = Object.values((await directoryRef.child('pages').child(String(pageIndex + 1)).get()).val() || {});
        rows = rows.concat(next.slice(0, limit - rows.length));
      }
    }
    response.status(200).json({ entries: rows, total: matchingTotal, offset, hasMore: offset + rows.length < matchingTotal });
  } catch (error) {
    console.error('getPublicPromoDirectory failed:', error);
    response.status(500).json({ message: '목록을 불러오지 못했습니다.' });
  }
});

// Public page source contains no write URLs or resolver tokens. The entry key is
// hashed server-side before lookup, and the destination is returned only via a
// version-checked, rate-limited redirect.
const openPublicPromoLink = onRequest(async (request, response) => {
  response.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  response.set('Referrer-Policy', 'no-referrer');
  response.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  const version = String(request.query.version || '');
  const token = String(request.query.token || '');
  const entryKey = String(request.query.key || '');
  const invalidEntryKey = !entryKey || entryKey.length > 200 || ['.', '#', '$', '/', '[', ']'].some((character) => entryKey.includes(character));
  if (!/^[a-f0-9]{32}$/.test(version) || (!/^[a-f0-9]{32}$/.test(token) && invalidEntryKey)) {
    response.status(400).send('잘못된 링크입니다.');
    return;
  }
  const db = getDatabase();
  const currentSnap = await db.ref('adminCenter/publicPromoPage/currentVersion').get();
  const current = currentSnap.val();
  const activeVersion = typeof current === 'string' ? current : String((current || {}).version || '');
  if (activeVersion !== version) {
    response.status(410).send('이 버전은 종료되었습니다. 최신 페이지로 이동해 주세요.');
    return;
  }
  if (!await takePublicPromoRateLimit(request, 'resolve', PUBLIC_PROMO_RATE_LIMITS.resolve)) {
    sendPublicPromoRateLimitPage(response, version, publicPromoRetryAfterSeconds());
    return;
  }
  const lookupKey = /^[a-f0-9]{32}$/.test(token)
    ? token
    : require('node:crypto').createHash('sha256').update(entryKey).digest('hex');
  const linkSnap = await db.ref('adminCenter/publicPromoPage/linkMaps/' + version + '/' + lookupKey).get();
  const destination = String(linkSnap.val() || '');
  try {
    if (!destination || normalizePromoUrl(destination) !== new URL(destination).toString()) throw new Error('invalid destination');
  } catch (_) {
    response.status(404).send('링크를 찾을 수 없습니다.');
    return;
  }
  response.redirect(302, destination);
});

function requireAuth(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  return request.auth.uid;
}

async function isAdminUid(uid) {
  const db = getDatabase();
  const snap = await db.ref('adminCenter/adminUids/' + uid).get();
  return snap.val() === true;
}

async function isOnyuAdminUid(uid) {
  const snap = await getDatabase().ref('onyuVn/adminUids/' + uid).get();
  return snap.val() === true;
}

function isAdminEmail(email) {
  return !!email && email === ADMIN_EMAIL;
}

async function requireAdmin(request) {
  const uid = requireAuth(request);
  if (await isAdminUid(uid)) return uid;
  const email = request.auth.token && request.auth.token.email;
  if (isAdminEmail(email)) {
    console.warn('관리자 판별 이메일 폴백 사용됨(uid 미등록):', uid);
    return uid;
  }
  throw new HttpsError('permission-denied', '관리자만 수행할 수 있습니다.');
}

// 09번 — 관리자 이메일 하드코딩 정리의 1회성 부트스트랩. requireAdmin(uid 우선,
// 이메일 폴백)으로 신원을 확인한 뒤, 호출한 사람의 uid를 adminCenter/adminUids에
// 등록한다. 이미 등록된 uid로 다시 호출해도 안전(멱등). request.auth.uid만
// 신뢰하고 클라이언트가 보낸 값은 쓰지 않는다 — 위조 불가능한 자기 등록.
const bootstrapAdminUid = onCall(async (request) => {
  const uid = await requireAdmin(request);
  const db = getDatabase();
  await db.ref('adminCenter/adminUids/' + uid).set(true);
  return { ok: true, uid };
});

// 주식시장·배팅시장이 공유하는 streamerVerifications 노드를 uid 필드로 조회한다.
// Admin SDK로 조회하므로 그 노드의 RTDB 규칙과 무관하게 항상 읽을 수 있다.
async function isVerifiedStreamerUid(uid) {
  const db = getDatabase();
  const snap = await db
    .ref('streamerVerifications')
    .orderByChild('uid')
    .equalTo(uid)
    .limitToFirst(1)
    .get();
  return snap.exists();
}

// 과거 인증 스트리머 위임을 위해 사용하던 이름은 호환성을 위해 남겨두되,
// 통합 관리 센터를 관리자 전용으로 전환한 뒤에는 모든 호출을 관리자 판정으로
// 수렴시킨다. 클라이언트 UI를 우회해 callable을 직접 호출하는 경우도 동일하게 차단한다.
async function requireAdminOrVerifiedStreamer(request) {
  const uid = await requireAdmin(request);
  return { uid, role: 'admin' };
}

// 과거 위임 권한 카탈로그용 이름도 관리자 전용 검증으로 고정한다. permissionKey는
// 호출부 호환을 위해 받지만 더 이상 스트리머에게 권한을 열어주지 않는다.
async function requireAdminOrDelegatedPermission(request, permissionKey) {
  void permissionKey;
  const uid = await requireAdmin(request);
  return { uid, role: 'admin' };
}

// 통합 관리 센터 — 관리자만 권한 상태를 조회할 수 있다.
const getAdminCenterState = onCall(async (request) => {
  await requireAdmin(request);
  const db = getDatabase();
  const [permsSnap, killswitchSnap] = await Promise.all([
    db.ref('adminCenter/streamerPermissions').get(),
    db.ref('adminCenter/killswitchLastRun').get(),
  ]);
  return { role: 'admin', permissions: permsSnap.val() || {}, killswitchLastRun: killswitchSnap.val() || null };
});

// 통합 관리 센터의 초기 세션 배지용 경량 요약. 전체 목록을 반환하지 않고 각 큐에
// 대기 항목이 하나라도 있는지만 확인한다. 실제 목록/상세 데이터는 사용자가 해당
// 세션을 연 뒤 기존 조회 함수에서 가져온다. Admin SDK 쿼리 결과는 서버 안에서만
// 사용하므로 클라이언트에 대형 RTDB 노드를 전송하지 않는다.
async function hasAnyEntry(db, path, status) {
  let queryRef = db.ref(path);
  if (status) queryRef = queryRef.orderByChild('status').equalTo(status);
  queryRef = queryRef.limitToFirst(1);
  try {
    return (await queryRef.get()).exists();
  } catch (error) {
    // RTDB 규칙에 해당 인덱스가 빠진 경우에도 관리자 요약 전체가 500으로
    // 실패하지 않도록 서버에서만 안전하게 보완한다. 규칙에는 인덱스를 계속
    // 추가하되, 배포 지연·자매 저장소 규칙 불일치 동안의 장애를 흡수한다.
    if (!status) throw error;
    console.warn('세션 요약 인덱스 조회 실패 — 서버 보완 조회:', path, error && error.message);
    const snapshot = await db.ref(path).get();
    const value = snapshot.val();
    if (!value || typeof value !== 'object') return false;
    return Object.keys(value).some(function (key) {
      return value[key] && value[key].status === status;
    });
  }
}

function isPendingVerificationRequest(request) {
  // 구버전 신청은 status가 없고, 계정전환 승인은 처리 후 approved 이력으로 남는다.
  return !!request && (!request.status || request.status === 'pending');
}

const getAdminSessionSummary = onCall(async (request) => {
  await requireAdmin(request);
  const role = 'admin';
  const permissions = (await getDatabase().ref('adminCenter/streamerPermissions').get()).val() || {};
  const db = getDatabase();
  const canReview = role === 'admin' || permissions.reviewQueue === true;

  const summary = { identity: false, monitoring: false, review: false, content: false, promotions: false, settings: false, devbar: false, shared: false };
  const tasks = [];
  if (role === 'admin') {
    tasks.push(Promise.all([
      db.ref('bettingMarket/verifyRequests').get().then(function (snapshot) {
        const requests = snapshot.val() || {};
        return Object.keys(requests).some(function (requestId) {
          return isPendingVerificationRequest(requests[requestId]);
        });
      }),
      hasAnyEntry(db, 'streamerVerificationRequests', 'pending'),
    ]).then(function (values) { summary.identity = values.some(Boolean); }));
  }
  if (canReview) {
    tasks.push(Promise.all([
      hasAnyEntry(db, 'bettingMarket/marketReports'),
      hasAnyEntry(db, 'bettingMarket/nicknameReports'),
      hasAnyEntry(db, 'presetMergeFailures'),
      hasAnyEntry(db, 'listingRequests', 'pending'),
      hasAnyEntry(db, 'bettingMarket/chestPurchaseRequests'),
      hasAnyEntry(db, 'chartBannerRequests', 'pending'),
      hasAnyEntry(db, 'cardBannerRequests', 'pending'),
      hasAnyEntry(db, 'treasureChestRequests', 'pending'),
      hasAnyEntry(db, 'cashChargeRequests', 'pending'),
      hasAnyEntry(db, 'unfreezeDonationRequests', 'pending'),
      hasAnyEntry(db, 'bannerRequests', 'pending'),
      hasAnyEntry(db, 'pinRequests', 'pending'),
      hasAnyEntry(db, 'relayRoomRequests', 'pending'),
      hasAnyEntry(db, 'lifeGame/sponsorRequests', 'pending'),
      hasAnyEntry(db, 'bettingMarket/markets', 'pendingValidation'),
      hasAnyEntry(db, 'bettingMarket/markets', 'closed'),
      hasAnyEntry(db, 'bettingMarket/markets', 'pendingSettlement'),
    ]).then(function (values) { summary.review = values.some(Boolean); }));
  }
  await Promise.all(tasks);
  return { role, summary };
});

// 통합 관리 센터 — 위임 권한 하나를 켜고/끈다. 관리자만 가능하고, 인증 스트리머 전원에게
// 동일하게 적용된다(스트리머별 개별 권한이 아니라 하나의 공용 스위치 목록).
const setAdminCenterPermission = onCall(async (request) => {
  await requireAdmin(request);
  const { key, granted } = request.data || {};
  if (typeof key !== 'string' || !key.trim() || key.length > 60) {
    throw new HttpsError('invalid-argument', '권한 key가 올바르지 않습니다.');
  }
  if (typeof granted !== 'boolean') {
    throw new HttpsError('invalid-argument', 'granted 값은 true/false여야 합니다.');
  }
  const db = getDatabase();
  await db.ref('adminCenter/streamerPermissions/' + key.trim()).set(granted);
  return { ok: true };
});

// 07번 4단계 — 즉시 회수 킬스위치. 카탈로그(PERMISSION_CATALOG)가 아직 비어 있어
// 지금 당장 되돌릴 위임 권한은 없지만, 나중에 카탈로그가 채워진 뒤 사고가 나면
// 그때 급하게 만들 여유가 없으므로 실제 위임을 시작하기 전에 미리 마련해둔다
// (07번에서 이 순서를 고정한 이유 그대로). 개별 스위치를 하나씩 끄는 대신
// 위임된 권한 전체를 한 번에 false로 되돌리는 패닉 버튼.
const revokeAllStreamerPermissions = onCall(async (request) => {
  const uid = await requireAdmin(request);
  const adminName = request.auth.token.name || request.auth.token.email || uid;
  const db = getDatabase();
  const snap = await db.ref('adminCenter/streamerPermissions').get();
  const data = snap.val() || {};
  const updates = {};
  let revokedCount = 0;
  Object.keys(data).forEach(function (key) {
    if (data[key]) {
      updates[key] = false;
      revokedCount += 1;
    }
  });
  if (revokedCount > 0) {
    await db.ref('adminCenter/streamerPermissions').update(updates);
  }
  await db.ref('adminCenter/killswitchLastRun').set({
    adminUid: uid,
    adminName: adminName,
    at: Date.now(),
    revokedCount: revokedCount,
  });
  return { ok: true, revokedCount: revokedCount };
});

// 통합 관리 센터 — 인증 스트리머 관리 1단계: 배팅시장(bettingMarket/verifyRequests)·
// 주식시장(streamerVerificationRequests)의 대기 신청과 공유 streamerVerifications을
// 한 화면에서 보기 위한 조회 전용 함수. 승인/거절/해제 자체는 여기서 새로 구현하지
// 않는다 - 각 게임의 기존 함수(배팅시장 approveVerification 등, 주식시장 adminAction의
// approveStreamerVerification 등 액션)를 클라이언트가 source 태그를 보고 그대로
// 호출한다. 이 함수는 흩어진 데이터를 한 번에 모아서 보여주는 역할만 한다.
// 승인/거절/해제는 두 스트리머를 저울질하는 민감한 권한이라 당분간 관리자 전용으로
// 유지하기로 했고, 조회도 같은 화면의 일부라 우선 관리자 전용으로 시작한다.
const listStreamerVerificationOverview = onCall(async (request) => {
  await requireAdmin(request);
  const db = getDatabase();
  const [bmReqSnap, smReqSnap, verifiedSnap] = await Promise.all([
    db.ref('bettingMarket/verifyRequests').get(),
    db.ref('streamerVerificationRequests').get(),
    db.ref('streamerVerifications').get(),
  ]);

  const bmReq = bmReqSnap.val() || {};
  const smReq = smReqSnap.val() || {};
  const verified = verifiedSnap.val() || {};

  const pending = [];
  Object.keys(bmReq).forEach(function (id) {
    // 일반 배팅시장 신청은 승인 시 삭제되지만 계정전환은 토큰 소비를 위해
    // switched 이력으로 남긴다. status 없는 구버전 레코드는 대기 중으로 본다.
    if (!isPendingVerificationRequest(bmReq[id])) return;
    pending.push(Object.assign({ id: id, source: 'bettingMarket' }, bmReq[id]));
  });
  Object.keys(smReq).forEach(function (id) {
    // 주식시장 쪽 노드는 승인/거절된 뒤에도 이력이 남아있는 구조라 pending만 걸러낸다.
    if (smReq[id].status !== 'pending') return;
    pending.push(Object.assign({ id: id, source: 'stockMarket' }, smReq[id]));
  });

  const verifiedList = Object.keys(verified).map(function (id) {
    return Object.assign({ id: id }, verified[id]);
  });

  return { pending: pending, verified: verifiedList };
});

// 통합 관리 센터 — 감사 로그 통합: 배팅시장의 기존 bettingMarket/auditLog와
// 주식시장의 새 adminAuditLog(이번에 처음 만든 것 - 스트리머 인증 관련 액션만
// 우선 기록 중, 다른 관리 액션 전체로 넓히는 건 별도 작업)를 합쳐서 시간순으로
// 보여준다. 관리자는 항상, 인증 스트리머는 'viewMonitoring' 위임 권한이 있을 때만.
const AUDIT_OVERVIEW_LIMIT = 100;
const listAuditLogOverview = onCall(async (request) => {
  await requireAdmin(request);
  const db = getDatabase();
  const [bmLogSnap, smLogSnap, galLogSnap, messengerLogSnap] = await Promise.all([
    db.ref('bettingMarket/auditLog').orderByChild('at').limitToLast(AUDIT_OVERVIEW_LIMIT).get(),
    db.ref('adminAuditLog').orderByChild('at').limitToLast(AUDIT_OVERVIEW_LIMIT).get(),
    db.ref('gallery/auditLog').orderByChild('at').limitToLast(AUDIT_OVERVIEW_LIMIT).get(),
    db.ref('streamerMessenger/auditLog').orderByChild('at').limitToLast(AUDIT_OVERVIEW_LIMIT).get(),
  ]);

  const bmLog = bmLogSnap.val() || {};
  const smLog = smLogSnap.val() || {};
  const galLog = galLogSnap.val() || {};
  const messengerLog = messengerLogSnap.val() || {};

  const entries = [];
  Object.keys(bmLog).forEach(function (id) {
    const e = bmLog[id];
    entries.push({
      id: id, source: 'bettingMarket', at: e.at,
      actorName: e.actorName, action: e.action, detail: e.detail,
    });
  });
  Object.keys(smLog).forEach(function (id) {
    const e = smLog[id];
    entries.push({
      id: id, source: 'stockMarket', at: e.at,
      actorName: e.actorName, action: e.action, detail: e.detail,
    });
  });
  Object.keys(galLog).forEach(function (id) {
    const e = galLog[id];
    entries.push({
      id: id, source: 'gallery', at: e.at,
      actorName: e.actorName, action: e.action, detail: e.detail,
    });
  });
  Object.keys(messengerLog).forEach(function (id) {
    const e = messengerLog[id];
    entries.push({
      id: id, source: 'streamerMessenger', at: e.at,
      actorName: e.actorName || e.actorUid, action: e.action, detail: e.detail,
    });
  });

  entries.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
  return { entries: entries.slice(0, AUDIT_OVERVIEW_LIMIT) };
});

// 시리즈 게임 목록 — 새 게임이 생기면 여기에 한 줄만 추가하면 된다(신규 게임
// 온보딩 체크리스트의 "통합 관리 센터에 등록" 항목이 사실상 이 배열 하나).
const GAME_CATALOG = [
  { id: 'bettingMarket', name: '스트리머 배팅시장' },
  { id: 'stockMarket', name: '스트리머 주식시장' },
  { id: 'backgroundMarket', name: '스트리머 배경시장' },
  { id: 'midnightMartRun', name: '미드나잇 마트런' },
  { id: 'dontClickAds', name: '절대 광고를 클릭하지 마' },
  { id: 'lifeGame', name: '스트리머 인생게임' },
  { id: 'gallery', name: '스트리머 갤러리' },
  { id: 'streamerMessenger', name: '스트리머 메신저' },
  { id: 'streamerJurumable', name: '스트리머 주루마블' },
  { id: 'dontPressButton', name: '한국인은 절대 못 깨는 게임' },
  { id: 'streamerFanPage', name: '스트리머 팬페이지' },
  { id: 'onyuVn', name: '당신이 여기에 온 이유' },
  { id: 'gameSeriesShop', name: '스트리머 게임시리즈 상점' },
];

const AUDIT_LOG_CAP = 200;
async function trimAdminAuditLog(db) {
  const ref = db.ref('adminAuditLog');
  const snap = await ref.orderByKey().get();
  const keys = Object.keys(snap.val() || {});
  if (keys.length <= AUDIT_LOG_CAP) return;
  const updates = {};
  keys.slice(0, keys.length - AUDIT_LOG_CAP).forEach(function (key) { updates[key] = null; });
  await ref.update(updates);
}
// listAuditLogOverview가 이미 adminAuditLog를 읽어서 보여주고 있으므로, 통합
// 관리 센터 자체 조작(콘텐츠 동결 토글 등)도 같은 노드에 기록하면 별도 UI 없이
// 그 감사 로그 카드에 자동으로 같이 나타난다.
async function logToAdminAuditLog(db, request, action, detail) {
  const email = request.auth.token && request.auth.token.email;
  const name = (request.auth.token && request.auth.token.name) || email || request.auth.uid;
  const ref = db.ref('adminAuditLog').push();
  await ref.set({ actorUid: request.auth.uid, actorName: name, action: action, detail: detail || '', at: Date.now() });
  await trimAdminAuditLog(db);
}

// 콘텐츠 동결(유지보수 모드와는 다른 개념) — 서비스 점검(다운)이 아니라, 특정
// 게임의 신규 콘텐츠 개발을 잠시 멈추고 버그 수정 위주로 운영 중임을 유저에게
// 알리는 라벨. 관리자만 조회·변경 가능(게임 운영 방침 결정이라 위임 대상 아님).
const getSeriesConfig = onCall(async (request) => {
  await requireAdmin(request);
  const db = getDatabase();
  const snap = await db.ref('seriesConfig').get();
  const config = snap.val() || {};
  return {
    games: GAME_CATALOG.map(function (g) {
      return { id: g.id, name: g.name, contentFreeze: !!(config[g.id] && config[g.id].contentFreeze) };
    }),
  };
});

const setSeriesConfig = onCall(async (request) => {
  await requireAdmin(request);
  const { gameId, contentFreeze } = request.data || {};
  const game = GAME_CATALOG.find(function (g) { return g.id === gameId; });
  if (!game) throw new HttpsError('invalid-argument', '알 수 없는 게임입니다.');
  if (typeof contentFreeze !== 'boolean') {
    throw new HttpsError('invalid-argument', 'contentFreeze 값은 true/false여야 합니다.');
  }
  const db = getDatabase();
  await db.ref('seriesConfig/' + gameId + '/contentFreeze').set(contentFreeze);
  await logToAdminAuditLog(db, request, contentFreeze ? '콘텐츠 동결 모드 켬' : '콘텐츠 동결 모드 끔', game.name);
  return { ok: true };
});

// 08번 — devbar(각 페이지 상단 "다른 게임 바로가기" 링크) 통합 관리. 지금까지 이
// 링크 목록은 페이지마다(StreamBet-Market 1곳, interior-3d-viewer 3곳, soop-stock-market
// 1곳) 하드코딩된 사본이라 링크 하나 바꾸려면 5개 파일을 일일이 고쳐야 했다. 이제
// devbarLinks RTDB 노드(공개 읽기)를 각 페이지가 직접 조회하고, 이 함수들이 그 값을
// 쓰는(write) 유일한 통로다. 노드가 비어있거나 네트워크 실패 시 각 페이지는 기존
// 하드코딩된 링크를 그대로 폴백으로 쓴다(devbar가 통째로 사라지는 사고 방지 - 각
// 페이지 쪽 구현).
//
// 06번 GAME_CATALOG에 종속시키지 않고 gameId를 자유 입력받는다 — 새 게임이 나올
// 때마다 GAME_CATALOG 배열을 코드로 고치고 재배포해야 하는 게 아니라, 관리자가
// UI에서 바로 새 항목을 추가할 수 있어야 한다는 요구사항 때문. GAME_CATALOG는
// 콘텐츠 동결(seriesConfig)·접속자 분석 등 다른 기능이 여전히 쓰므로 그대로 둔다.
const DEVBAR_URL_RE = /^https:\/\/\S+$/;
const DEVBAR_GAME_ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;

const setDevbarLink = onCall(async (request) => {
  // 07번 4단계 — devbar 링크 편집은 위임 권한 카탈로그의 첫 항목('devbarEdit').
  // 신원·재화에 영향이 없는 낮은 리스크 작업이라 관리자가 켜면 인증 스트리머도 쓸 수 있다.
  await requireAdmin(request);
  const { gameId, label, url, order } = request.data || {};
  const trimmedGameId = String(gameId || '').trim();
  if (!DEVBAR_GAME_ID_RE.test(trimmedGameId)) {
    throw new HttpsError('invalid-argument', 'gameId는 영문/숫자/-/_ 조합 1~40자여야 합니다.');
  }
  const trimmedLabel = String(label || '').trim();
  const trimmedUrl = String(url || '').trim();
  if (!trimmedLabel || trimmedLabel.length > 30) {
    throw new HttpsError('invalid-argument', '표시 이름을 1~30자로 입력해주세요.');
  }
  if (!DEVBAR_URL_RE.test(trimmedUrl)) {
    throw new HttpsError('invalid-argument', 'https:// 로 시작하는 올바른 URL을 입력해주세요.');
  }
  const orderNum = parseInt(order, 10);
  if (!Number.isFinite(orderNum)) {
    throw new HttpsError('invalid-argument', '순서 값이 올바르지 않습니다.');
  }
  const db = getDatabase();
  await db.ref('devbarLinks/' + trimmedGameId).set({ label: trimmedLabel, url: trimmedUrl, order: orderNum });
  await logToAdminAuditLog(db, request, 'devbar 링크 저장', trimmedGameId + ' → ' + trimmedUrl);
  return { ok: true };
});

const deleteDevbarLink = onCall(async (request) => {
  await requireAdmin(request);
  const { gameId } = request.data || {};
  const trimmedGameId = String(gameId || '').trim();
  if (!trimmedGameId) throw new HttpsError('invalid-argument', 'gameId가 필요합니다.');
  const db = getDatabase();
  await db.ref('devbarLinks/' + trimmedGameId).remove();
  await logToAdminAuditLog(db, request, 'devbar 링크 삭제', trimmedGameId);
  return { ok: true };
});

// 통합 관리 센터 운영 도구 — Adult Image Generator 링크 모음. 관리자만 조회·저장할
// 수 있으며 링크, 메모, 정렬 순서는 RTDB의 비공개 노드에만 보관한다. 기본 링크를
// 공개 소스에 포함하거나 조회 시 자동 시드하지 않는다.
const ADULT_IMAGE_GENERATOR_LINKS_PATH = 'adminCenter/adultImageGeneratorLinks';
const ADULT_IMAGE_GENERATOR_URL_RE = /^https:\/\/\S+$/;
const ADULT_IMAGE_GENERATOR_ID_RE = /^[a-z0-9][a-z0-9_-]{1,48}$/;

function adultImageGeneratorLinksFromValue(value) {
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value).map(function (id) {
    return Object.assign({ id: id }, value[id] || {});
  }).filter(function (item) {
    return typeof item.url === 'string' && ADULT_IMAGE_GENERATOR_URL_RE.test(item.url);
  }).sort(function (a, b) {
    return (Number(a.order) || 0) - (Number(b.order) || 0);
  }).map(function (item, index) {
    return {
      id: item.id,
      title: String(item.title || item.id).slice(0, 80),
      url: item.url,
      memo: String(item.memo || '').slice(0, 200),
      order: index,
    };
  });
}

const getAdultImageGeneratorLinks = onCall(async (request) => {
  await requireAdmin(request);
  const db = getDatabase();
  const snap = await db.ref(ADULT_IMAGE_GENERATOR_LINKS_PATH).get();
  return { links: adultImageGeneratorLinksFromValue(snap.val()) };
});

const saveAdultImageGeneratorLinks = onCall(async (request) => {
  await requireAdmin(request);
  const links = request.data && request.data.links;
  if (!Array.isArray(links) || links.length > 100) {
    throw new HttpsError('invalid-argument', '링크 목록이 올바르지 않습니다.');
  }
  const seen = new Set();
  const normalized = links.map(function (item, index) {
    const id = String(item && item.id || '').trim();
    const title = String(item && item.title || '').trim();
    const url = String(item && item.url || '').trim();
    const memo = String(item && item.memo || '').trim();
    if (!ADULT_IMAGE_GENERATOR_ID_RE.test(id) || seen.has(id)) {
      throw new HttpsError('invalid-argument', '링크 식별자가 올바르지 않거나 중복됩니다.');
    }
    if (!title || title.length > 80) {
      throw new HttpsError('invalid-argument', '링크 이름은 1~80자로 입력해주세요.');
    }
    if (!ADULT_IMAGE_GENERATOR_URL_RE.test(url) || url.length > 500) {
      throw new HttpsError('invalid-argument', 'https://로 시작하는 올바른 링크를 입력해주세요.');
    }
    if (memo.length > 200) {
      throw new HttpsError('invalid-argument', '메모는 200자 이내로 입력해주세요.');
    }
    seen.add(id);
    return { id, title, url, memo, order: index };
  });
  const data = {};
  normalized.forEach(function (item) { data[item.id] = item; });
  const db = getDatabase();
  await db.ref(ADULT_IMAGE_GENERATOR_LINKS_PATH).set(data);
  await logToAdminAuditLog(db, request, 'Adult Image Generator 링크 저장', normalized.length + '개');
  return { ok: true, links: normalized };
});

// 22번 — 게시글 홍보 현황(게임 전체로 확장). StreamBet-Market 전용이던
// bettingMarket/promotedStreamers 개념을 GAME_CATALOG 어떤 게임이든 쓸 수 있는
// 공용 노드로 옮긴다. 결제·승인·대상 검증이 전혀 없는 "자유 텍스트 라벨 + 시각"
// 체크리스트라 게임별 로직 분기가 필요 없다(12번·13번과 달리 정규화 이슈가 없음).
const PROMOTED_CONTENT_LABEL_MAX = 40;

const listPromotedContent = onCall(async (request) => {
  await requireAdmin(request);
  const db = getDatabase();
  const snap = await db.ref('adminCenter/promotedContent').get();
  const data = snap.val() || {};
  const games = GAME_CATALOG.map(function (g) {
    const gameData = data[g.id] || {};
    const entries = Object.keys(gameData).map(function (id) {
      return Object.assign({ id: id }, gameData[id]);
    }).sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
    return { id: g.id, name: g.name, entries: entries };
  });
  return { games: games };
});

const addPromotedContent = onCall(async (request) => {
  const adminUid = await requireAdmin(request);
  const { gameId, label } = request.data || {};
  const game = GAME_CATALOG.find(function (g) { return g.id === gameId; });
  if (!game) throw new HttpsError('invalid-argument', '알 수 없는 게임입니다.');
  const trimmedLabel = String(label || '').trim();
  if (!trimmedLabel) throw new HttpsError('invalid-argument', '내용을 입력해주세요.');
  if (trimmedLabel.length > PROMOTED_CONTENT_LABEL_MAX) {
    throw new HttpsError('invalid-argument', PROMOTED_CONTENT_LABEL_MAX + '자 이하로 입력해주세요.');
  }
  const db = getDatabase();
  const listRef = db.ref('adminCenter/promotedContent/' + gameId);
  const existingSnap = await listRef.get();
  const existing = existingSnap.val() || {};
  const alreadyAdded = Object.keys(existing).some(function (key) { return existing[key].label === trimmedLabel; });
  if (alreadyAdded) throw new HttpsError('failed-precondition', '이미 추가된 항목입니다.');
  const ref = listRef.push();
  await ref.set({ label: trimmedLabel, addedAt: Date.now(), addedBy: adminUid });
  await logToAdminAuditLog(db, request, '게시글 홍보 현황 추가', game.name + ' - ' + trimmedLabel);
  return { id: ref.key };
});

const removePromotedContent = onCall(async (request) => {
  await requireAdmin(request);
  const { gameId, entryId } = request.data || {};
  const game = GAME_CATALOG.find(function (g) { return g.id === gameId; });
  if (!game) throw new HttpsError('invalid-argument', '알 수 없는 게임입니다.');
  if (!entryId) throw new HttpsError('invalid-argument', 'entryId가 필요합니다.');
  const db = getDatabase();
  const ref = db.ref('adminCenter/promotedContent/' + gameId + '/' + entryId);
  const snap = await ref.get();
  const entry = snap.val();
  await ref.remove();
  await logToAdminAuditLog(db, request, '게시글 홍보 현황 삭제', game.name + ' - ' + (entry ? entry.label : entryId));
  return { status: 'removed' };
});

// bettingMarket/promotedStreamers에 이미 쌓인 이력을 새 공용 노드로 1회 이전한다.
// 같은 push 키를 그대로 재사용해서 이전 여부를 판단하므로(새 노드에 그 키가 이미
// 있으면 건너뜀) 여러 번 눌러도 안전(멱등)하다.
const migratePromotedStreamers = onCall(async (request) => {
  await requireAdmin(request);
  const db = getDatabase();
  const [oldSnap, newSnap] = await Promise.all([
    db.ref('bettingMarket/promotedStreamers').get(),
    db.ref('adminCenter/promotedContent/bettingMarket').get(),
  ]);
  const oldData = oldSnap.val() || {};
  const newData = newSnap.val() || {};
  const updates = {};
  let migratedCount = 0;
  Object.keys(oldData).forEach(function (id) {
    if (newData[id]) return;
    const entry = oldData[id];
    updates['adminCenter/promotedContent/bettingMarket/' + id] = {
      label: entry.nickname, addedAt: entry.addedAt, addedBy: entry.addedBy || null,
    };
    migratedCount += 1;
  });
  if (migratedCount > 0) await db.ref().update(updates);
  return { migratedCount: migratedCount };
});

// 인증 스트리머별 SOOP 홍보 게시판 글쓰기 바로가기. SOOP의 글쓰기 경로는
// 게시판 종류·로그인 상태에 따라 달라질 수 있으므로 방송국 주소를 추측해
// 자동 생성하지 않고, 관리자가 실제 글쓰기 URL을 한 번 등록한다. 링크는
// adminCenter 아래에만 저장하며 클라이언트에는 uid를 절대 반환하지 않는다.
const STREAMER_PROMO_URL_MAX = 500;
const SOOP_ID_RE = /^[A-Za-z0-9]{2,20}$/;

function normalizeSoopId(value) {
  const id = String(value || '').trim();
  return SOOP_ID_RE.test(id) ? id.toLowerCase() : '';
}

async function activateApprovedOnyuGiftsForStreamer(db, streamer) {
  const uid = String(streamer && streamer.uid || '').trim();
  const soopId = normalizeSoopId(streamer && streamer.soopId);
  if (!uid || !soopId) return 0;
  const giftsSnap = await db.ref('onyuVn/streamerGameGiftRequests').get();
  const gifts = giftsSnap.val() || {};
  const now = Date.now();
  let activatedCount = 0;
  for (const [requestId, gift] of Object.entries(gifts)) {
    if (!gift || gift.purchaseType !== 'gift' || gift.status !== 'approved' ||
        gift.activationStatus === 'activated' || normalizeSoopId(gift.targetSoopId) !== soopId) continue;
    const entitlementRef = db.ref('onyuVn/streamerGameEntitlements/' + uid);
    const grant = {
      status: 'active', grantedAt: now, grantedBy: 'streamer-verification', requestId,
      giftRequestId: requestId, purchaseType: 'gift', requesterUid: gift.requesterUid || '',
      donorNickname: gift.donorNickname || '', targetNickname: streamer.nickname || gift.targetNickname || '',
    };
    const current = (await entitlementRef.get()).val();
    if (current && current.status === 'active') {
      const sameGift = current.requestId === requestId || current.giftRequestId === requestId;
      await db.ref('onyuVn/streamerGameGiftRequests/' + requestId).update({
        targetUid: uid, activationStatus: sameGift ? 'activated' : 'blocked-existing-entitlement', updatedAt: now,
      });
      if (sameGift) activatedCount += 1;
      continue;
    }
    const result = await entitlementRef.transaction((value) => value === null ? grant : undefined);
    const stored = result.snapshot && result.snapshot.val();
    const activated = result.committed || !!(stored && (stored.requestId === requestId || stored.giftRequestId === requestId));
    await db.ref('onyuVn/streamerGameGiftRequests/' + requestId).update({
      targetUid: uid, targetNickname: streamer.nickname || gift.targetNickname || '',
      activationStatus: activated ? 'activated' : 'blocked-existing-entitlement', updatedAt: now,
    });
    if (activated) activatedCount += 1;
  }
  return activatedCount;
}

function normalizePromoUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length > STREAMER_PROMO_URL_MAX) {
    throw new HttpsError('invalid-argument', STREAMER_PROMO_URL_MAX + '자 이하의 링크를 입력해주세요.');
  }
  let parsed;
  try { parsed = new URL(raw); } catch (e) {
    throw new HttpsError('invalid-argument', '올바른 URL을 입력해주세요.');
  }
  const hostname = parsed.hostname.toLowerCase();
  const allowedHost = hostname === 'sooplive.com' || hostname.endsWith('.sooplive.com') ||
    hostname === 'sooplive.co.kr' || hostname.endsWith('.sooplive.co.kr') ||
    hostname === 'cafe.naver.com';
  if (parsed.protocol !== 'https:' || !allowedHost || parsed.username || parsed.password) {
    throw new HttpsError('invalid-argument', 'SOOP의 https 링크만 등록할 수 있습니다.');
  }
  return parsed.toString();
}

function promoStorageKey(verificationId, soopId) {
  const normalizedId = normalizeSoopId(soopId);
  return normalizedId || ('verification_' + String(verificationId || '').replace(/[^A-Za-z0-9_-]/g, '_'));
}

const STREAMER_PROMO_SEED_MIGRATION_KEY = 'seedToCandidatesV1';

async function migrateStreamerPromoSeedToCandidates(db, adminUid, request) {
  const migrationRef = db.ref('adminCenter/streamerPromoSeedMigration');
  const initialStatus = (await migrationRef.get()).val() || {};
  if (initialStatus.completedAt) {
    return {
      migratedCount: Number(initialStatus.migratedCount) || 0,
      skippedCount: Number(initialStatus.skippedCount) || 0,
      legacyCount: Number(initialStatus.legacyCount) || 0,
      alreadyCompleted: true,
    };
  }

  const now = Date.now();
  const lockOwner = String(adminUid || 'admin') + '-' + now + '-' + Math.random().toString(36).slice(2, 8);
  const lockRef = migrationRef.child('lock');
  const lockResult = await lockRef.transaction(function (current) {
    if (current && Number(current.expiresAt) > now) return;
    return { owner: lockOwner, expiresAt: now + 2 * 60 * 1000 };
  });
  if (!lockResult.committed) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(function (resolve) { setTimeout(resolve, 100); });
      const latestStatus = (await migrationRef.get()).val() || {};
      if (latestStatus.completedAt) {
        return {
          migratedCount: Number(latestStatus.migratedCount) || 0,
          skippedCount: Number(latestStatus.skippedCount) || 0,
          legacyCount: Number(latestStatus.legacyCount) || 0,
          alreadyCompleted: true,
        };
      }
    }
    throw new HttpsError('unavailable', '기본 홍보 목록 이전이 이미 진행 중입니다. 잠시 후 다시 불러와주세요.');
  }

  try {
    const [seedSnap, candidatesSnap, linksSnap, recentSnap, archiveSnap, latestStatusSnap] = await Promise.all([
      db.ref('adminCenter/streamerPromoSeed').get(),
      db.ref('adminCenter/streamerPromoCandidates').get(),
      db.ref('adminCenter/streamerPromoLinks').get(),
      db.ref('adminCenter/streamerPromoRecent').get(),
      db.ref('adminCenter/streamerPromoSeedArchive/' + STREAMER_PROMO_SEED_MIGRATION_KEY).get(),
      migrationRef.get(),
    ]);
    const latestStatus = latestStatusSnap.val() || {};
    if (latestStatus.completedAt) {
      return {
        migratedCount: Number(latestStatus.migratedCount) || 0,
        skippedCount: Number(latestStatus.skippedCount) || 0,
        legacyCount: Number(latestStatus.legacyCount) || 0,
        alreadyCompleted: true,
      };
    }

    const seed = seedSnap.val() || {};
    const candidates = candidatesSnap.val() || {};
    const links = linksSnap.val() || {};
    const recent = recentSnap.val() || null;
    const existingCandidateIds = new Set(Object.keys(candidates).map(function (key) {
      const row = candidates[key] || {};
      return normalizeSoopId(row.soopId || key);
    }).filter(Boolean));
    const updates = {};
    const legacyEntries = {};
    const migratedIds = [];
    const migratedPromoKeys = {};
    let skippedCount = 0;
    let legacyCount = 0;
    Object.keys(seed).forEach(function (key) {
      const entry = seed[key] || {};
      const soopId = normalizeSoopId(entry.soopId || key);
      const nickname = String(entry.nickname || '').normalize('NFC').replace(/\s+/g, ' ').trim();
      if (key.startsWith('cafe_')) {
        legacyEntries[key] = entry;
        skippedCount += 1;
        legacyCount += 1;
        return;
      }
      if (!soopId || !nickname) {
        legacyEntries[key] = entry;
        skippedCount += 1;
        legacyCount += 1;
        return;
      }
      const oldPromoKey = String(entry.key || key);
      const newPromoKey = promoStorageKey('', soopId);
      migratedPromoKeys[soopId] = { oldPromoKey: oldPromoKey, newPromoKey: newPromoKey };
      if (existingCandidateIds.has(soopId)) {
        skippedCount += 1;
      } else {
        const stamp = Date.now();
        updates['adminCenter/streamerPromoCandidates/' + soopId] = {
          nickname: nickname,
          soopId: soopId,
          writeUrl: String(entry.writeUrl || ''),
          createdAt: stamp,
          updatedAt: stamp,
          createdBy: 'streamer-promo-seed-migration',
          updatedBy: adminUid || 'streamer-promo-seed-migration',
          migratedFromSeed: true,
        };
        existingCandidateIds.add(soopId);
        migratedIds.push(soopId);
      }

      // Seed 항목 일부는 SOOP ID가 아니라 cafe_* 키로 저장됐습니다.
      // 후보 키를 SOOP ID로 통일하더라도 기존 링크/완료 상태가 사라지지 않게
      // canonical 키로 복사하고, 이미 canonical 레코드에 있는 값이 우선하도록 합니다.
      if (oldPromoKey !== newPromoKey && links[oldPromoKey]) {
        const canonicalLink = links[newPromoKey] || {};
        updates['adminCenter/streamerPromoLinks/' + newPromoKey] = Object.assign({}, links[oldPromoKey], canonicalLink);
      }
    });

    const normalizedRecentId = normalizeSoopId(recent && recent.soopId);
    const recentMapping = normalizedRecentId && migratedPromoKeys[normalizedRecentId];
    if (recentMapping && recent && recent.key !== recentMapping.newPromoKey) {
      updates['adminCenter/streamerPromoRecent/key'] = recentMapping.newPromoKey;
    }

    if (!archiveSnap.exists() && seedSnap.exists()) {
      updates['adminCenter/streamerPromoSeedArchive/' + STREAMER_PROMO_SEED_MIGRATION_KEY] = seed;
    }
    updates['adminCenter/streamerPromoSeed'] = Object.keys(legacyEntries).length ? legacyEntries : null;
    updates['adminCenter/streamerPromoSeedMigration/completedAt'] = Date.now();
    updates['adminCenter/streamerPromoSeedMigration/migratedCount'] = migratedIds.length;
    updates['adminCenter/streamerPromoSeedMigration/skippedCount'] = skippedCount;
    updates['adminCenter/streamerPromoSeedMigration/legacyCount'] = legacyCount;
    updates['adminCenter/streamerPromoSeedMigration/legacyKeys'] = Object.keys(legacyEntries).length
      ? Object.fromEntries(Object.keys(legacyEntries).map(function (key) { return [key, true]; }))
      : null;
    updates['adminCenter/streamerPromoSeedMigration/migratedBy'] = adminUid || '';
    await db.ref().update(updates);
    await logToAdminAuditLog(db, request, '기본 홍보 목록을 후보 목록으로 이전', migratedIds.length + '건 이전, ' + skippedCount + '건 보존/건너뜀');
    return { migratedCount: migratedIds.length, skippedCount: skippedCount, legacyCount: legacyCount, alreadyCompleted: false };
  } finally {
    await lockRef.transaction(function (current) {
      return current && current.owner === lockOwner ? null : current;
    });
  }
}

function getKnownPromoEntries(seedValue, verifiedValue, candidateValue) {
  const entries = Object.keys(seedValue || {}).map(function (key) {
    const entry = seedValue[key] || {};
    return Object.assign({}, entry, { isSeed: true });
  });
  const byKey = {};
  entries.forEach(function (entry) { byKey[entry.key] = entry; });
  collectVerifiedStreamerEntries(verifiedValue).forEach(function (entry) {
    const key = promoStorageKey(entry.id, entry.soopId);
    if (byKey[key]) {
      byKey[key].isVerified = true;
      if (!byKey[key].nickname && entry.nickname) byKey[key].nickname = entry.nickname;
      return;
    }
    byKey[key] = Object.assign({}, entry, { key: key, isVerified: true });
  });
  const candidates = candidateValue || {};
  Object.keys(candidates).forEach(function (soopId) {
    const row = candidates[soopId] || {};
    const normalizedId = normalizeSoopId(row.soopId || soopId);
    if (!normalizedId || !String(row.nickname || '').trim()) return;
    const key = promoStorageKey('', normalizedId);
    if (byKey[key]) return;
    byKey[key] = {
      key: key,
      nickname: String(row.nickname).trim(),
      soopId: normalizedId,
      writeUrl: String(row.writeUrl || ''),
      isManualCandidate: true,
    };
  });
  return Object.keys(byKey).map(function (key) { return byKey[key]; });
}

function isPromoEntryRemoved(entry, removedValue) {
  const removed = removedValue || {};
  const soopId = normalizeSoopId(entry && entry.soopId);
  const byId = soopId ? removed[soopId] : null;
  const byKey = entry && entry.key ? removed[entry.key] : null;
  return byId === true || byKey === true || !!(byId && typeof byId === 'object' && byId.removedAt) ||
    !!(byKey && typeof byKey === 'object' && byKey.removedAt);
}

function collectVerifiedStreamerEntries(value) {
  const data = value || {};
  const bySoopId = {};
  const entries = [];
  Object.keys(data).forEach(function (id) {
    const row = data[id] || {};
    const soopId = normalizeSoopId(row.soopId);
    const entry = { id: id, nickname: String(row.nickname || '').trim(), soopId: soopId, verifiedAt: row.verifiedAt || 0 };
    if (!entry.nickname && !entry.soopId) return;
    if (soopId && bySoopId[soopId]) {
      if ((entry.verifiedAt || 0) <= (bySoopId[soopId].verifiedAt || 0)) return;
      const oldIndex = entries.indexOf(bySoopId[soopId]);
      if (oldIndex >= 0) entries.splice(oldIndex, 1);
    }
    if (soopId) bySoopId[soopId] = entry;
    entries.push(entry);
  });
  return entries;
}

function normalizePromoStockMatchName(value) {
  return String(value || '').normalize('NFC').toLocaleLowerCase('ko-KR').trim()
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '');
}

const listStreamerPromoLinks = onCall(async (request) => {
  const adminUid = await requireAdmin(request);
  const db = getDatabase();
  const migration = await migrateStreamerPromoSeedToCandidates(db, adminUid, request);
  const [verifiedSnap, linksSnap, recentSnap, excludedPromoSnap, candidatesSnap, seedSnap, removedPromoSnap, stocksSnap] = await Promise.all([
    db.ref('streamerVerifications').get(),
    db.ref('adminCenter/streamerPromoLinks').get(),
    db.ref('adminCenter/streamerPromoRecent').get(),
    db.ref('adminCenter/streamerPromoExcluded').get(),
    db.ref('adminCenter/streamerPromoCandidates').get(),
    db.ref('adminCenter/streamerPromoSeed').get(),
    db.ref('adminCenter/streamerPromoRemoved').get(),
    db.ref('stocks').get(),
  ]);
  const links = linksSnap.val() || {};
  let recentOpened = recentSnap.val() || null;
  // 이전 버전은 항목마다 lastOpenedAt을 저장했으므로, 최초 조회 때 가장 최근
  // 1건만 공용 기록으로 승격하고 나머지 항목별 기록은 정리한다.
  if (!recentOpened) {
    Object.keys(links).forEach(function (key) {
      const item = links[key] || {};
      if (!item.lastOpenedAt || (recentOpened && recentOpened.lastOpenedAt >= item.lastOpenedAt)) return;
      recentOpened = {
        key: key,
        nickname: item.nickname || '',
        soopId: item.soopId || '',
        lastOpenedAt: item.lastOpenedAt,
        lastOpenedBy: item.lastOpenedBy || null,
      };
    });
  }
  const cleanupUpdates = {};
  Object.keys(links).forEach(function (key) {
    const item = links[key] || {};
    if (item.lastOpenedAt != null) cleanupUpdates['adminCenter/streamerPromoLinks/' + key + '/lastOpenedAt'] = null;
    if (item.lastOpenedBy != null) cleanupUpdates['adminCenter/streamerPromoLinks/' + key + '/lastOpenedBy'] = null;
  });
  if (!recentSnap.exists() && recentOpened) cleanupUpdates['adminCenter/streamerPromoRecent'] = recentOpened;
  if (Object.keys(cleanupUpdates).length) {
    await db.ref().update(cleanupUpdates);
  }
  const excludedPromoIds = excludedPromoSnap.val() || {};
  const removedPromoIds = removedPromoSnap.val() || {};
  const knownPromoEntries = getKnownPromoEntries(seedSnap.val(), verifiedSnap.val(), candidatesSnap.val());
  const isExcluded = function (entry) {
    return excludedPromoIds[entry.key] === true || (entry.soopId && excludedPromoIds[entry.soopId] === true);
  };
  const excludedStreamers = Object.keys(excludedPromoIds).filter(function (key) {
    return excludedPromoIds[key] === true;
  }).map(function (key) {
    const entry = knownPromoEntries.find(function (item) {
      return String(item.key || '').toLowerCase() === key.toLowerCase() || String(item.soopId || '').toLowerCase() === key.toLowerCase();
    });
    return {
      key: entry ? entry.key : key,
      nickname: entry ? String(entry.nickname || '') : '',
      soopId: entry ? String(entry.soopId || normalizeSoopId(key)) : normalizeSoopId(key),
    };
  });
  const streamers = knownPromoEntries.filter(function (entry) {
    return !isExcluded(entry) && !isPromoEntryRemoved(entry, removedPromoIds);
  });
  streamers.sort(function (a, b) {
    return (a.nickname || a.soopId).localeCompare((b.nickname || b.soopId), 'ko') || a.soopId.localeCompare(b.soopId);
  });
  const stockNames = Object.values(stocksSnap.val() || {}).map(function (stock) {
    return normalizePromoStockMatchName(stock && stock.name);
  }).filter(Boolean);
  const comparableStreamers = streamers.filter(function (entry) {
    return normalizePromoStockMatchName(entry.nickname);
  });
  const unlistedStreamers = comparableStreamers.filter(function (entry) {
    const nickname = normalizePromoStockMatchName(entry.nickname);
    return !stockNames.some(function (stockName) { return stockName.includes(nickname); });
  });
  return {
    streamers: streamers.map(function (entry) {
      const key = entry.key || promoStorageKey(entry.id, entry.soopId);
      const saved = links[key] || {};
      return {
        key: key,
        nickname: entry.nickname,
        soopId: entry.soopId,
        isManualCandidate: entry.isManualCandidate === true,
        canRemove: !!normalizeSoopId(entry.soopId),
        writeUrl: typeof saved.writeUrl === 'string' && saved.writeUrl ? saved.writeUrl : (entry.writeUrl || ''),
        promotedCompleted: saved.promotedCompleted === true,
        lastOpenedAt: recentOpened && recentOpened.key === key ? recentOpened.lastOpenedAt || null : null,
        updatedAt: saved.updatedAt || null,
      };
    }),
    unlistedStreamers: unlistedStreamers.map(function (entry) {
      return { nickname: String(entry.nickname || '').trim(), soopId: entry.soopId || '' };
    }),
    unlistedNicknameUnavailableCount: streamers.length - comparableStreamers.length,
    excludedStreamers: excludedStreamers,
    recentOpened: recentOpened || null,
    seedMigration: migration,
  };
});

const addStreamerPromoCandidate = onCall(async (request) => {
  const adminUid = await requireAdmin(request);
  const data = request.data || {};
  const nickname = String(data.nickname || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const soopId = normalizeSoopId(data.soopId);
  const writeUrl = normalizePromoUrl(data.writeUrl);
  if (!nickname || nickname.length > 100 || !soopId || !writeUrl) {
    throw new HttpsError('invalid-argument', '닉네임, SOOP 아이디, 글쓰기 URL을 확인해주세요.');
  }
  let parsedUrl;
  try { parsedUrl = new URL(writeUrl); } catch (_) { parsedUrl = null; }
  const pathMatch = parsedUrl && /^\/station\/([A-Za-z0-9]{2,20})\/post\/write\/([A-Za-z0-9_-]{1,80})\/?$/i.exec(parsedUrl.pathname);
  if (!parsedUrl || !['sooplive.com', 'www.sooplive.com'].includes(parsedUrl.hostname.toLowerCase()) ||
      !pathMatch || pathMatch[1].toLowerCase() !== soopId || parsedUrl.search || parsedUrl.hash) {
    throw new HttpsError('invalid-argument', '방송국 아이디와 일치하는 SOOP 글쓰기 주소만 등록할 수 있습니다.');
  }

  const db = getDatabase();
  const [verifiedSnap, candidatesSnap, seedSnap, removedPromoSnap] = await Promise.all([
    db.ref('streamerVerifications').get(),
    db.ref('adminCenter/streamerPromoCandidates').get(),
    db.ref('adminCenter/streamerPromoSeed').get(),
    db.ref('adminCenter/streamerPromoRemoved').get(),
  ]);
  const removedPromoIds = removedPromoSnap.val() || {};
  const entries = getKnownPromoEntries(seedSnap.val(), verifiedSnap.val(), candidatesSnap.val())
    .filter(function (entry) { return !isPromoEntryRemoved(entry, removedPromoIds); });
  const normalizedNickname = nickname.toLocaleLowerCase();
  const duplicate = entries.find(function (entry) {
    return String(entry.soopId || '').toLowerCase() === soopId ||
      String(entry.nickname || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase() === normalizedNickname;
  });
  if (duplicate) {
    throw new HttpsError('already-exists', '이미 홍보 리스트에 등록된 닉네임 또는 SOOP 아이디입니다: ' + (duplicate.nickname || duplicate.soopId));
  }

  const now = Date.now();
  const updates = {};
  updates['adminCenter/streamerPromoCandidates/' + soopId] = {
    nickname: nickname,
    soopId: soopId,
    writeUrl: writeUrl,
    createdAt: now,
    updatedAt: now,
    createdBy: adminUid,
    updatedBy: adminUid,
  };
  updates['adminCenter/streamerPromoRemoved/' + soopId] = null;
  updates['adminCenter/streamerPromoExcluded/' + soopId] = null;
  await db.ref().update(updates);
  await logToAdminAuditLog(db, request, '스트리머 홍보 후보 추가', nickname + ' (@' + soopId + ')');
  return { ok: true, nickname: nickname, soopId: soopId, writeUrl: writeUrl };
});

const removeStreamerPromoCandidate = onCall(async (request) => {
  const adminUid = await requireAdmin(request);
  const data = request.data || {};
  const requestedSoopId = normalizeSoopId(data.soopId);
  if (!requestedSoopId) {
    throw new HttpsError('invalid-argument', '홍보 목록에서 제외할 스트리머의 SOOP 아이디를 확인해주세요.');
  }

  const db = getDatabase();
  await migrateStreamerPromoSeedToCandidates(db, adminUid, request);
  const [verifiedSnap, candidatesSnap, seedSnap, recentSnap, linksSnap, removedSnap] = await Promise.all([
    db.ref('streamerVerifications').get(),
    db.ref('adminCenter/streamerPromoCandidates').get(),
    db.ref('adminCenter/streamerPromoSeed').get(),
    db.ref('adminCenter/streamerPromoRecent').get(),
    db.ref('adminCenter/streamerPromoLinks').get(),
    db.ref('adminCenter/streamerPromoRemoved').get(),
  ]);
  const candidates = candidatesSnap.val() || {};
  const removed = removedSnap.val() || {};
  const candidateKey = Object.keys(candidates).find(function (key) {
    const candidate = candidates[key] || {};
    return normalizeSoopId(candidate.soopId || key) === requestedSoopId;
  });
  const entry = getKnownPromoEntries(seedSnap.val(), verifiedSnap.val(), candidates)
    .find(function (item) { return item.soopId === requestedSoopId; });
  if (!entry || isPromoEntryRemoved(entry, removed)) {
    throw new HttpsError('not-found', '홍보 목록에서 제외할 스트리머를 찾을 수 없습니다.');
  }

  const now = Date.now();
  const links = linksSnap.val() || {};
  const savedLink = Object.assign({}, links[entry.key] || {}, links[requestedSoopId] || {});
  const updates = {};
  if (candidateKey) updates['adminCenter/streamerPromoCandidates/' + candidateKey] = null;
  updates['adminCenter/streamerPromoLinks/' + entry.key] = null;
  if (entry.key !== requestedSoopId) updates['adminCenter/streamerPromoLinks/' + requestedSoopId] = null;
  updates['adminCenter/streamerPromoRemoved/' + requestedSoopId] = {
    nickname: String(entry.nickname || ''),
    soopId: requestedSoopId,
    promoKey: String(entry.key || ''),
    removedAt: now,
    removedBy: adminUid,
    previousWriteUrl: String(savedLink.writeUrl || entry.writeUrl || ''),
    previousPromotedCompleted: savedLink.promotedCompleted === true,
  };
  updates['adminCenter/streamerPromoExcluded/' + requestedSoopId] = null;
  if (entry.key && entry.key !== requestedSoopId) updates['adminCenter/streamerPromoExcluded/' + entry.key] = null;
  const seed = seedSnap.val() || {};
  Object.keys(seed).forEach(function (key) {
    if (normalizeSoopId(seed[key] && (seed[key].soopId || key)) === requestedSoopId) {
      updates['adminCenter/streamerPromoSeed/' + key] = null;
    }
  });
  const recent = recentSnap.val() || null;
  if (recent && (recent.key === entry.key || normalizeSoopId(recent.soopId) === requestedSoopId)) {
    updates['adminCenter/streamerPromoRecent'] = null;
  }
  await db.ref().update(updates);
  await logToAdminAuditLog(db, request, '홍보 목록에서 스트리머 제외', (entry.nickname || requestedSoopId) + ' (@' + requestedSoopId + ')');
  return { ok: true, removed: true, nickname: entry.nickname || '', soopId: requestedSoopId, promoKey: entry.key || '' };
});

const setStreamerPromoExclusion = onCall(async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  const nickname = String(data.nickname || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const soopId = normalizeSoopId(data.soopId);
  const excluded = data.excluded === true;
  if (!nickname || nickname.length > 100 || !soopId) {
    throw new HttpsError('invalid-argument', '스트리머 닉네임과 SOOP 아이디를 확인해주세요.');
  }

  const db = getDatabase();
  const exclusionRef = db.ref('adminCenter/streamerPromoExcluded/' + soopId);
  if (excluded) {
    const [verifiedSnap, candidatesSnap, seedSnap, removedSnap] = await Promise.all([
      db.ref('streamerVerifications').get(),
      db.ref('adminCenter/streamerPromoCandidates').get(),
      db.ref('adminCenter/streamerPromoSeed').get(),
      db.ref('adminCenter/streamerPromoRemoved').get(),
    ]);
    const removed = removedSnap.val() || {};
    const known = getKnownPromoEntries(seedSnap.val(), verifiedSnap.val(), candidatesSnap.val())
      .filter(function (entry) { return !isPromoEntryRemoved(entry, removed); });
    const registered = known.find(function (entry) {
      return String(entry.soopId || '').toLowerCase() === soopId ||
        String(entry.nickname || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase() === nickname.toLocaleLowerCase();
    });
    if (registered) {
      throw new HttpsError('already-exists', '이미 홍보 리스트에 등록된 스트리머는 제외 목록에 추가할 수 없습니다.');
    }
    await exclusionRef.set(true);
  } else {
    await exclusionRef.remove();
  }
  await logToAdminAuditLog(db, request, excluded ? '홍보 후보 스트리머 제외' : '홍보 후보 스트리머 제외 해제', nickname + ' (@' + soopId + ')');
  return { ok: true, excluded: excluded, nickname: nickname, soopId: soopId };
});

const saveStreamerPromoLink = onCall(async (request) => {
  const adminUid = await requireAdmin(request);
  const data = request.data || {};
  const requestedPromoKey = String(data.promoKey || '').trim().toLowerCase();
  const requestedSoopId = normalizeSoopId(data.soopId);
  const requestedVerificationId = String(data.verificationId || '').trim();
  const writeUrl = normalizePromoUrl(data.writeUrl);
  if (!requestedPromoKey && !requestedSoopId && !requestedVerificationId) {
    throw new HttpsError('invalid-argument', '인증 스트리머 식별자가 필요합니다.');
  }

  const db = getDatabase();
  const [verifiedSnap, candidatesSnap, seedSnap] = await Promise.all([
    db.ref('streamerVerifications').get(),
    db.ref('adminCenter/streamerPromoCandidates').get(),
    db.ref('adminCenter/streamerPromoSeed').get(),
  ]);
  const entries = getKnownPromoEntries(seedSnap.val(), verifiedSnap.val(), candidatesSnap.val());
  const entry = entries.find(function (item) {
    return (requestedPromoKey && item.key === requestedPromoKey) ||
      (!requestedPromoKey && requestedSoopId && item.soopId === requestedSoopId) ||
      (!requestedPromoKey && !requestedSoopId && requestedVerificationId === item.id);
  });
  if (!entry) throw new HttpsError('failed-precondition', '등록된 스트리머만 수정할 수 있습니다.');

  const key = entry.key || promoStorageKey(entry.id, entry.soopId);
  const ref = db.ref('adminCenter/streamerPromoLinks/' + key);
  const existing = (await ref.get()).val() || {};
  if (!writeUrl) {
    await ref.remove();
    await logToAdminAuditLog(db, request, '스트리머 홍보글 링크 삭제', entry.nickname || entry.soopId);
    return { ok: true, removed: true };
  }
  await ref.set({
    nickname: entry.nickname,
    soopId: entry.soopId || null,
    writeUrl: writeUrl,
    createdAt: existing.createdAt || Date.now(),
    updatedAt: Date.now(),
    updatedBy: adminUid,
  });
  await logToAdminAuditLog(db, request, '스트리머 홍보글 링크 저장', entry.nickname || entry.soopId);
  return { ok: true, removed: false };
});

async function requireKnownPromoEntry(db, data) {
  const requestedKey = String((data || {}).promoKey || '').trim().toLowerCase();
  const requestedSoopId = normalizeSoopId((data || {}).soopId);
  const requestedVerificationId = String((data || {}).verificationId || '').trim();
  if (!requestedKey && !requestedSoopId && !requestedVerificationId) {
    throw new HttpsError('invalid-argument', '스트리머 식별자가 필요합니다.');
  }
  const [verifiedSnap, candidatesSnap, seedSnap] = await Promise.all([
    db.ref('streamerVerifications').get(),
    db.ref('adminCenter/streamerPromoCandidates').get(),
    db.ref('adminCenter/streamerPromoSeed').get(),
  ]);
  const entries = getKnownPromoEntries(seedSnap.val(), verifiedSnap.val(), candidatesSnap.val());
  const entry = entries.find(function (item) {
    return (requestedKey && item.key === requestedKey) ||
      (!requestedKey && requestedSoopId && item.soopId === requestedSoopId) ||
      (!requestedKey && !requestedSoopId && requestedVerificationId === item.id);
  });
  if (!entry) throw new HttpsError('not-found', '등록된 스트리머를 찾을 수 없습니다.');
  return entry;
}

const markStreamerPromoLinkOpened = onCall(async (request) => {
  const adminUid = await requireAdmin(request);
  const db = getDatabase();
  const entry = await requireKnownPromoEntry(db, request.data || {});
  const lastOpenedAt = Date.now();
  const linksSnap = await db.ref('adminCenter/streamerPromoLinks').get();
  const links = linksSnap.val() || {};
  const updates = {
    'adminCenter/streamerPromoRecent': {
      key: entry.key,
      nickname: entry.nickname || '',
      soopId: entry.soopId || '',
      lastOpenedAt: lastOpenedAt,
      lastOpenedBy: adminUid,
    },
  };
  Object.keys(links).forEach(function (key) {
    const item = links[key] || {};
    if (item.lastOpenedAt != null) updates['adminCenter/streamerPromoLinks/' + key + '/lastOpenedAt'] = null;
    if (item.lastOpenedBy != null) updates['adminCenter/streamerPromoLinks/' + key + '/lastOpenedBy'] = null;
  });
  await db.ref().update(updates);
  return { ok: true, lastOpenedAt: lastOpenedAt, recentOpened: updates['adminCenter/streamerPromoRecent'] };
});

const setStreamerPromoCompletion = onCall(async (request) => {
  const adminUid = await requireAdmin(request);
  const data = request.data || {};
  if (typeof data.completed !== 'boolean') {
    throw new HttpsError('invalid-argument', 'completed 값은 true/false여야 합니다.');
  }
  const db = getDatabase();
  const entry = await requireKnownPromoEntry(db, data);
  const ref = db.ref('adminCenter/streamerPromoLinks/' + entry.key);
  if (!data.completed) {
    await ref.update({ promotedCompleted: null, promotedAt: null, promotedBy: null });
    return { ok: true, completed: false };
  }
  const now = Date.now();
  await ref.update({
    nickname: entry.nickname,
    soopId: entry.soopId || null,
    promotedCompleted: true,
    promotedAt: now,
    promotedBy: adminUid,
  });
  return { ok: true, completed: true, promotedAt: now };
});

const clearAllStreamerPromoCompletion = onCall(async (request) => {
  await requireAdmin(request);
  const db = getDatabase();
  const snap = await db.ref('adminCenter/streamerPromoLinks').get();
  const data = snap.val() || {};
  const updates = {};
  let clearedCount = 0;
  Object.keys(data).forEach(function (key) {
    if (data[key] && data[key].promotedCompleted === true) {
      updates['adminCenter/streamerPromoLinks/' + key + '/promotedCompleted'] = null;
      updates['adminCenter/streamerPromoLinks/' + key + '/promotedAt'] = null;
      updates['adminCenter/streamerPromoLinks/' + key + '/promotedBy'] = null;
      clearedCount += 1;
    }
  });
  if (clearedCount) await db.ref().update(updates);
  return { ok: true, clearedCount: clearedCount };
});

// 24번 — 디스코드 웹훅 검수 알림. 웹훅 URL은 비밀번호와 동급인 민감정보라
// RTDB가 아니라 Secret Manager에 저장한다(05번에서 겪은 RTDB 규칙 동기화
// 실수 사고를 이 값에는 반복하지 않기 위함). 시크릿 컨테이너 자체는
// 미리 CLI로 한 번 만들어둬야 한다:
//   firebase functions:secrets:set DISCORD_WEBHOOK_URL --project soop-stock-market
const secretClient = new SecretManagerServiceClient();
const DISCORD_WEBHOOK_SECRET = 'DISCORD_WEBHOOK_URL';

function discordSecretParent() {
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  return `projects/${project}/secrets/${DISCORD_WEBHOOK_SECRET}`;
}

// 관리자가 통합 관리 센터 화면에서 웹훅 URL을 입력하면, RTDB가 아니라
// Secret Manager에 새 버전으로 기록한다. 입력값을 그대로 돌려주지 않는다
// (쓰기 전용) — UI는 getDiscordWebhookStatus로 "설정됨/설정 안 됨"만 표시한다.
const setDiscordWebhookUrl = onCall(async (request) => {
  await requireAdmin(request);
  const url = String((request.data || {}).url || '').trim();
  if (!/^https:\/\/discord(app)?\.com\/api\/webhooks\//.test(url)) {
    throw new HttpsError('invalid-argument', '올바른 디스코드 웹훅 URL이 아닙니다.');
  }
  await secretClient.addSecretVersion({
    parent: discordSecretParent(),
    payload: { data: Buffer.from(url, 'utf8') },
  });
  const db = getDatabase();
  await logToAdminAuditLog(db, request, '디스코드 웹훅 URL 변경', '');
  return { ok: true };
});

// 시크릿의 값(payload)은 절대 조회하지 않고, 활성화된 버전이 있는지만
// 확인한다 — 값을 화면에 다시 보여줄 방법 자체를 만들지 않기 위함.
const getDiscordWebhookStatus = onCall(async (request) => {
  await requireAdmin(request);
  try {
    const [versions] = await secretClient.listSecretVersions({
      parent: discordSecretParent(),
      filter: 'state:ENABLED',
    });
    return { configured: versions.length > 0 };
  } catch (e) {
    return { configured: false };
  }
});

// 실제 알림 발송 — 트리거 함수들이 공용으로 쓰는 헬퍼. 매번 최신 버전(latest)을
// 읽으므로, 관리자가 URL을 바꾸면 재배포 없이 다음 알림부터 바로 반영된다.
// placeholder 상태(최초 부트스트랩 값)이거나 아직 설정 전이면 조용히 건너뛴다.
// 반환값은 트리거 함수들은 신경 쓰지 않지만, sendTestDiscordNotification처럼
// 사람에게 성공/실패를 알려줘야 하는 호출부를 위해 상태를 그대로 돌려준다.
async function sendDiscordNotification(text) {
  let webhookUrl;
  try {
    const [version] = await secretClient.accessSecretVersion({
      name: `${discordSecretParent()}/versions/latest`,
    });
    webhookUrl = version.payload.data.toString('utf8');
  } catch (e) {
    console.error('디스코드 웹훅 시크릿을 읽을 수 없음', e);
    return { sent: false, reason: 'secret-read-failed' };
  }
  if (!webhookUrl || !webhookUrl.startsWith('https://discord')) {
    return { sent: false, reason: 'not-configured' };
  }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) {
      console.error('디스코드 웹훅 전송 실패 - 응답 코드', res.status);
      return { sent: false, reason: 'discord-rejected-' + res.status };
    }
    return { sent: true };
  } catch (e) {
    console.error('디스코드 웹훅 전송 실패', e);
    return { sent: false, reason: 'network-error' };
  }
}

// 관리 센터 UI의 "테스트 알림 보내기" 버튼용 — 프로덕션 RTDB에 가짜 데이터를
// 만들지 않고, 지금 설정된 웹훅으로 실제 메시지 한 건만 즉시 보내서 연결을
// 검증한다. 성공/실패를 그대로 반환해 UI가 사람이 읽을 결과를 보여줄 수 있다.
const sendTestDiscordNotification = onCall(async (request) => {
  await requireAdmin(request);
  const result = await sendDiscordNotification(
    '✅ **테스트 알림** — 통합 관리 센터 디스코드 웹훅 연결이 정상입니다.'
  );
  return result;
});

// interior-3d-viewer의 프리셋 소유권 병합 실패 — 13번에서 확인했듯 이 시리즈에서
// 유일하게 관리자가 CLI로 직접 RTDB를 만져야 처리되는 사각지대라, 가장 먼저
// 연결하는 트리거. RTDB 트리거는 프로젝트 전체에 걸리므로, interior-3d-viewer의
// 코드를 전혀 건드리지 않고 admin-center가 이 경로를 그대로 감시할 수 있다.
// 19번(세션 빠른 이동) 완료로 admin-center의 각 카드에 고유 앵커 id가 생겨서,
// 24번 설계 당시 미뤄뒀던 딥링크를 이제 붙일 수 있다 - URL 프래그먼트만 그
// id로 맞추면 별도 라우팅 없이 해당 카드로 바로 스크롤된다(admin-center
// 쪽에서 location.hash를 읽어 스크롤하는 처리 필요, index.html 참고).
const ADMIN_CENTER_URL = 'https://neezu-crypto.github.io/admin-center/';
function deepLink(anchorId) {
  return ADMIN_CENTER_URL + '#' + anchorId;
}

const notifyPresetMergeFailure = onValueCreated('/presetMergeFailures/{entryId}', async (event) => {
  const data = event.data.val() || {};
  const oldUid = data.oldUid || '(알 수 없음)';
  const newUid = data.newUid || '(알 수 없음)';
  const reason = data.reason || '(사유 없음)';
  await sendDiscordNotification(
    '🔔 **프리셋 소유권 병합 실패** — 배경시장\n' +
    '이전 uid: `' + oldUid + '`\n' +
    '새 uid: `' + newUid + '`\n' +
    '사유: ' + reason + '\n' +
    '⚠️ 현재는 관리자가 CLI로 직접 처리해야 합니다.\n' +
    deepLink('section-review-queue')
  );
});

// 나머지 검수·승인 큐 — 24번 표에 정리된 경로 전부. 신청 노드마다 필드 이름이
// 조금씩 다르지만(nickname/streamerId, soopId, stockName, days/hours, qty 등)
// 공통으로 있을 법한 필드만 골라 한 줄 요약을 만든다 — 큐마다 완벽한 포맷을
// 새로 짜는 대신, 06번 원칙처럼 하나의 공용 로직으로 감싼다.
function formatRequestSummary(data) {
  const parts = [];
  const name = data.nickname || data.streamerId || '';
  if (name) parts.push(name + (data.soopId ? ' (@' + data.soopId + ')' : ''));
  else if (data.requesterUid || data.uid) parts.push('uid: ' + (data.requesterUid || data.uid));
  if (data.stockName) parts.push('종목: ' + data.stockName);
  if (data.days) parts.push(data.days + '일');
  if (data.hours) parts.push(data.hours + '시간');
  if (data.qty) parts.push(data.qty + '개');
  if (data.reason) parts.push('사유: ' + data.reason);
  const liveUrl = streamerLiveUrlForData(data);
  if (liveUrl) parts.push('라이브: ' + liveUrl);
  return parts.length ? parts.join(' · ') : '(상세 정보 없음)';
}

// 스트리머 아이디가 있는 알림에는 바로 방송을 확인할 수 있는 SOOP 라이브
// 주소를 함께 표시한다. streamerId는 일부 큐에서 SOOP 아이디로 쓰이고,
// 일부 큐에서는 내부 식별자일 수 있으므로 영문/숫자 형식일 때만 링크를 만든다.
function streamerLiveUrlForData(data) {
  const raw = String((data && (data.soopId || data.streamerId)) || '').trim();
  if (!/^[A-Za-z0-9]{2,20}$/.test(raw)) return '';
  return 'https://play.sooplive.com/' + encodeURIComponent(raw.toLowerCase()) + '/';
}

function makeQueueTrigger(path, label, anchorId) {
  return onValueCreated(path, async (event) => {
    const data = event.data.val() || {};
    await sendDiscordNotification('🔔 **' + label + '**\n' + formatRequestSummary(data) + '\n' + deepLink(anchorId));
  });
}

const notifyMarketReport            = makeQueueTrigger('/bettingMarket/marketReports/{id}', '새 마켓 신고 (배팅시장)', 'section-review-queue');
const notifyNicknameReport          = makeQueueTrigger('/bettingMarket/nicknameReports/{id}', '새 닉네임 신고 (배팅시장)', 'section-review-queue');
const notifyBettingVerifyRequest    = makeQueueTrigger('/bettingMarket/verifyRequests/{id}', '새 인증 신청 (배팅시장)', 'section-verification');
// source 필드(2026-08-22, streamer-life-game 16장 도입, 사용자 승인)로 어느
// 앱에서 온 신청인지 구분한다 - 이 필드가 생기기 전 신청·기존 주식시장
// 호출부는 값을 안 보내므로(undefined) '주식시장'으로 폴백
// (notifyVerifiedStreamerVisit의 marketLabel과 동일한 패턴).
const STREAMER_VERIFY_SOURCE_LABELS = {
  'life-game': '인생게임',
  'streamer-fanpage': '팬페이지',
  'streamer-gallery': '갤러리',
  'streamer-messenger': '스트리머 메신저',
  'onyu-vn': '온 이유',
};
const notifyStockVerifyRequest = onValueCreated('/streamerVerificationRequests/{id}', async (event) => {
  const data = event.data.val() || {};
  const sourceLabel = STREAMER_VERIFY_SOURCE_LABELS[data.source] || '주식시장';
  const label = '새 인증 신청 (' + sourceLabel + ')';
  await sendDiscordNotification('🔔 **' + label + '**\n' + formatRequestSummary(data) + '\n' + deepLink('section-verification'));
});
const notifyStreamerVerificationAutoApproval = onValueUpdated('/streamerVerificationNoteClaims/{noteNo}', async (event) => {
  const before = event.data.before.val() || {};
  const claim = event.data.after.val() || {};
  const notification = claim.discordNotification;
  if (before.status === 'approved' || claim.status !== 'approved' ||
      !notification || notification.type !== 'streamer-verification-auto-approved') return null;

  const clean = (value, maxLength) => String(value || '').replace(/[\r\n`*_@]/g, ' ').trim().slice(0, maxLength);
  const sourceLabel = notification.service === 'betting-market'
    ? '배팅시장'
    : STREAMER_VERIFY_SOURCE_LABELS[notification.source] || '주식시장';
  const nickname = clean(notification.nickname, 60) || '(닉네임 없음)';
  const soopId = /^[a-z0-9]{2,20}$/i.test(String(notification.soopId || ''))
    ? String(notification.soopId).toLowerCase()
    : '';
  const deliveryRef = getDatabase().ref('streamerVerificationNoteClaims/' + event.params.noteNo + '/discordNotificationDelivery');
  const deliveryToken = String(event.id || 'event') + ':' + Date.now();
  const deliveryClaim = await deliveryRef.transaction((current) => {
    const now = Date.now();
    if (current && current.status === 'sent') return;
    if (current && current.status === 'processing' && now - Number(current.startedAt || now) < 2 * 60 * 1000) return;
    return { status: 'processing', token: deliveryToken, startedAt: now };
  }, undefined, false);
  if (!deliveryClaim.committed) return null;

  const result = await sendDiscordNotification(
    '✅ **스트리머 인증 쪽지 자동승인 완료**\n' +
    '신청 서비스: ' + sourceLabel + '\n' +
    '스트리머: ' + nickname + (soopId ? ' (@' + soopId + ')' : '') + '\n' +
    '신청 유형: ' + (notification.isSwitch === true ? '계정 전환' : '최초 인증') + '\n' +
    deepLink('section-verification')
  );
  await deliveryRef.transaction((current) => {
    if (!current || current.token !== deliveryToken) return;
    return result.sent
      ? { status: 'sent', sentAt: Date.now() }
      : { status: 'failed', reason: result.reason || 'unknown', failedAt: Date.now() };
  }, undefined, false);
  if (!result.sent) console.warn('스트리머 인증 자동승인 디스코드 알림 전송 실패:', result.reason);
  await getDatabase().ref('streamerVerificationNoteClaims/' + event.params.noteNo + '/discordNotification').remove();
  return null;
});
const notifyChestPurchaseRequest    = makeQueueTrigger('/bettingMarket/chestPurchaseRequests/{id}', '새 보물상자 구매 신청 (배팅시장)', 'section-purchase-approval');
const notifyBannerRequest           = makeQueueTrigger('/bannerRequests/{id}', '새 배너 신청 (주식시장)', 'section-purchase-approval');
const notifyChartBannerRequest      = makeQueueTrigger('/chartBannerRequests/{id}', '새 차트 배너 신청 (주식시장)', 'section-purchase-approval');
const notifyCardBannerRequest       = makeQueueTrigger('/cardBannerRequests/{id}', '새 카드 배너 신청 (주식시장)', 'section-purchase-approval');
const notifyPinRequest              = makeQueueTrigger('/pinRequests/{id}', '새 고정노출 신청 (주식시장)', 'section-purchase-approval');
const notifyRelayRoomRequest        = makeQueueTrigger('/relayRoomRequests/{id}', '새 중계방 신청 (주식시장)', 'section-purchase-approval');
const notifyTreasureChestRequest    = makeQueueTrigger('/treasureChestRequests/{id}', '새 보물상자 구매 신청 (주식시장)', 'section-purchase-approval');
const notifyCashChargeRequest       = makeQueueTrigger('/cashChargeRequests/{id}', '새 자산 충전 신청 (주식시장)', 'section-purchase-approval');
const notifyUnfreezeDonationRequest = makeQueueTrigger('/unfreezeDonationRequests/{id}', '새 동결 해제(후원) 신청 (주식시장)', 'section-purchase-approval');
const notifyMessengerReport = onValueCreated('/streamerMessenger/reports/{id}', async (event) => {
  const reportId = String(event.params.id || '').replace(/[\r\n`]/g, '').slice(0, 100);
  const data = event.data.val() || {};
  const at = Number(data.createdAt) || Date.now();
  // 신고자의 대화 내용, UID, 사유는 Discord로 보내지 않는다. 자세한 검토는 관리자 전용 페이지에서 한다.
  await sendDiscordNotification('🔔 **새 스트리머 메신저 신고**\n신고 ID: `' + reportId + '`\n접수 시각: ' + new Date(at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + '\n' + deepLink('section-review-queue'));
});
const notifyListingRequest          = makeQueueTrigger('/listingRequests/{id}', '새 종목 상장 신청 (주식시장)', 'section-listing-request');
// 이전 일반 시청자 접근 신청은 종료됐다. 배포된 옛 writer가 남아 있더라도
// 더는 게임 권한과 무관한 Discord 알림을 발생시키지 않도록 호환 trigger만 유지한다.
const notifyOnyuViewerAccessRequest = onValueCreated('/onyuVn/viewerAccessAlerts/{id}', async () => null);
const notifyOnyuStreamerGameGiftRequest = onValueCreated('/onyuVn/streamerGameGiftRequests/{requestId}', async (event) => {
  const data = event.data.val() || {};
  const target = String(data.targetNickname || '(닉네임 없음)').replace(/[\r\n`]/g, ' ').slice(0, 60);
  const donor = String(data.donorNickname || '(닉네임 미입력)').replace(/[\r\n`]/g, ' ').slice(0, 60);
  const balloons = Math.max(0, Number(data.balloons) || 50);
  const isViewerPurchase = data.purchaseType === 'self-viewer';
  const isSelfPurchase = data.purchaseType === 'self' || isViewerPurchase;
  await sendDiscordNotification(
    (isViewerPurchase ? '🎟️ **온 이유 게임 본인 이용권 구매 신청**\n' : isSelfPurchase ? '🎟️ **온 이유 스트리머 게임 이용권 직접 구매 신청**\n' : '🎁 **온 이유 스트리머 게임 선물 신청**\n') +
    (isSelfPurchase ? '구매자/이용권 대상: ' : '선물 대상: ') + target + (data.targetSoopId ? ' (@' + String(data.targetSoopId).replace(/[\r\n`]/g, '').slice(0, 30) + ')' : '') + '\n' +
    '후원자 닉네임: ' + donor + ' · 별풍선 ' + balloons + '개\n' +
    '실제 후원을 확인한 뒤 관리자센터에서 승인해 주세요.\n' + deepLink('section-onyu-access')
  );
});
const notifyOnyuProductionInquiry = onValueCreated('/onyuVn/productionInquiries/{requestId}', async (event) => {
  const data = event.data.val() || {};
  const safeText = (value, fallback, maxLength) => String(value || fallback || '')
    .replace(/[\r\n`*_~|>]/g, ' ')
    .replace(/@/g, '＠')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  const nickname = safeText(data.nickname, '닉네임 없음', 80);
  const soopId = safeText(data.soopId, '', 30);
  const description = safeText(data.description, '문의 내용 없음', 240);
  await sendDiscordNotification(
    '🎬 **온 이유 미연시 제작 문의**\n' +
    '인증 스트리머: ' + nickname + (soopId ? ' (@' + soopId + ')' : '') + '\n' +
    '문의 내용: ' + description + '\n' +
    '관리자센터에서 자세한 내용을 확인해 주세요.\n' + deepLink('section-onyu-production-inquiries')
  );
});
const notifyOnyuStreamerGameGiftAutoApproval = onValueUpdated('/onyuVn/streamerGameGiftRequests/{requestId}', async (event) => {
  const before = event.data.before.val() || {};
  const data = event.data.after.val() || {};
  if (before.status === 'approved' || data.status !== 'approved' || data.verificationSource !== 'soop-donation-notification') return null;
  const safeText = (value, fallback) => String(value || fallback || '').replace(/[\r\n`*_]/g, ' ').slice(0, 80);
  const purchaseType = data.purchaseType === 'self-viewer'
    ? '일반 이용자 본인 구매'
    : data.purchaseType === 'self'
      ? '스트리머 본인 구매'
      : '스트리머 선물';
  const donor = safeText(data.donorNickname, '(닉네임 미입력)');
  const donorSoopId = safeText(data.verificationSenderSoopId || data.donorSoopId, '');
  const target = safeText(data.targetNickname, '(대상 없음)');
  const targetSoopId = safeText(data.targetSoopId, '');
  const activationStatus = data.activationStatus === 'awaiting-streamer-verification'
    ? '후원 확인 완료 · 대상 스트리머 인증 승인 후 이용권 자동 연결 대기'
    : data.activationStatus === 'blocked-existing-entitlement'
      ? '후원 확인 완료 · 기존 이용권 여부 관리자 확인 필요'
      : '후원 확인 및 이용권 승인 완료';
  await sendDiscordNotification(
    '✅ **온이유 이용권 후원 자동 확인**\n' +
    '신청 유형: ' + purchaseType + '\n' +
    '후원자: ' + donor + (donorSoopId ? ' (@' + donorSoopId + ')' : '') + ' · 별풍선 ' + (Number(data.balloons) || 50) + '개\n' +
    '대상: ' + target + (targetSoopId ? ' (@' + targetSoopId + ')' : '') + '\n' +
    '결과: ' + activationStatus + '\n' +
    deepLink('section-onyu-access')
  );
  return null;
});

// 2026-09-05 추가(신규 게임 온보딩 체크리스트) — 인생게임/갤러리의 신고 큐는
// admin-center 페이지 안에 대응하는 섹션이 없고, 각 사이트 자체 관리 패널에서
// 처리한다. 그래서 makeQueueTrigger의 deepLink(admin-center#anchor 고정)를 그대로
// 못 쓰고, 그 사이트 자신의 URL로 안내하는 커스텀 트리거를 쓴다.
const notifyLifeGameReportAlert = onValueCreated('/lifeGame/galleryReports/{id}', async (event) => {
  const data = event.data.val() || {};
  await sendDiscordNotification('🔔 **새 갤러리 신고 (인생게임)**\n' + formatRequestSummary(data) + '\nhttps://neezu-crypto.github.io/streamer-life-game/ (관리자 패널에서 확인)');
});
// 게임 후기 신고 - 신고 노드는 reviewPublicId를 저장하므로 해당 공개 후기에서
// 별점·본문·작성자 정보를 함께 읽어 Discord 알림에 표시한다.
const notifyLifeGameReviewReportAlert = onValueCreated('/lifeGame/reviewReports/{id}', async (event) => {
  const data = event.data.val() || {};
  const reviewPublicId = String(data.reviewPublicId || data.reviewUid || '').trim();
  let review = null;
  if (reviewPublicId) {
    try {
      const reviewSnap = await db.ref('lifeGame/reviewsPublic/' + reviewPublicId).get();
      review = reviewSnap.val() || null;
    } catch (error) {
      console.error('인생게임 신고 후기 조회 실패:', reviewPublicId, error);
    }
  }
  const safeText = (value, maxLength) => String(value || '')
    .replace(/@/g, '@\u200b')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, maxLength);
  const reportId = safeText(event.params.id, 120) || '(알 수 없음)';
  const safeReviewPublicId = safeText(reviewPublicId, 120) || '(알 수 없음)';
  const nickname = safeText(review && review.nickname, 100);
  const soopId = safeText(review && review.soopId, 40);
  const rating = Number(review && review.rating);
  const reviewText = safeText(review && review.text, 500);
  const reason = safeText(data.reason, 300);
  const reportedAt = Number(data.reportedAt);
  const reportedAtText = Number.isFinite(reportedAt) && reportedAt > 0
    ? new Date(reportedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
    : '접수 시각 미상';
  const reviewBody = review
    ? reviewText.replace(/\r\n?/g, '\n').replace(/\n/g, '\n> ') || '(후기 본문 없음)'
    : '(원문을 불러오지 못했습니다. 후기 ID로 관리자 화면에서 확인해주세요.)';
  await sendDiscordNotification(
    '🔔 **새 후기 신고 (인생게임)**' +
    '\n신고 ID: `' + reportId + '` · 접수: ' + reportedAtText +
    '\n대상 후기 ID: `' + safeReviewPublicId + '`' +
    (nickname || soopId ? '\n작성자: ' + (nickname || '닉네임 미입력') + (soopId ? ' · SOOP ID: ' + soopId : '') : '') +
    (Number.isFinite(rating) && rating >= 1 && rating <= 5 ? '\n별점: ' + rating + '/5' : '') +
    '\n후기 내용:\n> ' + reviewBody +
    '\n신고 사유: ' + (reason || '미기재') +
    '\nhttps://neezu-crypto.github.io/streamer-life-game/ (관리자 패널 → 신고된 후기)'
  );
});
const notifyLifeGameSponsorRequest = onValueCreated('/lifeGame/sponsorRequests/{id}', async (event) => {
  const data = event.data.val() || {};
  const liveUrl = streamerLiveUrlForData(data);
  await sendDiscordNotification(
    '🔔 **새 후원 스트리머 신청 (인생게임)**\n' + (data.nickname || '(알 수 없음)') +
    (data.soopId ? ' (@' + data.soopId + ')' : '') +
    (data.days ? ' · ' + data.days + '일' : '') +
    (data.starBalloons ? ' · 별풍선 ' + data.starBalloons + '개' : '') +
    (liveUrl ? '\n라이브: ' + liveUrl : '') +
    '\n' + deepLink('section-purchase-approval')
  );
});
const notifyGalleryImageReport = onValueCreated('/gallery/imageReports/{id}', async (event) => {
  const data = event.data.val() || {};
  await sendDiscordNotification('🔔 **새 이미지 신고 (스트리머 갤러리)**\n' + formatRequestSummary(data) + '\nhttps://neezu-crypto.github.io/streamer-gallery/ (관리자 패널에서 확인)');
});
const notifyGalleryCommentReport = onValueCreated('/gallery/commentReports/{id}', async (event) => {
  const data = event.data.val() || {};
  const commentText = String(data.commentText || '(내용 없음)').replace(/[\r\n]/g, ' ').slice(0, 180);
  const reason = String(data.reason || '(사유 없음)').replace(/[\r\n]/g, ' ').slice(0, 180);
  await sendDiscordNotification(
    '🔔 **새 댓글 신고 (스트리머 갤러리)**\n' +
    '댓글: ' + commentText + '\n' +
    '작성자 uid: `' + (data.commentAuthorUid || '(알 수 없음)') + '`\n' +
    '신고자 uid: `' + (data.reporterUid || '(알 수 없음)') + '`\n' +
    '사유: ' + reason + '\n' +
    'https://neezu-crypto.github.io/streamer-gallery/ (관리자 패널에서 확인)'
  );
});
// 스트리머별 업로드 잠금 해금 신청(2026-09-05 추가) — 별풍선 100개 후원 인증은
// 완전 수동(soop-stock-market의 "동결 해제(후원)"와 동일 원칙)이라 관리자가 빨리
// 알아야 한다. formatRequestSummary는 streamerName 필드를 모르므로 직접 문구 구성.
const notifyGalleryUnlockRequest = onValueCreated('/gallery/unlockRequests/{id}', async (event) => {
  const data = event.data.val() || {};
  const liveUrl = streamerLiveUrlForData(data);
  await sendDiscordNotification(
    '🔔 **새 스트리머 해금 신청 (스트리머 갤러리)**\n' +
    (data.streamerName || '(알 수 없음)') + ' · 후원자 닉네임: ' + (data.nickname || '(알 수 없음)') +
    (liveUrl ? '\n라이브: ' + liveUrl : '') +
    '\nhttps://neezu-crypto.github.io/streamer-gallery/ (관리자 패널에서 확인)'
  );
});
// 스트리머 고점체크 계정 구독 신청은 팬페이지 함수가 서버 전용 pending 큐에
// 요청 ID를 기록한다. Discord에는 SOOP 아이디만 공유하고 Firebase UID는 보내지 않는다.
const notifyFanPageViewerSubscriptionRequest = onValueCreated('/streamerFanPageViewerSubscriptionPending/{requestId}', async (event) => {
  const requestId = String(event.params.requestId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (!requestId) return;
  const requestSnapshot = await getDatabase()
    .ref('streamerFanPageViewerSubscriptionRequests/' + requestId)
    .get();
  const data = requestSnapshot.val() || {};
  const nickname = String(data.nickname || '(닉네임 없음)')
    .replace(/[@<>\r\n`]/g, ' ')
    .slice(0, 60);
  const donorSoopId = normalizeSoopId(data.donorSoopId);
  const requestedAt = Number(data.requestedAt) || Date.now();
  const requestedAtText = new Date(requestedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  await sendDiscordNotification(
    '🔔 **새 구독 신청 (스트리머 고점체크)**\n' +
    '후원자 닉네임: ' + nickname + (donorSoopId ? ' · SOOP 아이디: @' + donorSoopId : '') +
    ' · 별풍선 ' + (Number(data.balloonCost) || FANPAGE_VIEWER_SUBSCRIPTION_BALLOONS) + '개 / 30일\n' +
    '신청 시각: ' + requestedAtText + '\n' +
    '후원 완료 신호 후 자동 대조하며, 일치하지 않거나 여러 신청과 겹치는 경우 팬페이지 관리자 통계에서 확인해 주세요.\n' +
    'https://neezu-crypto.github.io/streamer-fanpage/'
  );
});
// 고점체크 후원 스트리머 신청도 새 대기 인덱스가 생성되면 Discord로 알린다.
// 요청 본문은 server-only 요청 노드에서 읽고, Firebase UID는 알림에 포함하지 않는다.
const notifyFanPageSponsorAdRequest = onValueCreated('/streamerFanPageSponsorPending/{requestId}', async (event) => {
  const requestId = String(event.params.requestId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (!requestId) return null;
  const requestSnapshot = await getDatabase()
    .ref('streamerFanPageSponsorRequests/' + requestId)
    .get();
  const data = requestSnapshot.val() || {};
  if (!Object.keys(data).length) {
    console.warn('고점체크 홍보 신청 디스코드 알림: 연결된 신청 데이터가 없습니다.', requestId);
    return null;
  }
  const clean = (value, maxLength) => String(value || '')
    .replace(/[@<>\r\n`*_~|]/g, ' ')
    .trim()
    .slice(0, maxLength);
  const nickname = clean(data.nickname, 60) || '(닉네임 없음)';
  const streamerSoopId = normalizeSoopId(data.soopId);
  const donorSoopId = normalizeSoopId(data.donorSoopId);
  const days = Math.max(1, Math.min(30, Number(data.days) || 1));
  const balloons = Math.max(0, Number(data.balloonCost) || days * 10);
  const railLabel = data.rail === 'right' ? '오른쪽' : data.rail === 'left' ? '왼쪽' : '(확인 필요)';
  const requestedAt = Number(data.requestedAt) || Date.now();
  const requestedAtText = new Date(requestedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const statusLabel = data.status === 'approved' ? '\n상태: 이미 승인됨' : '';
  await sendDiscordNotification(
    '🔔 **새 홍보 신청 (스트리머 고점체크)**\n' +
    '홍보 대상: ' + nickname + (streamerSoopId ? ' · @' + streamerSoopId : '') + '\n' +
    '후원 계정: ' + (donorSoopId ? '@' + donorSoopId : '(확인 필요)') +
    ' · 별풍선 ' + balloons.toLocaleString('ko-KR') + '개 / ' + days + '일\n' +
    '홍보 위치: ' + railLabel + '\n' +
    '신청 시각: ' + requestedAtText +
    statusLabel + '\n' +
    '신청 번호: `' + requestId + '`\n' +
    deepLink('section-fanpage-sponsor-ads')
  );
});
// 팬페이지 디자인 문의·건의가 서버에 저장되면 관리자가 확인할 수 있도록 알림을 보낸다.
// Discord에는 문의 유형과 인증된 제출자·대상 팬페이지의 공개 신원만 보내며 제목·본문·UID는 포함하지 않는다.
const FANPAGE_FEEDBACK_CATEGORY_LABELS = {
  design: '디자인 변경 문의',
  suggestion: '기능 건의',
  bug: '오류 제보',
  other: '기타',
};
const notifyFanPageDesignFeedback = onValueCreated('/streamerFanPageDesignFeedback/{feedbackId}', async (event) => {
  const data = event.data.val() || {};
  const category = FANPAGE_FEEDBACK_CATEGORY_LABELS[data.category] || '기타';
  const senderVerification = data.senderVerification && typeof data.senderVerification === 'object'
    ? data.senderVerification
    : {};
  const senderNickname = String(senderVerification.nickname || '')
    .replace(/[@<>\r\n`]/g, ' ')
    .trim()
    .slice(0, 60);
  const senderSoopId = /^[A-Za-z0-9]{2,20}$/.test(String(senderVerification.soopId || ''))
    ? String(senderVerification.soopId).toLowerCase()
    : '';
  const verifiedAt = Number(senderVerification.verifiedAt) || 0;
  const verifiedAtText = verifiedAt
    ? new Date(verifiedAt).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })
    : '확인됨';
  const nickname = String(data.streamerNickname || '')
    .replace(/[@<>\r\n`]/g, ' ')
    .trim()
    .slice(0, 60);
  const soopId = /^[A-Za-z0-9]{2,20}$/.test(String(data.streamerId || ''))
    ? String(data.streamerId).toLowerCase()
    : '';
  const target = nickname
    ? `대상: ${nickname}${soopId ? ` (@${soopId})` : ''} 팬페이지`
    : '대상: 사이트 전체';
  const sender = senderNickname
    ? `인증 제출자: ${senderNickname}${senderSoopId ? ` (@${senderSoopId})` : ''} · 인증일 ${verifiedAtText}`
    : '인증 제출자 정보 없음';
  await sendDiscordNotification(
    '🔔 **새 팬페이지 디자인 문의 / 건의**\n' +
    '유형: ' + category + '\n' +
    sender + '\n' +
    target + '\n' +
    '상세 내용은 팬페이지 관리자 통계에서 확인해 주세요.\n' +
    'https://neezu-crypto.github.io/streamer-fanpage/'
  );
});
// 이미지 업로드 알림(2026-09-06 추가) — formatRequestSummary는 streamerName/
// category 필드를 모르므로(streamerId를 이름으로 착각해 내부 id 문자열을
// 그대로 보여줄 위험) 위 해금 신청과 동일하게 직접 문구를 구성한다. 썸네일
// URL을 본문에 그대로 넣어두면 Discord가 자동으로 미리보기 임베드를 붙여준다
// (별도 embeds payload 없이도 sendDiscordNotification의 단순 text 방식으로 충분).
const GALLERY_CATEGORY_LABELS = { screenshot: '스크린샷', 'ai-art': 'AI 일러스트', 'fan-art': '팬아트', meme: '밈', etc: '기타' };
const notifyGalleryImageUpload = onValueCreated('/gallery/images/{id}', async (event) => {
  const data = event.data.val() || {};
  const category = GALLERY_CATEGORY_LABELS[data.category] || data.category || '';
  const liveUrl = streamerLiveUrlForData(data);
  await sendDiscordNotification(
    '🖼️ **새 이미지 업로드 (스트리머 갤러리)**\n' +
    (data.streamerName || '(알 수 없음)') + (category ? ' · ' + category : '') +
    (liveUrl ? '\n라이브: ' + liveUrl : '') +
    (data.thumbUrl ? '\n' + data.thumbUrl : '') +
    '\nhttps://neezu-crypto.github.io/streamer-gallery/'
  );
});

// 25번 — 인증 스트리머가 주식시장/배팅시장/인생게임/갤러리/온이유/팬페이지에 접속하면 관리자
// 디스코드로 알림. verifiedStreamerVisits는 여러 앱이 공유하는 큐(soop-stock-
// market의 logStockMarketVisit, StreamBet-Market의 logBettingMarketVisit,
// streamer-life-game의 logLifeGameVisit, streamer-gallery의 logGalleryVisit이
// 각자 쓴다) - 승인 대기가 필요한 "신청" 큐가 아니라 그냥 접속 로그라
// makeQueueTrigger의 "🔔 새 O 신청" 문구 대신 별도 메시지를 쓴다. 같은
// 스트리머가 하루에 여러 번 들어와도 알림이 반복되지 않는 건 각 앱의 로깅
// 함수가 날짜별 dedup으로 이미 막아준다(여기서는 큐에 실제로 쌓인 항목만
// 그대로 알리면 됨). 딱히 검토가 필요한 큐가 아니라 admin-center에 대응하는
// 카드/앵커가 없어 딥링크는 생략.
// market 값은 각 앱의 로깅 함수가 PRESENCE_APPS(10번)와 동일한 이름으로 쓴다
// (betting/stock/lifeGame/gallery/onyuVn) - 없는 값이면 마켓 이름 대신 원본 문자열을
// 그대로 보여줘서, 새 앱이 이 매핑에 등록되는 걸 잊었을 때도 조용히
// "주식시장"으로 오표시되지 않고 눈에 띄게 한다(2026-09-06, lifeGame/gallery
// 추가 전엔 betting이 아니면 전부 "주식시장"으로 잘못 표시되는 버그가 있었음).
const VISIT_MARKET_LABELS = { betting: '배팅시장', stock: '주식시장', lifeGame: '인생게임', gallery: '갤러리', onyuVn: '온이유', streamerFanPage: '팬페이지' };
const notifyVerifiedStreamerVisit = onValueCreated('/verifiedStreamerVisits/{entryId}', async (event) => {
  const data = event.data.val() || {};
  const marketLabel = VISIT_MARKET_LABELS[data.market] || (data.market || '알 수 없는 앱');
  const name = data.nickname
    ? data.nickname + (data.soopId ? ' (@' + data.soopId + ')' : '')
    : 'uid: ' + (data.uid || '(알 수 없음)');
  const liveUrl = streamerLiveUrlForData(data);
  await sendDiscordNotification(
    '👋 **인증 스트리머 접속 — ' + marketLabel + '**\n' + name +
    (liveUrl ? '\n라이브: ' + liveUrl : '') + '\n오늘 첫 접속입니다.'
  );
});

// 온이유는 브라우저 heartbeat와 별도로 서버가 인증 상태를 확인한 후에만
// 공용 인증 스트리머 접속 큐에 기록한다. 같은 스트리머·앱 조합은 KST 기준
// 하루 한 번만 알림을 받으며, 클라이언트가 UID·닉네임·앱 이름을 지정할 수 없다.
const onyuVnLogVerifiedStreamerVisit = onCall(async (request) => {
  const uid = requireAuth(request);
  const db = getDatabase();
  const verifiedSnap = await db.ref('users/' + uid + '/streamerVerified').get();
  if (verifiedSnap.val() !== true) return { ok: true, logged: false };

  const dateKey = getKoreaDateKey();
  const dedupRef = db.ref('verifiedStreamerVisitDedup/onyuVn/' + uid + '/' + dateKey);
  let alreadyLogged = false;
  const dedupResult = await dedupRef.transaction((current) => {
    if (current) {
      alreadyLogged = true;
      return;
    }
    return true;
  });
  if (!dedupResult.committed || alreadyLogged) return { ok: true, logged: false };

  try {
    const verificationSnap = await db.ref('streamerVerifications')
      .orderByChild('uid').equalTo(uid).limitToFirst(1).get();
    const verification = verificationSnap.exists() ? Object.values(verificationSnap.val())[0] : null;
    await db.ref('verifiedStreamerVisits').push({
      uid,
      nickname: (verification && verification.nickname) || '',
      soopId: (verification && verification.soopId) || '',
      market: 'onyuVn',
      visitedAt: ServerValue.TIMESTAMP,
    });
  } catch (error) {
    await dedupRef.remove().catch(() => {});
    throw error;
  }
  return { ok: true, logged: true };
});

// 16번 — 유저 검색. StreamBet-Market의 adminLookupUser는 닉네임 "정확히 일치"만
// 지원하고, soop-stock-market의 getUserDetail은 uid만 받는다(닉네임 검색 자체가
// 없음) — 이 부분 검색(prefix)이 어디에도 없던 진짜 신규 기능이다. 결과는 후보
// uid 목록만 반환하고, 실제 상세 조회는 클라이언트가 각 게임의 기존 함수를
// 그대로 호출한다(06번 원칙 - 새 조회 로직을 중복 구현하지 않음).
const searchSeriesUser = onCall(async (request) => {
  await requireAdmin(request);
  const query = String((request.data || {}).query || '').trim();
  if (!query) throw new HttpsError('invalid-argument', '검색어를 입력해 주세요.');

  const db = getDatabase();
  const endKey = query + '';
  const [profileSnap, verifiedNickSnap, verifiedSoopSnap] = await Promise.all([
    db.ref('bettingMarket/profiles').orderByChild('nickname').startAt(query).endAt(endKey).limitToFirst(20).get(),
    db.ref('streamerVerifications').orderByChild('nickname').startAt(query).endAt(endKey).limitToFirst(20).get(),
    db.ref('streamerVerifications').orderByChild('soopId').startAt(query).endAt(endKey).limitToFirst(20).get(),
  ]);

  const results = new Map(); // uid -> candidate (uid로 중복 제거)
  const profiles = profileSnap.val() || {};
  Object.keys(profiles).forEach(function (uid) {
    results.set(uid, { uid: uid, nickname: profiles[uid].nickname || '', soopId: profiles[uid].soopId || '', source: 'bettingMarket' });
  });
  [verifiedNickSnap, verifiedSoopSnap].forEach(function (snap) {
    const val = snap.val() || {};
    Object.keys(val).forEach(function (id) {
      const entry = val[id];
      if (!entry.uid) return;
      if (!results.has(entry.uid)) {
        results.set(entry.uid, { uid: entry.uid, nickname: entry.nickname || '', soopId: entry.soopId || '', source: 'streamerVerifications' });
      }
    });
  });

  // uid 자체를 검색어로 넣은 경우 — 프로필/인증 기록이 전혀 없는 uid(예: 주식시장만
  // 이용한 유저)라도 그대로 후보에 넣어준다. 16번에서 지적한 한계(주식시장 전용
  // 유저는 이름으로 못 찾음)를 완전히 없애진 못하지만, uid를 이미 아는 경우엔 검색이 된다.
  if (!results.has(query)) {
    results.set(query, { uid: query, nickname: '', soopId: '', source: 'uid' });
  }

  return { candidates: Array.from(results.values()).slice(0, 20) };
});

// 12번 — 유저 상품 구매 현황. 게임마다 구매 기록 노드가 다 다르므로(12번 표 참고),
// 여기서는 그 노드들을 그대로 읽어 정규화해서 합칠 뿐 새 계산은 하지 않는다(06번 원칙).
// uid가 주어지면 그 유저의 기록만 필터링, 없으면 게임별 최근 N건을 반환한다.
const PURCHASE_OVERVIEW_LIMIT = 100;
// 필드명은 전부 각 게임의 실제 쓰기 코드를 직접 읽어서 확인한 값이다(추측 금지 -
// 특히 uidField는 소스마다 uid/requesterUid로 갈려서 틀리면 그 유형 전체가
// 조용히 결과에서 빠진다).
const PURCHASE_SOURCES = [
  { path: 'bettingMarket/skinPurchases', gameId: 'bettingMarket', itemType: 'skin', uidField: 'uid', labelField: 'skinName', amountField: 'price' },
  { path: 'bettingMarket/chestPurchaseRequests', gameId: 'bettingMarket', itemType: 'chest_purchase', uidField: 'uid', labelField: null, amountField: null },
  { path: 'bettingMarket/chestOpenLog', gameId: 'bettingMarket', itemType: 'chest_open', uidField: 'uid', labelField: null, amountField: 'prize' },
  { path: 'bannerRequests', gameId: 'stockMarket', itemType: 'banner', uidField: 'requesterUid', labelField: 'nickname', amountField: 'starBalloons' },
  { path: 'chartBannerRequests', gameId: 'stockMarket', itemType: 'chart_banner', uidField: 'requesterUid', labelField: 'stockName', amountField: 'starBalloons' },
  { path: 'cardBannerRequests', gameId: 'stockMarket', itemType: 'card_banner', uidField: 'requesterUid', labelField: 'nickname', amountField: 'starBalloons' },
  { path: 'pinRequests', gameId: 'stockMarket', itemType: 'pin', uidField: 'requesterUid', labelField: 'stockName', amountField: 'starBalloons' },
  { path: 'relayRoomRequests', gameId: 'stockMarket', itemType: 'relay_room', uidField: 'requesterUid', labelField: 'nickname', amountField: 'starBalloons' },
  { path: 'treasureChestRequests', gameId: 'stockMarket', itemType: 'treasure_chest', uidField: 'requesterUid', labelField: null, amountField: null },
  { path: 'cashChargeRequests', gameId: 'stockMarket', itemType: 'cash_charge', uidField: 'requesterUid', labelField: 'nickname', amountField: null },
  { path: 'unfreezeDonationRequests', gameId: 'stockMarket', itemType: 'unfreeze_donation', uidField: 'requesterUid', labelField: 'stockName', amountField: null },
  { path: 'playTimePurchases', gameId: 'stockMarket', itemType: 'play_time', uidField: 'uid', labelField: null, amountField: 'chargedAmount' },
  { path: 'lotteryPurchases', gameId: 'stockMarket', itemType: 'lottery', uidField: 'uid', labelField: null, amountField: 'chargedAmount' },
];

const getPurchaseOverview = onCall(async (request) => {
  const uidFilter = String((request.data || {}).uid || '').trim();
  // 개인 조회와 전체/유형별 목록 모두 관리자 전용으로 유지한다.
  await requireAdmin(request);
  // itemType 필터 - 배팅시장 스킨 구매 내역처럼 특정 유형만 전체 목록으로 보고
  // 싶을 때 쓴다. 필터 없이 전체를 불러오면 12개 소스가 하나의 상위 100건
  // 캡(PURCHASE_OVERVIEW_LIMIT)을 나눠 써서, 빈도가 낮은 유형(스킨 등)이 밀려날
  // 수 있다 - 그래서 정렬·자르기 전에 유형별로 먼저 걸러낸다.
  const itemTypeFilter = String((request.data || {}).itemType || '').trim();
  const db = getDatabase();

  const sources = itemTypeFilter
    ? PURCHASE_SOURCES.filter(function (src) { return src.itemType === itemTypeFilter; })
    : PURCHASE_SOURCES;
  const snaps = await Promise.all(sources.map(function (src) { return db.ref(src.path).get(); }));

  let entries = [];
  snaps.forEach(function (snap, i) {
    const src = sources[i];
    const val = snap.val() || {};
    Object.keys(val).forEach(function (id) {
      const rec = val[id];
      const uid = rec[src.uidField];
      if (!uid) return;
      if (uidFilter && uid !== uidFilter) return;
      entries.push({
        id: id,
        gameId: src.gameId,
        itemType: src.itemType,
        uid: uid,
        nickname: rec.nickname || '',
        label: src.labelField ? (rec[src.labelField] || '') : '',
        amount: src.amountField ? (rec[src.amountField] || 0) : null,
        at: rec.purchasedAt || rec.requestedAt || rec.openedAt || rec.createdAt || 0,
      });
    });
  });

  entries.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
  if (!uidFilter) entries = entries.slice(0, PURCHASE_OVERVIEW_LIMIT);
  return { entries: entries };
});

// 10번 — 페이지별 접속자 분석. interior-3d-viewer는 아직 presence 구현이 없어
// 우선 제외한다(별도 후속 작업, 10번 문서 참고). soop-stock-market이 이미 검증한
// 60분 유예 규칙을 그대로 재사용해 "활성 uid" 수를 센다.
// lifeGame/gallery는 2026-09-05 추가 — 클라이언트가 presence/{appId}/{uid}
// 표준 경로에 { lastSeen } 형태로 쓰기 시작한 뒤에만 실제로 값이 잡힌다(각 저장소
// 쪽 작업과 짝을 이룸). lifeGame은 자체 lifeGame/presence 경로(다른 용도, 세계관
// 패널·봇 시스템)와 별개로 이 표준 경로에도 병행 기록한다. dontPressButton은
// 클라이언트 직접 쓰기를 금지하고 해당 게임 서버 함수가 표준 presence를 기록한다.
const PRESENCE_APPS = ['bettingMarket', 'stockMarket', 'lifeGame', 'gallery', 'onyuVn', 'streamerMessenger', 'dontPressButton'];
const PRESENCE_GRACE_MS = 60 * 60 * 1000;
const PRESENCE_HOURLY_RETENTION_DAYS = 30;

async function trimOldPresenceHourly(db, appId) {
  const cutoffKey = new Date(Date.now() - PRESENCE_HOURLY_RETENTION_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 13);
  const ref = db.ref('analytics/presenceHourly/' + appId);
  const snap = await ref.orderByKey().endAt(cutoffKey).get();
  const updates = {};
  Object.keys(snap.val() || {}).forEach(function (key) { updates[key] = null; });
  if (Object.keys(updates).length) await ref.update(updates);
}

// appId 이름은 GAME_CATALOG의 id와 맞추되(06번), presence를 아직 구현한 앱만
// PRESENCE_APPS에 등록돼 있다. 이 스케줄러가 실제로 도는지는 배포 후
// Cloud Scheduler 콘솔이나 firebase functions:log로 확인할 것.
const sampleConcurrentUsers = onSchedule('every 5 minutes', async function () {
  const db = getDatabase();
  const now = Date.now();
  const hourKey = new Date(now).toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC 기준 — 관리 도구용이라 KST 변환 없이 단순화)

  await Promise.all(PRESENCE_APPS.map(async function (appId) {
    const snap = await db.ref('presence/' + appId).get();
    const users = snap.val() || {};
    let activeCount = 0;
    Object.values(users).forEach(function (u) {
      if (u && typeof u.lastSeen === 'number' && now - u.lastSeen <= PRESENCE_GRACE_MS) activeCount++;
    });

    const bucketRef = db.ref('analytics/presenceHourly/' + appId + '/' + hourKey);
    const bucketSnap = await bucketRef.get();
    const currentPeak = (bucketSnap.val() && bucketSnap.val().peak) || 0;
    if (activeCount > currentPeak) {
      await bucketRef.set({ peak: activeCount, sampledAt: now });
    }
    await trimOldPresenceHourly(db, appId);
  }));
});

// 관리 센터 UI가 호출하는 관리자 전용 조회 함수 — 앱별 최근 hours시간의 시간당
// 최고 접속자 수 시계열을 반환한다.
const getVisitorAnalytics = onCall(async (request) => {
  await requireAdmin(request);
  const hours = Math.min(Math.max(parseInt((request.data || {}).hours, 10) || 24, 1), 168);
  const db = getDatabase();
  const now = Date.now();
  const bucketKeys = [];
  for (let i = hours - 1; i >= 0; i--) {
    bucketKeys.push(new Date(now - i * 3600 * 1000).toISOString().slice(0, 13));
  }

  const results = {};
  await Promise.all(PRESENCE_APPS.map(async function (appId) {
    const ref = db.ref('analytics/presenceHourly/' + appId);
    const snap = bucketKeys.length
      ? await ref.orderByKey().startAt(bucketKeys[0]).endAt(bucketKeys[bucketKeys.length - 1]).get()
      : await ref.get();
    const data = snap.val() || {};
    results[appId] = bucketKeys.map(function (k) { return { hour: k, peak: (data[k] && data[k].peak) || 0 }; });
  }));

  return { apps: results };
});

// 배경시장(interior-3d-viewer) 갤러리 통계 — 공개 갤러리 프리셋별 "적용"/"OBS 링크
// 복사" 클릭 횟수. presetGallery는 interior-3d-viewer가 소유한 노드지만, Admin
// SDK는 그 저장소의 RTDB 규칙과 무관하게 항상 읽을 수 있다(06번 원칙과 동일하게,
// 새 로직을 그 저장소에 또 만들지 않고 이미 있는 데이터를 그대로 읽기만 한다).
// 관리자 전용 조회 함수.
const getGalleryStats = onCall(async (request) => {
  await requireAdmin(request);
  const db = getDatabase();
  const snap = await db.ref('presetGallery').get();
  const data = snap.val() || {};
  const presets = Object.keys(data).map(function (id) {
    const entry = data[id];
    const stats = entry.stats || {};
    return {
      id: id,
      name: entry.name || '(이름 없음)',
      applyCount: stats.applyCount || 0,
      obsLinkCount: stats.obsLinkCount || 0,
      createdAt: entry.createdAt || 0,
    };
  }).sort(function (a, b) { return (b.applyCount + b.obsLinkCount) - (a.applyCount + a.obsLinkCount); });
  return { presets: presets };
});

// 스트리머 인생게임(streamer-life-game) 통계 — 선택지별/엔딩별 집계 카운터와 전체
// 시작·완료·공유 수. lifeGame/stats는 그 저장소의 Cloud Function이 선택 제출 시점에
// ServerValue.increment로 미리 쌓아둔 카운터라(streamer-life-game/functions/index.js),
// 여기서는 원본 choiceLog를 훑지 않고 그 카운터만 그대로 읽는다 — getGalleryStats와
// 동일한 원칙(다른 저장소 소유 데이터를 Admin SDK로 읽기만, 새 로직 중복 없음).
const getLifeGameStats = onCall(async (request) => {
  await requireAdmin(request);
  const db = getDatabase();
  const snap = await db.ref('lifeGame/stats').get();
  const data = snap.val() || {};
  const totals = data.totals || {};

  const choicesRaw = data.choices || {};
  const choices = [];
  Object.keys(choicesRaw).forEach(function (stageId) {
    Object.keys(choicesRaw[stageId] || {}).forEach(function (choiceId) {
      choices.push({ stageId: stageId, choiceId: choiceId, count: choicesRaw[stageId][choiceId] || 0 });
    });
  });
  choices.sort(function (a, b) { return b.count - a.count; });

  const endingsRaw = data.endings || {};
  const endings = Object.keys(endingsRaw)
    .map(function (id) { return { id: id, count: endingsRaw[id] || 0 }; })
    .sort(function (a, b) { return b.count - a.count; });

  return {
    totals: { started: totals.started || 0, completed: totals.completed || 0, shared: totals.shared || 0 },
    choices: choices,
    endings: endings
  };
});

// 인생게임 이름 확정 후 0세 판이 시작된 UID 집계. UID별 첫 시작/최근 시작과
// 시작 횟수는 streamer-life-game의 서버 함수가 lifeGame/playerStartRecords에 기록한다.
const listLifeGamePlayerStartRecords = onCall(async (request) => {
  await requireAdmin(request);
  const snap = await getDatabase().ref('lifeGame/playerStartRecords').get();
  const raw = snap.val() || {};
  const players = Object.keys(raw).map(function (uid) {
    const entry = raw[uid] || {};
    return {
      uid: uid,
      firstStartedAt: Number(entry.firstStartedAt) || null,
      lastStartedAt: Number(entry.lastStartedAt) || null,
      startCount: Math.max(1, Number(entry.startCount) || 1),
    };
  }).sort(function (a, b) { return (b.lastStartedAt || 0) - (a.lastStartedAt || 0); });
  return { players: players, totalUsers: players.length, fetchedAt: Date.now() };
});

// 인생게임 플레이 스트리머 검수 목록. 후보와 검수 완료 allowlist 모두
// Admin SDK 전용 lifeGame 경로이며, 검수 등록만 이후 인증 자동 승인 근거가 된다.
const listLifeGamePlayedStreamers = onCall(async (request) => {
  await requireAdmin(request);
  const db = getDatabase();
  const [candidateSnap, allowlistSnap] = await Promise.all([
    db.ref('lifeGame/playedStreamerCandidates').get(),
    db.ref('lifeGame/playedStreamerAllowlist').get()
  ]);
  const allowlist = allowlistSnap.val() || {};
  const approved = [];
  Object.keys(allowlist).forEach(function (uid) {
    Object.keys(allowlist[uid] || {}).forEach(function (soopId) {
      approved.push(Object.assign({ uid: uid, soopId: soopId }, allowlist[uid][soopId] || {}));
    });
  });
  const candidates = [];
  const rawCandidates = candidateSnap.val() || {};
  Object.keys(rawCandidates).forEach(function (uid) {
    Object.keys(rawCandidates[uid] || {}).forEach(function (soopId) {
      if (allowlist[uid] && allowlist[uid][soopId]) return;
      candidates.push(Object.assign({ uid: uid, soopId: soopId }, rawCandidates[uid][soopId] || {}));
    });
  });
  candidates.sort(function (a, b) { return (b.lastSeenAt || 0) - (a.lastSeenAt || 0); });
  approved.sort(function (a, b) { return (b.reviewedAt || 0) - (a.reviewedAt || 0); });
  return { candidates: candidates.slice(0, 500), approved: approved.slice(0, 1000) };
});

const addLifeGamePlayedStreamer = onCall(async (request) => {
  const adminUid = await requireAdmin(request);
  const data = request.data || {};
  const uid = String(data.uid || '').trim();
  const soopId = String(data.soopId || '').trim().toLowerCase();
  const nickname = String(data.nickname || '').trim();
  const note = String(data.note || '').trim().slice(0, 500);
  const evidenceUrl = String(data.evidenceUrl || '').trim().slice(0, 500);
  if (!/^[A-Za-z0-9_-]{10,128}$/.test(uid)) throw new HttpsError('invalid-argument', 'Firebase UID 형식을 확인해주세요.');
  if (!/^[a-z0-9]{2,20}$/.test(soopId)) throw new HttpsError('invalid-argument', 'SOOP 아이디는 영문 소문자/숫자 2~20자로 입력해주세요.');
  if (!nickname || nickname.length > 50) throw new HttpsError('invalid-argument', '닉네임을 1~50자로 입력해주세요.');
  if (evidenceUrl && !/^https:\/\//i.test(evidenceUrl)) throw new HttpsError('invalid-argument', '검수 링크는 https URL이어야 합니다.');
  const db = getDatabase();
  const reviewedAt = Date.now();
  const entry = { uid: uid, soopId: soopId, nickname: nickname, reviewedAt: reviewedAt, reviewerUid: adminUid, source: 'manual-review' };
  if (note) entry.note = note;
  if (evidenceUrl) entry.evidenceUrl = evidenceUrl;
  await db.ref('lifeGame/playedStreamerAllowlist/' + uid + '/' + soopId).set(entry);
  await logToAdminAuditLog(db, request, '인생게임 플레이 스트리머 검수 등록', nickname + ' · ' + soopId + ' · ' + uid);
  return { ok: true };
});

const removeLifeGamePlayedStreamer = onCall(async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  const uid = String(data.uid || '').trim();
  const soopId = String(data.soopId || '').trim().toLowerCase();
  if (!/^[A-Za-z0-9_-]{10,128}$/.test(uid) || !/^[a-z0-9]{2,20}$/.test(soopId)) {
    throw new HttpsError('invalid-argument', 'UID 또는 SOOP 아이디 형식을 확인해주세요.');
  }
  const db = getDatabase();
  const ref = db.ref('lifeGame/playedStreamerAllowlist/' + uid + '/' + soopId);
  const snap = await ref.get();
  if (!snap.exists()) throw new HttpsError('not-found', '검수 등록 항목을 찾을 수 없습니다.');
  const entry = snap.val() || {};
  await ref.remove();
  await logToAdminAuditLog(db, request, '인생게임 플레이 스트리머 검수 해제', (entry.nickname || '') + ' · ' + soopId + ' · ' + uid);
  return { ok: true };
});

// 인생게임 관리형 봇(2026-08-30, streamer-life-game 62장) — 봇 수·1턴당 초·성향
// 분포를 관리자가 조절하는 설정 화면. 실제 실행(턴 진행)은 streamer-life-game
// 저장소의 예약 함수(runBotTurns)가 서버에서 알아서 도는 방식이라, 여기 설정
// 화면은 lifeGame/botConfig 노드를 읽고/쓰기만 한다 — 페이지를 열어둘 필요 없음.
const LIFEGAME_BOT_PERSONALITIES = ['wholesome', 'villain', 'explorer', 'gambler', 'romantic', 'workaholic'];

const getLifeGameBotConfig = onCall(async (request) => {
  await requireAdmin(request);
  const db = getDatabase();
  const [configSnap, botsSnap] = await Promise.all([
    db.ref('lifeGame/botConfig').get(),
    db.ref('lifeGame/bots').get()
  ]);
  const config = configSnap.val() || {};
  const bots = botsSnap.val() || {};
  const personalityWeights = {};
  LIFEGAME_BOT_PERSONALITIES.forEach(function (p) {
    personalityWeights[p] = (config.personalityWeights && Number(config.personalityWeights[p])) || 1;
  });
  return {
    enabled: !!config.enabled,
    botCount: config.botCount || 0,
    secondsPerTurn: config.secondsPerTurn || 30,
    personalityWeights: personalityWeights,
    bots: Object.keys(bots).map(function (uid) {
      return { uid: uid, personality: bots[uid].personality, createdAt: bots[uid].createdAt || null, lastTurnAt: bots[uid].lastTurnAt || null };
    })
  };
});

const setLifeGameBotConfig = onCall(async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  const enabled = !!data.enabled;
  const botCount = Math.max(0, Math.min(50, Math.round(Number(data.botCount) || 0)));
  const secondsPerTurn = Math.max(5, Math.min(600, Math.round(Number(data.secondsPerTurn) || 30)));
  const personalityWeights = {};
  LIFEGAME_BOT_PERSONALITIES.forEach(function (p) {
    const raw = data.personalityWeights && data.personalityWeights[p];
    personalityWeights[p] = Math.max(0, Number(raw) || 0);
  });
  const db = getDatabase();
  await db.ref('lifeGame/botConfig').set({ enabled: enabled, botCount: botCount, secondsPerTurn: secondsPerTurn, personalityWeights: personalityWeights, updatedAt: Date.now() });
  await logToAdminAuditLog(db, request, '인생게임 봇 설정 변경', 'enabled=' + enabled + ', botCount=' + botCount + ', secondsPerTurn=' + secondsPerTurn + 's');
  return { ok: true };
});

// 인생게임 후원 스트리머 배너(2026-09-09) — soop-stock-market의 배너 신청
// 승인/거절과 동일 원칙(후원창 후원 확인 → 승인)이지만, streamer-life-game은
// adminAction 같은 단일 디스패처가 없어(06번 원칙 - 각 게임 관례를 따름) 봇
// 설정과 동일하게 admin-center가 직접 lifeGame/currentSponsor를 조작한다.
// 검색화면·엔딩화면·멀티플레이 참가·모바일 하단배너 네 자리 전부가 이 단일
// 노드를 구독하므로 슬롯은 1개뿐 — 이미 진행 중인 후원이 있으면(soop-stock-
// market 배너와 동일하게) 남은 기간에 이어서 연장한다.
async function commitLifeGameSponsorApproval(db, request, adminUid, requestId, daysNum, nickname, verificationMetadata) {
  const requestRef = db.ref('lifeGame/sponsorRequests/' + requestId);
  // RTDB transaction callbacks run immediately against the local cache. A one-shot
  // get() does not keep that cache active, so hold a value listener through the
  // transaction to ensure a fresh Functions instance starts from server data.
  let releaseRequestListener = function () {};
  let existingRequest;
  try {
    existingRequest = await new Promise((resolve, reject) => {
      const onRequestValue = (snapshot) => resolve(snapshot.val());
      const onRequestError = (error) => reject(error);
      releaseRequestListener = () => requestRef.off('value', onRequestValue);
      requestRef.on('value', onRequestValue, onRequestError);
    });
    if (!existingRequest || existingRequest.status !== 'pending') {
      throw new HttpsError('failed-precondition', '대기 중인 신청이 아닙니다. 이미 처리 중일 수 있습니다.');
    }
    const processingToken = require('node:crypto').randomBytes(16).toString('hex');
    const claim = await requestRef.transaction((current) => {
      if (!current || current.status !== 'pending') return;
      return Object.assign({}, current, { status: 'processing', processingToken, processingStartedAt: Date.now() });
    }, undefined, false);
    if (!claim.committed) throw new HttpsError('failed-precondition', '대기 중인 신청이 아닙니다. 이미 처리 중일 수 있습니다.');
    const reqData = claim.snapshot.val() || {};
    let approvalCommitted = false;
    try {
      const finalNickname = nickname || reqData.nickname;
      const now = Date.now();
      const currentSnap = await db.ref('lifeGame/currentSponsor').get();
      const current = currentSnap.val();
      const baseTime = current && Number(current.endAt) > now ? Number(current.endAt) : now;
      const endAt = baseTime + daysNum * 86400000;
      const requestUpdates = Object.assign({
        nickname: finalNickname,
        status: 'approved',
        reviewedAt: now,
        reviewedBy: adminUid,
        processingToken: null,
        processingStartedAt: null,
      }, verificationMetadata || {});
      await db.ref().update(Object.assign({
        'lifeGame/currentSponsor': {
          nickname: finalNickname,
          soopId: reqData.soopId,
          previewImg: reqData.previewImg,
          stationLink: reqData.stationLink,
          startAt: now,
          endAt,
        },
        ['lifeGame/sponsorRequests/' + requestId]: requestUpdates,
      }));
      approvalCommitted = true;
      let auditLogged = true;
      try {
        await logToAdminAuditLog(db, request, '인생게임 후원 스트리머 승인', finalNickname + ' · ' + daysNum + '일');
      } catch (auditError) {
        auditLogged = false;
        console.error('인생게임 후원 스트리머 승인 감사 로그 실패:', String(auditError && auditError.message || auditError).slice(0, 160));
      }
      return { ok: true, endAt, auditLogged };
    } catch (error) {
      if (!approvalCommitted) {
        await requestRef.transaction((current) => {
          if (!current || current.status !== 'processing' || current.processingToken !== processingToken) return;
          return Object.assign({}, current, { status: 'pending', processingToken: null, processingStartedAt: null });
        }, undefined, false).catch(() => null);
      }
      throw error;
    }
  } finally {
    releaseRequestListener();
  }
}

const lifeGameApproveSponsorRequest = onCall(async (request) => {
  const adminUid = await requireAdmin(request);
  const data = request.data || {};
  const requestId = String(data.requestId || '').trim();
  if (!requestId || requestId.length > 200 || /[.#$\[\]/]/.test(requestId)) throw new HttpsError('invalid-argument', 'requestId가 필요합니다.');
  const daysNum = Math.round(Number(data.days));
  if (!Number.isInteger(daysNum) || daysNum < 1) {
    throw new HttpsError('invalid-argument', '노출 기간을 올바르게 입력해주세요.');
  }
  const nickname = String(data.nickname || '').trim();
  return commitLifeGameSponsorApproval(getDatabase(), request, adminUid, requestId, daysNum, nickname, {
    verificationSource: 'admin-manual',
  });
});

const lifeGameRejectSponsorRequest = onCall(async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  const requestId = data.requestId;
  if (!requestId) throw new HttpsError('invalid-argument', 'requestId가 필요합니다.');

  const db = getDatabase();
  const reqSnap = await db.ref('lifeGame/sponsorRequests/' + requestId).get();
  if (!reqSnap.exists()) throw new HttpsError('not-found', '신청 내역을 찾을 수 없습니다.');
  if (reqSnap.val().status !== 'pending') {
    throw new HttpsError('failed-precondition', '이미 처리된 신청입니다.');
  }

  await db.ref('lifeGame/sponsorRequests/' + requestId).update({ status: 'rejected', reviewedAt: Date.now() });
  await logToAdminAuditLog(db, request, '인생게임 후원 스트리머 거절', requestId);
  return { ok: true };
});

// 인생게임 '오늘의 후원 스트리머' 승인 이후 운영 도구. 공개 노드 하나만
// 조작하고 모든 쓰기는 관리자 인증 및 통합 감사 로그를 거친다.
const getLifeGameCurrentSponsor = onCall(async (request) => {
  await requireAdmin(request);
  const snap = await getDatabase().ref('lifeGame/currentSponsor').get();
  return { sponsor: snap.val() || null, fetchedAt: Date.now() };
});

const updateLifeGameCurrentSponsor = onCall(async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  const nickname = String(data.nickname || '').trim();
  const soopId = String(data.soopId || '').trim().toLowerCase();
  const extendDays = Math.round(Number(data.extendDays) || 0);
  if (!nickname || nickname.length > 20 || /[<>\x00-\x1F\x7F]/.test(nickname)) {
    throw new HttpsError('invalid-argument', '닉네임은 금지 문자를 제외하고 1~20자로 입력해주세요.');
  }
  if (!/^[a-z0-9]{2,20}$/.test(soopId)) {
    throw new HttpsError('invalid-argument', 'SOOP 아이디는 영문 소문자/숫자 2~20자로 입력해주세요.');
  }
  if (!Number.isInteger(extendDays) || extendDays < 0 || extendDays > 365) {
    throw new HttpsError('invalid-argument', '연장 일수는 0~365일로 입력해주세요.');
  }
  const db = getDatabase();
  const now = Date.now();
  const ref = db.ref('lifeGame/currentSponsor');
  // 주식시장 배너 승인처럼 서버의 현재 값을 읽고 루트 멀티패스 update로
  // 저장한다. 이 경로는 단일 광고 슬롯이라 트랜잭션보다 이 패턴이 적합하다.
  const currentSnap = await ref.get();
  const current = currentSnap.val();
  if (!currentSnap.exists() || !current || typeof current !== 'object') {
    throw new HttpsError('not-found', '관리할 후원 스트리머 광고가 없습니다. 새로고침 후 현재 광고를 다시 확인해주세요.');
  }
  const prefix = soopId.slice(0, 2);
  const baseTime = Math.max(now, Number(current.endAt) || 0);
  const after = Object.assign({}, current, {
    nickname,
    soopId,
    previewImg: 'https://stimg.sooplive.com/LOGO/' + prefix + '/' + soopId + '/' + soopId + '.jpg',
    stationLink: 'https://www.sooplive.com/station/' + soopId,
    endAt: extendDays ? baseTime + extendDays * 86400000 : current.endAt,
    updatedAt: now,
  });
  await db.ref().update({
    'lifeGame/currentSponsor/nickname': after.nickname,
    'lifeGame/currentSponsor/soopId': after.soopId,
    'lifeGame/currentSponsor/previewImg': after.previewImg,
    'lifeGame/currentSponsor/stationLink': after.stationLink,
    'lifeGame/currentSponsor/endAt': after.endAt,
    'lifeGame/currentSponsor/updatedAt': after.updatedAt,
  });
  await logToAdminAuditLog(db, request, '인생게임 후원 스트리머 광고 수정',
    current.nickname + ' → ' + nickname + ' · ' + soopId + (extendDays ? ' · ' + extendDays + '일 연장' : ''));
  return { ok: true, sponsor: after };
});

const endLifeGameCurrentSponsor = onCall(async (request) => {
  await requireAdmin(request);
  const db = getDatabase();
  const now = Date.now();
  const ref = db.ref('lifeGame/currentSponsor');
  const currentSnap = await ref.get();
  const current = currentSnap.val();
  if (!currentSnap.exists() || !current || typeof current !== 'object') {
    throw new HttpsError('not-found', '관리할 후원 스트리머 광고가 없습니다. 새로고침 후 현재 광고를 다시 확인해주세요.');
  }
  await db.ref().update({ 'lifeGame/currentSponsor/endAt': now, 'lifeGame/currentSponsor/endedAt': now });
  await logToAdminAuditLog(db, request, '인생게임 후원 스트리머 광고 즉시 종료', current.nickname + ' · ' + (current.soopId || ''));
  return { ok: true, endedAt: now };
});

// 20번 2단계 — 정지계정 관리. 게임별 정지(각 게임의 기존 banAccount/unbanAccount)가
// 기본이고, 여기 두 함수는 신원 단위로 명백히 심각한 사안(다중계정 어뷰징, 결제
// 사기 등)만 관리자가 명시적으로 "전체 게임 정지"로 격상시키는 전용 통로다(07번
// 위임 권한 카탈로그처럼 기본은 좁게 두고 필요할 때만 넓히는 결). 공유 원장
// bannedAccounts/{uid}의 all* 필드만 건드리고, 개별 게임의 games/{gameId}는
// 그대로 둔다 - 전체 정지를 해제해도 개별 게임 정지가 있었다면 그건 남는다.
const banAccountAllGames = onCall(async (request) => {
  const adminUid = await requireAdmin(request);
  const adminName = request.auth.token.name || request.auth.token.email;
  const { uid, reason } = request.data || {};
  if (!uid) throw new HttpsError('invalid-argument', '대상 uid가 필요합니다.');
  if (!reason || !reason.trim()) throw new HttpsError('invalid-argument', '정지 사유를 입력해주세요.');
  const db = getDatabase();
  await db.ref('bannedAccounts/' + uid).update({
    all: true,
    allReason: reason.trim(),
    allBannedAt: Date.now(),
    allBannedBy: adminUid,
    allBannedByName: adminName,
  });
  await logToAdminAuditLog(db, request, '전체 게임 정지', uid + ' · ' + reason.trim());
  return { ok: true };
});

const unbanAccountAllGames = onCall(async (request) => {
  await requireAdmin(request);
  const { uid } = request.data || {};
  if (!uid) throw new HttpsError('invalid-argument', '대상 uid가 필요합니다.');
  const db = getDatabase();
  await db.ref('bannedAccounts/' + uid).update({
    all: null,
    allReason: null,
    allBannedAt: null,
    allBannedBy: null,
    allBannedByName: null,
  });
  await logToAdminAuditLog(db, request, '전체 게임 정지 해제', uid);
  return { ok: true };
});

// bettingMarket/bannedAccounts에 쌓인 기존 정지 이력을 공유 원장으로 1회 이전한다.
// games.bettingMarket이 이미 있으면 건너뛰므로(멱등) 여러 번 눌러도 안전하다.
const migrateBannedAccounts = onCall(async (request) => {
  await requireAdmin(request);
  const db = getDatabase();
  const oldSnap = await db.ref('bettingMarket/bannedAccounts').get();
  const oldData = oldSnap.val() || {};
  const uids = Object.keys(oldData);
  const newSnaps = await Promise.all(uids.map(function (uid) {
    return db.ref('bannedAccounts/' + uid + '/games/bettingMarket').get();
  }));
  const updates = {};
  let migratedCount = 0;
  uids.forEach(function (uid, i) {
    if (newSnaps[i].exists()) return;
    const old = oldData[uid];
    updates['bannedAccounts/' + uid + '/games/bettingMarket'] = {
      reason: old.reason || '',
      bannedAt: old.bannedAt || Date.now(),
      bannedBy: old.bannedBy || null,
      bannedByName: old.bannedByName || '',
    };
    migratedCount += 1;
  });
  if (migratedCount > 0) await db.ref().update(updates);
  return { migratedCount: migratedCount };
});

// ── onyu-vn 일반 시청자 접근 승인 ─────────────────────────────
// onyu-vn은 정적 GitHub Pages 게임이라 클라이언트가 승인 여부를 직접 쓰면 우회할 수
// 있다. 신청·조회·게임 시작 판정은 이 관리자센터 codebase의 callable을 통해 처리하고,
// 승인·무시는 관리자만 실행한다. 승인 키는 브라우저가 아니라 Firebase uid다.
function onyuProviderLabel(request) {
  const provider = request.auth && request.auth.token && request.auth.token.firebase && request.auth.token.firebase.sign_in_provider;
  return provider === 'google.com' ? 'google' : 'kakao';
}

async function getOnyuAccessState(uid, request) {
  const db = getDatabase();
  const userSnap = await db.ref('users/' + uid).get();
  const user = userSnap.val() || {};
  const provider = request && request.auth && request.auth.token && request.auth.token.firebase && request.auth.token.firebase.sign_in_provider;
  const authenticatedViewer = provider !== 'anonymous' || user.googleLinked === true || user.kakaoLinked === true;
  const loginMethod = user.googleLinked === true || provider === 'google.com' ? 'google' : user.kakaoLinked === true ? 'kakao' : null;
  const isAdmin = await isOnyuAdminUid(uid);
  const requestedMode = request && request.data && request.data.accessMode;
  // 레거시 클라이언트의 adminMode=true 요청은 관리자 모드로 한 번만 호환하고,
  // 그 외에는 일반 로그인 유저 모드로 취급한다. 권한은 항상 UID로 재검증한다.
  const adminAccessMode = isAdmin && ['admin', 'streamer', 'viewer'].includes(requestedMode)
    ? requestedMode
    : isAdmin && request && request.data && request.data.adminMode === true ? 'admin' : 'viewer';
  if (isAdmin) {
    if (adminAccessMode === 'admin') {
      return { role: 'admin', accessMode: 'admin', accessStatus: 'free', canStartGame: true, authenticated: true, loginMethod, isAdmin: true, adminMode: true };
    }
    const role = adminAccessMode === 'streamer' ? 'streamer' : 'viewer';
    return { role, accessMode: adminAccessMode, accessStatus: 'free', canStartGame: true, authenticated: true, loginMethod, isAdmin: true, adminMode: false };
  }
  // 관리자가 아닌 계정은 users 플래그가 없는 레거시 인증 기록도 스트리머로 인식한다.
  // 게임 접근은 무료이며, 기존 이용권 기록은 접근 판정에 사용하지 않는다.
  const streamerVerified = user.streamerVerified === true || await isVerifiedStreamerUid(uid);
  if (streamerVerified) {
    return {
      role: 'streamer', accessMode: 'streamer', accessStatus: 'free',
      canStartGame: true, authenticated: true, loginMethod, isAdmin, adminMode: false,
    };
  }
  return {
    role: authenticatedViewer ? 'viewer' : 'anonymous',
    accessMode: 'viewer',
    accessStatus: authenticatedViewer ? 'free' : 'login-required',
    canStartGame: authenticatedViewer,
    authenticated: authenticatedViewer,
    loginMethod,
    isAdmin,
    adminMode: false,
  };
}

// 이전 일반 시청자 접근 신청은 무료 접근 정책으로 종료됐다. 예전 정적 페이지가
// 남아 있어도 접근 신청을 기록하지 않고 로그인 또는 스트리머 인증을 안내한다.
const onyuRequestViewerAccess = onCall(async (request) => {
  requireAuth(request);
  throw new HttpsError('failed-precondition', '온이유 게임은 로그인 또는 인증된 스트리머 계정으로 무료 이용할 수 있습니다.');
});

const onyuGetViewerAccess = onCall(async (request) => {
  const uid = requireAuth(request);
  return Object.assign({ ok: true, uid }, await getOnyuAccessState(uid, request));
});

// 과거 신청의 후원 대조·검수 경로가 사용하는 기록 형식. 신규 구매·선물 신청은 받지 않는다.
const ONYU_STREAMER_GIFT_BALLOONS = 50;
const FANPAGE_VIEWER_SUBSCRIPTION_BALLOONS = 33;
const LEGACY_FANPAGE_VIEWER_SUBSCRIPTION_BALLOONS = 10;
const FANPAGE_SPONSOR_ADS_PATH = 'streamerFanPageSponsorAds';
const FANPAGE_SPONSOR_REQUESTS_PATH = 'streamerFanPageSponsorRequests';
const FANPAGE_SPONSOR_PENDING_PATH = 'streamerFanPageSponsorPending';
const FANPAGE_SPONSOR_CLAIMS_PATH = 'streamerFanPageSponsorPlacementClaims';
const FANPAGE_SPONSOR_DONATION_DIAGNOSTICS_PATH = 'adminCenter/fanPageSponsorDonationDiagnostics';
const FANPAGE_SPONSOR_DONATION_DIAGNOSTICS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const FANPAGE_SPONSOR_DONATION_DIAGNOSTICS_MAX_RECORDS = 500;
const FANPAGE_SPONSOR_MAX_ADS_PER_RAIL = 5;
const FANPAGE_SPONSOR_MAX_ACTIVE_ADS = FANPAGE_SPONSOR_MAX_ADS_PER_RAIL * 2;
const FANPAGE_SPONSOR_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FANPAGE_SPONSOR_MAX_CAMPAIGN_MS = 30 * 24 * 60 * 60 * 1000;
const ONYU_GIFT_MONITOR_UID_PREFIX = 'onyu_gift_monitor_';

function onyuGiftMonitorUid(adminUid) {
  return ONYU_GIFT_MONITOR_UID_PREFIX + String(adminUid || '');
}

async function requireOnyuGiftMonitorAdmin(request) {
  const uid = requireAuth(request);
  const claims = request.auth.token || {};
  const adminUid = String(claims.onyuGiftAdminUid || '');
  if (claims.onyuGiftMonitor !== true || !adminUid || uid !== onyuGiftMonitorUid(adminUid) ||
      !(await isAdminUid(adminUid))) {
    throw new HttpsError('permission-denied', '이 이용권 모니터링 세션은 더 이상 유효하지 않습니다. 통합 관리 센터에 다시 로그인해 주세요.');
  }
  return adminUid;
}

function requestAsOnyuGiftAdmin(request, adminUid) {
  if (!request.auth || request.auth.uid === adminUid) return request;
  const token = Object.assign({}, request.auth.token || {}, {
    uid: adminUid,
    sub: adminUid,
    user_id: adminUid,
  });
  return Object.assign({}, request, {
    auth: Object.assign({}, request.auth, { uid: adminUid, token }),
  });
}

async function resolveOnyuGiftReviewActor(request) {
  const token = request.auth && request.auth.token || {};
  if (token.onyuGiftMonitor === true) {
    const adminUid = await requireOnyuGiftMonitorAdmin(request);
    return { adminUid, request: requestAsOnyuGiftAdmin(request, adminUid) };
  }
  return { adminUid: await requireAdmin(request), request };
}

const onyuCreateGiftBackgroundMonitorSession = onCall(async (request) => {
  const adminUid = await requireAdmin(request);
  // Background access is intentionally unavailable to the temporary email fallback:
  // its owner must have an explicit adminCenter/adminUids registration.
  if (!(await isAdminUid(adminUid))) {
    throw new HttpsError('failed-precondition', '관리자 UID 등록을 마친 뒤 백그라운드 모니터링을 시작할 수 있습니다.');
  }
  const monitorUid = onyuGiftMonitorUid(adminUid);
  const auth = getAuth();
  try {
    await auth.getUser(monitorUid);
  } catch (error) {
    if (!error || error.code !== 'auth/user-not-found') throw error;
    try {
      await auth.createUser({ uid: monitorUid });
    } catch (createError) {
      if (!createError || createError.code !== 'auth/uid-already-exists') throw createError;
    }
  }
  const monitorClaims = { onyuGiftMonitor: true, onyuGiftAdminUid: adminUid };
  await auth.setCustomUserClaims(monitorUid, monitorClaims);
  return { customToken: await auth.createCustomToken(monitorUid, monitorClaims) };
});

function onyuGiftHasEligibleBackgroundRequest(requests, now) {
  return Object.values(requests || {}).some((gift) => gift && gift.status === 'pending' &&
    normalizeSoopId(gift.donorSoopId) && Number(gift.balloons) === ONYU_STREAMER_GIFT_BALLOONS &&
    Number(gift.donationCompletedAt) > 0 && Number(gift.requestedAt) > now - 24 * 60 * 60 * 1000);
}

const onyuGiftBackgroundFeed = onRequest({ timeoutSeconds: 3600, memory: '256MiB' }, async (request, response) => {
  const origin = String(request.get('Origin') || '');
  const allowedOrigin = origin === 'https://neezu-crypto.github.io' || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  // Extension service-worker fetches with host permissions may omit Origin.
  // The feed is read-only and still requires a verified Firebase bearer token.
  const originlessBackgroundGet = !origin && request.method === 'GET';
  response.set('Vary', 'Origin');
  if (allowedOrigin) {
    response.set('Access-Control-Allow-Origin', origin);
    response.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  }
  if (request.method === 'OPTIONS') {
    response.status(allowedOrigin ? 204 : 403).send('');
    return;
  }
  if (request.method !== 'GET' || (!allowedOrigin && !originlessBackgroundGet)) {
    const reason = request.method === 'GET' ? 'origin-not-allowed' : 'method-not-allowed';
    const originType = !origin ? 'missing' : origin.startsWith('chrome-extension://') ? 'unrecognized-extension' : 'other';
    response.status(request.method === 'GET' ? 403 : 405).json({ reason, originType, message: '허용되지 않은 요청입니다.' });
    return;
  }
  const bearer = String(request.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!bearer) {
    response.status(401).json({ reason: 'bearer-missing', message: '인증이 필요합니다.' });
    return;
  }

  let decoded;
  let accessMode;
  let adminUid;
  try {
    decoded = await getAuth().verifyIdToken(bearer[1]);
  } catch (error) {
    console.warn('온이유 이용권 백그라운드 인증 토큰 거부:', {
      reason: 'id-token-invalid',
      errorCode: String(error && error.code || 'unknown').slice(0, 80),
    });
    response.status(403).json({ reason: 'id-token-invalid', message: '이용권 신청 스트림 접근 권한이 없습니다.' });
    return;
  }
  try {
    if (decoded.onyuGiftMonitor === true) {
      adminUid = await requireOnyuGiftMonitorAdmin({ auth: { uid: decoded.uid, token: decoded } });
      accessMode = 'monitor';
    } else if (await isAdminUid(decoded.uid)) {
      adminUid = decoded.uid;
      accessMode = 'admin';
    } else {
      console.warn('온이유 이용권 백그라운드 권한 거부:', {
        reason: 'admin-required',
        monitorClaim: false,
      });
      response.status(403).json({ reason: 'admin-required', message: '이용권 신청 스트림 접근 권한이 없습니다.' });
      return;
    }
  } catch (error) {
    const reason = decoded.onyuGiftMonitor === true ? 'monitor-session-invalid' : 'admin-lookup-failed';
    const claimedAdminUid = String(decoded.onyuGiftAdminUid || '');
    console.warn('온이유 이용권 백그라운드 권한 거부:', {
      reason,
      errorCode: String(error && error.code || 'unknown').slice(0, 80),
      monitorClaim: decoded.onyuGiftMonitor === true,
      adminUidClaimPresent: !!claimedAdminUid,
      monitorUidMatchesClaim: !!claimedAdminUid && decoded.uid === onyuGiftMonitorUid(claimedAdminUid),
    });
    response.status(403).json({ reason, message: '이용권 신청 스트림 접근 권한이 없습니다.' });
    return;
  }

  response.status(200);
  response.set('Content-Type', 'text/event-stream; charset=utf-8');
  response.set('Cache-Control', 'no-cache, no-transform');
  response.set('Connection', 'keep-alive');
  response.set('X-Accel-Buffering', 'no');
  response.flushHeaders();

  let closed = false;
  let active = false;
  let activeSources = [];
  let onyuRequests = {};
  let lifeGameRequests = {};
  let fanPagePendingRequests = {};
  let fanPageSponsorRequests = {};
  const db = getDatabase();
  const requestRef = db.ref('onyuVn/streamerGameGiftRequests');
  const lifeGameRequestRef = db.ref('lifeGame/sponsorRequests');
  const fanPagePendingRef = db.ref('streamerFanPageViewerSubscriptionPending');
  const fanPageSponsorRequestRef = db.ref(FANPAGE_SPONSOR_REQUESTS_PATH);
  const adminRef = db.ref('adminCenter/adminUids/' + adminUid);
  const connectionId = require('node:crypto').randomBytes(12).toString('hex');
  const monitorStatusRef = db.ref('adminCenter/donationVerificationMonitorStatus/' + adminUid + '/' + connectionId);
  const writeEvent = (name, data) => {
    if (closed || response.destroyed) return;
    response.write('event: ' + name + '\ndata: ' + JSON.stringify(data || {}) + '\n\n');
  };
  const sendMonitorState = () => {
    const now = Date.now();
    activeSources = [];
    if (onyuGiftHasEligibleBackgroundRequest(onyuRequests, now)) activeSources.push('onyu-vn');
    if (lifeGameSponsorHasEligibleBackgroundRequest(lifeGameRequests, now)) activeSources.push('streamer-life-game');
    if (fanPageViewerSubscriptionHasEligibleBackgroundRequest(fanPagePendingRequests, now,
      [LEGACY_FANPAGE_VIEWER_SUBSCRIPTION_BALLOONS, FANPAGE_VIEWER_SUBSCRIPTION_BALLOONS])) activeSources.push('streamer-fanpage');
    if (fanPageSponsorAdHasEligibleBackgroundRequest(fanPageSponsorRequests, now)) activeSources.push('streamer-fanpage-sponsor');
    active = activeSources.length > 0;
    writeEvent('watch-state', { active, activeSources, expiresAt: active ? now + 60000 : 0 });
    monitorStatusRef.update({ watching: active, activeSources, lastWatchStateAt: now }).catch(() => null);
  };
  const onRequestValue = (snapshot) => {
    onyuRequests = snapshot.val() || {};
    if (accessMode === 'monitor') {
      sendMonitorState();
      return;
    }
    const value = onyuRequests;
    const requests = Object.keys(value).map((id) => Object.assign({}, value[id] || {}, { requestId: id }))
      .sort((a, b) => (Number(b.updatedAt || b.requestedAt) || 0) - (Number(a.updatedAt || a.requestedAt) || 0));
    writeEvent('requests', { requests });
  };
  const onLifeGameRequestValue = (snapshot) => {
    lifeGameRequests = snapshot.val() || {};
    if (accessMode === 'monitor') sendMonitorState();
  };
  const onFanPagePendingValue = (snapshot) => {
    fanPagePendingRequests = snapshot.val() || {};
    if (accessMode === 'monitor') sendMonitorState();
  };
  const onFanPageSponsorRequestValue = (snapshot) => {
    fanPageSponsorRequests = snapshot.val() || {};
    if (accessMode === 'monitor') sendMonitorState();
  };
  const onRequestError = (error) => {
    console.error('SOOP 후원 자동 검증 백그라운드 실시간 구독 실패:', String(error && error.message || error).slice(0, 160));
    writeEvent('stream-error', { reason: 'database-subscription-failed' });
    cleanup();
  };
  const onAdminValue = (snapshot) => {
    if (snapshot.val() === true) return;
    writeEvent('auth-revoked', { reason: 'admin-access-revoked' });
    cleanup();
  };
  const heartbeat = setInterval(() => {
    if (accessMode === 'monitor') {
      const now = Date.now();
      writeEvent('heartbeat', { active, activeSources, expiresAt: active ? now + 60000 : 0 });
      monitorStatusRef.update({ active: true, watching: active, activeSources, lastHeartbeatAt: now }).catch(() => null);
    }
    else writeEvent('heartbeat', { at: Date.now() });
  }, 20000);
  const maxDuration = setTimeout(() => {
    writeEvent('session-expiring', {});
    cleanup();
  }, 55 * 60 * 1000);
  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(maxDuration);
    requestRef.off('value', onRequestValue);
    lifeGameRequestRef.off('value', onLifeGameRequestValue);
    fanPagePendingRef.off('value', onFanPagePendingValue);
    fanPageSponsorRequestRef.off('value', onFanPageSponsorRequestValue);
    adminRef.off('value', onAdminValue);
    if (accessMode === 'monitor') monitorStatusRef.remove().catch(() => null);
    if (!response.destroyed) response.end();
  }
  response.on('close', cleanup);
  if (accessMode === 'monitor') {
    monitorStatusRef.set({ connectedAt: Date.now(), lastHeartbeatAt: Date.now(), active: true, watching: false, activeSources: [], connectionId }).catch(() => null);
    lifeGameRequestRef.on('value', onLifeGameRequestValue, onRequestError);
    fanPagePendingRef.on('value', onFanPagePendingValue, onRequestError);
    fanPageSponsorRequestRef.on('value', onFanPageSponsorRequestValue, onRequestError);
  }
  adminRef.on('value', onAdminValue, onRequestError);
  requestRef.on('value', onRequestValue, onRequestError);
});

const getLifeGameSponsorAutoVerificationDiagnostics = onCall(async (request) => {
  const adminUid = await requireAdmin(request);
  const diagnosticCode = String(request.data && request.data.diagnosticCode || '').trim().toUpperCase();
  if (!/^LG-[A-F0-9]{8}$/.test(diagnosticCode)) {
    throw new HttpsError('invalid-argument', '점검 코드를 확인해주세요.');
  }
  const db = getDatabase();
  const requestId = String((await db.ref('lifeGame/sponsorDiagnosticCodes/' + diagnosticCode).get()).val() || '');
  if (!requestId) throw new HttpsError('not-found', '해당 점검 코드의 신청을 찾을 수 없습니다.');
  const [requestSnap, diagnosticSnap, monitorSnap] = await Promise.all([
    db.ref('lifeGame/sponsorRequests/' + requestId).get(),
    db.ref('adminCenter/donationVerificationDiagnostics/' + diagnosticCode).limitToLast(30).get(),
    db.ref('adminCenter/donationVerificationMonitorStatus/' + adminUid).get(),
  ]);
  const item = requestSnap.val() || {};
  const diagnostics = diagnosticSnap.val() || {};
  const monitors = monitorSnap.val() || {};
  const now = Date.now();
  return {
    ok: true,
    diagnosticCode,
    request: {
      requestId,
      status: String(item.status || ''),
      nickname: String(item.nickname || ''),
      soopId: String(item.soopId || ''),
      donorSoopId: String(item.donorSoopId || ''),
      days: Number(item.days) || 0,
      starBalloons: Number(item.starBalloons) || 0,
      requestedAt: Number(item.requestedAt) || 0,
      donationCompletedAt: Number(item.donationCompletedAt) || 0,
      reviewedAt: Number(item.reviewedAt) || 0,
      verificationSource: String(item.verificationSource || ''),
      verificationEventKey: String(item.verificationEventKey || ''),
      verifiedAt: Number(item.verifiedAt) || 0,
    },
    monitorConnections: Object.values(monitors).map((monitor) => ({
      connected: monitor && monitor.active === true && now - Number(monitor.lastHeartbeatAt || 0) < 60000,
      watching: monitor && monitor.watching === true,
      activeSources: Array.isArray(monitor && monitor.activeSources) ? monitor.activeSources : [],
      lastWatchStateAt: Number(monitor && monitor.lastWatchStateAt) || 0,
      connectedAt: Number(monitor && monitor.connectedAt) || 0,
      lastHeartbeatAt: Number(monitor && monitor.lastHeartbeatAt) || 0,
    })),
    events: Object.keys(diagnostics).map((eventKey) => Object.assign({ eventKey }, diagnostics[eventKey] || {}))
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)),
    checkedAt: now,
  };
});
const ONYU_STREAMER_GIFT_TARGET_LOCK_PATH = 'onyuVn/streamerGameGiftTargetLocks';

async function updateOnyuStreamerGiftTargetLock(db, gift, requestId, status) {
  if (!gift || (gift.purchaseType || 'gift') !== 'gift') return;
  const soopId = normalizeSoopId(gift.targetSoopId);
  if (!soopId) return;
  const lockRef = db.ref(ONYU_STREAMER_GIFT_TARGET_LOCK_PATH + '/' + soopId);
  if (status === 'rejected') {
    await lockRef.transaction((value) => value && value.requestId === requestId ? null : undefined, undefined, false);
    return;
  }
  await lockRef.transaction((value) => {
    if (!value || value.requestId !== requestId) return;
    return Object.assign({}, value, { status: 'approved', approvedAt: Date.now(), reservationExpiresAt: null });
  }, undefined, false);
}

const onyuListStreamerGiftTargets = onCall(async (request) => {
  requireAuth(request);
  throw new HttpsError('failed-precondition', '온이유 게임은 로그인 또는 인증된 스트리머 계정으로 무료 이용할 수 있습니다. 새로운 이용권 구매·선물 신청은 종료되었습니다.');
});

const onyuSubmitStreamerGameGift = onCall(async (request) => {
  requireAuth(request);
  throw new HttpsError('failed-precondition', '온이유 게임은 로그인 또는 인증된 스트리머 계정으로 무료 이용할 수 있습니다. 새로운 이용권 구매·선물 신청은 종료되었습니다.');
});

const onyuListStreamerGameGifts = onCall(async (request) => {
  await requireAdmin(request);
  const snap = await getDatabase().ref('onyuVn/streamerGameGiftRequests').get();
  const data = snap.val() || {};
  const requests = Object.keys(data).map((id) => Object.assign({ requestId: id }, data[id]))
    .sort((a, b) => (b.updatedAt || b.requestedAt || 0) - (a.updatedAt || a.requestedAt || 0));
  return { requests };
});

const ONYU_GIFT_PROCESSING_STALE_MS = 10 * 60 * 1000;

// Abandoned claims can be released only after a conservative timeout. Re-approving
// the same request remains idempotent because the entitlement writer checks requestId.
const onyuRecoverStuckStreamerGameGift = onCall(async (request) => {
  const adminUid = await requireAdmin(request);
  const requestId = String(request.data && request.data.requestId || '').trim();
  if (!requestId || requestId.length > 200 || /[.#$\[\]/]/.test(requestId)) {
    throw new HttpsError('invalid-argument', '복구할 이용권 신청을 선택해 주세요.');
  }
  const db = getDatabase();
  const giftRef = db.ref('onyuVn/streamerGameGiftRequests/' + requestId);
  const now = Date.now();
  const staleBefore = now - ONYU_GIFT_PROCESSING_STALE_MS;
  const result = await giftRef.transaction((current) => {
    if (!current || current.status !== 'processing') return;
    const startedAt = Number(current.processingStartedAt || current.updatedAt || current.requestedAt) || 0;
    if (!startedAt || startedAt > staleBefore) return;
    return Object.assign({}, current, {
      status: 'pending', processingToken: null, processingStartedAt: null,
      updatedAt: now, recoveryCount: (Number(current.recoveryCount) || 0) + 1,
      lastRecoveredAt: now, lastRecoveredBy: adminUid,
    });
  }, undefined, false);
  if (!result.committed) {
    const current = (await giftRef.get()).val();
    if (!current) throw new HttpsError('not-found', '이용권 신청을 찾을 수 없습니다.');
    throw new HttpsError('failed-precondition', current.status !== 'processing'
      ? '이미 다른 상태로 변경된 신청입니다.'
      : '처리 시작 후 10분이 지나지 않아 아직 복구할 수 없습니다.');
  }
  const recovered = result.snapshot.val() || {};
  let auditLogged = true;
  try {
    await logToAdminAuditLog(db, request, '온이유 멈춘 이용권 신청 복구',
      String(recovered.targetNickname || recovered.targetSoopId || recovered.targetUid || '') + ' · ' + requestId + ' · 복구 ' + recovered.recoveryCount + '회');
  } catch (error) {
    auditLogged = false;
    console.error('온이유 멈춘 이용권 신청 복구 감사 로그 실패:', error);
  }
  return { ok: true, requestId, status: 'pending', recoveryCount: recovered.recoveryCount, auditLogged };
});

function safeOnyuEntitlementRecord(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    status: String(value.status || ''),
    grantedAt: Number(value.grantedAt) || 0,
    grantedBy: String(value.grantedBy || ''),
    requestId: String(value.requestId || ''),
    giftRequestId: String(value.giftRequestId || ''),
    purchaseType: String(value.purchaseType || ''),
    revokedAt: Number(value.revokedAt) || 0,
    revokedBy: String(value.revokedBy || ''),
    revocationReason: String(value.revocationReason || ''),
  };
}

function safeOnyuGiftRequestRecord(requestId, value) {
  return {
    requestId,
    requesterUid: String(value.requesterUid || ''),
    targetUid: String(value.targetUid || ''),
    purchaseType: String(value.purchaseType || 'gift'),
    status: String(value.status || 'pending'),
    activationStatus: String(value.activationStatus || ''),
    donorNickname: String(value.donorNickname || ''),
    donorSoopId: String(value.donorSoopId || ''),
    targetNickname: String(value.targetNickname || ''),
    targetSoopId: String(value.targetSoopId || ''),
    requestedAt: Number(value.requestedAt) || 0,
    donationCompletedAt: Number(value.donationCompletedAt) || 0,
    reviewedAt: Number(value.reviewedAt) || 0,
    reviewedBy: String(value.reviewedBy || ''),
    verificationSource: String(value.verificationSource || ''),
  };
}

const onyuAdminLookupEntitlement = onCall(async (request) => {
  await requireAdmin(request);
  const lookupType = String(request.data && request.data.lookupType || '');
  const query = String(request.data && request.data.query || '').trim();
  if (!['uid', 'soopId'].includes(lookupType) || !query || query.length > 128) {
    throw new HttpsError('invalid-argument', '조회 유형과 검색어를 확인해 주세요.');
  }
  const lookupSoopId = lookupType === 'soopId' ? normalizeSoopId(query) : '';
  if (lookupType === 'soopId' && !lookupSoopId) throw new HttpsError('invalid-argument', 'SOOP 아이디는 영문·숫자 2~20자로 입력해 주세요.');
  if (lookupType === 'uid' && /[.#$\[\]/]/.test(query)) throw new HttpsError('invalid-argument', 'Firebase UID 형식이 올바르지 않습니다.');

  const db = getDatabase();
  const [verificationSnap, giftSnap] = await Promise.all([
    db.ref('streamerVerifications').get(),
    db.ref('onyuVn/streamerGameGiftRequests').get(),
  ]);
  const verificationRows = Object.values(verificationSnap.val() || {}).filter((row) => row && typeof row === 'object');
  const giftRows = Object.entries(giftSnap.val() || {}).map(([id, value]) => safeOnyuGiftRequestRecord(id, value || {}));
  const matchedVerifications = lookupType === 'uid'
    ? verificationRows.filter((row) => String(row.uid || '') === query)
    : verificationRows.filter((row) => normalizeSoopId(row.soopId) === lookupSoopId);
  const uidSet = new Set(lookupType === 'uid' ? [query] : []);
  matchedVerifications.forEach((row) => { if (row.uid) uidSet.add(String(row.uid)); });
  const uids = Array.from(uidSet).slice(0, 20);
  const profiles = await Promise.all(uids.map(async (uid) => {
    const verification = matchedVerifications.find((row) => String(row.uid || '') === uid) || null;
    const [userSnap, viewerSnap, streamerSnap] = await Promise.all([
      db.ref('users/' + uid).get(),
      db.ref('onyuVn/gameEntitlements/' + uid).get(),
      db.ref('onyuVn/streamerGameEntitlements/' + uid).get(),
    ]);
    const user = userSnap.val() || {};
    const soopId = normalizeSoopId(verification && verification.soopId || user.soopId || user.streamerId);
    const requests = giftRows.filter((gift) => gift.requesterUid === uid || gift.targetUid === uid ||
      (soopId && normalizeSoopId(gift.targetSoopId) === soopId));
    return {
      uid,
      nickname: String(verification && verification.nickname || user.nickname || user.displayName || '').slice(0, 80),
      soopId,
      streamerVerified: !!verification || user.streamerVerified === true,
      viewerEntitlement: safeOnyuEntitlementRecord(viewerSnap.val()),
      streamerEntitlement: safeOnyuEntitlementRecord(streamerSnap.val()),
      requests: requests.sort((a, b) => b.requestedAt - a.requestedAt).slice(0, 50),
      requestsTruncated: requests.length > 50,
    };
  }));
  const matchedUidSet = new Set(uids);
  const unlinkedRequests = lookupSoopId
    ? giftRows.filter((gift) => normalizeSoopId(gift.targetSoopId) === lookupSoopId && !gift.targetUid && !matchedUidSet.size)
      .sort((a, b) => b.requestedAt - a.requestedAt).slice(0, 50)
    : [];
  return {
    lookupType,
    query: lookupType === 'soopId' ? lookupSoopId : query,
    profiles,
    unlinkedRequests,
    truncated: matchedVerifications.length > uids.length || profiles.some((profile) => profile.requestsTruncated) || unlinkedRequests.length === 50,
  };
});

const onyuAdminRevokeEntitlement = onCall(async (request) => {
  const adminUid = await requireAdmin(request);
  const uid = String(request.data && request.data.uid || '').trim();
  const entitlementType = String(request.data && request.data.entitlementType || '');
  const reason = String(request.data && request.data.reason || '').replace(/[\0\r\n]/g, ' ').trim();
  if (!uid || uid.length > 128 || /[.#$\[\]/]/.test(uid) || !['viewer', 'streamer'].includes(entitlementType)) {
    throw new HttpsError('invalid-argument', '대상 계정 또는 이용권 유형이 올바르지 않습니다.');
  }
  if (!reason || reason.length > 200) throw new HttpsError('invalid-argument', '회수 사유를 1~200자로 입력해 주세요.');
  const db = getDatabase();
  const entitlementPath = entitlementType === 'viewer' ? 'onyuVn/gameEntitlements/' : 'onyuVn/streamerGameEntitlements/';
  const entitlementRef = db.ref(entitlementPath + uid);
  const now = Date.now();
  const result = await entitlementRef.transaction((current) => {
    if (!current || current.status !== 'active') return;
    return Object.assign({}, current, {
      status: 'revoked', revokedAt: now, revokedBy: adminUid,
      revocationReason: reason, updatedAt: now,
    });
  }, undefined, false);
  if (!result.committed) {
    const current = (await entitlementRef.get()).val();
    if (!current) throw new HttpsError('not-found', '활성 이용권을 찾을 수 없습니다.');
    throw new HttpsError('failed-precondition', '이용권이 이미 회수됐거나 활성 상태가 아닙니다.');
  }
  const entitlement = result.snapshot.val() || {};
  const requestId = String(entitlement.giftRequestId || entitlement.requestId || '');
  let requestHistoryUpdated = true;
  if (requestId) {
    try {
      await db.ref('onyuVn/streamerGameGiftRequests/' + requestId).update({
        activationStatus: 'revoked', entitlementRevokedAt: now, entitlementRevokedBy: adminUid, updatedAt: now,
      });
    } catch (error) {
      requestHistoryUpdated = false;
      console.error('온이유 이용권 회수 신청 이력 갱신 실패:', error);
    }
  }
  let auditLogged = true;
  try {
    await logToAdminAuditLog(db, request, '온이유 ' + (entitlementType === 'viewer' ? '일반' : '스트리머') + ' 이용권 회수',
      uid + (requestId ? ' · 신청 ' + requestId : '') + ' · 사유: ' + reason);
  } catch (error) {
    auditLogged = false;
    console.error('온이유 이용권 회수 감사 로그 실패:', error);
  }
  return { ok: true, uid, entitlementType, status: 'revoked', revokedAt: now, requestHistoryUpdated, auditLogged };
});

const onyuGetMyStreamerGameGiftRequestStatus = onCall(async (request) => {
  const uid = requireAuth(request);
  const requestId = String(request.data && request.data.requestId || '').trim();
  if (!requestId || requestId.length > 200 || /[.#$\[\]/]/.test(requestId)) throw new HttpsError('invalid-argument', '신청 정보가 올바르지 않습니다.');
  const snap = await getDatabase().ref('onyuVn/streamerGameGiftRequests/' + requestId).get();
  const gift = snap.val();
  if (!gift || gift.requesterUid !== uid) return { ok: true, found: false };
  return {
    ok: true,
    found: true,
    status: String(gift.status || 'pending'),
    activationStatus: String(gift.activationStatus || ''),
    purchaseType: String(gift.purchaseType || 'gift'),
    targetNickname: String(gift.targetNickname || ''),
    balloons: Number(gift.balloons) || ONYU_STREAMER_GIFT_BALLOONS,
    donationCompletedAt: Number(gift.donationCompletedAt) || 0,
    updatedAt: Number(gift.updatedAt || gift.reviewedAt || gift.requestedAt) || 0,
  };
});

const onyuMarkStreamerGameGiftDonationComplete = onCall(async (request) => {
  const uid = requireAuth(request);
  const requestId = String(request.data && request.data.requestId || '').trim();
  if (!requestId || requestId.length > 200 || /[.#$\[\]/]/.test(requestId)) throw new HttpsError('invalid-argument', '신청 정보가 올바르지 않습니다.');
  const giftRef = getDatabase().ref('onyuVn/streamerGameGiftRequests/' + requestId);
  const now = Date.now();
  const result = await giftRef.transaction((current) => {
    if (!current || current.requesterUid !== uid || current.status !== 'pending') return;
    if (Number(current.donationCompletedAt) > 0) return;
    return Object.assign({}, current, { donationCompletedAt: now, updatedAt: now });
  }, undefined, false);
  if (!result.committed) {
    const current = (await giftRef.get()).val();
    if (!current || current.requesterUid !== uid) throw new HttpsError('not-found', '신청을 찾을 수 없습니다.');
    if (current.status !== 'pending' || !Number(current.donationCompletedAt)) {
      throw new HttpsError('failed-precondition', '대기 중인 신청이 아니거나 후원 완료를 접수할 수 없습니다.');
    }
  }
  return { ok: true, donationCompletedAt: Number(result.snapshot && result.snapshot.val() && result.snapshot.val().donationCompletedAt) || now };
});

async function processOnyuStreamerGameGiftReview(request, adminUid, requestId, decision, verificationMetadata) {
  const db = getDatabase();
  const giftRef = db.ref('onyuVn/streamerGameGiftRequests/' + requestId);
  const now = Date.now();
  const claimToken = require('node:crypto').randomBytes(16).toString('hex');
  const claim = await giftRef.transaction((current) => {
    if (!current || current.status !== 'pending') return;
    return Object.assign({}, current, { status: 'processing', processingToken: claimToken, processingStartedAt: now });
  }, undefined, false);
  if (!claim.committed) throw new HttpsError('failed-precondition', '대기 중인 선물 신청이 아닙니다. 다른 관리자가 이미 처리 중일 수 있습니다.');
  const gift = claim.snapshot.val() || {};
  try {
  const purchaseType = gift.purchaseType || 'gift';
  if (decision === 'approve') {
    const isViewerPurchase = purchaseType === 'self-viewer';
    if (isViewerPurchase) {
      if (gift.requesterUid !== gift.targetUid) throw new HttpsError('failed-precondition', '본인 구매 신청 계정 정보가 일치하지 않습니다.');
    } else {
      if (purchaseType === 'gift') {
        const soopId = normalizeSoopId(gift.targetSoopId);
        if (!soopId) throw new HttpsError('failed-precondition', '선물 받을 SOOP 아이디가 없습니다.');
        const verifiedSnap = await db.ref('streamerVerifications').orderByChild('soopId').equalTo(soopId).limitToFirst(1).get();
        const verified = Object.values(verifiedSnap.val() || {})[0] || null;
        if (verified && gift.targetNickname && String(verified.nickname || '').trim() !== String(gift.targetNickname).trim()) {
          throw new HttpsError('failed-precondition', '선물 대상 SOOP 닉네임과 아이디가 인증 정보와 일치하지 않습니다.');
        }
        if (verified && verified.uid) {
          gift.targetUid = String(verified.uid);
          gift.targetNickname = String(verified.nickname || gift.targetNickname || '');
        } else {
          // 후원 확인은 완료됐지만 아직 인증 전이면 승인 상태로 보관하고,
          // streamerVerifications 기록이 생기는 즉시 entitlement를 연결한다.
          await giftRef.update({
            status: 'approved', activationStatus: 'awaiting-streamer-verification',
            reviewedAt: now, reviewedBy: adminUid, updatedAt: now,
            processingToken: null, processingStartedAt: null,
            ...(verificationMetadata || {}),
          });
          await updateOnyuStreamerGiftTargetLock(db, gift, requestId, 'approved');
          // 인증 승인이 거의 동시에 진행됐더라도 놓치지 않도록, 대기 상태 기록
          // 직후 원장을 다시 읽어 인증 완료분을 즉시 연결한다.
          const latestVerifiedSnap = await db.ref('streamerVerifications').orderByChild('soopId').equalTo(soopId).limitToFirst(1).get();
          const latestVerified = Object.values(latestVerifiedSnap.val() || {})[0];
          if (latestVerified && latestVerified.uid) {
            await activateApprovedOnyuGiftsForStreamer(db, latestVerified);
            const latestGift = (await giftRef.get()).val() || {};
            if (latestGift.activationStatus === 'activated') {
              await logToAdminAuditLog(db, request, '온 이유 스트리머 게임 선물 승인', gift.targetNickname + ' · ' + requestId);
              await recordOnyuServerEvent(request, 'streamer_game_gift_approved', { targetUid: latestVerified.uid });
              return { ok: true, status: 'approved', activationStatus: 'activated', targetUid: latestVerified.uid };
            }
          }
          await logToAdminAuditLog(db, request, '온 이유 스트리머 게임 선물 승인 (인증 대기)', gift.targetNickname + ' · ' + requestId);
          await recordOnyuServerEvent(request, 'streamer_game_gift_approved', { targetUid: null });
          return { ok: true, status: 'approved', activationStatus: 'awaiting-streamer-verification', targetUid: null };
        }
      } else {
        const streamerFlagSnap = await db.ref('users/' + gift.targetUid + '/streamerVerified').get();
        if (streamerFlagSnap.val() !== true && !(await isVerifiedStreamerUid(gift.targetUid))) {
          throw new HttpsError('failed-precondition', '선물 받을 계정이 더 이상 인증 스트리머가 아닙니다.');
        }
      }
    }
    const entitlementRef = db.ref((isViewerPurchase ? 'onyuVn/gameEntitlements/' : 'onyuVn/streamerGameEntitlements/') + gift.targetUid);
    const grant = {
      status: 'active',
      grantedAt: now,
      grantedBy: adminUid,
      requestId,
      giftRequestId: isViewerPurchase ? null : requestId,
      purchaseType,
      requesterUid: gift.requesterUid || '',
      donorNickname: gift.donorNickname || '',
      targetNickname: gift.targetNickname || '',
    };
    const currentEntitlement = (await entitlementRef.get()).val();
    if (currentEntitlement && currentEntitlement.status === 'active') {
      if (currentEntitlement.requestId !== requestId && currentEntitlement.giftRequestId !== requestId) {
        throw new HttpsError('already-exists', '해당 계정에 이미 이용권이 부여되어 있습니다.');
      }
    } else {
      const result = await entitlementRef.transaction((current) => current === null ? grant : undefined);
      if (!result.committed) throw new HttpsError('already-exists', '해당 계정에 이미 이용권이 부여되어 있습니다.');
    }
  }
  await giftRef.update({
    status: decision === 'approve' ? 'approved' : 'rejected',
    ...(decision === 'approve' && purchaseType === 'gift' ? { activationStatus: 'activated', targetUid: gift.targetUid } : {}),
    reviewedAt: now,
    reviewedBy: adminUid,
    updatedAt: now,
    processingToken: null,
    processingStartedAt: null,
    ...(verificationMetadata || {}),
  });
  await updateOnyuStreamerGiftTargetLock(db, gift, requestId, decision === 'approve' ? 'approved' : 'rejected');
  const requestLabel = purchaseType === 'self-viewer' ? '일반 유저 게임 이용권 본인 구매' : purchaseType === 'self' ? '스트리머 게임 이용권 직접 구매' : '스트리머 게임 선물';
  await logToAdminAuditLog(db, request, '온 이유 ' + requestLabel + ' ' + (decision === 'approve' ? '승인' : '거절'), gift.targetNickname + ' · ' + requestId);
  const eventPrefix = purchaseType === 'self-viewer' ? 'viewer_game_license_purchase_' : purchaseType === 'self' ? 'streamer_game_license_purchase_' : 'streamer_game_gift_';
  await recordOnyuServerEvent(request, eventPrefix + (decision === 'approve' ? 'approved' : 'rejected'), { targetUid: gift.targetUid });
  return { ok: true, status: decision === 'approve' ? 'approved' : 'rejected', targetUid: gift.targetUid };
  } catch (error) {
    await giftRef.transaction((current) => {
      if (!current || current.status !== 'processing' || current.processingToken !== claimToken) return;
      const restored = Object.assign({}, current, { status: 'pending', processingToken: null, processingStartedAt: null });
      return restored;
    }, undefined, false).catch(() => null);
    throw error;
  }
}

const onyuReviewStreamerGameGift = onCall(async (request) => {
  const adminUid = await requireAdmin(request);
  const requestId = String(request.data && request.data.requestId || '').trim();
  const decision = String(request.data && request.data.decision || '').trim();
  if (!requestId || requestId.length > 200 || /[.#$\[\]/]/.test(requestId)) throw new HttpsError('invalid-argument', '선물 신청을 선택해 주세요.');
  if (!['approve', 'reject'].includes(decision)) throw new HttpsError('invalid-argument', '처리 유형이 올바르지 않습니다.');
  return processOnyuStreamerGameGiftReview(request, adminUid, requestId, decision, null);
});

const onyuConfirmStreamerGameGiftFromNotification = onCall(async (request) => {
  const reviewer = await resolveOnyuGiftReviewActor(request);
  const adminUid = reviewer.adminUid;
  request = reviewer.request;
  const senderSoopId = normalizeSoopId(request.data && request.data.senderSoopId);
  const balloons = Number(request.data && request.data.balloons);
  const observedAt = Number(request.data && request.data.observedAt);
  const eventAtMin = Number(request.data && request.data.eventAtMin);
  const eventAtMax = Number(request.data && request.data.eventAtMax);
  const candidateFingerprint = String(request.data && request.data.candidateFingerprint || '').toLowerCase();
  const exactTimestamp = request.data && request.data.exactTimestamp === true;
  const now = Date.now();
  if (!senderSoopId || balloons !== ONYU_STREAMER_GIFT_BALLOONS ||
      !Number.isFinite(observedAt) || observedAt < now - 2 * 60 * 1000 || observedAt > now + 30000 ||
      !Number.isFinite(eventAtMin) || !Number.isFinite(eventAtMax) || eventAtMin > eventAtMax ||
      eventAtMin < observedAt - 24 * 60 * 60 * 1000 || eventAtMax > observedAt + 30000 ||
      !/^[a-f0-9]{32,64}$/.test(candidateFingerprint)) {
    throw new HttpsError('invalid-argument', '후원 알림 정보가 올바르지 않습니다.');
  }
  const db = getDatabase();
  const eventKey = require('node:crypto').createHash('sha256')
    .update(senderSoopId + '|' + balloons + '|' + candidateFingerprint).digest('hex').slice(0, 40);
  const eventRef = db.ref('onyuVn/streamerGameGiftDonationEvents/' + eventKey);
  const claimToken = require('node:crypto').randomBytes(16).toString('hex');
  const eventClaim = await eventRef.transaction((current) => {
    if (current && (current.status !== 'processing' || now - Number(current.startedAt || now) < 2 * 60 * 1000)) return;
    return { status: 'processing', startedAt: now, claimToken, balloons };
  }, undefined, false);
  if (!eventClaim.committed) return { ok: false, reason: 'notification-already-processed' };
  try {
    const requestSnap = await db.ref('onyuVn/streamerGameGiftRequests').get();
    const requests = requestSnap.val() || {};
    const candidates = Object.entries(requests).filter(([requestId, gift]) => {
      if (!gift || gift.status !== 'pending' || normalizeSoopId(gift.donorSoopId) !== senderSoopId ||
          Number(gift.balloons) !== balloons) return false;
      const requestedAt = Number(gift.requestedAt) || 0;
      const donationCompletedAt = Number(gift.donationCompletedAt) || 0;
      if (!requestedAt || requestedAt > observedAt || observedAt - requestedAt > 24 * 60 * 60 * 1000) return false;
      if (!donationCompletedAt || donationCompletedAt < requestedAt || donationCompletedAt > observedAt + 30000 ||
          observedAt - donationCompletedAt > 20 * 60 * 1000) return false;
      // Exact DOM timestamps must fall after the application and close to the
      // requester's explicit completion signal. Relative labels are a range;
      // require overlap with that short window and a single matching request.
      // Rows outside the window or ambiguous matches stay in manual review.
      if (exactTimestamp) return eventAtMin === eventAtMax && requestedAt <= eventAtMin &&
        eventAtMin >= donationCompletedAt - 5 * 60 * 1000 && eventAtMin <= donationCompletedAt + 2 * 60 * 1000;
      return requestedAt <= eventAtMax && eventAtMin <= donationCompletedAt + 2 * 60 * 1000 &&
        eventAtMax >= donationCompletedAt - 5 * 60 * 1000;
    });
    if (candidates.length !== 1) {
      await eventRef.transaction((current) => current && current.claimToken === claimToken ? null : undefined, undefined, false);
      return { ok: false, reason: candidates.length ? 'multiple-matching-requests' : 'no-matching-pending-request' };
    }
    const [requestId, gift] = candidates[0];
    const verifiedAt = Date.now();
    const result = await processOnyuStreamerGameGiftReview(request, adminUid, requestId, 'approve', {
      verificationSource: 'soop-donation-notification',
      verificationSenderSoopId: senderSoopId,
      verificationEventKey: eventKey,
      verifiedAt,
    });
    await eventRef.update({ status: 'approved', requestId, claimToken: null, approvedAt: Date.now() });
    return Object.assign({}, result, { targetNickname: String(gift.targetNickname || ''), verificationSource: 'soop-donation-notification' });
  } catch (error) {
    await eventRef.transaction((current) => current && current.claimToken === claimToken ? null : undefined, undefined, false).catch(() => null);
    if (error instanceof HttpsError && error.code === 'failed-precondition') return { ok: false, reason: 'request-no-longer-pending' };
    throw error;
  }
});

// Other services also collect SOOP donations on the same admin station. Their
// requests do not all carry a donor ID or a completion signal, so a recent
// amount/time overlap must block automatic approval instead of being guessed.
// These source paths and fields were checked against their callable writers.
const OTHER_GAME_DONATION_REQUEST_SOURCES = [
  { path: 'bannerRequests', gameKey: 'soop-stock-market', requestType: 'rank-banner', amountField: 'starBalloons' },
  { path: 'chartBannerRequests', gameKey: 'soop-stock-market', requestType: 'chart-banner', amountField: 'starBalloons' },
  { path: 'cardBannerRequests', gameKey: 'soop-stock-market', requestType: 'card-banner', amountField: 'starBalloons' },
  { path: 'pinRequests', gameKey: 'soop-stock-market', requestType: 'pin', amountField: 'starBalloons' },
  { path: 'relayRoomRequests', gameKey: 'soop-stock-market', requestType: 'relay-room', amountField: 'starBalloons' },
  { path: 'cashChargeRequests', gameKey: 'soop-stock-market', requestType: 'cash-charge', donorField: 'soopId', amountUnknown: true },
  { path: 'unfreezeDonationRequests', gameKey: 'soop-stock-market', requestType: 'unfreeze-donation', donorField: 'soopId', fixedAmount: 50 },
];
const OTHER_GAME_DONATION_REQUEST_WINDOW_MS = 20 * 60 * 1000;

async function commitFanPageViewerSubscriptionApproval(db, adminUid, requestId, senderSoopId, balloons, observedAt, eventAtMin, eventAtMax, exactTimestamp, verificationMetadata) {
  const requestRef = db.ref('streamerFanPageViewerSubscriptionRequests/' + requestId);
  const claimToken = require('node:crypto').randomBytes(16).toString('hex');
  const claimedAt = Date.now();
  const claim = await requestRef.transaction((current) => {
    if (!current || current.status !== 'pending' ||
        !fanPageViewerSubscriptionDonationCanMatch(current, senderSoopId, balloons, observedAt,
          eventAtMin, eventAtMax, exactTimestamp,
          [LEGACY_FANPAGE_VIEWER_SUBSCRIPTION_BALLOONS, FANPAGE_VIEWER_SUBSCRIPTION_BALLOONS])) return;
    return Object.assign({}, current, { status: 'processing', processingAt: claimedAt, processingToken: claimToken });
  }, undefined, false);
  if (!claim.committed) {
    const current = claim.snapshot.val() || {};
    if (current.status === 'approved' && current.verificationEventKey === verificationMetadata.verificationEventKey) {
      const subscription = (await db.ref('streamerFanPageViewerSubscriptions/' + current.requesterUid).get()).val() || {};
      return { ok: true, status: 'approved', expiresAt: Number(subscription.expiresAt) || 0 };
    }
    throw new HttpsError('failed-precondition', '구독 신청이 더 이상 자동 승인 대기 상태가 아닙니다.');
  }

  const item = claim.snapshot.val() || {};
  const subscriptionRef = db.ref('streamerFanPageViewerSubscriptions/' + item.requesterUid);
  try {
    await db.ref('streamerFanPageViewerSubscriptionPending/' + requestId).update({ status: 'processing' });
    const entitlement = await subscriptionRef.transaction((current) => {
      const previous = current && typeof current === 'object' ? current : {};
      if (previous.lastApprovedRequestId === requestId) return previous;
      if (previous.pendingRequestId !== requestId) return;
      const approvedAt = Date.now();
      return Object.assign({}, previous, {
        expiresAt: Math.max(approvedAt, Number(previous.expiresAt) || 0) + 30 * 24 * 60 * 60 * 1000,
        lastApprovedAt: approvedAt,
        lastApprovedRequestId: requestId,
      });
    });
    const entitlementValue = entitlement.snapshot.val() || {};
    if (!entitlement.committed && entitlementValue.lastApprovedRequestId !== requestId) {
      throw new HttpsError('aborted', '구독 기간을 적용하지 못했습니다. 자동 확인을 다시 시도해 주세요.');
    }
    const expiresAt = Number(entitlementValue.expiresAt) || 0;
    const finalized = await requestRef.transaction((current) => {
      if (!current || current.status !== 'processing' || current.processingToken !== claimToken) return;
      return Object.assign({}, current, verificationMetadata, {
        status: 'approved',
        reviewedAt: Date.now(),
        reviewedBy: adminUid,
        approvedUntil: expiresAt,
        processingAt: null,
        processingToken: null,
      });
    }, undefined, false);
    const finalValue = finalized.snapshot.val() || {};
    if (!finalized.committed && !(finalValue.status === 'approved' && finalValue.verificationEventKey === verificationMetadata.verificationEventKey)) {
      throw new HttpsError('aborted', '신청 상태를 승인 완료로 저장하지 못했습니다. 관리자가 확인해야 합니다.');
    }
    await db.ref().update({
      ['streamerFanPageViewerSubscriptionPending/' + requestId]: null,
      ['streamerFanPageViewerSubscriptions/' + item.requesterUid + '/pendingRequestId']: null,
    });
    return { ok: true, status: 'approved', expiresAt };
  } catch (error) {
    const restored = await requestRef.transaction((current) => {
      if (!current || current.status !== 'processing' || current.processingToken !== claimToken) return;
      return Object.assign({}, current, { status: 'pending', processingAt: null, processingToken: null });
    }, undefined, false).catch(() => null);
    if (restored && restored.committed) {
      const pending = restored.snapshot.val() || {};
      await db.ref('streamerFanPageViewerSubscriptionPending/' + requestId).set({
        status: 'pending',
        requestedAt: Number(pending.requestedAt) || 0,
        donorSoopId: String(pending.donorSoopId || ''),
        balloonCost: Number(pending.balloonCost) || 0,
        donationCompletedAt: Number(pending.donationCompletedAt) || 0,
      }).catch(() => null);
    }
    throw error;
  }
}

async function holdFreshRealtimeSnapshot(ref) {
  let listener = null;
  const snapshot = await new Promise((resolve, reject) => {
    listener = (value) => resolve(value);
    ref.on('value', listener, reject);
  });
  return { snapshot, release: () => ref.off('value', listener) };
}

async function commitFanPageSponsorAdApproval(db, adminUid, requestId, senderSoopId, balloons, observedAt, eventAtMin, eventAtMax, exactTimestamp, verificationMetadata) {
  const requestRef = db.ref(FANPAGE_SPONSOR_REQUESTS_PATH + '/' + requestId);
  const claimRef = db.ref(FANPAGE_SPONSOR_CLAIMS_PATH + '/' + requestId);
  const adsRef = db.ref(FANPAGE_SPONSOR_ADS_PATH);
  const claimToken = require('node:crypto').randomBytes(16).toString('hex');
  const verifiedAt = Number(verificationMetadata.verifiedAt) || Date.now();
  const held = [];
  let claimPrepared = false;
  let adCreatedByAttempt = false;
  let adExpiresAt = 0;
  let pendingRecord = null;
  try {
    for (const ref of [requestRef, claimRef, adsRef]) held.push(await holdFreshRealtimeSnapshot(ref));
    pendingRecord = held[0].snapshot.val() || {};
    if (pendingRecord.status === 'approved' && pendingRecord.verificationEventKey === verificationMetadata.verificationEventKey) {
      const existingAd = pendingRecord.campaignId
        ? (await db.ref(FANPAGE_SPONSOR_ADS_PATH + '/' + pendingRecord.campaignId).get()).val()
        : null;
      return { ok: true, status: 'approved', expiresAt: Number(existingAd && existingAd.expiresAt) || Number(pendingRecord.approvedUntil) || 0 };
    }

    const claimed = await requestRef.transaction((current) => {
      if (!fanPageSponsorAdDonationCanMatch(current, senderSoopId, balloons, observedAt, eventAtMin, eventAtMax, exactTimestamp)) return;
      const now = Date.now();
      if (current.status === 'pending' && current.processingToken &&
          now - Number(current.processingAt || now) < 2 * 60 * 1000) return;
      return Object.assign({}, current, {
        status: 'processing',
        processingAt: now,
        processingToken: claimToken,
        donationCompletedAt: Number(current.donationCompletedAt) || verifiedAt,
      });
    }, undefined, false);
    if (!claimed.committed) {
      const current = claimed.snapshot.val() || {};
      if (current.status === 'approved' && current.verificationEventKey === verificationMetadata.verificationEventKey) {
        return { ok: true, status: 'approved', expiresAt: Number(current.approvedUntil) || 0 };
      }
      throw new HttpsError('failed-precondition', '홍보 신청이 더 이상 자동 승인 대기 상태가 아닙니다.');
    }
    pendingRecord = claimed.snapshot.val() || {};

    const requestSoopId = normalizeSoopId(pendingRecord.soopId);
    const rail = pendingRecord.rail === 'right' ? 'right' : pendingRecord.rail === 'left' ? 'left' : '';
    const days = Number(pendingRecord.days);
    if (!requestSoopId || !rail || !Number.isInteger(days) || days < 1 || days > 30 || days * 10 !== balloons) {
      throw new HttpsError('failed-precondition', '홍보 신청의 스트리머·위치·기간 정보가 올바르지 않습니다.');
    }

    const requestClaim = await claimRef.transaction((current) => {
      const now = Date.now();
      if (!current || current.status !== 'pending' || normalizeSoopId(current.soopId) !== requestSoopId ||
          current.rail !== rail || (current.verificationProcessingToken &&
            now - Number(current.verificationProcessingAt || now) < 2 * 60 * 1000)) return;
      return Object.assign({}, current, {
        donationCompletedAt: Number(current.donationCompletedAt) || verifiedAt,
        verificationProcessingAt: now,
        verificationProcessingToken: claimToken,
      });
    }, undefined, false);
    if (!requestClaim.committed) throw new HttpsError('failed-precondition', '홍보 자리 예약을 확인하지 못했습니다.');
    claimPrepared = true;

    const campaignId = requestId;
    const now = Date.now();
    adExpiresAt = now + days * 24 * 60 * 60 * 1000;
    const savedAd = {
      campaignId,
      soopId: requestSoopId,
      rail,
      nickname: String(pendingRecord.nickname || '').slice(0, 40),
      status: 'active',
      startsAt: now,
      expiresAt: adExpiresAt,
      requestId,
    };
    const capacity = await adsRef.transaction((current) => {
      const next = { ...(current && typeof current === 'object' ? current : {}) };
      for (const [id, ad] of Object.entries(next)) {
        if (!ad || ad.status !== 'active' || Number(ad.expiresAt) <= now) delete next[id];
      }
      const existing = next[campaignId];
      if (existing && existing.status === 'active' && existing.requestId === requestId && existing.soopId === requestSoopId) return next;
      if (Object.values(next).some((ad) => normalizeSoopId(ad && ad.soopId) === requestSoopId) ||
          Object.keys(next).length >= FANPAGE_SPONSOR_MAX_ACTIVE_ADS ||
          Object.values(next).filter((ad) => ad && ad.rail === rail).length >= FANPAGE_SPONSOR_MAX_ADS_PER_RAIL) return;
      next[campaignId] = savedAd;
      return next;
    }, undefined, false);
    const committedAd = (capacity.snapshot.val() || {})[campaignId];
    if (!capacity.committed && !(committedAd && committedAd.status === 'active' && committedAd.requestId === requestId && committedAd.soopId === requestSoopId)) {
      throw new HttpsError('resource-exhausted', '현재 홍보 칸이 모두 찼습니다. 운영자가 신청을 확인해야 합니다.');
    }
    const preexistingAd = (held[2].snapshot.val() || {})[campaignId];
    adCreatedByAttempt = !!capacity.committed && !preexistingAd && committedAd && committedAd.requestId === requestId;
    if (committedAd && Number(committedAd.expiresAt) > 0) adExpiresAt = Number(committedAd.expiresAt);

    const activation = await claimRef.transaction((current) => {
      if (!current || current.status !== 'pending' || current.verificationProcessingToken !== claimToken ||
          normalizeSoopId(current.soopId) !== requestSoopId || current.rail !== rail) return;
      return Object.assign({}, current, {
        status: 'active',
        expiresAt: adExpiresAt,
        campaignId,
        verificationEventKey: verificationMetadata.verificationEventKey,
        verificationProcessingAt: null,
        verificationProcessingToken: null,
      });
    }, undefined, false);
    if (!activation.committed && !((activation.snapshot.val() || {}).status === 'active' &&
        (activation.snapshot.val() || {}).campaignId === campaignId)) {
      throw new HttpsError('aborted', '홍보 자리 예약을 노출 상태로 전환하지 못했습니다.');
    }

    const finalized = await requestRef.transaction((current) => {
      if (!current || current.status !== 'processing' || current.processingToken !== claimToken) return;
      return Object.assign({}, current, verificationMetadata, {
        status: 'approved',
        reviewedAt: Date.now(),
        reviewedBy: adminUid,
        campaignId,
        approvedUntil: adExpiresAt,
        processingAt: null,
        processingToken: null,
        verificationProcessingAt: null,
        verificationProcessingToken: null,
        updatedAt: Date.now(),
      });
    }, undefined, false);
    const finalValue = finalized.snapshot.val() || {};
    if (!finalized.committed && !(finalValue.status === 'approved' && finalValue.verificationEventKey === verificationMetadata.verificationEventKey)) {
      throw new HttpsError('aborted', '신청 승인 결과를 저장하지 못했습니다. 운영자가 확인해야 합니다.');
    }
    await db.ref(FANPAGE_SPONSOR_PENDING_PATH + '/' + requestId).remove().catch((error) => {
      console.error('고점체크 후원 스트리머 대기 인덱스 정리 실패:', String(error && error.message || error).slice(0, 120));
    });
    return { ok: true, status: 'approved', expiresAt: adExpiresAt };
  } catch (error) {
    if (adCreatedByAttempt) await adsRef.child(requestId).transaction((current) =>
      current && current.requestId === requestId && current.soopId === normalizeSoopId(pendingRecord && pendingRecord.soopId) ? null : current,
    undefined, false).catch(() => null);
    if (claimPrepared) await claimRef.transaction((current) => {
      if (!current || (current.verificationProcessingToken !== claimToken &&
          !(current.status === 'active' && current.campaignId === requestId &&
            current.verificationEventKey === verificationMetadata.verificationEventKey))) return;
      return Object.assign({}, current, {
        status: 'pending',
        expiresAt: Number(pendingRecord && pendingRecord.expiresAt) || Number(current.expiresAt) || Date.now(),
        campaignId: null,
        donationCompletedAt: Number(current.donationCompletedAt) || verifiedAt,
        verificationProcessingAt: null,
        verificationProcessingToken: null,
      });
    }, undefined, false).catch(() => null);
    await requestRef.transaction((current) => {
      if (!current || current.status !== 'processing' || current.processingToken !== claimToken) return;
      return Object.assign({}, current, {
        status: 'pending',
        processingAt: null,
        processingToken: null,
        donationCompletedAt: Number(current.donationCompletedAt) || verifiedAt,
        verificationProcessingAt: null,
        verificationProcessingToken: null,
        updatedAt: Date.now(),
      });
    }, undefined, false).catch(() => null);
    throw error;
  } finally {
    held.forEach((item) => item.release());
  }
}

function findOtherGameDonationRequestCandidates(sourceMaps, senderSoopId, balloons, observedAt, eventAtMin, eventAtMax) {
  const candidates = [];
  OTHER_GAME_DONATION_REQUEST_SOURCES.forEach((source) => {
    const requests = sourceMaps[source.path] || {};
    Object.entries(requests).forEach(([requestId, item]) => {
      if (!item || item.status !== 'pending') return;
      const requestedAt = Number(item.requestedAt) || 0;
      if (!requestedAt || requestedAt > observedAt || observedAt - requestedAt > 24 * 60 * 60 * 1000 ||
          requestedAt < eventAtMin - OTHER_GAME_DONATION_REQUEST_WINDOW_MS || requestedAt > eventAtMax) return;
      if (source.amountField && Number(item[source.amountField]) !== balloons) return;
      if (Number.isFinite(source.fixedAmount) && source.fixedAmount !== balloons) return;
      const donorSoopId = source.donorField ? normalizeSoopId(item[source.donorField]) : '';
      if (donorSoopId && donorSoopId !== senderSoopId) return;
      candidates.push({
        gameKey: source.gameKey,
        requestType: source.requestType,
        requestPath: source.path,
        requestId,
        requestedAt,
        expectedBalloons: source.amountUnknown ? null : Number(source.fixedAmount || item[source.amountField]) || 0,
        donorMatch: donorSoopId ? true : 'unknown',
      });
    });
  });
  return candidates;
}

async function writeLifeGameSponsorDonationDiagnostic(db, diagnosticCodes, eventKey, details) {
  const codes = Array.from(new Set((diagnosticCodes || []).filter((code) => /^LG-[A-F0-9]{8}$/.test(String(code || '')))));
  if (!codes.length) return;
  const now = Date.now();
  const updates = {};
  codes.forEach((code) => {
    updates['adminCenter/donationVerificationDiagnostics/' + code + '/' + eventKey] = Object.assign({
      eventKey,
      createdAt: now,
    }, details || {});
  });
  await db.ref().update(updates);
}

async function writeFanPageSponsorDonationDiagnostic(db, eventKey, details) {
  if (!/^[a-f0-9]{40}$/.test(String(eventKey || ''))) return;
  const now = Date.now();
  const diagnosticsRef = db.ref(FANPAGE_SPONSOR_DONATION_DIAGNOSTICS_PATH);
  const recordRef = diagnosticsRef.child(eventKey);
  await recordRef.transaction((current) => Object.assign({}, current || {}, details || {}, {
    eventKey,
    createdAt: Number(current && current.createdAt) || now,
    updatedAt: now,
  }), undefined, false);

  // Admin-only diagnostic data is bounded even if SOOP notifications keep arriving.
  // Keep at most 500 records from the last 90 days; no raw notification text or token is stored.
  const allSnapshot = await diagnosticsRef.get();
  const entries = Object.entries(allSnapshot.val() || {})
    .sort((a, b) => (Number(a[1] && a[1].createdAt) || 0) - (Number(b[1] && b[1].createdAt) || 0));
  const cutoff = now - FANPAGE_SPONSOR_DONATION_DIAGNOSTICS_RETENTION_MS;
  const removeCount = Math.max(0, entries.length - FANPAGE_SPONSOR_DONATION_DIAGNOSTICS_MAX_RECORDS);
  const updates = {};
  entries.forEach(([key, value], index) => {
    if ((Number(value && value.createdAt) || 0) < cutoff || index < removeCount) updates[key] = null;
  });
  if (Object.keys(updates).length) await diagnosticsRef.update(updates);
}

const listFanPageSponsorDonationDiagnostics = onCall(async (request) => {
  await requireAdmin(request);
  const snapshot = await getDatabase().ref(FANPAGE_SPONSOR_DONATION_DIAGNOSTICS_PATH).get();
  const events = Object.entries(snapshot.val() || {})
    .map(([eventKey, value]) => Object.assign({ eventKey }, value || {}))
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
    .slice(0, 100);
  return { ok: true, events, checkedAt: Date.now(), retentionDays: 90, maxRecords: FANPAGE_SPONSOR_DONATION_DIAGNOSTICS_MAX_RECORDS };
});

function validFanPageSponsorRequestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

async function writeFanPageSponsorAdminAudit(db, request, action, detail) {
  try {
    await logToAdminAuditLog(db, request, action, detail);
    return true;
  } catch (error) {
    console.error('고점체크 후원 광고 감사 로그 실패:', String(error && error.message || error).slice(0, 160));
    return false;
  }
}

// 고점체크의 후원 스트리머 신청·광고는 fanpage 서버 전용 노드에 보관한다.
// 관리센터가 관리자 인증 후 Admin SDK로만 읽고 쓰며, 공개 callable의 App Check나
// 브라우저 RTDB 권한을 우회해 데이터를 노출하지 않는다. 신청 승인 조건과 슬롯
// 예약·용량 규칙은 streamer-fanpage/functions/sponsor-ads.js와 맞춰 유지한다.
const manageFanPageSponsorAds = onCall(async (request) => {
  const adminUid = await requireAdmin(request);
  const db = getDatabase();
  const data = request.data || {};
  const action = String(data.action || 'list');

  if (action === 'list') {
    const pendingSnapshot = await db.ref(FANPAGE_SPONSOR_PENDING_PATH).get();
    const pendingMap = pendingSnapshot.val() || {};
    const requestIds = Object.keys(pendingMap).slice(-100);
    const requests = [];
    for (const requestId of requestIds) {
      const requestRef = db.ref(FANPAGE_SPONSOR_REQUESTS_PATH + '/' + requestId);
      const record = (await requestRef.get()).val();
      if (!record || record.status !== 'pending') continue;
      if (!Number(record.donationCompletedAt) && Number(record.expiresAt) <= Date.now()) {
        const expired = await requestRef.transaction((current) => {
          if (!current || current.status !== 'pending' || Number(current.donationCompletedAt) > 0 || Number(current.expiresAt) > Date.now()) return;
          return Object.assign({}, current, { status: 'expired', updatedAt: Date.now() });
        }, undefined, false);
        if (expired.committed) {
          await Promise.all([
            db.ref(FANPAGE_SPONSOR_PENDING_PATH + '/' + requestId).remove(),
            db.ref(FANPAGE_SPONSOR_CLAIMS_PATH + '/' + requestId).remove(),
          ]);
        }
        continue;
      }
      requests.push({
        requestId,
        nickname: String(record.nickname || '').slice(0, 40),
        soopId: normalizeSoopId(record.soopId),
        donorSoopId: normalizeSoopId(record.donorSoopId),
        rail: record.rail === 'right' ? 'right' : 'left',
        days: Math.max(1, Math.min(30, Number(record.days) || 1)),
        balloonCost: Math.max(0, Number(record.balloonCost) || 0),
        donationCompletedAt: Math.max(0, Number(record.donationCompletedAt) || 0),
        requestedAt: Math.max(0, Number(record.requestedAt) || 0),
        expiresAt: Math.max(0, Number(record.expiresAt) || 0),
      });
    }
    requests.sort((a, b) => a.requestedAt - b.requestedAt);

    const adsSnapshot = await db.ref(FANPAGE_SPONSOR_ADS_PATH).get();
    const ads = Object.entries(adsSnapshot.val() || {})
      .map(([campaignId, record]) => ({ campaignId, ...(record || {}) }))
      .filter((ad) => ad.status === 'active')
      .sort((a, b) => Number(b.expiresAt || 0) - Number(a.expiresAt || 0))
      .slice(0, 100)
      .map((ad) => ({
        campaignId: String(ad.campaignId || ad.requestId || ''),
        requestId: String(ad.requestId || ''),
        nickname: String(ad.nickname || '').slice(0, 40),
        soopId: normalizeSoopId(ad.soopId),
        rail: ad.rail === 'right' ? 'right' : 'left',
        startsAt: Math.max(0, Number(ad.startsAt) || 0),
        expiresAt: Math.max(0, Number(ad.expiresAt) || 0),
      }));
    return {
      ok: true,
      requests,
      ads,
      truncated: Object.keys(pendingMap).length > requestIds.length,
      checkedAt: Date.now(),
    };
  }

  if (action === 'approve' || action === 'reject') {
    const requestId = typeof data.requestId === 'string' ? data.requestId.trim() : '';
    if (!validFanPageSponsorRequestId(requestId)) throw new HttpsError('invalid-argument', '신청 번호가 올바르지 않습니다.');
    const requestRef = db.ref(FANPAGE_SPONSOR_REQUESTS_PATH + '/' + requestId);
    const claimRef = db.ref(FANPAGE_SPONSOR_CLAIMS_PATH + '/' + requestId);
    const now = Date.now();
    const initial = (await requestRef.get()).val();
    if (!initial || initial.status !== 'pending') throw new HttpsError('failed-precondition', '대기 중인 신청만 처리할 수 있습니다.');
    if (action === 'approve' && !Number(initial.donationCompletedAt)) {
      throw new HttpsError('failed-precondition', '신청자가 후원 완료를 표시한 신청만 승인할 수 있습니다.');
    }
    if (!Number(initial.donationCompletedAt) && Number(initial.expiresAt) <= now) {
      await requestRef.transaction((current) => {
        if (!current || current.status !== 'pending' || Number(current.donationCompletedAt) > 0 || Number(current.expiresAt) > Date.now()) return;
        return Object.assign({}, current, { status: 'expired', updatedAt: Date.now() });
      }, undefined, false);
      await Promise.all([
        db.ref(FANPAGE_SPONSOR_PENDING_PATH + '/' + requestId).remove(),
        claimRef.remove(),
      ]);
      throw new HttpsError('failed-precondition', '신청이 만료되어 처리할 수 없습니다.');
    }

    if (action === 'reject') {
      // A one-shot get() does not keep RTDB's local cache active for a transaction
      // in a fresh Functions instance. Hold a value listener until the transaction
      // finishes so its update callback receives the current server record.
      const heldRequest = await holdFreshRealtimeSnapshot(requestRef);
      try {
        const currentRequest = heldRequest.snapshot.val();
        if (currentRequest && currentRequest.status === 'rejected') {
          await Promise.all([
            db.ref(FANPAGE_SPONSOR_PENDING_PATH + '/' + requestId).remove(),
            claimRef.remove(),
          ]);
          return { ok: true, status: 'rejected', alreadyProcessed: true };
        }
        if (!currentRequest || currentRequest.status !== 'pending') {
          const status = String(currentRequest && currentRequest.status || 'missing');
          throw new HttpsError('failed-precondition', '현재 신청 상태가 ' + status + '입니다. 목록을 새로고침해 주세요.');
        }

        const rejected = await requestRef.transaction((current) => {
          if (!current || current.status !== 'pending') return;
          return Object.assign({}, current, { status: 'rejected', reviewedAt: now, reviewedBy: adminUid, updatedAt: now });
        }, undefined, false);
        const result = rejected.snapshot.val();
        if (!rejected.committed && !(result && result.status === 'rejected')) {
          console.error('고점체크 후원 신청 반려 트랜잭션 실패:', {
            requestId,
            currentStatus: String(result && result.status || 'missing'),
          });
          throw new HttpsError('aborted', '반려 상태를 저장하지 못했습니다. 신청 목록을 새로고침한 뒤 다시 시도해 주세요.');
        }
        await Promise.all([
          db.ref(FANPAGE_SPONSOR_PENDING_PATH + '/' + requestId).remove(),
          claimRef.remove(),
        ]);
        const auditLogged = await writeFanPageSponsorAdminAudit(db, request, '고점체크 후원 스트리머 신청 반려', currentRequest.nickname + ' (@' + normalizeSoopId(currentRequest.soopId) + ')');
        return { ok: true, status: 'rejected', auditLogged };
      } finally {
        heldRequest.release();
      }
    }

    const soopId = normalizeSoopId(initial.soopId);
    const rail = initial.rail === 'left' || initial.rail === 'right' ? initial.rail : '';
    const days = Number(initial.days);
    if (!/^[a-z0-9]{2,20}$/.test(soopId) || !rail || !Number.isInteger(days) || days < 1 || days > 30 || Number(initial.balloonCost) !== days * 10) {
      throw new HttpsError('failed-precondition', '신청의 SOOP 아이디·영역·기간·후원 개수가 올바르지 않습니다.');
    }
    const processingToken = require('node:crypto').randomBytes(16).toString('hex');
    const processing = await requestRef.transaction((current) => {
      if (!current || current.status !== 'pending' || !Number(current.donationCompletedAt)) return;
      return Object.assign({}, current, { status: 'processing', processingAt: now, processingBy: adminUid, processingToken });
    }, undefined, false);
    if (!processing.committed) throw new HttpsError('failed-precondition', '이미 처리 중이거나 완료된 신청입니다.');

    let claimPrepared = false;
    let claimActivated = false;
    let adCreated = false;
    const campaignId = requestId;
    const adRef = db.ref(FANPAGE_SPONSOR_ADS_PATH);
    const approvedUntil = now + days * 24 * 60 * 60 * 1000;
    try {
      const prepared = await claimRef.transaction((current) => {
        if (!current || current.status !== 'pending' || normalizeSoopId(current.soopId) !== soopId || current.rail !== rail || !Number(current.donationCompletedAt)) return;
        return Object.assign({}, current, { verificationProcessingAt: now, verificationProcessingToken: processingToken });
      }, undefined, false);
      if (!prepared.committed) throw new HttpsError('failed-precondition', '홍보 자리 예약이 신청과 일치하지 않습니다.');
      claimPrepared = true;

      const savedAd = {
        campaignId,
        soopId,
        rail,
        nickname: String(initial.nickname || '').trim().slice(0, 40),
        status: 'active',
        startsAt: now,
        expiresAt: approvedUntil,
        requestId,
      };
      const capacity = await adRef.transaction((current) => {
        const next = Object.assign({}, current && typeof current === 'object' ? current : {});
        for (const [id, ad] of Object.entries(next)) {
          if (!ad || ad.status !== 'active' || Number(ad.expiresAt) <= now) delete next[id];
        }
        if (Object.values(next).some((ad) => normalizeSoopId(ad && ad.soopId) === soopId) ||
            Object.keys(next).length >= FANPAGE_SPONSOR_MAX_ACTIVE_ADS ||
            Object.values(next).filter((ad) => ad && ad.rail === rail).length >= FANPAGE_SPONSOR_MAX_ADS_PER_RAIL) return;
        next[campaignId] = savedAd;
        return next;
      }, undefined, false);
      if (!capacity.committed) throw new HttpsError('resource-exhausted', '현재 고점체크 후원 광고 슬롯이 가득 찼거나 같은 스트리머가 이미 등록되어 있습니다.');
      adCreated = true;

      const activated = await claimRef.transaction((current) => {
        if (!current || current.status !== 'pending' || current.verificationProcessingToken !== processingToken || current.rail !== rail || normalizeSoopId(current.soopId) !== soopId) return;
        return Object.assign({}, current, { status: 'active', expiresAt: approvedUntil, campaignId, verificationProcessingAt: null, verificationProcessingToken: null });
      }, undefined, false);
      if (!activated.committed) throw new HttpsError('aborted', '홍보 자리 예약을 활성화하지 못했습니다.');
      claimActivated = true;

      const finalized = await requestRef.transaction((current) => {
        if (!current || current.status !== 'processing' || current.processingToken !== processingToken) return;
        return Object.assign({}, current, {
          status: 'approved', reviewedAt: now, reviewedBy: adminUid,
          verificationSource: 'admin-center-manual', campaignId, approvedUntil,
          processingAt: null, processingBy: null, processingToken: null, updatedAt: now,
        });
      }, undefined, false);
      if (!finalized.committed) throw new HttpsError('aborted', '승인 결과를 저장하지 못했습니다.');
      await db.ref(FANPAGE_SPONSOR_PENDING_PATH + '/' + requestId).remove().catch((error) => {
        console.error('고점체크 후원 대기 인덱스 정리 실패:', String(error && error.message || error).slice(0, 160));
      });
      const auditLogged = await writeFanPageSponsorAdminAudit(db, request, '고점체크 후원 스트리머 광고 승인', initial.nickname + ' (@' + soopId + ') · ' + days + '일');
      return { ok: true, status: 'approved', expiresAt: approvedUntil, auditLogged };
    } catch (error) {
      if (adCreated) {
        await adRef.child(campaignId).transaction((current) =>
          current && current.requestId === requestId && Number(current.startsAt) === now ? null : current,
        undefined, false).catch(() => null);
      }
      if (claimPrepared || claimActivated) {
        await claimRef.transaction((current) => {
          if (!current || (current.verificationProcessingToken !== processingToken && !(current.status === 'active' && current.campaignId === campaignId))) return;
          return Object.assign({}, current, {
            status: 'pending', expiresAt: Number(initial.expiresAt) || Date.now(), campaignId: null,
            verificationProcessingAt: null, verificationProcessingToken: null,
            donationCompletedAt: Number(current.donationCompletedAt) || Number(initial.donationCompletedAt) || 0,
          });
        }, undefined, false).catch(() => null);
      }
      await requestRef.transaction((current) => {
        if (!current || current.status !== 'processing' || current.processingToken !== processingToken) return;
        return Object.assign({}, current, { status: 'pending', processingAt: null, processingBy: null, processingToken: null, updatedAt: Date.now() });
      }, undefined, false).catch(() => null);
      throw error;
    }
  }

  if (action === 'update' || action === 'end') {
    const campaignId = typeof data.campaignId === 'string' ? data.campaignId.trim() : '';
    if (!validFanPageSponsorRequestId(campaignId)) throw new HttpsError('invalid-argument', '광고 번호가 올바르지 않습니다.');
    const adRef = db.ref(FANPAGE_SPONSOR_ADS_PATH + '/' + campaignId);
    const current = (await adRef.get()).val();
    if (!current || current.status !== 'active') throw new HttpsError('not-found', '노출 중인 광고를 찾을 수 없습니다. 새로고침 후 다시 시도해 주세요.');
    const now = Date.now();
    const soopId = normalizeSoopId(current.soopId);
    const requestId = String(current.requestId || campaignId);
    if (!validFanPageSponsorRequestId(requestId)) throw new HttpsError('failed-precondition', '광고의 연결된 신청 번호가 올바르지 않습니다.');
    const linkedRequestRef = db.ref(FANPAGE_SPONSOR_REQUESTS_PATH + '/' + requestId);
    if (!(await linkedRequestRef.get()).exists()) throw new HttpsError('failed-precondition', '광고 신청 이력을 찾을 수 없습니다.');

    if (action === 'end') {
      const ended = await adRef.transaction((value) => {
        if (!value || value.status !== 'active') return;
        return Object.assign({}, value, { status: 'ended', endedAt: now, updatedAt: now });
      }, undefined, false);
      if (!ended.committed) throw new HttpsError('failed-precondition', '광고가 이미 종료되었거나 처리 중입니다.');
      await Promise.all([
        db.ref(FANPAGE_SPONSOR_CLAIMS_PATH + '/' + requestId).transaction((claim) =>
          claim && claim.campaignId === campaignId ? null : claim,
        undefined, false),
        linkedRequestRef.update({ endedAt: now, approvedUntil: now, updatedAt: now }),
      ]);
      const auditLogged = await writeFanPageSponsorAdminAudit(db, request, '고점체크 후원 스트리머 광고 즉시 종료', current.nickname + ' (@' + soopId + ')');
      return { ok: true, endedAt: now, auditLogged };
    }

    const nickname = typeof data.nickname === 'string' ? data.nickname.trim() : '';
    const extendDays = Number(data.extendDays);
    if (!nickname || nickname.length > 40 || /[<>\x00-\x1F\x7F]/.test(nickname)) {
      throw new HttpsError('invalid-argument', '닉네임은 금지 문자를 제외하고 1~40자로 입력해 주세요.');
    }
    if (!Number.isInteger(extendDays) || extendDays < 0 || extendDays > 30) {
      throw new HttpsError('invalid-argument', '연장 일수는 0~30일로 입력해 주세요.');
    }
    if (Number(current.expiresAt) <= now) throw new HttpsError('failed-precondition', '이미 만료된 광고는 연장하거나 수정할 수 없습니다.');
    const startsAt = Math.max(0, Number(current.startsAt) || now);
    const currentExpiresAt = Math.max(now, Number(current.expiresAt) || now);
    const maximumExpiresAt = startsAt + FANPAGE_SPONSOR_MAX_CAMPAIGN_MS;
    const expiresAt = extendDays ? Math.min(currentExpiresAt + extendDays * 24 * 60 * 60 * 1000, maximumExpiresAt) : currentExpiresAt;
    if (extendDays && expiresAt <= currentExpiresAt) throw new HttpsError('failed-precondition', '이 캠페인은 이미 최대 30일 노출 기간을 사용했습니다.');
    const appliedExtendDays = extendDays ? Math.floor((expiresAt - currentExpiresAt) / (24 * 60 * 60 * 1000)) : 0;
    if (extendDays && !appliedExtendDays) throw new HttpsError('failed-precondition', '최대 노출 기간까지 하루 미만 남아 있어 일 단위 연장이 불가능합니다.');

    const claimRef = db.ref(FANPAGE_SPONSOR_CLAIMS_PATH + '/' + requestId);
    const claimUpdate = await claimRef.transaction((claim) => {
      if (!claim || claim.status !== 'active' || claim.campaignId !== campaignId || normalizeSoopId(claim.soopId) !== soopId) return;
      return Object.assign({}, claim, { expiresAt, updatedAt: now });
    }, undefined, false);
    if (!claimUpdate.committed) throw new HttpsError('failed-precondition', '활성 홍보 자리 예약이 없어 광고를 수정할 수 없습니다.');

    const updated = await adRef.transaction((value) => {
      if (!value || value.status !== 'active' || String(value.requestId || campaignId) !== requestId || Number(value.expiresAt) !== Number(current.expiresAt)) return;
      return Object.assign({}, value, { nickname, expiresAt, updatedAt: now });
    }, undefined, false);
    if (!updated.committed) {
      await claimRef.transaction((claim) => claim && claim.campaignId === campaignId && Number(claim.expiresAt) === expiresAt
        ? Object.assign({}, claim, { expiresAt: Number(current.expiresAt), updatedAt: now }) : claim,
      undefined, false).catch(() => null);
      throw new HttpsError('aborted', '광고가 동시에 변경되어 저장하지 못했습니다. 새로고침 후 다시 시도해 주세요.');
    }
    await linkedRequestRef.update({ approvedUntil: expiresAt, updatedAt: now });
    const auditLogged = await writeFanPageSponsorAdminAudit(db, request, '고점체크 후원 스트리머 광고 수정', current.nickname + ' → ' + nickname + ' (@' + soopId + ')' + (appliedExtendDays ? ' · ' + appliedExtendDays + '일 연장' : ''));
    return { ok: true, expiresAt, extendedDays: appliedExtendDays, auditLogged };
  }

  throw new HttpsError('invalid-argument', '고점체크 후원 광고 관리 동작을 확인해 주세요.');
});

const confirmGameDonationFromNotification = onCall(async (request) => {
  const reviewer = await resolveOnyuGiftReviewActor(request);
  const adminUid = reviewer.adminUid;
  request = reviewer.request;
  const senderSoopId = normalizeSoopId(request.data && request.data.senderSoopId);
  const balloons = Number(request.data && request.data.balloons);
  const observedAt = Number(request.data && request.data.observedAt);
  const eventAtMin = Number(request.data && request.data.eventAtMin);
  const eventAtMax = Number(request.data && request.data.eventAtMax);
  const candidateFingerprint = String(request.data && request.data.candidateFingerprint || '').toLowerCase();
  const exactTimestamp = request.data && request.data.exactTimestamp === true;
  const now = Date.now();
  if (!senderSoopId || !Number.isInteger(balloons) ||
      !(balloons === FANPAGE_VIEWER_SUBSCRIPTION_BALLOONS || (balloons >= 10 && balloons <= 300 && balloons % 10 === 0)) ||
      !Number.isFinite(observedAt) || observedAt < now - 2 * 60 * 1000 || observedAt > now + 30000 ||
      !Number.isFinite(eventAtMin) || !Number.isFinite(eventAtMax) || eventAtMin > eventAtMax ||
      eventAtMin < observedAt - 24 * 60 * 60 * 1000 || eventAtMax > observedAt + 30000 ||
      !/^[a-f0-9]{32,64}$/.test(candidateFingerprint)) {
    throw new HttpsError('invalid-argument', '후원 알림 정보가 올바르지 않습니다.');
  }

  const db = getDatabase();
  const crypto = require('node:crypto');
  const eventKey = crypto.createHash('sha256')
    .update(senderSoopId + '|' + balloons + '|' + candidateFingerprint).digest('hex').slice(0, 40);
  const eventRef = db.ref('adminCenter/donationVerificationEventClaims/' + eventKey);
  const claimToken = crypto.randomBytes(16).toString('hex');
  const eventClaim = await eventRef.transaction((current) => {
    if (current && (current.status !== 'processing' || now - Number(current.startedAt || now) < 2 * 60 * 1000)) return;
    return { status: 'processing', startedAt: now, claimToken, senderSoopId, balloons };
  }, undefined, false);
  if (!eventClaim.committed) return { ok: false, reason: 'notification-already-processed', eventKey };

  let lifeGameDiagnosticCodes = [];
  const eventDetails = {
    senderSoopId,
    balloons,
    observedAt,
    eventAtMin,
    eventAtMax,
    exactTimestamp,
    gameCandidates: [],
  };
  try {
    const [onyuSnap, lifeGameSnap, fanPagePendingSnap, fanPageSponsorSnap, ...otherGameSnaps] = await Promise.all([
      db.ref('onyuVn/streamerGameGiftRequests').get(),
      db.ref('lifeGame/sponsorRequests').get(),
      db.ref('streamerFanPageViewerSubscriptionPending').get(),
      db.ref(FANPAGE_SPONSOR_REQUESTS_PATH).get(),
      ...OTHER_GAME_DONATION_REQUEST_SOURCES.map((source) => db.ref(source.path).orderByChild('status').equalTo('pending').get()),
    ]);
    const onyuRequests = onyuSnap.val() || {};
    const lifeGameRequests = lifeGameSnap.val() || {};
    const fanPagePendingRequests = fanPagePendingSnap.val() || {};
    const fanPageSponsorRequests = fanPageSponsorSnap.val() || {};
    const otherGameRequestMaps = {};
    OTHER_GAME_DONATION_REQUEST_SOURCES.forEach((source, index) => {
      otherGameRequestMaps[source.path] = otherGameSnaps[index].val() || {};
    });
    const onyuCandidates = Object.entries(onyuRequests).filter(([, item]) =>
      notificationFallsInDonationRequestWindow(item, senderSoopId, balloons, observedAt, eventAtMin, eventAtMax, exactTimestamp));
    const lifeGameDiagnosticCandidates = Object.entries(lifeGameRequests).filter(([, item]) => item && item.status === 'pending' &&
      Number(item.starBalloons) === balloons && Number(item.days) * 10 === balloons &&
      /^LG-[A-F0-9]{8}$/.test(String(item.diagnosticCode || '')) &&
      notificationFallsInDonationRequestWindow(Object.assign({}, item, { donorSoopId: senderSoopId }), senderSoopId,
        balloons, observedAt, eventAtMin, eventAtMax, exactTimestamp, true));
    const lifeGameByDonorAndAmount = Object.entries(lifeGameRequests).filter(([, item]) => item && item.status === 'pending' &&
      normalizeSoopId(item.donorSoopId) === senderSoopId && Number(item.starBalloons) === balloons &&
      Number(item.days) * 10 === balloons && /^LG-[A-F0-9]{8}$/.test(String(item.diagnosticCode || '')));
    const lifeGameCandidates = lifeGameByDonorAndAmount.filter(([, item]) =>
      notificationFallsInDonationRequestWindow(item, senderSoopId, balloons, observedAt, eventAtMin, eventAtMax, exactTimestamp, true));
    const fanPageRequestIds = Object.entries(fanPagePendingRequests).filter(([, index]) => index &&
      fanPageViewerSubscriptionDonationCanMatch(
        Object.assign({}, index, { status: index.status || 'pending' }), senderSoopId, balloons,
        observedAt, eventAtMin, eventAtMax, exactTimestamp,
        [LEGACY_FANPAGE_VIEWER_SUBSCRIPTION_BALLOONS, FANPAGE_VIEWER_SUBSCRIPTION_BALLOONS],
      ))
      .map(([requestId]) => requestId);
    const fanPageRequests = await Promise.all(fanPageRequestIds.map(async (requestId) => {
      const snapshot = await db.ref('streamerFanPageViewerSubscriptionRequests/' + requestId).get();
      return [requestId, snapshot.val()];
    }));
    const fanPageCandidates = fanPageRequests.filter(([, item]) =>
      fanPageViewerSubscriptionDonationCanMatch(
        item, senderSoopId, balloons, observedAt, eventAtMin, eventAtMax, exactTimestamp,
        [LEGACY_FANPAGE_VIEWER_SUBSCRIPTION_BALLOONS, FANPAGE_VIEWER_SUBSCRIPTION_BALLOONS],
      ));
    const matchedFanPageRequestIds = new Set(fanPageCandidates.map(([requestId]) => requestId));
    const fanPageOtherDonationCandidates = fanPageRequests.filter(([requestId, item]) => item && item.status === 'pending' &&
      !matchedFanPageRequestIds.has(requestId) && normalizeSoopId(item.donorSoopId) === senderSoopId &&
      Number(item.balloonCost) === balloons)
      .map(([requestId, item]) => ({
        gameKey: 'streamer-fanpage',
        requestType: 'viewer-subscription',
        requestId,
        requestedAt: Number(item.requestedAt) || 0,
        expectedBalloons: Number(item.balloonCost) || 0,
        donorMatch: true,
      }));
    const fanPageSponsorCandidates = Object.entries(fanPageSponsorRequests).filter(([, item]) =>
      fanPageSponsorAdDonationCanMatch(item, senderSoopId, balloons, observedAt, eventAtMin, eventAtMax, exactTimestamp));
    const matchedFanPageSponsorRequestIds = new Set(fanPageSponsorCandidates.map(([requestId]) => requestId));
    const fanPageSponsorOtherDonationCandidates = Object.entries(fanPageSponsorRequests).filter(([requestId, item]) => {
      if (!item || item.status !== 'pending' || matchedFanPageSponsorRequestIds.has(requestId) ||
          normalizeSoopId(item.donorSoopId) !== senderSoopId || Number(item.balloonCost) !== balloons ||
          Number(item.days) * 10 !== balloons) return false;
      const requestedAt = Number(item.requestedAt) || 0;
      if (!requestedAt || observedAt - requestedAt > FANPAGE_SPONSOR_REQUEST_TTL_MS || requestedAt > eventAtMax) return false;
      if (Number(item.donationCompletedAt) > 0) return false;
      return eventAtMax >= requestedAt && eventAtMin <= (Number(item.expiresAt) || requestedAt + FANPAGE_SPONSOR_REQUEST_TTL_MS);
    }).map(([requestId, item]) => ({
      gameKey: 'streamer-fanpage-sponsor',
      requestType: 'sponsored-ad',
      requestId,
      requestedAt: Number(item.requestedAt) || 0,
      expectedBalloons: Number(item.balloonCost) || 0,
      donorMatch: true,
    }));
    lifeGameDiagnosticCodes = Array.from(new Set([
      ...lifeGameByDonorAndAmount.map(([, item]) => String(item.diagnosticCode || '')),
      ...lifeGameDiagnosticCandidates.map(([, item]) => String(item.diagnosticCode || '')),
    ]));
    const candidates = [
      ...onyuCandidates.map(([requestId, item]) => ({ game: 'onyu-vn', requestId, item })),
      ...lifeGameCandidates.map(([requestId, item]) => ({ game: 'streamer-life-game', requestId, item })),
      ...fanPageCandidates.map(([requestId, item]) => ({ game: 'streamer-fanpage', requestId, item })),
      ...fanPageSponsorCandidates.map(([requestId, item]) => ({ game: 'streamer-fanpage-sponsor', requestId, item })),
    ];
    const otherDonationCandidates = [
      ...findOtherGameDonationRequestCandidates(otherGameRequestMaps, senderSoopId, balloons, observedAt, eventAtMin, eventAtMax),
      ...fanPageOtherDonationCandidates,
      ...fanPageSponsorOtherDonationCandidates,
    ];
    eventDetails.otherDonationCandidateCount = otherDonationCandidates.length;
    eventDetails.otherDonationCandidates = otherDonationCandidates.slice(0, 20);
    eventDetails.otherDonationCandidatesOmitted = Math.max(0, otherDonationCandidates.length - 20);
    const fanPageSponsorDiagnosticCandidates = Object.entries(fanPageSponsorRequests)
      .map(([requestId, item]) => describeFanPageSponsorDonationCandidate(
        requestId, item, senderSoopId, balloons, observedAt, eventAtMin, eventAtMax, exactTimestamp,
      ))
      .filter(Boolean)
      .sort((a, b) => (Number(b.requestedAt) || 0) - (Number(a.requestedAt) || 0));
    eventDetails.sponsorAdCandidateCount = fanPageSponsorDiagnosticCandidates.length;
    eventDetails.sponsorAdCandidates = fanPageSponsorDiagnosticCandidates.slice(0, 20);
    eventDetails.sponsorAdCandidatesOmitted = Math.max(0, fanPageSponsorDiagnosticCandidates.length - 20);
    eventDetails.gameCandidateCount = candidates.length;
    eventDetails.gameCandidates = candidates.slice(0, 20).map((candidate) => ({
      game: candidate.game,
      requestId: candidate.requestId,
      diagnosticCode: candidate.game === 'streamer-life-game' ? String(candidate.item.diagnosticCode || '') : '',
    }));
    eventDetails.gameCandidatesOmitted = Math.max(0, candidates.length - 20);
    eventDetails.lifeGameDiagnosticCandidateCount = lifeGameDiagnosticCandidates.length;
    eventDetails.lifeGameDiagnosticCandidates = lifeGameDiagnosticCandidates.slice(0, 20).map(([requestId, item]) => ({
      requestId,
      diagnosticCode: String(item.diagnosticCode || ''),
      senderMatched: normalizeSoopId(item.donorSoopId) === senderSoopId,
    }));
    eventDetails.lifeGameDiagnosticCandidatesOmitted = Math.max(0, lifeGameDiagnosticCandidates.length - 20);

    if (candidates.length !== 1 || otherDonationCandidates.length > 0) {
      const reason = candidates.length > 1 || (candidates.length === 1 && otherDonationCandidates.length > 0)
        ? 'ambiguous-across-game-requests'
        : 'no-matching-pending-request';
      await writeLifeGameSponsorDonationDiagnostic(db, lifeGameDiagnosticCodes, eventKey, Object.assign({}, eventDetails, {
        outcome: reason === 'ambiguous-across-game-requests' ? 'ambiguous' : 'not-matched', reason,
      })).catch((error) => console.warn('인생게임 후원 자동검증 진단 저장 실패:', error && (error.code || error.message) || error));
      if (eventDetails.sponsorAdCandidateCount > 0 || candidates.some((candidate) => candidate.game === 'streamer-fanpage-sponsor')) {
        await writeFanPageSponsorDonationDiagnostic(db, eventKey, Object.assign({}, eventDetails, {
          outcome: reason === 'ambiguous-across-game-requests' ? 'ambiguous' : 'not-matched', reason,
        })).catch((error) => console.warn('고점체크 후원 자동검증 진단 저장 실패:', error && (error.code || error.message) || error));
      }
      if (reason === 'ambiguous-across-game-requests') {
        await eventRef.update({ status: 'ambiguous', completedAt: Date.now(), claimToken: null, reason });
      } else {
        await eventRef.transaction((current) => current && current.claimToken === claimToken ? null : undefined, undefined, false);
      }
      return { ok: false, reason, eventKey, gameCandidates: eventDetails.gameCandidates, otherDonationCandidates };
    }

    const candidate = candidates[0];
    const verifiedAt = Date.now();
    const verificationEventMetadata = {
      verificationSource: 'soop-donation-notification',
      verificationGame: candidate.game,
      verificationSenderSoopId: senderSoopId,
      verificationEventKey: eventKey,
      verifiedAt,
    };
    let result;
    if (candidate.game === 'onyu-vn') {
      result = await processOnyuStreamerGameGiftReview(request, adminUid, candidate.requestId, 'approve', verificationEventMetadata);
      result = Object.assign({}, result, {
        gameKey: candidate.game,
        targetNickname: String(candidate.item.targetNickname || ''),
      });
    } else {
      if (candidate.game === 'streamer-life-game') {
        result = await commitLifeGameSponsorApproval(db, request, adminUid, candidate.requestId,
          Number(candidate.item.days), String(candidate.item.nickname || ''), verificationEventMetadata);
        result = Object.assign({}, result, {
          gameKey: candidate.game,
          targetNickname: String(candidate.item.nickname || ''),
          diagnosticCode: String(candidate.item.diagnosticCode || ''),
        });
      } else if (candidate.game === 'streamer-fanpage-sponsor') {
        result = await commitFanPageSponsorAdApproval(db, adminUid, candidate.requestId, senderSoopId,
          balloons, observedAt, eventAtMin, eventAtMax, exactTimestamp, verificationEventMetadata);
        result = Object.assign({}, result, {
          gameKey: candidate.game,
          targetNickname: String(candidate.item.nickname || ''),
        });
      } else {
        result = await commitFanPageViewerSubscriptionApproval(db, adminUid, candidate.requestId, senderSoopId,
          balloons, observedAt, eventAtMin, eventAtMax, exactTimestamp, verificationEventMetadata);
        result = Object.assign({}, result, {
          gameKey: candidate.game,
          targetNickname: String(candidate.item.nickname || ''),
        });
      }
    }
    await eventRef.update({ status: 'approved', requestId: candidate.requestId, gameKey: candidate.game, claimToken: null, approvedAt: Date.now() });
    await writeLifeGameSponsorDonationDiagnostic(db, lifeGameDiagnosticCodes, eventKey, Object.assign({}, eventDetails, {
      outcome: 'approved', reason: '', matchedGame: candidate.game, matchedRequestId: candidate.requestId,
    })).catch((error) => console.warn('인생게임 후원 자동검증 진단 저장 실패:', error && (error.code || error.message) || error));
    if (candidate.game === 'streamer-fanpage-sponsor' || eventDetails.sponsorAdCandidateCount > 0) {
      await writeFanPageSponsorDonationDiagnostic(db, eventKey, Object.assign({}, eventDetails, {
        outcome: 'approved', reason: '', matchedGame: candidate.game, matchedRequestId: candidate.requestId,
      })).catch((error) => console.warn('고점체크 후원 자동검증 진단 저장 실패:', error && (error.code || error.message) || error));
    }
    return Object.assign({}, result, { ok: true, eventKey, verificationSource: 'soop-donation-notification' });
  } catch (error) {
    await eventRef.transaction((current) => current && current.claimToken === claimToken ? null : undefined, undefined, false).catch(() => null);
    await writeLifeGameSponsorDonationDiagnostic(db, lifeGameDiagnosticCodes, eventKey, Object.assign({}, eventDetails, {
      outcome: 'error', reason: String(error && (error.code || error.message) || 'server-error').slice(0, 120),
    })).catch(() => null);
    if (Number(eventDetails.sponsorAdCandidateCount) > 0) {
      await writeFanPageSponsorDonationDiagnostic(db, eventKey, Object.assign({}, eventDetails, {
        outcome: 'error', reason: String(error && (error.code || error.message) || 'server-error').slice(0, 120),
      })).catch(() => null);
    }
    if (error instanceof HttpsError && ['failed-precondition', 'already-exists'].includes(error.code)) {
      return { ok: false, reason: 'request-no-longer-pending', eventKey };
    }
    throw error;
  }
});

// 게임 시작 직전에 호출하는 최종 서버 판정. 관리자는 설정에서 선택한 모드로
// 판정하고, 일반 로그인 유저와 인증 스트리머는 역할에 맞는 활성 이용권을 확인한다.
const onyuStartSession = onCall(async (request) => {
  const uid = requireAuth(request);
  const isAdmin = await isOnyuAdminUid(uid);
  const requestedMode = request.data && request.data.accessMode;
  const streamerFlagSnap = await getDatabase().ref('users/' + uid + '/streamerVerified').get();
  const isVerifiedStreamer = streamerFlagSnap.val() === true || await isVerifiedStreamerUid(uid);
  const accessMode = isAdmin
    ? (['admin', 'streamer', 'viewer'].includes(requestedMode) ? requestedMode : 'admin')
    : isVerifiedStreamer ? 'streamer' : 'viewer';
  const modeRequest = Object.assign({}, request, {
    data: Object.assign({}, request.data || {}, { accessMode }),
  });
  const state = await getOnyuAccessState(uid, modeRequest);
  if (!state.canStartGame) {
    throw new HttpsError('permission-denied', '로그인하거나 스트리머 인증을 완료하면 온이유 게임을 무료로 이용할 수 있습니다.');
  }
  await recordOnyuServerEvent(request, 'game_access_granted');
  return Object.assign({ ok: true, uid }, state);
});

// 연인 엔딩 플레이 후기는 인증된 사용자의 계정·엔딩별 최신 1건으로 저장한다.
// 클라이언트가 uid나 저장 경로를 지정하지 못하며, onyuVn 노드는 RTDB 규칙에서
// 클라이언트 읽기/쓰기가 차단되어 있다. 계정 식별자는 서버에만 두고, 홍보를
// 선택한 경우에만 사용자가 직접 입력하거나 서버가 검증한 공개 방송국 정보를 노출한다.
const onyuSubmitReview = onCall(async (request) => {
  const uid = requireAuth(request);
  const provider = request.auth.token && request.auth.token.firebase && request.auth.token.firebase.sign_in_provider;
  const db = getDatabase();
  const userSnap = await db.ref('users/' + uid + '/streamerVerified').get();
  const verified = userSnap.val() === true || await isVerifiedStreamerUid(uid);
  if (provider === 'anonymous' && !verified) {
    throw new HttpsError('failed-precondition', '로그인했거나 스트리머 인증을 완료한 계정으로만 후기를 저장할 수 있습니다.');
  }
  const endingId = String(request.data && request.data.endingId || '').trim();
  if (endingId !== 'lover') {
    throw new HttpsError('invalid-argument', '지원하지 않는 엔딩 후기입니다.');
  }
  const review = String(request.data && request.data.review || '').replace(/\0/g, '').trim();
  if (!review) throw new HttpsError('invalid-argument', '후기 내용을 입력해 주세요.');
  if (review.length > 1000) throw new HttpsError('invalid-argument', '후기는 1,000자 이내로 작성해 주세요.');

  const rating = Number(request.data && request.data.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new HttpsError('invalid-argument', '별점은 1~5점 중에서 선택해 주세요.');
  }
  let nickname = '';
  let soopId = '';
  let promoteRequested = false;
  if (verified) {
    const profileSnap = await db.ref('streamerVerifications').orderByChild('uid').equalTo(uid).limitToFirst(1).get();
    profileSnap.forEach((child) => {
      const profile = child.val() || {};
      nickname = String(profile.nickname || '').trim().slice(0, 20);
      soopId = normalizeSoopId(profile.soopId);
      return true;
    });
  } else if (request.data && request.data.promoteBroadcast) {
    nickname = String(request.data.nickname || '').trim();
    soopId = normalizeSoopId(request.data.soopId);
    if (!nickname || nickname.length > 20 || /[<>\x00-\x1F\x7F]/.test(nickname)) {
      throw new HttpsError('invalid-argument', '스트리머 닉네임을 올바르게 입력해 주세요.');
    }
    if (!soopId) throw new HttpsError('invalid-argument', 'SOOP 아이디는 영문 소문자·숫자 2~20자로 입력해 주세요.');
    promoteRequested = !(await isOnyuAdminUid(uid));
  }

  const now = Date.now();
  const reviewRef = db.ref('onyuVn/reviews/' + uid + '/' + endingId);
  const previous = (await reviewRef.get()).val() || {};
  const reviewId = previous.publicId || db.ref('onyuVn/publicReviews').push().key;
  const result = await reviewRef.transaction((current) => ({
    endingId,
    review,
    rating,
    nickname,
    soopId,
    createdAt: current && Number.isFinite(current.createdAt) ? current.createdAt : now,
    updatedAt: now,
    publicId: current && current.publicId || reviewId,
    visibility: current && current.visibility === 'hidden' ? 'hidden' : 'public',
  }));
  if (!result.committed) throw new HttpsError('aborted', '후기를 저장하지 못했습니다. 다시 시도해 주세요.');
  const saved = result.snapshot.val();
  const indexItem = {
    endingId,
    review: saved.review,
    rating: saved.rating,
    nickname: saved.nickname || '',
    soopId: saved.soopId || '',
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
    visibility: saved.visibility,
    uid,
  };
  const updates = {};
  updates['onyuVn/reviewIndex/' + saved.publicId] = indexItem;
  updates['onyuVn/reviewOwners/' + saved.publicId] = uid;
  updates['onyuVn/publicReviews/' + saved.publicId] = saved.visibility === 'public'
    ? { endingId, review: saved.review, rating: saved.rating, nickname: saved.nickname || '', soopId: saved.soopId || '', createdAt: saved.createdAt, updatedAt: saved.updatedAt }
    : null;
  await db.ref().update(updates);
  return { ok: true, updatedAt: now, promoteRequested, verifiedStreamer: verified, nickname, soopId };
});

// 연인 엔딩 후기를 저장한 인증 스트리머가 본인 IP의 미연시 제작을 문의한다.
// 신원·프로필은 클라이언트 입력을 받지 않고 인증 UID와 검증된 스트리머 기록에서 가져온다.
const onyuSubmitStreamerProductionInquiry = onCall(async (request) => {
  const uid = requireAuth(request);
  const db = getDatabase();
  const userSnap = await db.ref('users/' + uid).get();
  const profileSnap = await db.ref('streamerVerifications').orderByChild('uid').equalTo(uid).limitToFirst(1).get();
  const user = userSnap.val() || {};
  const verified = user.streamerVerified === true || profileSnap.exists();
  if (!verified) throw new HttpsError('permission-denied', '인증 스트리머만 미연시 제작 문의를 보낼 수 있습니다.');

  const description = String(request.data && request.data.description || '').replace(/\0/g, '').trim();
  if (!description) throw new HttpsError('invalid-argument', '원하는 이야기와 제작 방향을 입력해 주세요.');
  if (description.length > 3000) throw new HttpsError('invalid-argument', '문의 내용은 3,000자 이내로 작성해 주세요.');

  let nickname = '';
  let soopId = '';
  profileSnap.forEach((child) => {
    const profile = child.val() || {};
    nickname = String(profile.nickname || '').trim().slice(0, 80);
    soopId = normalizeSoopId(profile.soopId);
    return true;
  });
  if (!nickname) nickname = String(user.nickname || user.displayName || '').trim().slice(0, 80);
  if (!soopId) soopId = normalizeSoopId(user.soopId);

  const requestRef = db.ref('onyuVn/productionInquiries').push();
  const requestedAt = Date.now();
  await requestRef.set({
    uid,
    nickname,
    soopId,
    description,
    status: 'new',
    requestedAt,
  });
  return { ok: true, requestId: requestRef.key, requestedAt };
});

const onyuAdminListProductionInquiries = onCall(async (request) => {
  await requireAdmin(request);
  // Keep this low-volume admin queue unindexed, avoiding an RTDB rules change
  // that would need to be synchronized across all sibling apps.
  const snap = await getDatabase().ref('onyuVn/productionInquiries').get();
  const inquiries = [];
  snap.forEach((child) => {
    const item = child.val() || {};
    if (typeof item.description !== 'string') return;
    inquiries.push({
      id: child.key,
      nickname: String(item.nickname || '').slice(0, 80),
      soopId: normalizeSoopId(item.soopId),
      description: item.description.slice(0, 3000),
      status: item.status === 'new' ? 'new' : String(item.status || 'new').slice(0, 30),
      requestedAt: Number(item.requestedAt) || 0,
    });
  });
  inquiries.sort((a, b) => b.requestedAt - a.requestedAt);
  return { inquiries: inquiries.slice(0, 100) };
});

const ONYU_REVIEW_PAGE_SIZE = 30;
const ONYU_REVIEW_ID_RE = /^[A-Za-z0-9_-]{20}$/;

function publicOnyuReview(item) {
  return {
    endingId: item.endingId,
    review: item.review,
    rating: Number.isInteger(Number(item.rating)) && Number(item.rating) >= 1 && Number(item.rating) <= 5 ? Number(item.rating) : null,
    nickname: String(item.nickname || '').slice(0, 20),
    soopId: normalizeSoopId(item.soopId),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

async function listOnyuReviewPage(db, node, cursor) {
  let query = db.ref(node).orderByChild('updatedAt');
  if (cursor && Number.isFinite(cursor.updatedAt) && typeof cursor.id === 'string' && ONYU_REVIEW_ID_RE.test(cursor.id)) {
    query = query.endAt(cursor.updatedAt, cursor.id);
  }
  const snap = await query.limitToLast(ONYU_REVIEW_PAGE_SIZE + 1).get();
  const entries = [];
  snap.forEach((child) => {
    const value = child.val();
    if (!value || typeof value.review !== 'string') return;
    const updatedAt = Number(value.updatedAt) || Number(value.createdAt) || 0;
    if (cursor && (updatedAt > cursor.updatedAt || (updatedAt === cursor.updatedAt && child.key >= cursor.id))) return;
    entries.push({ id: child.key, updatedAt, value });
  });
  const hasMore = entries.length > ONYU_REVIEW_PAGE_SIZE || snap.numChildren() >= ONYU_REVIEW_PAGE_SIZE + 1;
  const page = entries.slice(-ONYU_REVIEW_PAGE_SIZE);
  return {
    reviews: page.map((entry) => Object.assign({ id: entry.id, visibility: entry.value.visibility }, publicOnyuReview(entry.value))),
    hasMore,
    nextCursor: hasMore && page.length
      ? { id: page[0].id, updatedAt: page[0].updatedAt }
      : null,
  };
}

// 공개 열람 API는 익명 Firebase Auth 계정도 사용할 수 있지만, 서버가 허용 필드만
// 반환한다. uid와 내부 moderation 필드는 RTDB 규칙을 열지 않고 응답에서 제거한다.
const onyuVnListPublicReviews = onCall(async (request) => {
  requireAuth(request);
  const cursor = request.data && request.data.cursor;
  const page = await listOnyuReviewPage(getDatabase(), 'onyuVn/publicReviews', cursor);
  page.reviews = page.reviews.map((item) => ({
    id: item.id,
    endingId: item.endingId,
    review: item.review,
    rating: item.rating,
    nickname: item.nickname,
    soopId: item.soopId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));
  return page;
});

async function ensureOnyuReviewIndex(db, adminUid) {
  const markerRef = db.ref('onyuVn/reviewIndexMigrationV1');
  const token = db.ref('onyuVn/reviewIndexMigrationV1').push().key;
  const lock = await markerRef.transaction((current) => {
    if (current && current.status === 'complete') return;
    if (current && current.status === 'running' && Date.now() - Number(current.startedAt || 0) < 600000) return;
    return { status: 'running', startedAt: Date.now(), token };
  });
  const marker = lock.snapshot.val();
  if (marker && marker.status === 'complete') return;
  if (!lock.committed || !marker || marker.token !== token) {
    throw new HttpsError('unavailable', '기존 후기 목록을 준비 중입니다. 잠시 후 새로고침해 주세요.');
  }

  try {
    const reviewsSnap = await db.ref('onyuVn/reviews').get();
    const updates = {};
    reviewsSnap.forEach((userSnap) => {
      userSnap.forEach((reviewSnap) => {
        if (reviewSnap.key !== 'lover') return;
        const item = reviewSnap.val();
        if (!item || typeof item.review !== 'string' || !item.review.trim()) return;
        const id = item.publicId || db.ref('onyuVn/publicReviews').push().key;
        const visibility = item.visibility === 'hidden' ? 'hidden' : 'public';
        const createdAt = Number(item.createdAt) || Date.now();
        const updatedAt = Number(item.updatedAt) || createdAt;
        const rating = Number.isInteger(Number(item.rating)) && Number(item.rating) >= 1 && Number(item.rating) <= 5 ? Number(item.rating) : null;
        const nickname = String(item.nickname || '').slice(0, 20);
        const soopId = normalizeSoopId(item.soopId);
        const entry = { endingId: reviewSnap.key, review: item.review, rating, nickname, soopId, createdAt, updatedAt, visibility, uid: userSnap.key };
        updates['onyuVn/reviewIndex/' + id] = entry;
        updates['onyuVn/reviewOwners/' + id] = userSnap.key;
        updates['onyuVn/reviews/' + userSnap.key + '/' + reviewSnap.key + '/publicId'] = id;
        if (!item.visibility) updates['onyuVn/reviews/' + userSnap.key + '/' + reviewSnap.key + '/visibility'] = visibility;
        updates['onyuVn/publicReviews/' + id] = visibility === 'public'
          ? { endingId: reviewSnap.key, review: item.review, rating, nickname, soopId, createdAt, updatedAt }
          : null;
      });
    });
    if (Object.keys(updates).length) await db.ref().update(updates);
    await markerRef.set({ status: 'complete', completedAt: Date.now(), completedBy: adminUid });
  } catch (error) {
    await markerRef.set({ status: 'failed', failedAt: Date.now() });
    throw error;
  }
}

const onyuAdminListPlayerReviews = onCall(async (request) => {
  const adminUid = await requireAdmin(request);
  const db = getDatabase();
  await ensureOnyuReviewIndex(db, adminUid);
  const page = await listOnyuReviewPage(db, 'onyuVn/reviewIndex', request.data && request.data.cursor);
  page.reviews = page.reviews.map((item) => ({
    id: item.id,
    endingId: item.endingId,
    review: item.review,
    rating: item.rating,
    nickname: item.nickname,
    soopId: item.soopId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    visibility: item.visibility === 'hidden' ? 'hidden' : 'public',
  }));
  return page;
});

const onyuAdminSetPlayerReviewVisibility = onCall(async (request) => {
  await requireAdmin(request);
  const id = String(request.data && request.data.reviewId || '');
  const visible = request.data && request.data.visible;
  if (!ONYU_REVIEW_ID_RE.test(id) || typeof visible !== 'boolean') {
    throw new HttpsError('invalid-argument', '후기 ID 또는 공개 상태가 올바르지 않습니다.');
  }
  const db = getDatabase();
  const ownerSnap = await db.ref('onyuVn/reviewOwners/' + id).get();
  const uid = ownerSnap.val();
  if (typeof uid !== 'string') throw new HttpsError('not-found', '후기를 찾을 수 없습니다.');
  const indexSnap = await db.ref('onyuVn/reviewIndex/' + id).get();
  const endingId = indexSnap.child('endingId').val();
  if (endingId !== 'lover') throw new HttpsError('not-found', '후기를 찾을 수 없습니다.');
  const reviewRef = db.ref('onyuVn/reviews/' + uid + '/' + endingId);
  const reviewSnap = await reviewRef.get();
  const item = reviewSnap.val();
  if (!item || item.publicId !== id) throw new HttpsError('not-found', '후기를 찾을 수 없습니다.');
  const visibility = visible ? 'public' : 'hidden';
  const updates = {};
  updates['onyuVn/reviews/' + uid + '/lover/visibility'] = visibility;
  updates['onyuVn/reviewIndex/' + id + '/visibility'] = visibility;
  updates['onyuVn/publicReviews/' + id] = visible
    ? publicOnyuReview(item)
    : null;
  await db.ref().update(updates);
  return { ok: true, visibility };
});

const onyuAdminDeletePlayerReview = onCall(async (request) => {
  await requireAdmin(request);
  const id = String(request.data && request.data.reviewId || '');
  if (!ONYU_REVIEW_ID_RE.test(id)) throw new HttpsError('invalid-argument', '후기 ID가 올바르지 않습니다.');
  const db = getDatabase();
  const ownerSnap = await db.ref('onyuVn/reviewOwners/' + id).get();
  const uid = ownerSnap.val();
  if (typeof uid !== 'string') throw new HttpsError('not-found', '후기를 찾을 수 없습니다.');
  const indexSnap = await db.ref('onyuVn/reviewIndex/' + id).get();
  const endingId = indexSnap.child('endingId').val();
  if (endingId !== 'lover') throw new HttpsError('not-found', '후기를 찾을 수 없습니다.');
  const reviewRef = db.ref('onyuVn/reviews/' + uid + '/' + endingId);
  const reviewSnap = await reviewRef.get();
  if (!reviewSnap.exists() || reviewSnap.child('publicId').val() !== id) {
    throw new HttpsError('not-found', '후기를 찾을 수 없습니다.');
  }
  const updates = {};
  updates['onyuVn/reviews/' + uid + '/' + endingId] = null;
  updates['onyuVn/reviewIndex/' + id] = null;
  updates['onyuVn/reviewOwners/' + id] = null;
  updates['onyuVn/publicReviews/' + id] = null;
  await db.ref().update(updates);
  return { ok: true };
});

const onyuListViewerAccessRequests = onCall(async (request) => {
  await requireAdmin(request);
  const snap = await getDatabase().ref('onyuVn/viewerAccessRequests').get();
  const data = snap.val() || {};
  const requests = Object.keys(data).map((uid) => Object.assign({ uid }, data[uid])).sort((a, b) => (b.updatedAt || b.requestedAt || 0) - (a.updatedAt || a.requestedAt || 0));
  return { requests };
});

async function updateOnyuViewerAccess(request, status) {
  await requireAdmin(request);
  void status;
  throw new HttpsError('failed-precondition', '이전 접근 신청은 종료됐습니다. 로그인 사용자와 인증 스트리머는 별도 승인 없이 게임을 무료로 이용할 수 있습니다.');
}

const onyuApproveViewerAccess = onCall((request) => updateOnyuViewerAccess(request, 'approved'));
const onyuRejectViewerAccess = onCall((request) => updateOnyuViewerAccess(request, 'rejected'));
const onyuRevokeViewerAccess = onCall((request) => updateOnyuViewerAccess(request, 'revoked'));

// ── onyu-vn 분석 이벤트 수집 ──────────────────────────────────
// 클라이언트는 이 목록 밖의 이벤트나 임의의 RTDB 경로를 쓸 수 없다. 모든 이벤트는
// 일별 카운터로 합산하고, 운영·오류 분석에 필요한 일부 이벤트만 짧은 기간 원문을
// 남긴다. 집계 경로는 관리자센터가 읽고, 클라이언트에는 공개하지 않는다.
const ONYU_ANALYTICS_EVENTS = new Set([
  'visit', 'session_start', 'session_end', 'screen_viewed', 'signature_shown', 'signature_completed', 'signature_skipped',
  'sound_unlock_clicked', 'login_success', 'viewer_access_requested', 'viewer_access_approved',
  'viewer_access_rejected', 'viewer_access_revoked', 'streamer_verification_requested',
  'streamer_verification_approved', 'streamer_verification_rejected',
  'streamer_game_gift_requested', 'streamer_game_gift_approved', 'streamer_game_gift_rejected',
  'access_check_success', 'access_check_denied', 'game_access_granted', 'game_access_denied',
  'game_started', 'game_paused', 'game_resumed', 'game_abandoned', 'game_completed',
  'name_submitted', 'chapter_started', 'chapter_completed', 'choice_shown', 'choice_selected',
  'cg_revealed', 'gallery_opened', 'gallery_item_opened', 'gallery_unlock', 'ending_branch_entered',
  'ending_reached', 'credits_started', 'credits_cg_skipped', 'ending_title_revealed',
  'return_to_title', 'outfit_picker_shown', 'outfit_selected', 'outfit_selection_cancelled',
  'autosave_created', 'manual_save_created', 'save_loaded', 'save_load_failed',
  'bgm_play_started', 'bgm_play_failed', 'bgm_changed', 'bgm_autoplay_blocked',
  'sfx_played', 'sfx_play_failed', 'settings_changed', 'transition_started',
  'transition_completed', 'input_blocked_during_transition', 'fullscreen_entered',
  'fullscreen_exited', 'asset_load_error', 'presence_heartbeat',
]);
const ONYU_ANALYTICS_RAW_EVENTS = new Set([
  'session_start', 'signature_skipped', 'game_started', 'game_completed', 'chapter_started', 'chapter_completed',
  'choice_selected', 'cg_revealed', 'ending_reached', 'outfit_selected',
  'viewer_access_requested', 'viewer_access_approved', 'viewer_access_rejected',
  'viewer_access_revoked', 'access_check_denied', 'game_access_denied', 'asset_load_error',
  'streamer_verification_approved', 'streamer_verification_rejected',
]);
const ONYU_ANALYTICS_DAILY_RETENTION_DAYS = 400;
const ONYU_ANALYTICS_RAW_RETENTION_DAYS = 30;
const ONYU_ANALYTICS_DEDUP_RETENTION_DAYS = 35;

function onyuAnalyticsKey(value, fallback) {
  const text = String(value === undefined || value === null ? (fallback || '') : value).trim();
  // RTDB 경로 키에는 점(.)도 허용되지 않는다.
  return /^[A-Za-z0-9_-]{1,80}$/.test(text) ? text : '';
}

function onyuAnalyticsVersionKey(value) {
  // 앱 버전은 2026.09.17 형식이므로 RTDB 키에 안전한 하이픈 형식으로 저장한다.
  return String(value || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80);
}

function onyuAnalyticsDate(at) {
  return new Date(at).toISOString().slice(0, 10);
}

function onyuAnalyticsUidKey(uid) {
  // Firebase uid는 슬래시를 포함하지 않지만 방어적으로 허용 문자만 남긴다.
  return onyuAnalyticsKey(uid, 'anonymous') || 'anonymous';
}

async function getOnyuAnalyticsMeta(uid, request) {
  const db = getDatabase();
  const userSnap = await db.ref('users/' + uid).get();
  const user = userSnap.val() || {};
  const provider = request && request.auth && request.auth.token && request.auth.token.firebase && request.auth.token.firebase.sign_in_provider;
  const isAdmin = await isOnyuAdminUid(uid);
  const verified = !isAdmin && (user.streamerVerified === true || (provider !== 'anonymous' && await isVerifiedStreamerUid(uid)));
  return {
    uid,
    provider: provider === 'google.com' ? 'google' : provider === 'kakao.com' ? 'kakao' : provider === 'anonymous' ? 'anonymous' : 'other',
    authMode: isAdmin ? 'admin' : verified ? 'streamer' : provider === 'anonymous' ? 'anonymous' : 'viewer',
  };
}

async function writeOnyuAnalyticsEvents(db, meta, events) {
  const incrementCounts = {};
  const updates = {};
  const rawEntries = [];
  const reservedDedupRefs = [];
  const now = Date.now();
  const uidKey = onyuAnalyticsUidKey(meta.uid);
  function increment(path) { incrementCounts[path] = (incrementCounts[path] || 0) + 1; }
  let accepted = 0;
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex];
    const eventName = event.event;
    if (!ONYU_ANALYTICS_EVENTS.has(eventName)) continue;
    const clientAt = Number(event.clientAt);
    const at = isFinite(clientAt) && clientAt > now - 7 * 24 * 3600 * 1000 && clientAt < now + 10 * 60 * 1000 ? clientAt : now;
    const date = onyuAnalyticsDate(at);
    const eventId = onyuAnalyticsKey(event.eventId);
    if (eventId) {
      // v2 공간을 사용해 과거 버전에서 카운터 저장 전에 남은 dedup 마커를
      // 재전송 이벤트가 영구히 가로막지 않게 한다.
      const dedupRef = db.ref('onyuVn/analytics/dedup/' + date + '/v2-' + eventId);
      const dedupResult = await dedupRef.transaction(function (value) {
        return value === true ? undefined : true;
      });
      if (!dedupResult.committed) continue;
      reservedDedupRefs.push(dedupRef);
    }
    accepted++;
    const base = 'onyuVn/analytics/daily/' + date;
    increment(base + '/totals/' + eventName);
    increment(base + '/authModes/' + meta.authMode);
    increment(base + '/providers/' + meta.provider);
    updates[base + '/uniqueUsers/' + uidKey] = true;

    const chapterId = onyuAnalyticsKey(event.chapterId);
    const choiceId = onyuAnalyticsKey(event.choiceId);
    const optionId = onyuAnalyticsKey(event.optionId);
    const itemId = onyuAnalyticsKey(event.itemId || event.cgId);
    const endingId = onyuAnalyticsKey(event.endingId);
    const trackId = onyuAnalyticsKey(event.trackId);
    if (chapterId) increment(base + '/chapters/' + chapterId + '/' + eventName);
    if (chapterId && choiceId) increment(base + '/choices/' + chapterId + '/' + choiceId + '/' + (optionId || 'unknown'));
    if (endingId) increment(base + '/endings/' + endingId + '/' + eventName);
    if (itemId) increment(base + '/items/' + itemId + '/' + eventName);
    if (trackId) increment(base + '/audio/' + trackId + '/' + eventName);
    const screen = onyuAnalyticsKey(event.screen);
    if (screen) increment(base + '/screens/' + screen);
    const mode = onyuAnalyticsKey(event.requestedMode);
    if (mode) increment(base + '/requestedModes/' + mode);
    const deviceType = onyuAnalyticsKey(event.deviceType);
    const orientation = onyuAnalyticsKey(event.orientation);
    const clientVersion = onyuAnalyticsVersionKey(event.clientVersion);
    if (deviceType) increment(base + '/devices/' + deviceType);
    if (orientation) increment(base + '/orientations/' + orientation);
    if (clientVersion) increment(base + '/clientVersions/' + clientVersion);

    const summary = 'onyuVn/analytics/users/' + uidKey + '/summary';
    if (eventName === 'game_started') increment(summary + '/startedCount');
    if (eventName === 'game_completed') increment(summary + '/completedCount');
    if (eventName === 'session_start') increment(summary + '/sessionCount');
    if (chapterId && (eventName === 'chapter_started' || eventName === 'chapter_completed')) updates[summary + '/lastChapterId'] = chapterId;
    if (endingId && eventName === 'ending_reached') updates[summary + '/endings/' + endingId] = true;
    if (itemId && (eventName === 'cg_revealed' || eventName === 'gallery_unlock')) updates[summary + '/items/' + itemId] = true;
    updates[summary + '/lastEventAt'] = now;

    if (ONYU_ANALYTICS_RAW_EVENTS.has(eventName)) {
      const raw = {
        event: eventName,
        uid: meta.uid,
        provider: meta.provider,
        authMode: meta.authMode,
        clientAt: isFinite(clientAt) ? clientAt : null,
        serverAt: now,
        sessionId: onyuAnalyticsKey(event.sessionId),
        deviceType: onyuAnalyticsKey(event.deviceType) || null,
        orientation: onyuAnalyticsKey(event.orientation) || null,
        clientVersion: onyuAnalyticsKey(event.clientVersion) || null,
        chapterId: chapterId || null,
        choiceId: choiceId || null,
        optionId: optionId || null,
        itemId: itemId || null,
        endingId: endingId || null,
        trackId: trackId || null,
      };
      rawEntries.push({ date: date, value: raw });
    }
  }

  Object.keys(incrementCounts).forEach(function (path) {
    updates[path] = ServerValue.increment(incrementCounts[path]);
  });
  rawEntries.forEach(function (entry) {
    const key = db.ref('onyuVn/analytics/raw/' + entry.date).push().key;
    updates['onyuVn/analytics/raw/' + entry.date + '/' + key] = entry.value;
  });
  if (Object.keys(updates).length) {
    try {
      await db.ref().update(updates);
    } catch (error) {
      // dedup 선점 뒤 집계 저장이 실패하면 마커를 되돌려 다음 재전송에서 복구한다.
      await Promise.all(reservedDedupRefs.map(function (ref) {
        return ref.remove().catch(function () {});
      }));
      throw error;
    }
  }
  return { accepted };
}

const onyuTrackEvents = onCall(async (request) => {
  const uid = requireAuth(request);
  const events = request.data && request.data.events;
  if (!Array.isArray(events) || !events.length || events.length > 25) {
    throw new HttpsError('invalid-argument', '이벤트는 1~25개 묶음이어야 합니다.');
  }
  const cleaned = events.map(function (event) {
    const source = event && typeof event === 'object' ? event : {};
    const clean = {};
    Object.keys(source).slice(0, 20).forEach(function (key) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)) return;
      const value = source[key];
      if (typeof value === 'string') clean[key] = value.slice(0, 120);
      else if (typeof value === 'number' && isFinite(value)) clean[key] = value;
      else if (typeof value === 'boolean') clean[key] = value;
    });
    return clean;
  });
  const meta = await getOnyuAnalyticsMeta(uid, request);
  return Object.assign({ ok: true }, await writeOnyuAnalyticsEvents(getDatabase(), meta, cleaned));
});

async function recordOnyuServerEvent(request, eventName, extra) {
  try {
    const uid = requireAuth(request);
    const meta = await getOnyuAnalyticsMeta(uid, request);
    await writeOnyuAnalyticsEvents(getDatabase(), meta, [Object.assign({ event: eventName, serverAt: Date.now() }, extra || {})]);
  } catch (e) {
    // 분석 기록 실패가 로그인·승인·게임 시작을 막아서는 안 된다.
    console.error('온 이유 서버 이벤트 기록 실패:', eventName, e);
  }
}

const getOnyuStats = onCall(async (request) => {
  await requireAdmin(request);
  const days = Math.min(Math.max(Number(request.data && request.data.days) || 14, 1), 90);
  const db = getDatabase();
  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(onyuAnalyticsDate(Date.now() - i * 24 * 3600 * 1000));
  const snaps = await Promise.all(dates.map(function (date) { return db.ref('onyuVn/analytics/daily/' + date).get(); }));
  const totals = {};
  const chapters = {}, choices = {}, endings = {}, cgs = {}, audio = {}, screens = {}, authModes = {}, providers = {};
  const devices = {}, orientations = {}, clientVersions = {};
  const unique = {};
  const daily = [];
  const dailyUsers = [];
  function mergeCounter(target, source, prefix) {
    Object.keys(source || {}).forEach(function (key) {
      const value = source[key];
      if (value && typeof value === 'object') mergeCounter(target, value, prefix ? prefix + '/' + key : key);
      else if (typeof value === 'number') target[prefix ? prefix + '/' + key : key] = (target[prefix ? prefix + '/' + key : key] || 0) + value;
    });
  }
  snaps.forEach(function (snap, index) {
    const value = snap.val() || {};
    const usersForDay = Object.keys(value.uniqueUsers || {});
    dailyUsers.push(new Set(usersForDay));
    daily.push({ date: dates[index], uniqueUsers: usersForDay.length, totals: value.totals || {} });
    mergeCounter(totals, value.totals || {}, '');
    mergeCounter(chapters, value.chapters || {}, '');
    mergeCounter(choices, value.choices || {}, '');
    mergeCounter(endings, value.endings || {}, '');
    mergeCounter(cgs, value.items || {}, '');
    mergeCounter(audio, value.audio || {}, '');
    mergeCounter(screens, value.screens || {}, '');
    mergeCounter(authModes, value.authModes || {}, '');
    mergeCounter(providers, value.providers || {}, '');
    mergeCounter(devices, value.devices || {}, '');
    mergeCounter(orientations, value.orientations || {}, '');
    mergeCounter(clientVersions, value.clientVersions || {}, '');
    Object.keys(value.uniqueUsers || {}).forEach(function (uid) { unique[uid] = true; });
  });
  const funnel = {
    visitors: totals.visit || 0,
    sessions: totals.session_start || 0,
    gameStarted: totals.game_started || 0,
    chapterStarted: totals.chapter_started || 0,
    endingReached: totals.ending_reached || 0,
    gameCompleted: totals.game_completed || 0,
  };
  const retention = daily.map(function (day, index) {
    const cohort = dailyUsers[index];
    function returning(offset) {
      if (index + offset >= dailyUsers.length) return null;
      let count = 0;
      cohort.forEach(function (uid) { if (dailyUsers[index + offset].has(uid)) count++; });
      return count;
    }
    const day1 = returning(1);
    const day7 = returning(7);
    return { date: day.date, cohortUsers: cohort.size, day1, day7,
      day1Rate: day1 === null || !cohort.size ? null : day1 / cohort.size,
      day7Rate: day7 === null || !cohort.size ? null : day7 / cohort.size };
  });
  return {
    days,
    from: dates[0],
    to: dates[dates.length - 1],
    uniqueUsers: Object.keys(unique).length,
    totals,
    chapters,
    choices,
    endings,
    cgs,
    audio,
    screens,
    authModes,
    providers,
    devices,
    orientations,
    clientVersions,
    daily,
    funnel,
    retention,
  };
});

const trimOnyuAnalytics = onSchedule('every 24 hours', async function () {
  const db = getDatabase();
  const snap = await db.ref('onyuVn/analytics').get();
  const data = snap.val() || {};
  const now = Date.now();
  const updates = {};
  Object.keys(data.daily || {}).forEach(function (date) {
    if (now - new Date(date + 'T00:00:00Z').getTime() > ONYU_ANALYTICS_DAILY_RETENTION_DAYS * 24 * 3600 * 1000) updates['onyuVn/analytics/daily/' + date] = null;
  });
  Object.keys(data.raw || {}).forEach(function (date) {
    if (now - new Date(date + 'T00:00:00Z').getTime() > ONYU_ANALYTICS_RAW_RETENTION_DAYS * 24 * 3600 * 1000) updates['onyuVn/analytics/raw/' + date] = null;
  });
  Object.keys(data.dedup || {}).forEach(function (date) {
    if (now - new Date(date + 'T00:00:00Z').getTime() > ONYU_ANALYTICS_DEDUP_RETENTION_DAYS * 24 * 3600 * 1000) updates['onyuVn/analytics/dedup/' + date] = null;
  });
  if (Object.keys(updates).length) await db.ref().update(updates);
});

// 주식시장 공용 스트리머 인증 요청 노드의 상태 변경을 온이유 출처만 골라 집계한다.
// 요청 생성 알림은 기존 notifyStockVerifyRequest가 담당하므로 여기서는 승인·거절
// 전환만 처리해 클라이언트 이벤트 유실을 보완한다.
const trackOnyuStreamerVerificationStatus = onValueUpdated('/streamerVerificationRequests/{id}', async (event) => {
  const before = event.data.before.val() || {};
  const after = event.data.after.val() || {};
  if (after.source !== 'onyu-vn' || before.status === after.status || !after.uid) return null;
  const status = after.status === 'approved' ? 'approved' : after.status === 'rejected' ? 'rejected' : null;
  if (!status) return null;
  const meta = { uid: String(after.uid), provider: 'other', authMode: status === 'approved' ? 'streamer' : 'viewer' };
  await writeOnyuAnalyticsEvents(getDatabase(), meta, [{
    event: 'streamer_verification_' + status,
    serverAt: Date.now(),
  }]);
  return null;
});

// 인증 원장은 SOOP 아이디를 canonical key로 쓰는 공유 노드다. 관리자가 인증을
// 승인해 새 레코드를 만들거나 기존 레코드의 UID를 바꿨을 때, 후원 확인까지 끝난
// 온이유 선물을 해당 스트리머 UID에 연결한다. 함수는 재시도되어도 같은 요청권만
// 멱등 지급하고, 이미 다른 이용권이 있으면 덮어쓰지 않는다.
const activateOnyuGiftsAfterStreamerVerification = onValueWritten('/streamerVerifications/{id}', async (event) => {
  const streamer = event.data.after.val() || {};
  await activateApprovedOnyuGiftsForStreamer(getDatabase(), streamer);
  return null;
});

module.exports = {
  getPublicPromoPageVersion,
  getPublicPromoDirectory,
  recordPublicPromoEvent,
  getPublicPromoPageStats,
  openPublicPromoLink,
  getGalleryStats,
  getLifeGameStats,
  listLifeGamePlayerStartRecords,
  listLifeGamePlayedStreamers,
  addLifeGamePlayedStreamer,
  removeLifeGamePlayedStreamer,
  getLifeGameBotConfig,
  setLifeGameBotConfig,
  lifeGameApproveSponsorRequest,
  getLifeGameSponsorAutoVerificationDiagnostics,
  listFanPageSponsorDonationDiagnostics,
  manageFanPageSponsorAds,
  lifeGameRejectSponsorRequest,
  getLifeGameCurrentSponsor,
  updateLifeGameCurrentSponsor,
  endLifeGameCurrentSponsor,
  banAccountAllGames,
  unbanAccountAllGames,
  migrateBannedAccounts,
  getAdminCenterState,
  getAdminSessionSummary,
  setAdminCenterPermission,
  revokeAllStreamerPermissions,
  setDevbarLink,
  deleteDevbarLink,
  getAdultImageGeneratorLinks,
  saveAdultImageGeneratorLinks,
  listPromotedContent,
  addPromotedContent,
  removePromotedContent,
  migratePromotedStreamers,
  listStreamerPromoLinks,
  addStreamerPromoCandidate,
  removeStreamerPromoCandidate,
  setStreamerPromoExclusion,
  saveStreamerPromoLink,
  markStreamerPromoLinkOpened,
  setStreamerPromoCompletion,
  clearAllStreamerPromoCompletion,
  listStreamerVerificationOverview,
  listAuditLogOverview,
  getSeriesConfig,
  setSeriesConfig,
  bootstrapAdminUid,
  setDiscordWebhookUrl,
  getDiscordWebhookStatus,
  sendTestDiscordNotification,
  notifyPresetMergeFailure,
  notifyMarketReport,
  notifyNicknameReport,
  notifyBettingVerifyRequest,
  notifyStockVerifyRequest,
  notifyStreamerVerificationAutoApproval,
  notifyChestPurchaseRequest,
  notifyBannerRequest,
  notifyChartBannerRequest,
  notifyCardBannerRequest,
  notifyPinRequest,
  notifyRelayRoomRequest,
  notifyTreasureChestRequest,
  notifyCashChargeRequest,
  notifyUnfreezeDonationRequest,
  notifyMessengerReport,
  notifyListingRequest,
  notifyLifeGameReportAlert,
  notifyLifeGameReviewReportAlert,
  notifyLifeGameSponsorRequest,
  notifyGalleryImageReport,
  notifyGalleryCommentReport,
  notifyGalleryUnlockRequest,
  notifyFanPageViewerSubscriptionRequest,
  notifyFanPageSponsorAdRequest,
  notifyFanPageDesignFeedback,
  notifyGalleryImageUpload,
  notifyVerifiedStreamerVisit,
  onyuVnLogVerifiedStreamerVisit,
  searchSeriesUser,
  getPurchaseOverview,
  sampleConcurrentUsers,
  getVisitorAnalytics,
  onyuRequestViewerAccess,
  onyuSubmitReview,
  onyuSubmitStreamerProductionInquiry,
  onyuAdminListProductionInquiries,
  onyuVnListPublicReviews,
  onyuAdminListPlayerReviews,
  onyuAdminSetPlayerReviewVisibility,
  onyuAdminDeletePlayerReview,
  notifyOnyuViewerAccessRequest,
  notifyOnyuStreamerGameGiftRequest,
  notifyOnyuProductionInquiry,
  notifyOnyuStreamerGameGiftAutoApproval,
  onyuGetViewerAccess,
  onyuListStreamerGiftTargets,
  onyuSubmitStreamerGameGift,
  onyuMarkStreamerGameGiftDonationComplete,
  onyuGetMyStreamerGameGiftRequestStatus,
  onyuListStreamerGameGifts,
  onyuRecoverStuckStreamerGameGift,
  onyuAdminLookupEntitlement,
  onyuAdminRevokeEntitlement,
  onyuReviewStreamerGameGift,
  onyuConfirmStreamerGameGiftFromNotification,
  confirmGameDonationFromNotification,
  onyuCreateGiftBackgroundMonitorSession,
  onyuGiftBackgroundFeed,
  onyuStartSession,
  onyuListViewerAccessRequests,
  onyuApproveViewerAccess,
  onyuRejectViewerAccess,
  onyuRevokeViewerAccess,
  onyuTrackEvents,
  getOnyuStats,
  trimOnyuAnalytics,
  trackOnyuStreamerVerificationStatus,
  activateOnyuGiftsAfterStreamerVerification,
};
