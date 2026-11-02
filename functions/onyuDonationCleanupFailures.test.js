'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  onyuDonationCleanupFailureId,
  mergeOnyuDonationCleanupFailure,
} = require('./onyuDonationCleanupFailures');

test('cleanup failure IDs are stable but change when the expiry identity changes', () => {
  const task = { kind: 'session', key: 'session_123456789', expiresAt: 1234567890 };
  assert.equal(onyuDonationCleanupFailureId(task), onyuDonationCleanupFailureId(Object.assign({}, task)));
  assert.notEqual(onyuDonationCleanupFailureId(task), onyuDonationCleanupFailureId(Object.assign({}, task, { expiresAt: 1234567891 })));
  assert.match(onyuDonationCleanupFailureId(task), /^[a-f0-9]{64}$/);
});

test('cleanup failure records retain bounded operational details and increment attempts', () => {
  const task = { kind: 'tokenSecret', key: 'firebaseUid', expiresAt: 2000, soopConsentAt: 1000 };
  const first = mergeOnyuDonationCleanupFailure(null, task, { code: 'PERMISSION_DENIED' }, 3000);
  const second = mergeOnyuDonationCleanupFailure(first, task, { message: 'must not be stored' }, 4000);
  assert.equal(first.attempts, 1);
  assert.equal(second.attempts, 2);
  assert.equal(second.firstFailedAt, 3000);
  assert.equal(second.lastFailedAt, 4000);
  assert.equal(second.lastErrorCode, 'cleanup-failed');
  assert.equal(Object.hasOwn(second, 'message'), false);
  assert.equal(Object.hasOwn(second, 'refreshToken'), false);
});
