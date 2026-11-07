'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, 'index.js'), 'utf8');
const helper = source.slice(source.indexOf('async function holdFreshRealtimeSnapshot('), source.indexOf('async function writeFanPageSponsorAdminAudit('));
const start = source.indexOf('const manageFanPageSponsorAds = onCall(');
const body = source.slice(start, source.indexOf('\n});', start) + 4);
const requestId = 'test_request_123';
function harness() {
  const uid = 'user';
  const now = Date.now();
  const state = {
    [`streamerFanPageViewerSponsors/campaigns/${requestId}`]: { status: 'ended', paymentRequestId: requestId, requesterUidHash: crypto.createHash('sha256').update(uid).digest('hex'), startsAt: now - 1000, endedAt: now, expiresAt: now + 1000, cashCost: 10 },
    [`streamerFanPageViewerSponsors/paymentResults/${requestId}`]: { status: 'activated', campaignId: requestId, requesterUid: uid, cashAmount: 10 },
    [`gameSeriesWallet/accounts/${uid}`]: { balanceCash: 20, fanPageViewerSponsorPurchases: { [requestId]: { product: 'viewerSponsorPromotion', status: 'charged', cashAmount: 10 } } },
    [`gameSeriesWallet/ledger/${uid}/${requestId}_viewerSponsorPromotion`]: { requestId, type: 'viewerSponsorPromotion', balanceDelta: -10 },
  };
  const listeners = new Set();
  const snapshot = (value) => ({ val: () => value == null ? null : structuredClone(value), exists: () => value != null });
  let failRefundLedger = false;
  const db = { ref(path) { return { get: async () => snapshot(state[path]), on: (_, cb) => { listeners.add(path); cb(snapshot(state[path])); }, off: () => listeners.delete(path), transaction: async (fn) => { if (failRefundLedger && path.endsWith('_adminRefund')) { failRefundLedger = false; throw new Error('ledger unavailable'); } const next = fn(listeners.has(path) ? structuredClone(state[path]) : null); if (next === undefined) return { committed: false, snapshot: snapshot(state[path]) }; state[path] = next; return { committed: true, snapshot: snapshot(next) }; } }; } };
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const context = { onCall: (fn) => fn, requireAdmin: async () => 'admin', fanpageDatabase: () => db, getDatabase: () => db,
    validFanPageSponsorRequestId: () => true, writeFanPageSponsorAdminAudit: async () => true, HttpsError, require, Date, console };
  vm.runInNewContext(helper + '\n' + body + '\nthis.run = manageFanPageSponsorAds;', context);
  return { state, failNextLedger: () => { failRefundLedger = true; },
    call: () => context.run({ auth: { uid: 'admin' }, data: { action: 'cash-refund', campaignId: requestId, reason: '운영 장애' } }),
    retryFailed: () => context.run({ auth: { uid: 'admin' }, data: { action: 'cash-retry-failed-refund', requestId } }) };
}
test('캐시 부분 환불과 재시도는 한 번만 지급하고 원장을 남긴다', async () => {
  const h = harness();
  assert.equal((await h.call()).refundAmount, 5);
  assert.equal((await h.call()).alreadyRefunded, true);
  assert.equal(h.state['gameSeriesWallet/accounts/user'].balanceCash, 25);
  assert.equal(h.state[`gameSeriesWallet/ledger/user/${requestId}_viewerSponsorPromotion_adminRefund`].balanceDelta, 5);
});
test('지급 후 원장 장애가 나더라도 재시도는 중복 지급 없이 원장을 복구한다', async () => {
  const h = harness();
  h.failNextLedger();
  await assert.rejects(h.call(), /ledger unavailable/);
  assert.equal(h.state['gameSeriesWallet/accounts/user'].balanceCash, 25);
  assert.equal((await h.call()).alreadyRefunded, true);
  assert.equal(h.state['gameSeriesWallet/accounts/user'].balanceCash, 25);
  assert.equal(h.state[`gameSeriesWallet/ledger/user/${requestId}_viewerSponsorPromotion_adminRefund`].balanceDelta, 5);
});
test('원 차감 원장이나 구매자 연결이 맞지 않으면 지급하지 않는다', async () => {
  const h = harness();
  h.state[`gameSeriesWallet/ledger/user/${requestId}_viewerSponsorPromotion`].balanceDelta = -100;
  await assert.rejects(h.call());
  assert.equal(h.state['gameSeriesWallet/accounts/user'].balanceCash, 20);
});
test('활성화 실패 전액 환불을 복구하고 재시도해도 중복 지급하지 않는다', async () => {
  const h = harness();
  h.state[`streamerFanPageViewerSponsors/campaigns/${requestId}`] = null;
  h.state[`streamerFanPageViewerSponsors/paymentResults/${requestId}`] = { status: 'refund-pending', requesterUid: 'user', cashAmount: 10 };
  assert.equal((await h.retryFailed()).refundAmount, 10);
  assert.equal((await h.retryFailed()).alreadyRefunded, true);
  assert.equal(h.state['gameSeriesWallet/accounts/user'].balanceCash, 30);
  assert.equal(h.state[`gameSeriesWallet/ledger/user/${requestId}_viewerSponsorPromotion_refund`].balanceDelta, 10);
});
test('활성화 실패로 기록돼도 캠페인이 남아 있으면 환불하지 않는다', async () => {
  const h = harness();
  h.state[`streamerFanPageViewerSponsors/paymentResults/${requestId}`] = { status: 'refund-pending', requesterUid: 'user', cashAmount: 10 };
  await assert.rejects(h.retryFailed());
  assert.equal(h.state['gameSeriesWallet/accounts/user'].balanceCash, 20);
});
