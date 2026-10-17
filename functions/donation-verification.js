const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeSoopId(value) {
  const id = String(value || '').trim();
  return /^[a-z0-9]{2,20}$/i.test(id) ? id.toLowerCase() : '';
}

function lifeGameSponsorHasEligibleBackgroundRequest(requests, now) {
  return Object.values(requests || {}).some((item) => item && item.status === 'pending' &&
    normalizeSoopId(item.donorSoopId) && /^LG-[A-F0-9]{8}$/.test(String(item.diagnosticCode || '')) &&
    Number(item.starBalloons) >= 10 && Number(item.starBalloons) <= 70 && Number(item.starBalloons) % 10 === 0 &&
    Number(item.days) * 10 === Number(item.starBalloons) && Number(item.requestedAt) > 0 &&
    Number(item.requestedAt) <= now && now - Number(item.requestedAt) <= DAY_MS);
}

function notificationFallsInDonationRequestWindow(item, senderSoopId, balloons, observedAt, eventAtMin, eventAtMax, exactTimestamp, allowMissingCompletionSignal) {
  const normalizedSenderSoopId = normalizeSoopId(senderSoopId);
  if (!item || item.status !== 'pending' || !normalizedSenderSoopId || normalizeSoopId(item.donorSoopId) !== normalizedSenderSoopId ||
      Number(item.balloons || item.starBalloons || item.balloonCost) !== balloons) return false;
  const requestedAt = Number(item.requestedAt) || 0;
  const donationCompletedAt = Number(item.donationCompletedAt) || 0;
  if (!requestedAt || requestedAt > observedAt || observedAt - requestedAt > DAY_MS ||
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
  lifeGameSponsorHasEligibleBackgroundRequest,
  notificationFallsInDonationRequestWindow,
};
