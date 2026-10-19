const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fanPageViewerSubscriptionDonationCanMatch,
  fanPageViewerSubscriptionHasEligibleBackgroundRequest,
  fanPageSponsorAdDonationCanMatch,
  describeFanPageSponsorDonationCandidate,
  fanPageSponsorAdHasEligibleBackgroundRequest,
  lifeGameSponsorHasEligibleBackgroundRequest,
  notificationFallsInDonationRequestWindow,
} = require('./donation-verification');

const now = 1_800_000_000_000;
const hourMs = 60 * 60 * 1000;
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

const sponsorRequest = {
  status: 'pending',
  soopId: 'streamer01',
  donorSoopId: 'ysk7895',
  rail: 'left',
  days: 12,
  balloonCost: 120,
  requestedAt: now - 6 * 24 * 60 * 60 * 1000,
  expiresAt: now + 24 * 60 * 60 * 1000,
};

const viewerSubscriptionRequest = {
  status: 'pending',
  donorSoopId: 'ysk7895',
  balloonCost: 33,
  requestedAt: now - 5 * 60 * 1000,
  donationCompletedAt: 0,
};

test('starts background watch for a pending viewer subscription without a completion click', () => {
  assert.equal(fanPageViewerSubscriptionHasEligibleBackgroundRequest(
    { request: viewerSubscriptionRequest }, now, [10, 33],
  ), true);
  assert.equal(fanPageViewerSubscriptionHasEligibleBackgroundRequest(
    { request: { ...viewerSubscriptionRequest, status: 'approved' } }, now, [10, 33],
  ), false);
  assert.equal(fanPageViewerSubscriptionHasEligibleBackgroundRequest(
    { request: { ...viewerSubscriptionRequest, donorSoopId: '' } }, now, [10, 33],
  ), false);
  assert.equal(fanPageViewerSubscriptionHasEligibleBackgroundRequest(
    { request: { ...viewerSubscriptionRequest, requestedAt: now - hourMs - 1 } }, now, [10, 33],
  ), false);
  assert.equal(fanPageViewerSubscriptionHasEligibleBackgroundRequest(
    { request: { ...viewerSubscriptionRequest, requestedAt: now - hourMs + 1000 } }, now, [10, 33],
  ), true);
  assert.equal(fanPageViewerSubscriptionHasEligibleBackgroundRequest(
    { request: { ...viewerSubscriptionRequest, requestedAt: now - hourMs } }, now, [10, 33],
  ), false);
  assert.equal(fanPageViewerSubscriptionHasEligibleBackgroundRequest(
    { request: { ...viewerSubscriptionRequest, requestedAt: now - 25 * hourMs } }, now, [10, 33],
  ), false);
});

test('matches viewer subscription by donor ID and amount without a completion click or alert-time match', () => {
  assert.equal(fanPageViewerSubscriptionDonationCanMatch(
    viewerSubscriptionRequest, 'YSK7895', 33, now, [10, 33],
  ), true);
  assert.equal(fanPageViewerSubscriptionDonationCanMatch(
    viewerSubscriptionRequest, 'otheruser', 33, now, [10, 33],
  ), false);
  assert.equal(fanPageViewerSubscriptionDonationCanMatch(
    viewerSubscriptionRequest, '', 33, now, [10, 33],
  ), false);
  assert.equal(fanPageViewerSubscriptionDonationCanMatch(
    viewerSubscriptionRequest, 'ysk7895', 50, now, [10, 33],
  ), false);
  assert.equal(fanPageViewerSubscriptionDonationCanMatch(
    viewerSubscriptionRequest, 'ysk7895', 33, now, [10, 33],
  ), true);
  assert.equal(fanPageViewerSubscriptionDonationCanMatch(
    { ...viewerSubscriptionRequest, requestedAt: now - hourMs - 1 }, 'ysk7895', 33, now, [10, 33],
  ), false);
  assert.equal(fanPageViewerSubscriptionDonationCanMatch(
    { ...viewerSubscriptionRequest, requestedAt: now - hourMs + 1000 }, 'ysk7895', 33, now, [10, 33],
  ), true);
  assert.equal(fanPageViewerSubscriptionDonationCanMatch(
    { ...viewerSubscriptionRequest, requestedAt: now - hourMs }, 'ysk7895', 33, now, [10, 33],
  ), false);
  assert.equal(fanPageViewerSubscriptionDonationCanMatch(
    { ...viewerSubscriptionRequest, requestedAt: now + 1000 }, 'ysk7895', 33, now, [10, 33],
  ), false);
});

test('describes sponsor-ad donation candidate matches and exclusion reasons', () => {
  const eventAt = now - 60 * 1000;
  const exactMatch = describeFanPageSponsorDonationCandidate(
    'request-1', sponsorRequest, 'YSK7895', 120, now, eventAt, eventAt, true,
  );
  assert.equal(exactMatch.eligibleByCurrentRule, true);
  assert.equal(exactMatch.donorMatch, true);
  assert.equal(exactMatch.amountMatch, true);
  assert.deepEqual(exactMatch.reasons, []);

  const donorMismatch = describeFanPageSponsorDonationCandidate(
    'request-2', sponsorRequest, 'anotherUser', 120, now, eventAt, eventAt, true,
  );
  assert.equal(donorMismatch.eligibleByCurrentRule, false);
  assert.deepEqual(donorMismatch.reasons, ['donor-account-mismatch']);

  const staleWindow = describeFanPageSponsorDonationCandidate(
    'request-3', sponsorRequest, 'ysk7895', 120, now, sponsorRequest.requestedAt - 1000,
    sponsorRequest.requestedAt - 1000, true,
  );
  assert.equal(staleWindow.eligibleByCurrentRule, false);
  assert.ok(staleWindow.reasons.includes('notification-may-precede-request'));
});

test('omits unrelated pending sponsor requests from a donation diagnostic', () => {
  assert.equal(describeFanPageSponsorDonationCandidate(
    'request-unrelated', sponsorRequest, 'anotherUser', 33, now, now - 1000, now - 1000, true,
  ), null);
});

test('watches pending streamer-fanpage sponsorship requests up to 30 days of donation value', () => {
  assert.equal(fanPageSponsorAdHasEligibleBackgroundRequest({ request: sponsorRequest }, now), true);
  assert.equal(fanPageSponsorAdHasEligibleBackgroundRequest({ request: { ...sponsorRequest, balloonCost: 70 } }, now), false);
  assert.equal(fanPageSponsorAdHasEligibleBackgroundRequest({ request: { ...sponsorRequest, status: 'approved' } }, now), false);
});

test('matches sponsor-ad donations without a completion click for the request TTL', () => {
  const eventAt = now - 60 * 1000;
  assert.equal(fanPageSponsorAdDonationCanMatch(sponsorRequest, 'ysk7895', 120, now, eventAt, eventAt, true), true);
  assert.equal(fanPageSponsorAdDonationCanMatch(sponsorRequest, 'ysk7895', 130, now, eventAt, eventAt, true), false);
  assert.equal(fanPageSponsorAdDonationCanMatch(sponsorRequest, 'someone-else', 120, now, eventAt, eventAt, true), false);
  assert.equal(fanPageSponsorAdDonationCanMatch({ ...sponsorRequest, expiresAt: eventAt - 1 }, 'ysk7895', 120, now, eventAt, eventAt, true), false);
  assert.equal(notificationFallsInDonationRequestWindow(
    sponsorRequest, 'ysk7895', 120, now, eventAt, eventAt, true, true,
  ), false);
});

test('keeps sponsor requests inactive after expiry or the seven-day request window', () => {
  assert.equal(fanPageSponsorAdHasEligibleBackgroundRequest({ request: { ...sponsorRequest, expiresAt: now - 1 } }, now), false);
  assert.equal(fanPageSponsorAdHasEligibleBackgroundRequest({ request: { ...sponsorRequest, donationCompletedAt: now - 1 } }, now), true);
  assert.equal(fanPageSponsorAdHasEligibleBackgroundRequest({ request: { ...sponsorRequest, requestedAt: now - 8 * 24 * 60 * 60 * 1000 } }, now), false);
});
