const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onValueCreated, onValueUpdated } = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const { ServerValue } = require('firebase-admin/database');
const STREAMER_PROMO_SEED = require('./streamer-promo-seed.json');

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
      hasAnyEntry(db, 'bettingMarket/verifyRequests'),
      hasAnyEntry(db, 'streamerVerificationRequests', 'pending'),
      hasAnyEntry(db, 'onyuVn/viewerAccessRequests', 'pending'),
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
  { id: 'onyuVn', name: '당신이 여기에 온 이유' },
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

function getKnownPromoEntries(verifiedValue) {
  const entries = STREAMER_PROMO_SEED.map(function (entry) {
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
  return Object.keys(byKey).map(function (key) { return byKey[key]; });
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

const listStreamerPromoLinks = onCall(async (request) => {
  await requireAdmin(request);
  const db = getDatabase();
  const [verifiedSnap, linksSnap, recentSnap] = await Promise.all([
    db.ref('streamerVerifications').get(),
    db.ref('adminCenter/streamerPromoLinks').get(),
    db.ref('adminCenter/streamerPromoRecent').get(),
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
  const streamers = getKnownPromoEntries(verifiedSnap.val());
  streamers.sort(function (a, b) {
    return (a.nickname || a.soopId).localeCompare((b.nickname || b.soopId), 'ko') || a.soopId.localeCompare(b.soopId);
  });
  return {
    streamers: streamers.map(function (entry) {
      const key = promoStorageKey(entry.id, entry.soopId);
      const saved = links[key] || {};
      return {
        key: key,
        nickname: entry.nickname,
        soopId: entry.soopId,
        writeUrl: typeof saved.writeUrl === 'string' && saved.writeUrl ? saved.writeUrl : (entry.writeUrl || ''),
        promotedCompleted: saved.promotedCompleted === true,
        lastOpenedAt: recentOpened && recentOpened.key === key ? recentOpened.lastOpenedAt || null : null,
        updatedAt: saved.updatedAt || null,
      };
    }),
    recentOpened: recentOpened || null,
  };
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
  const verifiedSnap = await db.ref('streamerVerifications').get();
  const entries = getKnownPromoEntries(verifiedSnap.val());
  const entry = entries.find(function (item) {
    return (requestedPromoKey && item.key === requestedPromoKey) ||
      (!requestedPromoKey && requestedSoopId && item.soopId === requestedSoopId) ||
      (!requestedPromoKey && !requestedSoopId && requestedVerificationId === item.id);
  });
  if (!entry) throw new HttpsError('failed-precondition', '등록된 스트리머만 수정할 수 있습니다.');

  const key = promoStorageKey(entry.id, entry.soopId);
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
  const verifiedSnap = await db.ref('streamerVerifications').get();
  const entries = getKnownPromoEntries(verifiedSnap.val());
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
const notifyOnyuViewerAccessRequest = onValueCreated('/onyuVn/viewerAccessAlerts/{id}', async (event) => {
  const data = event.data.val() || {};
  const nickname = String(data.nickname || '(닉네임 미입력)').replace(/[\r\n]/g, ' ').slice(0, 60);
  const uid = String(data.uid || '(알 수 없음)').replace(/[\r\n]/g, ' ').slice(0, 120);
  await sendDiscordNotification(
    '🔔 **새 후원 승인 신청 (온 이유)**\n' +
    '후원자 닉네임: ' + nickname + '\n' +
    'uid: `' + uid + '`\n' +
    deepLink('section-onyu-access')
  );
});

// 2026-09-05 추가(신규 게임 온보딩 체크리스트) — 인생게임/갤러리의 신고 큐는
// admin-center 페이지 안에 대응하는 섹션이 없고, 각 사이트 자체 관리 패널에서
// 처리한다. 그래서 makeQueueTrigger의 deepLink(admin-center#anchor 고정)를 그대로
// 못 쓰고, 그 사이트 자신의 URL로 안내하는 커스텀 트리거를 쓴다.
const notifyLifeGameReportAlert = onValueCreated('/lifeGame/galleryReports/{id}', async (event) => {
  const data = event.data.val() || {};
  await sendDiscordNotification('🔔 **새 갤러리 신고 (인생게임)**\n' + formatRequestSummary(data) + '\nhttps://neezu-crypto.github.io/streamer-life-game/ (관리자 패널에서 확인)');
});
// 게임 후기 신고(2026-09-08 추가) - formatRequestSummary는 이 노드의 필드명
// (reviewUid/reporterUid)을 모르는 필드로 취급해 "(상세 정보 없음)"만 찍을
// 수 있어서(requesterUid/uid만 인식) 직접 문구를 구성한다.
const notifyLifeGameReviewReportAlert = onValueCreated('/lifeGame/reviewReports/{id}', async (event) => {
  const data = event.data.val() || {};
  await sendDiscordNotification(
    '🔔 **새 후기 신고 (인생게임)**\n대상 후기 uid: ' + (data.reviewUid || '(알 수 없음)') +
    (data.reason ? ' · 사유: ' + data.reason : '') +
    '\nhttps://neezu-crypto.github.io/streamer-life-game/ (관리자 패널에서 확인)'
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

// 25번 — 인증 스트리머가 주식시장/배팅시장/인생게임/갤러리에 접속하면 관리자
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
// (betting/stock/lifeGame/gallery) - 없는 값이면 마켓 이름 대신 원본 문자열을
// 그대로 보여줘서, 새 앱이 이 매핑에 등록되는 걸 잊었을 때도 조용히
// "주식시장"으로 오표시되지 않고 눈에 띄게 한다(2026-09-06, lifeGame/gallery
// 추가 전엔 betting이 아니면 전부 "주식시장"으로 잘못 표시되는 버그가 있었음).
const VISIT_MARKET_LABELS = { betting: '배팅시장', stock: '주식시장', lifeGame: '인생게임', gallery: '갤러리' };
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
// 패널·봇 시스템)와 별개로 이 표준 경로에도 병행 기록한다.
const PRESENCE_APPS = ['bettingMarket', 'stockMarket', 'lifeGame', 'gallery', 'onyuVn', 'streamerMessenger'];
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
const lifeGameApproveSponsorRequest = onCall(async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  const requestId = data.requestId;
  if (!requestId) throw new HttpsError('invalid-argument', 'requestId가 필요합니다.');
  const daysNum = Math.round(Number(data.days));
  if (!Number.isInteger(daysNum) || daysNum < 1) {
    throw new HttpsError('invalid-argument', '노출 기간을 올바르게 입력해주세요.');
  }
  const nickname = (data.nickname || '').toString().trim();

  const db = getDatabase();
  const reqSnap = await db.ref('lifeGame/sponsorRequests/' + requestId).get();
  if (!reqSnap.exists()) throw new HttpsError('not-found', '신청 내역을 찾을 수 없습니다.');
  const reqData = reqSnap.val();
  if (reqData.status !== 'pending') {
    throw new HttpsError('failed-precondition', '이미 처리된 신청입니다.');
  }

  const finalNickname = nickname || reqData.nickname;
  const now = Date.now();
  const currentSnap = await db.ref('lifeGame/currentSponsor').get();
  const current = currentSnap.val();
  const baseTime = (current && current.endAt > now) ? current.endAt : now;
  const endAt = baseTime + daysNum * 86400000;

  await db.ref().update({
    'lifeGame/currentSponsor': {
      nickname: finalNickname,
      soopId: reqData.soopId,
      previewImg: reqData.previewImg,
      stationLink: reqData.stationLink,
      startAt: now,
      endAt: endAt,
    },
    ['lifeGame/sponsorRequests/' + requestId + '/nickname']: finalNickname,
    ['lifeGame/sponsorRequests/' + requestId + '/status']: 'approved',
    ['lifeGame/sponsorRequests/' + requestId + '/reviewedAt']: now,
  });
  await logToAdminAuditLog(db, request, '인생게임 후원 스트리머 승인', finalNickname + ' · ' + daysNum + '일');
  return { ok: true, endAt: endAt };
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
const ONYU_ADMIN_UID = '3Y2N5S5aCxT3bVDvcjx6GLyUaEs1';
function onyuProviderLabel(request) {
  const provider = request.auth && request.auth.token && request.auth.token.firebase && request.auth.token.firebase.sign_in_provider;
  return provider === 'google.com' ? 'google' : 'kakao';
}

async function getOnyuAccessState(uid, request) {
  const db = getDatabase();
  const [userSnap, accessSnap, requestSnap] = await Promise.all([
    db.ref('users/' + uid).get(),
    db.ref('onyuVn/viewerAccess/' + uid).get(),
    db.ref('onyuVn/viewerAccessRequests/' + uid).get(),
  ]);
  const user = userSnap.val() || {};
  const provider = request && request.auth && request.auth.token && request.auth.token.firebase && request.auth.token.firebase.sign_in_provider;
  const authenticatedViewer = provider !== 'anonymous' || user.googleLinked === true || user.kakaoLinked === true;
  const loginMethod = user.googleLinked === true || provider === 'google.com' ? 'google' : user.kakaoLinked === true ? 'kakao' : null;
  const isAdmin = uid === ONYU_ADMIN_UID;
  const requestedMode = request && request.data && request.data.accessMode;
  // 레거시 클라이언트의 adminMode=true 요청은 관리자 모드로 한 번만 호환하고,
  // 그 외에는 일반 로그인 유저 모드로 취급한다. 권한은 항상 UID로 재검증한다.
  const adminAccessMode = isAdmin && ['admin', 'streamer', 'viewer'].includes(requestedMode)
    ? requestedMode
    : isAdmin && request && request.data && request.data.adminMode === true ? 'admin' : 'viewer';
  if (isAdmin && adminAccessMode === 'admin') {
    return { role: 'admin', accessMode: 'admin', accessStatus: 'approved', canStartGame: true, authenticated: true, loginMethod, isAdmin: true, adminMode: true };
  }
  if (isAdmin && adminAccessMode === 'streamer') {
    return { role: 'streamer', accessMode: 'streamer', accessStatus: 'approved', canStartGame: true, authenticated: true, loginMethod, isAdmin: true, adminMode: false };
  }
  // 관리자 계정은 일반 유저 모드에서 스트리머 인증 혜택까지 우회하지 않도록
  // 시청자 경로로 판정한다. 관리자 모드일 때만 위에서 모든 접근을 허용한다.
  // 그 외 계정은 users 플래그가 없는 레거시 인증 기록도 스트리머로 인식한다.
  const streamerVerified = !isAdmin && (user.streamerVerified === true || await isVerifiedStreamerUid(uid));
  if (streamerVerified) return { role: 'streamer', accessMode: 'streamer', accessStatus: 'approved', canStartGame: true, authenticated: true, loginMethod, isAdmin, adminMode: false };
  const access = accessSnap.val() || {};
  const req = requestSnap.val() || {};
  const status = access.status || req.status || 'none';
  return { role: 'viewer', accessMode: 'viewer', accessStatus: status, canStartGame: authenticatedViewer && status === 'approved', authenticated: authenticatedViewer, loginMethod, isAdmin, adminMode: false };
}

// 일반 시청자가 후원 후 관리자 승인을 기다리는 신청을 생성한다. 익명 세션은 신청할
// 수 없고, 스트리머 인증 유저는 별도 승인 없이 이미 통과 상태로 반환한다.
const onyuRequestViewerAccess = onCall(async (request) => {
  const uid = requireAuth(request);
  const provider = request.auth.token && request.auth.token.firebase && request.auth.token.firebase.sign_in_provider;
  if (provider === 'anonymous') throw new HttpsError('failed-precondition', 'Google 또는 카카오 로그인이 필요합니다.');
  const nickname = String(request.data && request.data.nickname || '').trim();
  if (!nickname || nickname.length > 30) throw new HttpsError('invalid-argument', 'SOOP 후원자 닉네임을 입력해 주세요.');
  const current = await getOnyuAccessState(uid, request);
  if (current.role === 'streamer' || (current.authenticated && current.accessStatus === 'approved')) return Object.assign({ ok: true }, current);
  if (!current.authenticated) throw new HttpsError('failed-precondition', 'Google 또는 카카오 로그인이 필요합니다.');

  const db = getDatabase();
  const requestRef = db.ref('onyuVn/viewerAccessRequests/' + uid);
  const existingSnap = await requestRef.get();
  const existing = existingSnap.val() || {};
  const now = Date.now();
  const next = {
    uid,
    nickname,
    provider: onyuProviderLabel(request),
    status: 'pending',
    requestedAt: existing.requestedAt || now,
    updatedAt: now,
  };
  await requestRef.set(next);
  // 같은 uid가 재신청할 때도 디스코드 알림이 누락되지 않도록, 현재 상태 노드와
  // 별도의 일회성 알림 큐를 만든다. 알림 큐 기록 실패가 후원 신청 자체를 막지는 않는다.
  try {
    await db.ref('onyuVn/viewerAccessAlerts').push().set({
      uid,
      nickname,
      provider: onyuProviderLabel(request),
      status: 'pending',
      requestedAt: now,
    });
  } catch (e) {
    console.error('온 이유 후원 신청 알림 큐 기록 실패:', e);
  }
  await recordOnyuServerEvent(request, 'viewer_access_requested');
  return { ok: true, role: 'viewer', accessStatus: 'pending', canStartGame: false, requestId: uid };
});

const onyuGetViewerAccess = onCall(async (request) => {
  const uid = requireAuth(request);
  return Object.assign({ ok: true, uid }, await getOnyuAccessState(uid, request));
});

// 게임 시작 직전에 호출하는 최종 서버 판정. 정적 콘텐츠 파일 자체를 숨기는 함수는
// 아니지만, 정상적인 시작 경로의 승인 우회는 이 함수에서 차단한다.
const onyuStartSession = onCall(async (request) => {
  const uid = requireAuth(request);
  const state = await getOnyuAccessState(uid, request);
  if (!state.canStartGame) {
    throw new HttpsError('permission-denied', state.authenticated ? '별풍선 후원 확인 및 관리자 승인이 필요합니다.' : 'Google 또는 카카오 로그인 후 접근 승인을 받아야 합니다.');
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
  if (provider === 'anonymous') {
    throw new HttpsError('failed-precondition', '로그인한 계정으로만 후기를 저장할 수 있습니다.');
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
  const db = getDatabase();
  const userSnap = await db.ref('users/' + uid + '/streamerVerified').get();
  const verified = userSnap.val() === true || await isVerifiedStreamerUid(uid);
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
    promoteRequested = uid !== ONYU_ADMIN_UID;
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
  return { ok: true, updatedAt: now, promoteRequested, nickname, soopId };
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
  const adminUid = await requireAdmin(request);
  const uid = String(request.data && request.data.uid || '').trim();
  if (!uid || uid.length > 200) throw new HttpsError('invalid-argument', '대상 uid가 필요합니다.');
  const db = getDatabase();
  const reqRef = db.ref('onyuVn/viewerAccessRequests/' + uid);
  const reqSnap = await reqRef.get();
  const req = reqSnap.val() || {};
  if (!req.uid) throw new HttpsError('not-found', '해당 접근 승인 신청을 찾을 수 없습니다.');
  const now = Date.now();
  const adminName = (request.auth.token && (request.auth.token.name || request.auth.token.email)) || adminUid;
  const updates = {};
  updates['onyuVn/viewerAccess/' + uid] = {
    status,
    approvedAt: status === 'approved' ? now : null,
    rejectedAt: status === 'rejected' ? now : null,
    revokedAt: status === 'revoked' ? now : null,
    reviewedAt: now,
    reviewedBy: adminUid,
  };
  updates['onyuVn/viewerAccessRequests/' + uid + '/status'] = status;
  updates['onyuVn/viewerAccessRequests/' + uid + '/reviewedAt'] = now;
  updates['onyuVn/viewerAccessRequests/' + uid + '/reviewedBy'] = adminUid;
  await db.ref().update(updates);
  await logToAdminAuditLog(db, request, 'onyu-vn 접근 ' + (status === 'approved' ? '승인' : status === 'rejected' ? '무시' : '회수'), uid + ' · ' + adminName);
  await recordOnyuServerEvent(request, 'viewer_access_' + status, { targetUid: uid });
  return { ok: true, uid, status };
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
  const isAdmin = uid === ONYU_ADMIN_UID;
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

module.exports = {
  getGalleryStats,
  getLifeGameStats,
  getLifeGameBotConfig,
  setLifeGameBotConfig,
  lifeGameApproveSponsorRequest,
  lifeGameRejectSponsorRequest,
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
  notifyGalleryImageUpload,
  notifyVerifiedStreamerVisit,
  searchSeriesUser,
  getPurchaseOverview,
  sampleConcurrentUsers,
  getVisitorAnalytics,
  onyuRequestViewerAccess,
  onyuSubmitReview,
  onyuVnListPublicReviews,
  onyuAdminListPlayerReviews,
  onyuAdminSetPlayerReviewVisibility,
  onyuAdminDeletePlayerReview,
  notifyOnyuViewerAccessRequest,
  onyuGetViewerAccess,
  onyuStartSession,
  onyuListViewerAccessRequests,
  onyuApproveViewerAccess,
  onyuRejectViewerAccess,
  onyuRevokeViewerAccess,
  onyuTrackEvents,
  getOnyuStats,
  trimOnyuAnalytics,
  trackOnyuStreamerVerificationStatus,
};
