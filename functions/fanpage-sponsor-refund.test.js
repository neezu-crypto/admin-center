'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateUnusedCashRefund, applyUnusedCashRefund, applyFailedFullRefund } = require('./fanpage-sponsor-refund');

test('중단 시점에 남은 노출 시간에 비례하고 소수점은 이용자에게 유리하게 올림한다', () => {
  assert.equal(calculateUnusedCashRefund({ startsAt: 100, expiresAt: 400, endedAt: 250, cashCost: 10 }), 5);
  assert.equal(calculateUnusedCashRefund({ startsAt: 100, expiresAt: 400, endedAt: 399, cashCost: 10 }), 1);
});

test('같은 결제의 부분 환불은 한 번만 지급하고 다른 금액과 전액 환불 건은 거부한다', () => {
  const account = { balanceCash: 5, fanPageViewerSponsorPurchases: { req: { product: 'viewerSponsorPromotion', status: 'charged', cashAmount: 10 } } };
  const request = { requestId: 'req', cashCost: 10, refundAmount: 4, now: 123, reason: '운영 중단' };
  const first = applyUnusedCashRefund(account, request);
  assert.equal(first.balanceCash, 9);
  assert.equal(applyUnusedCashRefund(first, request).balanceCash, 9);
  assert.equal(applyUnusedCashRefund(first, { ...request, refundAmount: 5 }), undefined);
  assert.equal(applyUnusedCashRefund({ ...account, fanPageViewerSponsorPurchases: { req: { ...account.fanPageViewerSponsorPurchases.req, status: 'refunded' } } }, request), undefined);
});

test('홍보 시작 전 또는 종료 이후에도 원액과 0 사이로 제한한다', () => {
  assert.equal(calculateUnusedCashRefund({ startsAt: 100, expiresAt: 400, endedAt: 1, cashCost: 10 }), 10);
  assert.equal(calculateUnusedCashRefund({ startsAt: 100, expiresAt: 400, endedAt: 500, cashCost: 10 }), 0);
});

test('오염된 기간이나 결제액은 거부한다', () => {
  for (const input of [
    { startsAt: 100, expiresAt: 100, endedAt: 100, cashCost: 10 },
    { startsAt: 100, expiresAt: 400, endedAt: 200, cashCost: -1 },
    { startsAt: 100, expiresAt: 400, endedAt: 200, cashCost: 1.5 },
  ]) assert.throws(() => calculateUnusedCashRefund(input), RangeError);
});

test('활성화 실패 전액 환불은 재시도해도 한 번만 지급하고 부분 환불과 혼합하지 않는다', () => {
  const account = { balanceCash: 5, fanPageViewerSponsorPurchases: { req: { product: 'viewerSponsorPromotion', status: 'charged', cashAmount: 10 } } };
  const request = { requestId: 'req', cashCost: 10, now: 123, reason: '활성화 실패' };
  const first = applyFailedFullRefund(account, request);
  assert.equal(first.balanceCash, 15);
  assert.equal(applyFailedFullRefund(first, request).balanceCash, 15);
  const partial = applyUnusedCashRefund(account, { ...request, refundAmount: 4 });
  assert.equal(applyFailedFullRefund(partial, request), undefined);
});
