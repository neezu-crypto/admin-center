'use strict';

// 스트리머 시리즈 서비스별 일시정지 플래그(주식시장 제외 — 주식시장은 stockMarketScheduler가 전용 DB에 따로 둔다).
// 저장 위치는 공유 기본 RTDB의 servicePause/{serviceId} = { active, updatedAt }이고, 각 서비스의
// maintenance-admin-gate.js가 로그인 전에도 읽을 수 있게 규칙이 공개 읽기·쓰기 금지로 열려 있다.
// 값이 없을 때의 상태(defaultPaused)는 각 서비스 게이트와 서버 함수에 박힌 기본값과 같아야 한다.
// stoppedJobs: 일시정지 중 실제로 건너뛰는 스케줄 함수, keptJobs: 스케줄이 아니라 예약 작업(Cloud Tasks)이라 계속 도는 함수(관리자 화면 안내용).
// 정산·결제 대사·보관 기간 삭제 함수도 일시정지 중에는 멈추며, 재개하면 다음 실행에서 밀린 대상을 처리한다.

const ROOT = 'servicePause';

// 게이트가 이미 붙어 있던 서비스는 기본 일시정지(true), 처음부터 열려 있던 서비스는 기본 운영(false).
const SERVICE_PAUSE_TARGETS = [
  { id: 'bettingMarket', name: '스트리머 배팅시장', defaultPaused: true, stoppedJobs: ['마켓 마감·정산 확정(5분마다)'], keptJobs: [] },
  { id: 'backgroundMarket', name: '스트리머 배경시장', defaultPaused: true, stoppedJobs: [], keptJobs: [] },
  { id: 'lifeGame', name: '스트리머 인생게임', defaultPaused: true, stoppedJobs: ['세계 상태 일일 기록', '좀비 자연 확산'], keptJobs: [] },
  { id: 'gallery', name: '스트리머 갤러리', defaultPaused: true, stoppedJobs: ['신고 증거 이미지 정리(10분마다)'], keptJobs: [] },
  { id: 'streamerMessenger', name: '스트리머 메신저', defaultPaused: true, stoppedJobs: ['신청 만료 처리(매시)', '만료 데이터 삭제(매일)', '사용량 집계(매일)'], keptJobs: [] },
  { id: 'streamerJurumable', name: '스트리머 주루마블', defaultPaused: false, stoppedJobs: [], keptJobs: [] },
  { id: 'dontPressButton', name: '한국인은 절대 못 깨는 게임', defaultPaused: true, stoppedJobs: ['1분 틱(참가자 정리·라운드 시작 판정)'], keptJobs: ['라운드 상태 전환 작업(예약된 작업)'] },
  { id: 'onyuVn', name: '당신이 여기에 온 이유', defaultPaused: true, stoppedJobs: ['통계 정리(매일)'], keptJobs: ['후원 만료 정리(예약된 작업)'] },
  { id: 'streamerFanPage', name: '스트리머 팬페이지', defaultPaused: false, stoppedJobs: ['영상 라이브러리 정기·주간 동기화', '후원 결제 대사(15분)', '시청 통계 해금 복구(15분)', '작업·집계 정리(매일)', '영상 동기화 중단 복구(5분)'], keptJobs: [] },
  { id: 'gameSeriesShop', name: '스트리머 게임시리즈 상점', defaultPaused: false, stoppedJobs: [], keptJobs: [] },
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
    stoppedJobs: target.stoppedJobs || [],
    keptJobs: target.keptJobs || [],
    updatedAt: configured && Number.isFinite(value.updatedAt) ? value.updatedAt : null,
  };
}

async function getServicePauseOverview(db) {
  const root = (await db.ref(ROOT).get()).val() || {};
  return { ok: true, services: SERVICE_PAUSE_TARGETS.map((target) => resolveState(target, root[target.id])) };
}

// 스케줄 함수가 일시정지 여부만 빠르게 확인할 때 쓴다. 읽지 못하면 멈추지 않는다.
async function isPaused(db, serviceId) {
  const target = findTarget(serviceId);
  if (!target) return false;
  try {
    return resolveState(target, (await db.ref(`${ROOT}/${target.id}`).get()).val()).active;
  } catch (error) {
    return false;
  }
}

async function setServicePause(db, data, { now = Date.now() } = {}) {
  const target = findTarget(data && data.serviceId);
  if (!target) throw new ServicePauseError('invalid-argument', '알 수 없는 서비스입니다.');
  if (typeof data.paused !== 'boolean') throw new ServicePauseError('invalid-argument', 'paused 값이 필요합니다.');
  const before = resolveState(target, (await db.ref(`${ROOT}/${target.id}`).get()).val());
  await db.ref(`${ROOT}/${target.id}`).update({ active: data.paused, updatedAt: now });
  return { ok: true, serviceId: target.id, name: target.name, paused: data.paused, changed: before.active !== data.paused };
}

module.exports = { ROOT, SERVICE_PAUSE_TARGETS, ServicePauseError, getServicePauseOverview, setServicePause, isPaused };
