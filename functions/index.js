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

module.exports = { getAdminCenterState, setAdminCenterPermission };
