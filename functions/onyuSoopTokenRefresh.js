'use strict';

const { integrationExpiresAt } = require('./onyuDonationRetention');
const SOOP_TOKEN_ENDPOINT = 'https://openapi.sooplive.com/auth/token';

function isOnyuSoopRefreshEligible(integration, { verifiedSoopId, now = Date.now() } = {}) {
  const record = integration && typeof integration === 'object' ? integration : {};
  const expectedSoopId = String(verifiedSoopId || '').trim().toLowerCase();
  return record.status === 'active'
    && record.sdkApproved === true
    && Number(record.soopConsentAt) > 0
    && integrationExpiresAt(record) > Number(now)
    && !!expectedSoopId
    && String(record.soopId || '').trim().toLowerCase() === expectedSoopId;
}

function normalizeErrorCode(value) {
  return String(value || '').trim().toUpperCase();
}

function extractSoopErrorCode(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return normalizeErrorCode(payload.error_code || payload.errorCode || payload.code || payload.error);
}

function classifySoopRefreshFailure({ httpStatus, errorCode, confirmedRevocationCodes = [] } = {}) {
  const normalized = normalizeErrorCode(errorCode);
  const revokedCodes = new Set((confirmedRevocationCodes || []).map(normalizeErrorCode).filter(Boolean));
  if (normalized && revokedCodes.has(normalized)) return 'revoked';
  const status = Number(httpStatus) || 0;
  if (status === 429 || status >= 500 || status === 0) return 'retryable';
  return 'unclassified';
}

async function readResponseJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function refreshSoopTokens({
  clientId,
  clientSecret,
  refreshToken,
  redirectUri,
  confirmedRevocationCodes = [],
  fetchImpl = globalThis.fetch,
} = {}) {
  const safeClientId = String(clientId || '').trim();
  const safeClientSecret = String(clientSecret || '');
  const safeRefreshToken = String(refreshToken || '');
  if (!safeClientId || !safeClientSecret || !safeRefreshToken || typeof fetchImpl !== 'function') {
    throw new TypeError('SOOP 토큰 갱신에 필요한 서버 설정이 없습니다.');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: safeClientId,
    client_secret: safeClientSecret,
    refresh_token: safeRefreshToken,
  });
  const safeRedirectUri = String(redirectUri || '').trim();
  if (safeRedirectUri) body.set('redirect_uri', safeRedirectUri);

  const response = await fetchImpl(SOOP_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await readResponseJson(response);
  if (!response.ok) {
    const errorCode = extractSoopErrorCode(payload);
    return {
      ok: false,
      errorCode,
      httpStatus: Number(response.status) || 0,
      failureClass: classifySoopRefreshFailure({ httpStatus: response.status, errorCode, confirmedRevocationCodes }),
    };
  }

  const accessToken = String(payload && payload.access_token || '');
  const nextRefreshToken = String(payload && payload.refresh_token || '');
  const expiresInSeconds = Number(payload && payload.expires_in);
  if (!accessToken || !nextRefreshToken || !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds <= 0) {
    const error = new Error('SOOP 토큰 갱신 응답의 필수 필드가 없습니다.');
    error.code = 'SOOP_REFRESH_RESPONSE_INVALID';
    throw error;
  }

  return { ok: true, accessToken, refreshToken: nextRefreshToken, expiresInSeconds };
}

module.exports = {
  SOOP_TOKEN_ENDPOINT,
  isOnyuSoopRefreshEligible,
  extractSoopErrorCode,
  classifySoopRefreshFailure,
  refreshSoopTokens,
};
