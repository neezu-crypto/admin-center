const test = require('node:test');
const assert = require('node:assert/strict');
const {
  lifeGameSponsorHasEligibleBackgroundRequest,
  notificationFallsInDonationRequestWindow,
} = require('./donation-verification');

const now = 1_800_000_000_000;
const request = {
  status: 'pending',
  donorSoopId: 'ysk7895',
  diagnosticCode: 'LG-B8EE12FA',
  starBalloons: 20,
  days: 2,
  requestedAt: now - 5 * 60 * 1000,
};

test('activates life-game donation watch before the requester clicks completion', () => {
  assert.equal(lifeGameSponsorHasEligibleBackgroundRequest({ request }, now), true);
});

test('does not watch invalid, stale, or non-pending life-game requests', () => {
  assert.equal(lifeGameSponsorHasEligibleBackgroundRequest({ request: { ...request, status: 'approved' } }, now), false);
  assert.equal(lifeGameSponsorHasEligibleBackgroundRequest({ request: { ...request, donorSoopId: '' } }, now), false);
  assert.equal(lifeGameSponsorHasEligibleBackgroundRequest({ request: { ...request, starBalloons: 25 } }, now), false);
  assert.equal(lifeGameSponsorHasEligibleBackgroundRequest({ request: { ...request, requestedAt: now - 25 * 60 * 60 * 1000 } }, now), false);
});

test('accepts an exact matching SOOP donation alert after the request without a completion signal', () => {
  const eventAt = now - 60 * 1000;
  assert.equal(notificationFallsInDonationRequestWindow(
    request, 'YSK7895', 20, now, eventAt, eventAt, true, true,
  ), true);
});

test('rejects an alert before the request and age ranges that overlap the request time', () => {
  const beforeRequest = request.requestedAt - 1000;
  assert.equal(notificationFallsInDonationRequestWindow(
    request, 'ysk7895', 20, now, beforeRequest, beforeRequest, true, true,
  ), false);
  assert.equal(notificationFallsInDonationRequestWindow(
    request, 'ysk7895', 20, now, request.requestedAt - 30_000, request.requestedAt + 30_000, false, true,
  ), false);
});

test('keeps the completion signal mandatory unless the caller opts into the life-game fallback', () => {
  const eventAt = now - 60 * 1000;
  assert.equal(notificationFallsInDonationRequestWindow(
    request, 'ysk7895', 20, now, eventAt, eventAt, true,
  ), false);
});

test('preserves the narrow timestamp match when the completion signal exists', () => {
  const completedAt = now - 90 * 1000;
  const eventAt = completedAt - 60 * 1000;
  assert.equal(notificationFallsInDonationRequestWindow(
    { ...request, donationCompletedAt: completedAt }, 'ysk7895', 20, now, eventAt, eventAt, true,
  ), true);
  assert.equal(notificationFallsInDonationRequestWindow(
    { ...request, donationCompletedAt: completedAt }, 'different', 20, now, eventAt, eventAt, true, true,
  ), false);
});
