const test = require('node:test');
const assert = require('node:assert/strict');
const pause = require('./servicePause');

function makeDb(seed = {}) {
  const data = structuredClone(seed);
  const parts = (path) => path.split('/').filter(Boolean);
  const valueAt = (path) => parts(path).reduce((value, key) => value?.[key] ?? null, data);
  const ref = (path = '') => ({
    get: async () => ({ val: () => { const v = valueAt(path); return v == null ? null : structuredClone(v); } }),
    update: async (value) => {
      const keys = parts(path);
      let parent = data;
      for (const key of keys) parent = parent[key] ||= {};
      Object.assign(parent, structuredClone(value));
    },
  });
  return { ref, data };
}

test('unconfigured services follow their default state', async () => {
  const { services } = await pause.getServicePauseOverview(makeDb());
  const byId = Object.fromEntries(services.map((s) => [s.id, s]));
  assert.equal(byId.bettingMarket.active, true);
  assert.equal(byId.bettingMarket.configured, false);
  assert.equal(byId.streamerFanPage.active, false);
  assert.equal(byId.gameSeriesShop.active, false);
  assert.equal(services.length, 10);
});

test('setting a flag overrides the default and reports a change', async () => {
  const db = makeDb();
  const result = await pause.setServicePause(db, { serviceId: 'bettingMarket', paused: false }, { now: 123 });
  assert.deepEqual([result.paused, result.changed], [false, true]);
  assert.deepEqual(db.data.servicePause.bettingMarket, { active: false, updatedAt: 123 });
  const again = await pause.setServicePause(db, { serviceId: 'bettingMarket', paused: false }, { now: 456 });
  assert.equal(again.changed, false);
  const { services } = await pause.getServicePauseOverview(db);
  assert.equal(services.find((s) => s.id === 'bettingMarket').active, false);
});

test('pausing an open-by-default service is a change', async () => {
  const db = makeDb();
  const result = await pause.setServicePause(db, { serviceId: 'streamerFanPage', paused: true });
  assert.equal(result.changed, true);
  assert.equal(db.data.servicePause.streamerFanPage.active, true);
});

test('rejects unknown services, stock market and non-boolean values', async () => {
  const db = makeDb();
  await assert.rejects(pause.setServicePause(db, { serviceId: 'nope', paused: true }), pause.ServicePauseError);
  await assert.rejects(pause.setServicePause(db, { serviceId: 'stockMarket', paused: true }), pause.ServicePauseError);
  await assert.rejects(pause.setServicePause(db, { serviceId: 'lifeGame', paused: 'yes' }), pause.ServicePauseError);
  assert.equal(db.data.servicePause, undefined);
});

test('malformed stored values fall back to the default', async () => {
  const { services } = await pause.getServicePauseOverview(makeDb({ servicePause: { lifeGame: { active: 'no' }, gallery: 5 } }));
  assert.equal(services.find((s) => s.id === 'lifeGame').active, true);
  assert.equal(services.find((s) => s.id === 'gallery').configured, false);
});
