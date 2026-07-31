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

module.exports = { getAdminCenterState, setAdminCenterPermission, listStreamerVerificationOverview };
