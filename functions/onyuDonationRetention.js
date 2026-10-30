const DONATION_CONSENT_TTL_MS = 24 * 60 * 60 * 1000;

function integrationExpiresAt(record) {
  const explicitExpiry = Number(record && record.expiresAt) || 0;
  if (explicitExpiry > 0) return explicitExpiry;
  const consentedAt = Number(record && record.consentedAt) || 0;
  return consentedAt > 0 ? consentedAt + DONATION_CONSENT_TTL_MS : 0;
}

function isIntegrationExpired(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return false;
  const expiry = integrationExpiresAt(record);
  return expiry > 0 && expiry <= now;
}

function isOutfitSessionExpired(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return false;
  const expiry = Number(record.expiresAt) || 0;
  return expiry > 0 && expiry <= now;
}

async function removeExpiredRecordIfMatches(db, path, key, getExpiry, expectedExpiry, now = Date.now()) {
  const expected = Number(expectedExpiry) || 0;
  if (!expected || expected > now) return false;
  const result = await db.ref(`${path}/${key}`).transaction((current) => {
    if (!current || Number(getExpiry(current)) !== expected || Number(getExpiry(current)) > now) return current;
    return null;
  });
  return result.committed && result.snapshot.val() === null;
}

module.exports = {
  DONATION_CONSENT_TTL_MS,
  integrationExpiresAt,
  isIntegrationExpired,
  isOutfitSessionExpired,
  removeExpiredRecordIfMatches,
};
