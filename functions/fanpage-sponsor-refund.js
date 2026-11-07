'use strict';

// 원래 노출 기간의 남은 시간만 보상한다. 금액은 올림하되 원 결제액을 넘지 않는다.
function calculateUnusedCashRefund({ startsAt, expiresAt, endedAt, cashCost }) {
  if (![startsAt, expiresAt, endedAt, cashCost].every(Number.isSafeInteger)
    || startsAt < 0 || endedAt < 0 || expiresAt <= startsAt || cashCost < 0) {
    throw new RangeError('홍보 기간 또는 결제액이 올바르지 않습니다.');
  }
  const duration = BigInt(expiresAt - startsAt);
  const remaining = BigInt(Math.max(0, expiresAt - Math.max(startsAt, endedAt)));
  const amount = BigInt(cashCost);
  return Number((amount * remaining + duration - 1n) / duration);
}

function applyUnusedCashRefund(account, { requestId, cashCost, refundAmount, now, reason }) {
  if (!account || !Number.isSafeInteger(account.balanceCash) || account.balanceCash < 0
    || !Number.isSafeInteger(refundAmount) || refundAmount < 0 || refundAmount > cashCost) return;
  const purchases = account.fanPageViewerSponsorPurchases || {};
  const purchase = purchases[requestId];
  if (!purchase || purchase.product !== 'viewerSponsorPromotion' || purchase.cashAmount !== cashCost) return;
  if (purchase.adminRefund) return purchase.adminRefund.amount === refundAmount ? account : undefined;
  if (purchase.status !== 'charged' || !Number.isSafeInteger(account.balanceCash + refundAmount)) return;
  return { ...account, balanceCash: account.balanceCash + refundAmount,
    fanPageViewerSponsorPurchases: { ...purchases, [requestId]: { ...purchase,
      adminRefund: { amount: refundAmount, processedAt: now, reason } } } };
}

function applyFailedFullRefund(account, { requestId, cashCost, now, reason }) {
  if (!account || !Number.isSafeInteger(account.balanceCash) || account.balanceCash < 0 || !Number.isSafeInteger(cashCost) || cashCost <= 0) return;
  const purchases = account.fanPageViewerSponsorPurchases || {};
  const purchase = purchases[requestId];
  if (!purchase || purchase.product !== 'viewerSponsorPromotion' || purchase.cashAmount !== cashCost || purchase.adminRefund) return;
  if (purchase.status === 'refunded') return account;
  if (purchase.status !== 'charged' || !Number.isSafeInteger(account.balanceCash + cashCost)) return;
  return { ...account, balanceCash: account.balanceCash + cashCost,
    fanPageViewerSponsorPurchases: { ...purchases, [requestId]: { ...purchase, status: 'refunded', refundedAt: now, refundReason: reason } } };
}

module.exports = { calculateUnusedCashRefund, applyUnusedCashRefund, applyFailedFullRefund };
