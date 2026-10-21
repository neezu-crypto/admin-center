const test = require('node:test');
const assert = require('node:assert/strict');
const {
  notificationFallsInDonationRequestWindow,
} = require('./donation-verification');

const now = 1_800_000_000_000;
const onyuGiftRequest = {
  status: 'pending',
  donorSoopId: 'ysk7895',
  balloons: 50,
  requestedAt: now - 5 * 60 * 1000,
  donationCompletedAt: now - 90 * 1000,
};

test('accepts an exact matching SOOP alert after an Onyu legacy request completion signal', () => {
  const eventAt = now - 60 * 1000;
  assert.equal(notificationFallsInDonationRequestWindow(
    onyuGiftRequest, 'YSK7895', 50, now, eventAt, eventAt, true,
  ), true);
});
test('rejects alerts before the request or outside the completion time window', () => {
  const beforeRequest = onyuGiftRequest.requestedAt - 1000;
  assert.equal(notificationFallsInDonationRequestWindow(
    onyuGiftRequest, 'ysk7895', 50, now, beforeRequest, beforeRequest, true,
  ), false);
  assert.equal(notificationFallsInDonationRequestWindow(
    onyuGiftRequest, 'ysk7895', 50, now, now - 10 * 60 * 1000,
    now - 9 * 60 * 1000, false,
  ), false);
});

test('requires the donation completion signal', () => {
  const eventAt = now - 60 * 1000;
  assert.equal(notificationFallsInDonationRequestWindow(
    { ...onyuGiftRequest, donationCompletedAt: 0 }, 'ysk7895', 50, now, eventAt, eventAt, true,
  ), false);
});

test('preserves the narrow timestamp match when the completion signal exists', () => {
  const completedAt = now - 90 * 1000;
  const eventAt = completedAt - 60 * 1000;
  assert.equal(notificationFallsInDonationRequestWindow(
    { ...onyuGiftRequest, donationCompletedAt: completedAt }, 'ysk7895', 50, now, eventAt, eventAt, true,
  ), true);
  assert.equal(notificationFallsInDonationRequestWindow(
    { ...onyuGiftRequest, donationCompletedAt: completedAt }, 'different', 50, now, eventAt, eventAt, true,
  ), false);
});
