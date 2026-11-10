'use strict';

// 스트리머 시리즈 서비스별 일시정지 플래그(주식시장 제외 — 주식시장은 stockMarketScheduler가 전용 DB에 따로 둔다).
// 저장 위치는 공유 기본 RTDB의 servicePause/{serviceId} = { active, updatedAt }이고, 각 서비스의
// maintenance-admin-gate.js가 로그인 전에도 읽을 수 있게 규칙이 공개 읽기·쓰기 금지로 열려 있다.
// 값이 없을 때의 상태(defaultPaused)는 각 서비스 게이트에 박힌 기본값과 같아야 한다.

const ROOT = 'servicePause';

// 게이트가 이미 붙어 있던 서비스는 기본 일시정지(true), 처음부터 열려 있던 서비스는 기본 운영(false).
const SERVICE_PAUSE_TARGETS = [
  { id: 'bettingMarket', name: '스트리머 배팅시장', defaultPaused: true },
  { id: 'backgroundMarket', name: '스트리머 배경시장', defaultPaused: true },
  { id: 'lifeGame', name: '스트리머 인생게임', defaultPaused: true },
  { id: 'gallery', name: '스트리머 갤러리', defaultPaused: true },
  { id: 'streamerMessenger', name: '스트리머 메신저', defaultPaused: true },
  { id: 'streamerJurumable', name: '스트리머 주루마블', defaultPaused: false },
  { id: 'dontPressButton', name: '한국인은 절대 못 깨는 게임', defaultPaused: true },
  { id: 'onyuVn', name: '당신이 여기에 온 이유', defaultPaused: true },
  { id: 'streamerFanPage', name: '스트리머 팬페이지', defaultPaused: false },
  { id: 'gameSeriesShop', name: '스트리머 게임시리즈 상점', defaultPaused: false },
];

class ServicePauseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ServicePauseError';
    this.code = code;
  }
}

function findTarget(serviceId) {
  return SERVICE_PAUSE_TARGETS.find((target) => target.id === serviceId) || null;
}

function resolveState(target, value) {
  const configured = !!value && typeof value.active === 'boolean';
  return {
    id: target.id,
    name: target.name,
    active: configured ? value.active : target.defaultPaused,
    configured,
    defaultPaused: target.defaultPaused,
    updatedAt: configured && Number.isFinite(value.updatedAt) ? value.updatedAt : null,
  };
}

async function getServicePauseOverview(db) {
  const root = (await db.ref(ROOT).get()).val() || {};
  return { ok: true, services: SERVICE_PAUSE_TARGETS.map((target) => resolveState(target, root[target.id])) };
}

async function setServicePause(db, data, { now = Date.now() } = {}) {
  const target = findTarget(data && data.serviceId);
  if (!target) throw new ServicePauseError('invalid-argument', '알 수 없는 서비스입니다.');
  if (typeof data.paused !== 'boolean') throw new ServicePauseError('invalid-argument', 'paused 값이 필요합니다.');
  const before = resolveState(target, (await db.ref(`${ROOT}/${target.id}`).get()).val());
  await db.ref(`${ROOT}/${target.id}`).update({ active: data.paused, updatedAt: now });
  return { ok: true, serviceId: target.id, name: target.name, paused: data.paused, changed: before.active !== data.paused };
}

module.exports = { ROOT, SERVICE_PAUSE_TARGETS, ServicePauseError, getServicePauseOverview, setServicePause };
