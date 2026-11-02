'use strict';

const crypto = require('node:crypto');

function onyuDonationCleanupFailureId(data) {
  return crypto.createHash('sha256')
    .update([data.kind, data.key, Number(data.expiresAt) || 0, Number(data.soopConsentAt) || 0].join('|'))
    .digest('hex');
}

function mergeOnyuDonationCleanupFailure(current, data, error, now = Date.now()) {
  return Object.assign({}, current || {}, {
    failureId: onyuDonationCleanupFailureId(data),
    kind: String(data.kind || ''),
    key: String(data.key || ''),
    expiresAt: Number(data.expiresAt) || 0,
    soopConsentAt: Number(data.soopConsentAt) || null,
    keepRevokedRecord: data.keepRevokedRecord === true,
    status: 'open',
    attempts: (Number(current && current.attempts) || 0) + 1,
    firstFailedAt: Number(current && current.firstFailedAt) || Number(now),
    lastFailedAt: Number(now),
    lastErrorCode: String(error && error.code || error && error.name || 'cleanup-failed').slice(0, 80),
    updatedAt: Number(now),
  });
}

module.exports = { onyuDonationCleanupFailureId, mergeOnyuDonationCleanupFailure };
