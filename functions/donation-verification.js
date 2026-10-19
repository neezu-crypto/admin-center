const DAY_MS = 24 * 60 * 60 * 1000;
const FANPAGE_VIEWER_SUBSCRIPTION_WATCH_MS = 60 * 60 * 1000;
const FANPAGE_SPONSOR_AD_WATCH_MS = 60 * 60 * 1000;

function normalizeSoopId(value) {
  const id = String(value || '').trim();
  return /^[a-z0-9]{2,20}$/i.test(id) ? id.toLowerCase() : '';
}

function fanPageViewerSubscriptionHasEligibleBackgroundRequest(requests, now, allowedBalloons) {
  return Object.values(requests || {}).some((item) => {
    const requestedAt = Number(item && item.requestedAt) || 0;
    return item && (!item.status || item.status === 'pending') && normalizeSoopId(item.donorSoopId) &&
      Array.isArray(allowedBalloons) && allowedBalloons.includes(Number(item.balloonCost)) &&
      requestedAt > now - FANPAGE_VIEWER_SUBSCRIPTION_WATCH_MS && requestedAt <= now;
  });
}

function fanPageViewerSubscriptionDonationCanMatch(item, senderSoopId, balloons, observedAt, allowedBalloons) {
  const balloonCost = Number(item && item.balloonCost);
  const requestedAt = Number(item && item.requestedAt) || 0;
  const donorSoopId = normalizeSoopId(item && item.donorSoopId);
  const normalizedSenderSoopId = normalizeSoopId(senderSoopId);
  return !!item && item.status === 'pending' &&
    !!normalizedSenderSoopId && donorSoopId === normalizedSenderSoopId &&
    Array.isArray(allowedBalloons) && allowedBalloons.includes(balloonCost) && balloonCost === balloons &&
    Number.isFinite(observedAt) && requestedAt > 0 && requestedAt <= observedAt &&
    observedAt - requestedAt < FANPAGE_VIEWER_SUBSCRIPTION_WATCH_MS;
}

function lifeGameSponsorHasEligibleBackgroundRequest(requests, now) {
  return Object.values(requests || {}).some((item) => item && item.status === 'pending' &&
    normalizeSoopId(item.donorSoopId) && /^LG-[A-F0-9]{8}$/.test(String(item.diagnosticCode || '')) &&
    Number(item.starBalloons) >= 10 && Number(item.starBalloons) <= 70 && Number(item.starBalloons) % 10 === 0 &&
    Number(item.days) * 10 === Number(item.starBalloons) && Number(item.requestedAt) > 0 &&
    Number(item.requestedAt) <= now && now - Number(item.requestedAt) <= DAY_MS);
}

function fanPageSponsorAdHasEligibleBackgroundRequest(requests, now) {
  return Object.values(requests || {}).some((item) => {
    if (!item || item.status !== 'pending' || !normalizeSoopId(item.donorSoopId) ||
        !normalizeSoopId(item.soopId) || !['left', 'right'].includes(item.rail)) return false;
    const days = Number(item.days);
    const requestedAt = Number(item.requestedAt) || 0;
    return Number.isInteger(days) && days >= 1 && days <= 30 &&
      Number(item.balloonCost) === days * 10 && requestedAt > 0 && requestedAt <= now &&
      now - requestedAt < FANPAGE_SPONSOR_AD_WATCH_MS;
  });
}

function fanPageSponsorAdDonationCanMatch(item, senderSoopId, balloons, observedAt) {
  const normalizedSenderSoopId = normalizeSoopId(senderSoopId);
  if (!item || item.status !== 'pending' || !normalizedSenderSoopId || normalizeSoopId(item.donorSoopId) !== normalizedSenderSoopId ||
      !normalizeSoopId(item.soopId) || !['left', 'right'].includes(item.rail)) return false;
  const days = Number(item.days);
  const requestedAt = Number(item.requestedAt) || 0;
  if (!Number.isInteger(days) || days < 1 || days > 30 || days * 10 !== balloons ||
      Number(item.balloonCost) !== balloons || !requestedAt || requestedAt > observedAt) return false;
  return observedAt - requestedAt < FANPAGE_SPONSOR_AD_WATCH_MS;
}

function describeFanPageSponsorDonationCandidate(requestId, item, senderSoopId, balloons, observedAt) {
  if (!item || item.status !== 'pending') return null;
  const normalizedSenderSoopId = normalizeSoopId(senderSoopId);
  const donorSoopId = normalizeSoopId(item.donorSoopId);
  const soopId = normalizeSoopId(item.soopId);
  const days = Number(item.days) || 0;
  const balloonCost = Number(item.balloonCost) || 0;
  const requestedAt = Number(item.requestedAt) || 0;
  const expiresAt = Number(item.expiresAt) || 0;
  const donationCompletedAt = Number(item.donationCompletedAt) || 0;
  const donorMatch = !!normalizedSenderSoopId && donorSoopId === normalizedSenderSoopId;
  const amountMatch = balloonCost === balloons && days * 10 === balloons;
  if (!donorMatch && !amountMatch) return null;

  const reasons = [];
  const eligibleByCurrentRule = fanPageSponsorAdDonationCanMatch(item, senderSoopId, balloons, observedAt);
  if (!donorMatch) reasons.push('donor-account-mismatch');
  if (!amountMatch) reasons.push('balloon-count-mismatch');
  if (!soopId || !['left', 'right'].includes(item.rail) || !Number.isInteger(days) || days < 1 || days > 30 || balloonCost !== days * 10) {
    reasons.push('invalid-sponsor-request-fields');
  }
  if (!requestedAt || requestedAt > observedAt) {
    reasons.push('request-not-yet-created');
  } else if (observedAt - requestedAt >= FANPAGE_SPONSOR_AD_WATCH_MS) {
    reasons.push('automatic-watch-window-ended');
  }

  return {
    requestId: String(requestId || '').slice(0, 200),
    nickname: String(item.nickname || '').slice(0, 60),
    soopId,
    rail: ['left', 'right'].includes(item.rail) ? item.rail : '',
    status: String(item.status || ''),
    donorSoopId,
    donorMatch,
    days,
    balloonCost,
    amountMatch,
    requestedAt,
    expiresAt,
    donationCompletedAt,
    eligibleByCurrentRule,
    automaticWatchExpiresAt: requestedAt > 0 ? requestedAt + FANPAGE_SPONSOR_AD_WATCH_MS : 0,
    reasons,
  };
}

function notificationFallsInDonationRequestWindow(item, senderSoopId, balloons, observedAt, eventAtMin, eventAtMax, exactTimestamp, allowMissingCompletionSignal, maxRequestAgeMs) {
  const normalizedSenderSoopId = normalizeSoopId(senderSoopId);
  if (!item || item.status !== 'pending' || !normalizedSenderSoopId || normalizeSoopId(item.donorSoopId) !== normalizedSenderSoopId ||
      Number(item.balloons || item.starBalloons || item.balloonCost) !== balloons) return false;
  const requestedAt = Number(item.requestedAt) || 0;
  const donationCompletedAt = Number(item.donationCompletedAt) || 0;
  const requestAgeLimit = Number.isFinite(Number(maxRequestAgeMs)) && Number(maxRequestAgeMs) > 0
    ? Number(maxRequestAgeMs)
    : DAY_MS;
  if (!requestedAt || requestedAt > observedAt || observedAt - requestedAt > requestAgeLimit ||
      !Number.isFinite(eventAtMin) || !Number.isFinite(eventAtMax) || eventAtMin > eventAtMax ||
      eventAtMin < observedAt - DAY_MS || eventAtMax > observedAt + 30000) return false;

  if (!donationCompletedAt) {
    if (!allowMissingCompletionSignal) return false;
    // Without the page's completion click, only accept an alert whose entire
    // possible timestamp range is after the request. Ambiguous age ranges stay manual.
    return requestedAt <= eventAtMin;
  }

  if (donationCompletedAt < requestedAt || donationCompletedAt > observedAt + 30000 ||
      observedAt - donationCompletedAt > 20 * 60 * 1000) return false;
  if (exactTimestamp) return eventAtMin === eventAtMax && requestedAt <= eventAtMin &&
    eventAtMin >= donationCompletedAt - 5 * 60 * 1000 && eventAtMin <= donationCompletedAt + 2 * 60 * 1000;
  return requestedAt <= eventAtMax && eventAtMin <= donationCompletedAt + 2 * 60 * 1000 &&
    eventAtMax >= donationCompletedAt - 5 * 60 * 1000;
}

module.exports = {
  fanPageViewerSubscriptionDonationCanMatch,
  fanPageViewerSubscriptionHasEligibleBackgroundRequest,
  fanPageSponsorAdDonationCanMatch,
  fanPageSponsorAdHasEligibleBackgroundRequest,
  describeFanPageSponsorDonationCandidate,
  lifeGameSponsorHasEligibleBackgroundRequest,
  notificationFallsInDonationRequestWindow,
};
