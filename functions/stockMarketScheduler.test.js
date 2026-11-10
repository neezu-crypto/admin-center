const test = require('node:test');
const assert = require('node:assert/strict');
const scheduler = require('./stockMarketScheduler');

function makeDb(seed = {}) {
  const data = structuredClone(seed);
  const parts = (path) => path.split('/').filter(Boolean);
  const valueAt = (path) => parts(path).reduce((value, key) => value?.[key] ?? null, data);
  const writeAt = (path, value) => {
    const keys = parts(path);
    let parent = data;
    for (const key of keys.slice(0, -1)) parent = parent[key] ||= {};
    if (value === null) delete parent[keys.at(-1)];
    else parent[keys.at(-1)] = structuredClone(value);
  };
  const ref = (path = '') => ({
    get: async () => ({ val: () => { const v = valueAt(path); return v == null ? null : structuredClone(v); } }),
    update: async (value) => {
      for (const [key, item] of Object.entries(value)) writeAt([path, key].filter(Boolean).join('/'), item);
    },
  });
  return { ref, data };
}

const HOUR = 3600 * 1000;
const { STOCK_DELIST_JOB, CREW_SYNC_JOB } = scheduler;
const state = (db, job) => db.data.stockMarket.adminSchedulerControl[job];

test('both jobs are listed as running when no flag exists', async () => {
  const status = await scheduler.getStockMarketSchedulerControl(makeDb());
  assert.deepEqual(status.jobs.map((job) => job.id), [STOCK_DELIST_JOB, CREW_SYNC_JOB]);
  assert.ok(status.jobs.every((job) => job.enabled === true && job.label && job.schedule && job.offNote));
});

test('only an explicit false marks a job as stopped', async () => {
  const db = makeDb({ stockMarket: { adminSchedulerControl: { [CREW_SYNC_JOB]: { enabled: false, disabledAt: 7, lastRunAt: 3 } } } });
  const status = await scheduler.getStockMarketSchedulerControl(db);
  const crew = status.jobs.find((job) => job.id === CREW_SYNC_JOB);
  assert.equal(crew.enabled, false);
  assert.equal(crew.disabledAt, 7);
  assert.equal(crew.lastRunAt, 3);
  assert.equal(status.jobs.find((job) => job.id === STOCK_DELIST_JOB).enabled, true);
});

test('turning a job off records when and repeating the request changes nothing', async () => {
  const db = makeDb();
  const off = await scheduler.setStockMarketSchedulerControl(db, { job: CREW_SYNC_JOB, enabled: false }, { now: 1000 });
  assert.deepEqual(off, { ok: true, job: CREW_SYNC_JOB, enabled: false, changed: true, shiftedCount: 0 });
  assert.equal(state(db, CREW_SYNC_JOB).disabledAt, 1000);
  const again = await scheduler.setStockMarketSchedulerControl(db, { job: CREW_SYNC_JOB, enabled: false }, { now: 5000 });
  assert.equal(again.changed, false);
  assert.equal(state(db, CREW_SYNC_JOB).disabledAt, 1000);
});

test('turning delisting back on pushes frozen deadlines by the paused time before enabling', async () => {
  const t0 = 100 * HOUR;
  const db = makeDb({
    stocks: {
      beforePause: { frozenAt: t0 - 2 * HOUR, freezeDeadline: t0 + 10 * HOUR },
      duringPause: { frozenAt: t0 + 5 * HOUR, freezeDeadline: t0 + 17 * HOUR },
      notFrozen: { price: 1000 },
    },
  });
  await scheduler.setStockMarketSchedulerControl(db, { job: STOCK_DELIST_JOB, enabled: false }, { now: t0 });
  const now = t0 + 24 * HOUR;
  const on = await scheduler.setStockMarketSchedulerControl(db, { job: STOCK_DELIST_JOB, enabled: true }, { now });
  assert.equal(on.shiftedCount, 2);
  assert.equal(db.data.stocks.beforePause.freezeDeadline, t0 + 10 * HOUR + 24 * HOUR);
  // 중지 도중 동결된 종목은 켠 시점부터 처음 유예시간(12시간)이 다시 시작된다.
  assert.equal(db.data.stocks.duringPause.freezeDeadline, now + 12 * HOUR);
  assert.equal(db.data.stocks.notFrozen.freezeDeadline, undefined);
  const saved = state(db, STOCK_DELIST_JOB);
  assert.equal(saved.enabled, true);
  assert.equal(saved.disabledAt, undefined);
  assert.equal(saved.lastShiftedCount, 2);
});

test('turning crew sync back on never touches stock deadlines', async () => {
  const db = makeDb({ stocks: { s: { frozenAt: 1, freezeDeadline: 5 * HOUR } } });
  await scheduler.setStockMarketSchedulerControl(db, { job: CREW_SYNC_JOB, enabled: false }, { now: 10 * HOUR });
  const on = await scheduler.setStockMarketSchedulerControl(db, { job: CREW_SYNC_JOB, enabled: true }, { now: 30 * HOUR });
  assert.equal(on.shiftedCount, 0);
  assert.equal(db.data.stocks.s.freezeDeadline, 5 * HOUR);
});

test('enabling an already-enabled job never moves deadlines', async () => {
  const db = makeDb({ stocks: { s: { frozenAt: 1, freezeDeadline: 2 * HOUR } } });
  const result = await scheduler.setStockMarketSchedulerControl(db, { job: STOCK_DELIST_JOB, enabled: true }, { now: 50 * HOUR });
  assert.equal(result.changed, false);
  assert.equal(db.data.stocks.s.freezeDeadline, 2 * HOUR);
});

test('unknown jobs and non-boolean values are rejected', async () => {
  const db = makeDb();
  await assert.rejects(scheduler.setStockMarketSchedulerControl(db, { job: 'other', enabled: true }), (error) => error.code === 'invalid-argument');
  await assert.rejects(scheduler.setStockMarketSchedulerControl(db, { job: CREW_SYNC_JOB, enabled: 'yes' }), (error) => error.code === 'invalid-argument');
});

test('service pause defaults to paused until the flag is explicitly turned off', async () => {
  assert.deepEqual(await scheduler.getServicePause(makeDb()), { active: true, configured: false, updatedAt: null });
  const open = makeDb({ servicePause: { active: false, updatedAt: 9 } });
  assert.deepEqual(await scheduler.getServicePause(open), { active: false, configured: true, updatedAt: 9 });
  const status = await scheduler.getStockMarketSchedulerControl(open);
  assert.equal(status.servicePause.active, false);
});

test('starting a pause turns the notice on and stops both jobs, even when partly applied', async () => {
  const db = makeDb({ stockMarket: { adminSchedulerControl: { [CREW_SYNC_JOB]: { enabled: false, disabledAt: 1 } } } });
  const result = await scheduler.setStockMarketServicePause(db, { paused: true }, { now: 5000 });
  assert.equal(result.paused, true);
  assert.deepEqual(result.changedJobs, [STOCK_DELIST_JOB]);
  assert.deepEqual(db.data.servicePause, { active: true, updatedAt: 5000 });
  assert.equal(state(db, STOCK_DELIST_JOB).enabled, false);
  assert.equal(state(db, CREW_SYNC_JOB).disabledAt, 1);
});

test('resuming restarts the jobs, extends frozen deadlines, then opens the service', async () => {
  const t0 = 100 * HOUR;
  const db = makeDb({ stocks: { s: { frozenAt: t0 - HOUR, freezeDeadline: t0 + 11 * HOUR } } });
  await scheduler.setStockMarketServicePause(db, { paused: true }, { now: t0 });
  const result = await scheduler.setStockMarketServicePause(db, { paused: false }, { now: t0 + 6 * HOUR });
  assert.equal(result.paused, false);
  assert.equal(result.shiftedCount, 1);
  assert.equal(db.data.stocks.s.freezeDeadline, t0 + 17 * HOUR);
  assert.deepEqual(db.data.servicePause, { active: false, updatedAt: t0 + 6 * HOUR });
  assert.equal(state(db, STOCK_DELIST_JOB).enabled, true);
  assert.equal(state(db, CREW_SYNC_JOB).enabled, true);
});

test('service pause rejects non-boolean values', async () => {
  await assert.rejects(scheduler.setStockMarketServicePause(makeDb(), { paused: 'yes' }), (error) => error.code === 'invalid-argument');
});
