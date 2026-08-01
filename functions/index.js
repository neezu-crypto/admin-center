const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

initializeApp();

// 07번 — 주식시장·배팅시장과 같은 관리자 이메일. uid 위변조 검증 원칙(그 두 저장소와 동일):
// 대상 uid는 항상 request.auth.uid에서만 가져오고, 클라이언트가 보낸 값은 신뢰하지 않는다.
const ADMIN_EMAIL = 'skftodwocks2@gmail.com';

function requireAuth(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  return request.auth.uid;
}

function isAdminEmail(email) {
  return !!email && email === ADMIN_EMAIL;
}

function requireAdmin(request) {
  const uid = requireAuth(request);
  const email = request.auth.token && request.auth.token.email;
  if (!isAdminEmail(email)) {
    throw new HttpsError('permission-denied', '관리자만 수행할 수 있습니다.');
  }
  return uid;
}

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

async function requireAdminOrVerifiedStreamer(request) {
  const uid = requireAuth(request);
  const email = request.auth.token && request.auth.token.email;
  if (isAdminEmail(email)) return { uid, role: 'admin' };
  if (await isVerifiedStreamerUid(uid)) return { uid, role: 'streamer' };
  throw new HttpsError('permission-denied', '관리자 또는 인증된 스트리머만 이용할 수 있습니다.');
}

// 통합 관리 센터 — 인증 스트리머 전원에게 공통으로 적용되는 위임 권한 목록을 읽는다.
// 관리자·인증 스트리머 둘 다 호출 가능(화면에 보여줄 상태를 그대로 반환).
const getAdminCenterState = onCall(async (request) => {
  const { role } = await requireAdminOrVerifiedStreamer(request);
  const db = getDatabase();
  const snap = await db.ref('adminCenter/streamerPermissions').get();
  return { role, permissions: snap.val() || {} };
});

// 통합 관리 센터 — 위임 권한 하나를 켜고/끈다. 관리자만 가능하고, 인증 스트리머 전원에게
// 동일하게 적용된다(스트리머별 개별 권한이 아니라 하나의 공용 스위치 목록).
const setAdminCenterPermission = onCall(async (request) => {
  requireAdmin(request);
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

// 통합 관리 센터 — 인증 스트리머 관리 1단계: 배팅시장(bettingMarket/verifyRequests)·
// 주식시장(streamerVerificationRequests)의 대기 신청과 공유 streamerVerifications을
// 한 화면에서 보기 위한 조회 전용 함수. 승인/거절/해제 자체는 여기서 새로 구현하지
// 않는다 - 각 게임의 기존 함수(배팅시장 approveVerification 등, 주식시장 adminAction의
// approveStreamerVerification 등 액션)를 클라이언트가 source 태그를 보고 그대로
// 호출한다. 이 함수는 흩어진 데이터를 한 번에 모아서 보여주는 역할만 한다.
// 승인/거절/해제는 두 스트리머를 저울질하는 민감한 권한이라 당분간 관리자 전용으로
// 유지하기로 했고, 조회도 같은 화면의 일부라 우선 관리자 전용으로 시작한다.
const listStreamerVerificationOverview = onCall(async (request) => {
  requireAdmin(request);
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
// 보여준다. 관리자 전용.
const AUDIT_OVERVIEW_LIMIT = 100;
const listAuditLogOverview = onCall(async (request) => {
  requireAdmin(request);
  const db = getDatabase();
  const [bmLogSnap, smLogSnap] = await Promise.all([
    db.ref('bettingMarket/auditLog').get(),
    db.ref('adminAuditLog').get(),
  ]);

  const bmLog = bmLogSnap.val() || {};
  const smLog = smLogSnap.val() || {};

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
  requireAdmin(request);
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
  requireAdmin(request);
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

module.exports = {
  getAdminCenterState,
  setAdminCenterPermission,
  listStreamerVerificationOverview,
  listAuditLogOverview,
  getSeriesConfig,
  setSeriesConfig,
};
