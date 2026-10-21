const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fanPageViewerSubscriptionDonationCanMatch,
  fanPageViewerSubscriptionHasEligibleBackgroundRequest,
  fanPageSponsorAdDonationCanMatch,
  describeFanPageSponsorDonationCandidate,
  fanPageSponsorAdHasEligibleBackgroundRequest,
  notificationFallsInDonationRequestWindow,
} = require('./donation-verification');

const now = 1_800_000_000_000;
const hourMs = 60 * 60 * 1000;
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

const sponsorRequest = {
  status: 'pending',
  soopId: 'streamer01',
  donorSoopId: 'ysk7895',
  rail: 'left',
  days: 12,
  balloonCost: 120,
  requestedAt: now - 5 * 60 * 1000,
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
  const exactMatch = describeFanPageSponsorDonationCandidate(
    'request-1', sponsorRequest, 'YSK7895', 120, now,
  );
  assert.equal(exactMatch.eligibleByCurrentRule, true);
  assert.equal(exactMatch.donorMatch, true);
  assert.equal(exactMatch.amountMatch, true);
  assert.deepEqual(exactMatch.reasons, []);

  const donorMismatch = describeFanPageSponsorDonationCandidate(
    'request-2', sponsorRequest, 'anotherUser', 120, now,
  );
  assert.equal(donorMismatch.eligibleByCurrentRule, false);
  assert.deepEqual(donorMismatch.reasons, ['donor-account-mismatch']);

  const staleRequest = describeFanPageSponsorDonationCandidate(
    'request-3', { ...sponsorRequest, requestedAt: now - hourMs }, 'ysk7895', 120, now,
  );
  assert.equal(staleRequest.eligibleByCurrentRule, false);
  assert.ok(staleRequest.reasons.includes('automatic-watch-window-ended'));
});

test('omits unrelated pending sponsor requests from a donation diagnostic', () => {
  assert.equal(describeFanPageSponsorDonationCandidate(
    'request-unrelated', sponsorRequest, 'anotherUser', 33, now,
  ), null);
});

test('watches pending streamer-fanpage sponsorship requests for one hour without a completion click', () => {
  assert.equal(fanPageSponsorAdHasEligibleBackgroundRequest({ request: sponsorRequest }, now), true);
  assert.equal(fanPageSponsorAdHasEligibleBackgroundRequest({ request: { ...sponsorRequest, balloonCost: 70 } }, now), false);
  assert.equal(fanPageSponsorAdHasEligibleBackgroundRequest({ request: { ...sponsorRequest, status: 'approved' } }, now), false);
  assert.equal(fanPageSponsorAdHasEligibleBackgroundRequest({
    request: { ...sponsorRequest, donationCompletedAt: now - 5 * 60 * 1000 },
  }, now), true);
  assert.equal(fanPageSponsorAdHasEligibleBackgroundRequest({
    request: { ...sponsorRequest, requestedAt: now - hourMs },
  }, now), false);
});

test('matches sponsor-ad donations by donor ID and exact amount, independent of click or alert time', () => {
  assert.equal(fanPageSponsorAdDonationCanMatch(sponsorRequest, 'YSK7895', 120, now), true);
  assert.equal(fanPageSponsorAdDonationCanMatch({ ...sponsorRequest, donationCompletedAt: now - hourMs }, 'ysk7895', 120, now), true);
  assert.equal(fanPageSponsorAdDonationCanMatch(sponsorRequest, 'ysk7895', 130, now), false);
  assert.equal(fanPageSponsorAdDonationCanMatch(sponsorRequest, 'someone-else', 120, now), false);
  assert.equal(fanPageSponsorAdDonationCanMatch({ ...sponsorRequest, requestedAt: now - hourMs }, 'ysk7895', 120, now), false);
  assert.equal(fanPageSponsorAdDonationCanMatch({ ...sponsorRequest, requestedAt: now + 1 }, 'ysk7895', 120, now), false);
});

test('stops sponsor-ad automatic matching at one hour even if the request remains pending', () => {
  const oldRequest = { ...sponsorRequest, requestedAt: now - 2 * hourMs, expiresAt: now + 5 * 24 * hourMs };
  assert.equal(fanPageSponsorAdHasEligibleBackgroundRequest({ request: oldRequest }, now), false);
  assert.equal(fanPageSponsorAdDonationCanMatch(oldRequest, 'ysk7895', 120, now), false);
  assert.equal(describeFanPageSponsorDonationCandidate('old-request', oldRequest, 'ysk7895', 120, now)
    .reasons.includes('automatic-watch-window-ended'), true);
});
