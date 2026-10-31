const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, 'index.js'), 'utf8');
const helper = source.slice(source.indexOf('async function holdFreshRealtimeSnapshot('), source.indexOf('async function writeFanPageSponsorAdminAudit('));
const start = source.indexOf('const manageFanPageSponsorAds = onCall(');
const callable = source.slice(start, source.indexOf('\n});', start) + 4);
const id = 'test_request_123';
const paths = { ad: 'streamerFanPageSponsorAds/' + id, request: 'streamerFanPageSponsorRequests/' + id, claim: 'streamerFanPageSponsorPlacementClaims/' + id };
function makeHarness(missingClaim = false) {
  const now = Date.now();
  const state = { [paths.ad]: { status: 'active', soopId: 'abc123', nickname: 'test', requestId: id, startsAt: now, expiresAt: now + 86400000 }, [paths.request]: { status: 'approved' }, [paths.claim]: missingClaim ? null : { status: 'active', campaignId: id, soopId: 'abc123', expiresAt: now + 86400000 } };
  const listeners = new Set();
  const snapshot = v => ({ val: () => v == null ? null : structuredClone(v), exists: () => v != null });
  const db = { ref(path) { return { get: async () => snapshot(state[path]), on: (_, cb) => { listeners.add(path); cb(snapshot(state[path])); }, off: () => listeners.delete(path), transaction: async fn => { const next = fn(listeners.has(path) ? structuredClone(state[path]) : null); if (next === undefined) return { committed: false, snapshot: snapshot(state[path]) }; state[path] = next; return { committed: true, snapshot: snapshot(next) }; }, update: async value => { state[path] = { ...state[path], ...value }; } }; } };
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const context = { onCall: f => f, requireAdmin: async () => 'admin', fanpageDatabase: () => db, getDatabase: () => ({}), FANPAGE_SPONSOR_ADS_PATH: 'streamerFanPageSponsorAds', FANPAGE_SPONSOR_REQUESTS_PATH: 'streamerFanPageSponsorRequests', FANPAGE_SPONSOR_CLAIMS_PATH: 'streamerFanPageSponsorPlacementClaims', FANPAGE_SPONSOR_MAX_CAMPAIGN_MS: 30 * 86400000, validFanPageSponsorRequestId: () => true, normalizeSoopId: v => String(v || '').toLowerCase(), writeFanPageSponsorAdminAudit: async () => true, HttpsError, Date, console, require };
  vm.runInNewContext(helper + '\n' + callable + '\nthis.run = manageFanPageSponsorAds;', context);
  return { state, listeners, call: data => context.run({ data: { campaignId: id, ...data }, auth: { uid: 'admin', token: {} } }) };
}
(async () => {
  let h = makeHarness();
  assert.equal((await h.call({ action: 'end' })).ok, true);
  assert.equal(h.state[paths.ad].status, 'ended');
  assert.equal(h.state[paths.claim], null);
  assert.equal(h.listeners.size, 0);
  h = makeHarness();
  assert.equal((await h.call({ action: 'update', nickname: 'new name', extendDays: 1 })).ok, true);
  assert.equal(h.state[paths.ad].nickname, 'new name');
  assert.equal(h.state[paths.ad].expiresAt, h.state[paths.claim].expiresAt);
  assert.equal(h.listeners.size, 0);
  h = makeHarness(true);
  await assert.rejects(h.call({ action: 'update', nickname: 'new name', extendDays: 0 }));
  assert.equal(h.state[paths.ad].nickname, 'test');
  assert.equal(h.listeners.size, 0);
  console.log('cold-cache end, update and missing-claim cleanup passed');
})().catch(error => { console.error(error); process.exit(1); });
