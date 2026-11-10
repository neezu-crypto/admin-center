'use strict';

// 주식시장(soop-stock-market) 백그라운드 스케줄 작업의 켜기/끄기 상태.
// 실제로 작업을 건너뛰는 쪽은 soop-stock-market의 스케줄 함수이며, 각 함수가 실행될 때마다
// stockMarket/adminSchedulerControl/{job}/enabled 하나를 읽고 false면 바로 끝낸다(없으면 켜짐).
// 이 모듈은 통합 관리 센터에서 그 플래그를 읽고 쓰는 유일한 경로이며 시장 전용 DB만 다룬다.

const ROOT = 'stockMarket/adminSchedulerControl';
const STOCK_DELIST_JOB = 'checkFrozenStockDelistings';
const CREW_SYNC_JOB = 'syncCrewRosterFromSheet';
// 점검 안내 화면 플래그. 주식시장 페이지의 maintenance-admin-gate.js가 공개 읽기로 가져간다.
// active가 명시적으로 false일 때만 서비스가 열리고, 값이 없으면 일시정지로 본다.
const PAUSE_PATH = 'servicePause';

const STOCK_MARKET_SCHEDULER_JOBS = {
  [STOCK_DELIST_JOB]: {
    label: '동결 종목 상장폐지 검사',
    schedule: '10분마다',
    description: '동결 유예시간이 지난 종목을 상장폐지합니다. 이용이 일시중지된 동안에는 유저가 동결을 해제할 수 없으므로 꺼 두는 것을 권장합니다.',
    offNote: '꺼 두는 동안은 상장폐지가 집행되지 않습니다. 다시 켜면 동결 중인 종목의 마감시간이 중지된 시간만큼 뒤로 미뤄집니다.',
  },
  [CREW_SYNC_JOB]: {
    label: '크루 시트 자동 동기화',
    schedule: '15분마다',
    description: '크루 시트를 확인해 종목 크루 프리픽스를 반영합니다. 주식시장 관리자 페이지의 자동 동기화 설정이 꺼져 있으면 아무 작업 없이 끝나지만 실행은 계속됩니다.',
    offNote: '꺼 두는 동안은 시트를 확인하지 않습니다. 수동 미리보기·적용은 그대로 쓸 수 있습니다.',
  },
};

class SchedulerControlError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function jobRef(marketDb, jobId) {
  return marketDb.ref(`${ROOT}/${jobId}`);
}

async function getServicePause(marketDb) {
  const value = (await marketDb.ref(PAUSE_PATH).get()).val();
  return {
    active: !(value && value.active === false),
    configured: !!value && typeof value.active === 'boolean',
    updatedAt: (value && value.updatedAt) || null,
  };
}

async function getStockMarketSchedulerControl(marketDb) {
  const servicePause = await getServicePause(marketDb);
  const stored = (await marketDb.ref(ROOT).get()).val() || {};
  const jobs = Object.entries(STOCK_MARKET_SCHEDULER_JOBS).map(([id, meta]) => {
    const state = stored[id] || {};
    const enabled = state.enabled !== false;
    return {
      id,
      label: meta.label,
      schedule: meta.schedule,
      description: meta.description,
      offNote: meta.offNote,
      enabled,
      updatedAt: state.updatedAt || null,
      disabledAt: enabled ? null : (state.disabledAt || null),
      lastRunAt: state.lastRunAt || null,
      lastDelistedCount: id === STOCK_DELIST_JOB && Number.isFinite(state.lastDelistedCount) ? state.lastDelistedCount : null,
      lastShiftedCount: id === STOCK_DELIST_JOB && Number.isFinite(state.lastShiftedCount) ? state.lastShiftedCount : null,
    };
  });
  return { ok: true, servicePause, jobs };
}

// 다시 켤 때 중지된 시간만큼 동결 마감시간을 뒤로 민다. 중지 도중 동결된 종목은 동결 시점부터
// 지난 시간만큼만 민다(결과적으로 켠 시점부터 처음 유예시간이 다시 주어진다).
async function shiftFrozenDeadlines(marketDb, disabledAt, now) {
  const stocks = (await marketDb.ref('stocks').get()).val() || {};
  const updates = {};
  let count = 0;
  for (const [stockId, stock] of Object.entries(stocks)) {
    if (!stock || !stock.frozenAt || !Number.isFinite(Number(stock.freezeDeadline))) continue;
    const pausedFrom = Math.max(Number(disabledAt) || now, Number(stock.frozenAt) || 0);
    const shift = Math.max(0, now - pausedFrom);
    if (!shift) continue;
    updates[`stocks/${stockId}/freezeDeadline`] = Number(stock.freezeDeadline) + shift;
    count += 1;
  }
  if (count) await marketDb.ref().update(updates);
  return count;
}

async function setStockMarketSchedulerControl(marketDb, { job, enabled } = {}, { now = Date.now() } = {}) {
  const jobId = String(job || '');
  if (!Object.prototype.hasOwnProperty.call(STOCK_MARKET_SCHEDULER_JOBS, jobId)) {
    throw new SchedulerControlError('invalid-argument', '알 수 없는 작업입니다.');
  }
  if (typeof enabled !== 'boolean') {
    throw new SchedulerControlError('invalid-argument', '켜기/끄기 값은 true/false여야 합니다.');
  }
  const ref = jobRef(marketDb, jobId);
  const state = (await ref.get()).val() || {};
  const wasEnabled = state.enabled !== false;
  if (wasEnabled === enabled) return { ok: true, job: jobId, enabled, changed: false, shiftedCount: 0 };

  if (!enabled) {
    await ref.update({ enabled: false, disabledAt: now, updatedAt: now });
    return { ok: true, job: jobId, enabled: false, changed: true, shiftedCount: 0 };
  }

  // 켜기: 마감시간을 먼저 밀고 나서 플래그를 켠다. 순서가 반대면 켜진 직후 첫 실행이 밀기 전의
  // 마감시간으로 상장폐지를 집행할 수 있다.
  let shiftedCount = 0;
  if (jobId === STOCK_DELIST_JOB) shiftedCount = await shiftFrozenDeadlines(marketDb, state.disabledAt, now);
  const update = { enabled: true, disabledAt: null, updatedAt: now };
  if (jobId === STOCK_DELIST_JOB) update.lastShiftedCount = shiftedCount;
  await ref.update(update);
  return { ok: true, job: jobId, enabled: true, changed: true, shiftedCount };
}

// 서비스 일시정지 시작/재개. 안내 화면과 두 백그라운드 작업을 한 번에 바꾼다.
// 시작: 안내 화면을 먼저 켜고 작업을 끈다. 재개: 작업을 먼저 켜고(동결 마감 연장 포함) 안내 화면을 끈다.
// 이미 같은 상태여도 모든 항목에 다시 적용해, 일부만 어긋난 상태(예: 안내 화면은 켜져 있는데 작업은 실행 중)를 맞춘다.
async function setStockMarketServicePause(marketDb, { paused } = {}, { now = Date.now() } = {}) {
  if (typeof paused !== 'boolean') {
    throw new SchedulerControlError('invalid-argument', 'paused 값은 true/false여야 합니다.');
  }
  const jobIds = Object.keys(STOCK_MARKET_SCHEDULER_JOBS);
  const results = [];
  if (paused) {
    await marketDb.ref(PAUSE_PATH).update({ active: true, updatedAt: now });
    for (const job of jobIds) results.push(await setStockMarketSchedulerControl(marketDb, { job, enabled: false }, { now }));
  } else {
    for (const job of jobIds) results.push(await setStockMarketSchedulerControl(marketDb, { job, enabled: true }, { now }));
    await marketDb.ref(PAUSE_PATH).update({ active: false, updatedAt: now });
  }
  const shiftedCount = results.reduce((sum, item) => sum + (item.shiftedCount || 0), 0);
  return { ok: true, paused, shiftedCount, changedJobs: results.filter((item) => item.changed).map((item) => item.job) };
}

module.exports = {
  PAUSE_PATH, getServicePause, setStockMarketServicePause,
  ROOT, STOCK_DELIST_JOB, CREW_SYNC_JOB, STOCK_MARKET_SCHEDULER_JOBS, SchedulerControlError,
  getStockMarketSchedulerControl, setStockMarketSchedulerControl, shiftFrozenDeadlines,
};
