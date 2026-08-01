const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onValueCreated } = require('firebase-functions/v2/database');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

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

// 09번 — 관리자 이메일 하드코딩 정리의 1회성 부트스트랩. 이메일 문자열 비교
// (isAdminEmail)는 이 함수에서 마지막으로 한 번 더 쓰이고, 그 결과로 호출한
// 사람의 uid를 adminCenter/adminUids에 등록한다. 이후 모든 관리자 판별은
// 이 uid 노드만 보게 되므로, 관리자 이메일을 바꿔야 할 때도 이 노드 하나만
// 고치면 된다(전체 조사는 09번 문서 참고). request.auth.uid만 신뢰하고
// 클라이언트가 보낸 값은 쓰지 않는다 — 위조 불가능한 자기 등록.
const bootstrapAdminUid = onCall(async (request) => {
  const uid = requireAdmin(request); // 기존 이메일 비교 방식으로 마지막 검증
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
  requireAdmin(request);
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
  requireAdmin(request);
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
  requireAdmin(request);
  const result = await sendDiscordNotification(
    '✅ **테스트 알림** — 통합 관리 센터 디스코드 웹훅 연결이 정상입니다.'
  );
  return result;
});

// interior-3d-viewer의 프리셋 소유권 병합 실패 — 13번에서 확인했듯 이 시리즈에서
// 유일하게 관리자가 CLI로 직접 RTDB를 만져야 처리되는 사각지대라, 가장 먼저
// 연결하는 트리거. RTDB 트리거는 프로젝트 전체에 걸리므로, interior-3d-viewer의
// 코드를 전혀 건드리지 않고 admin-center가 이 경로를 그대로 감시할 수 있다.
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
    '⚠️ 현재는 관리자가 CLI로 직접 처리해야 합니다.'
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
  return parts.length ? parts.join(' · ') : '(상세 정보 없음)';
}

function makeQueueTrigger(path, label) {
  return onValueCreated(path, async (event) => {
    const data = event.data.val() || {};
    await sendDiscordNotification('🔔 **' + label + '**\n' + formatRequestSummary(data));
  });
}

const notifyMarketReport            = makeQueueTrigger('/bettingMarket/marketReports/{id}', '새 마켓 신고 (배팅시장)');
const notifyNicknameReport          = makeQueueTrigger('/bettingMarket/nicknameReports/{id}', '새 닉네임 신고 (배팅시장)');
const notifyBettingVerifyRequest    = makeQueueTrigger('/bettingMarket/verifyRequests/{id}', '새 인증 신청 (배팅시장)');
const notifyStockVerifyRequest      = makeQueueTrigger('/streamerVerificationRequests/{id}', '새 인증 신청 (주식시장)');
const notifyChestPurchaseRequest    = makeQueueTrigger('/bettingMarket/chestPurchaseRequests/{id}', '새 보물상자 구매 신청 (배팅시장)');
const notifyBannerRequest           = makeQueueTrigger('/bannerRequests/{id}', '새 배너 신청 (주식시장)');
const notifyChartBannerRequest      = makeQueueTrigger('/chartBannerRequests/{id}', '새 차트 배너 신청 (주식시장)');
const notifyPinRequest              = makeQueueTrigger('/pinRequests/{id}', '새 고정노출 신청 (주식시장)');
const notifyRelayRoomRequest        = makeQueueTrigger('/relayRoomRequests/{id}', '새 중계방 신청 (주식시장)');
const notifyTreasureChestRequest    = makeQueueTrigger('/treasureChestRequests/{id}', '새 보물상자 구매 신청 (주식시장)');
const notifyCashChargeRequest       = makeQueueTrigger('/cashChargeRequests/{id}', '새 자산 충전 신청 (주식시장)');
const notifyUnfreezeDonationRequest = makeQueueTrigger('/unfreezeDonationRequests/{id}', '새 동결 해제(후원) 신청 (주식시장)');
const notifyListingRequest          = makeQueueTrigger('/listingRequests/{id}', '새 종목 상장 신청 (주식시장)');
// cardBannerRequests(soop-stock-market)는 관리자 승인 단계 없이 즉시 적용되는
// 흐름이라(14번에서 이미 확인) 검수 알림 대상이 아니다 — 의도적으로 제외.

module.exports = {
  getAdminCenterState,
  setAdminCenterPermission,
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
  notifyPinRequest,
  notifyRelayRoomRequest,
  notifyTreasureChestRequest,
  notifyCashChargeRequest,
  notifyUnfreezeDonationRequest,
  notifyListingRequest,
};
