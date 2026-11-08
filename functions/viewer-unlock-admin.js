'use strict';

const { createHash, randomUUID } = require('node:crypto');

const FEATURE_PRICES = Object.freeze({ period: 40, same_day: 40, keyword: 40 });

function isRequestId(value) {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value || '');
}

function productFor(featureId) {
  return Object.prototype.hasOwnProperty.call(FEATURE_PRICES, featureId)
    ? { featureId, priceCash: FEATURE_PRICES[featureId] }
    : null;
}

async function freshTransaction(ref, update) {
  let listener;
  await new Promise((resolve, reject) => { listener = () => resolve(); ref.on('value', listener, reject); });
  try { return await ref.transaction(update, undefined, false); }
  finally { ref.off('value', listener); }
}

async function acquireFeatureLock(db, uid, featureId, token, now) {
  const ref = db.ref(`viewerStatsUnlockTransfers/featureLocks/${uid}/${featureId}`);
  const result = await freshTransaction(ref, (current) => {
    if (current && current.token !== token && Number(current.leaseUntil || 0) > now) return;
    return { token, leaseUntil: now + 120000 };
  });
  if (!result.committed) throw new Error('feature-busy');
  return async () => freshTransaction(ref, (current) => current?.token === token ? null : undefined);
}

// 처리 불능(review-required) 또는 이미 환불을 시작한 결제만 되돌린다. 활성 권한은
// 회수하지 않으므로, 정상적으로 이용 가능해진 상품을 관리자가 실수로 환불할 수 없다.
async function refundUnactivatedViewerUnlock({ fanpageDb, walletDb, requestId, now = Date.now() }) {
  if (!isRequestId(requestId)) throw new Error('invalid-input');
  const opRef = fanpageDb.ref(`viewerStatsUnlockPayments/operations/${requestId}`);
  const token = randomUUID();
  const reserved = await freshTransaction(opRef, (current) => {
    if (!current || !['review-required', 'refund-pending', 'refunded'].includes(current.status)) return;
    if (current.status === 'refunded') return current;
    if (Number(current.leaseUntil || 0) > now) return;
    return { ...current, status: 'refund-pending', leaseToken: token, leaseUntil: now + 120000, updatedAt: now };
  });
  if (!reserved.committed) throw new Error('operation-unavailable');
  const operation = reserved.snapshot.val();
  if (operation.status === 'refunded') return { status: 'refunded', replay: true };
  let release;
  try {
    const product = productFor(String(operation.featureId || ''));
    const uid = String(operation.uid || '');
    const amount = Number(operation.cashAmount);
    if (!product || !uid || /[.#$\[\]/]/.test(uid) || !Number.isSafeInteger(amount) || amount !== product.priceCash) throw new Error('operation-conflict');
    const expectedOwnershipId = createHash('sha256').update(`${uid}:${product.featureId}:${requestId}`).digest('hex');
    if (operation.ownershipId !== expectedOwnershipId) throw new Error('operation-conflict');
    release = await acquireFeatureLock(fanpageDb, uid, product.featureId, token, now);
    const accountRef = walletDb.ref(`gameSeriesWallet/accounts/${uid}`);
    const account = (await accountRef.get()).val() || {};
    const purchase = account.viewerStatsUnlockPurchases?.[requestId];
    if (!purchase || purchase.featureId !== product.featureId || Number(purchase.cashAmount) !== amount || !['charged', 'refunded'].includes(purchase.status)) throw new Error('wallet-conflict');
    const ownerRef = fanpageDb.ref(`viewerStatsUnlockTransfers/ownership/${expectedOwnershipId}`);
    const owner = await freshTransaction(ownerRef, (current) => {
      if (!current) return null;
      if (current.ownerUid !== uid || current.featureId !== product.featureId || current.requestId !== requestId || !['pending', 'refund-cancelled'].includes(current.status)) return;
      return { ...current, status: 'refund-cancelled' };
    });
    if (!owner.committed) throw new Error('ownership-conflict');
    const indexRef = fanpageDb.ref(`viewerStatsUnlocks/${uid}/${product.featureId}`);
    const index = await freshTransaction(indexRef, (current) => !current || current.ownershipId === expectedOwnershipId ? null : current);
    if (!index.committed) throw new Error('index-conflict');
    const refunded = await freshTransaction(accountRef, (current) => {
      const selected = current?.viewerStatsUnlockPurchases?.[requestId];
      if (!selected || Number(selected.cashAmount) !== amount) return;
      if (selected.status === 'refunded') return current;
      if (selected.status !== 'charged' || current?.viewerStatsUnlockPurchaseLocks?.[product.featureId]?.requestId !== requestId) return;
      const next = { ...current, balanceCash: Math.max(0, Number(current.balanceCash) || 0) + amount };
      next.viewerStatsUnlockPurchases = { ...(current.viewerStatsUnlockPurchases || {}), [requestId]: { ...selected, status: 'refunded', refundedAt: now } };
      next.viewerStatsUnlockPurchaseLocks = { ...(current.viewerStatsUnlockPurchaseLocks || {}) };
      delete next.viewerStatsUnlockPurchaseLocks[product.featureId];
      return next;
    });
    if (!refunded.committed) throw new Error('wallet-conflict');
    const ledgerRef = walletDb.ref(`gameSeriesWallet/ledger/${uid}/${requestId}_viewerStatsUnlock_refund`);
    const ledger = await freshTransaction(ledgerRef, (current) => current
      ? current.requestId === requestId && current.type === 'viewerStatsUnlock_refund' && current.balanceDelta === amount ? current : undefined
      : { requestId, type: 'viewerStatsUnlock_refund', balanceDelta: amount, createdAt: now });
    if (!ledger.committed) throw new Error('refund-ledger-conflict');
    const done = await freshTransaction(opRef, (current) => {
      if (!current || current.leaseToken !== token || current.status !== 'refund-pending') return;
      return { ...current, status: 'refunded', refundedAt: now, updatedAt: now };
    });
    if (!done.committed) throw new Error('operation-conflict');
    return { status: 'refunded', replay: false, uid, featureId: product.featureId, cashAmount: amount };
  } finally {
    try { if (release) await release(); }
    finally { await freshTransaction(opRef, (current) => {
      if (!current || current.leaseToken !== token) return;
      const next = { ...current }; delete next.leaseToken; delete next.leaseUntil; return next;
    }); }
  }
}

function buildUnlockPaymentPage(records, limit = 100) {
  const items = Object.entries(records || {})
    .filter(([requestId, item]) => isRequestId(requestId) && item && typeof item === 'object')
    .map(([requestId, item]) => ({ requestId, uid: String(item.uid || ''), featureId: String(item.featureId || ''), status: String(item.status || ''), cashAmount: Number(item.cashAmount) || 0, createdAt: Number(item.createdAt) || 0, updatedAt: Number(item.updatedAt) || 0, failureCode: String(item.lastFailureCode || item.failureCode || ''), refundReason: String(item.refundReason || '') }))
    .sort((a, b) => b.createdAt - a.createdAt || b.requestId.localeCompare(a.requestId));
  return { items: items.slice(0, Math.max(1, Math.min(100, Number(limit) || 100))) };
}

function filterUnlockPaymentRecords(records, { query = '', status = '' } = {}) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const normalizedStatus = String(status || '').trim();
  return Object.fromEntries(Object.entries(records || {}).filter(([requestId, item]) => {
    if (!item || typeof item !== 'object') return false;
    if (normalizedStatus && String(item.status || '') !== normalizedStatus) return false;
    if (!normalizedQuery) return true;
    return String(requestId).toLowerCase().includes(normalizedQuery)
      || String(item.uid || '').toLowerCase().includes(normalizedQuery);
  }));
}

module.exports = { isRequestId, refundUnactivatedViewerUnlock, buildUnlockPaymentPage, filterUnlockPaymentRecords };
