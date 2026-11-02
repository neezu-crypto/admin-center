'use strict';

const crypto = require('node:crypto');
const { DONATION_CONSENT_TTL_MS } = require('./onyuDonationRetention');

const ONYU_SOOP_REFRESH_SECRET_PREFIX = 'onyu-soop-refresh-';

function onyuRefreshSecretId(uid, soopConsentAt) {
  const safeUid = String(uid || '').trim();
  const consentAt = Number(soopConsentAt) || 0;
  if (!safeUid || !Number.isSafeInteger(consentAt) || consentAt <= 0) {
    throw new TypeError('유효한 인증 UID와 SOOP 동의 시각이 필요합니다.');
  }
  const digest = crypto.createHash('sha256').update(`${safeUid}:${consentAt}`).digest('hex');
  return ONYU_SOOP_REFRESH_SECRET_PREFIX + digest;
}

function onyuRefreshSecretName(projectId, secretId) {
  const project = String(projectId || '').trim();
  const id = String(secretId || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{4,62}$/.test(project)) throw new TypeError('Google Cloud 프로젝트 정보가 올바르지 않습니다.');
  if (!new RegExp(`^${ONYU_SOOP_REFRESH_SECRET_PREFIX}[a-f0-9]{64}$`).test(id)) throw new TypeError('온이유 Refresh Token 시크릿 정보가 올바르지 않습니다.');
  return `projects/${project}/secrets/${id}`;
}

function accessTokenExpiresAt(expiresInSeconds, now = Date.now()) {
  const seconds = Number(expiresInSeconds);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new TypeError('SOOP expires_in 값이 올바르지 않습니다.');
  const expiry = Number(now) + seconds * 1000;
  if (!Number.isSafeInteger(expiry)) throw new TypeError('Access Token 만료 시각을 계산할 수 없습니다.');
  return expiry;
}

function isNotFound(error) {
  return Number(error && error.code) === 5 || Number(error && error.code) === 404;
}

function isAlreadyExists(error) {
  return Number(error && error.code) === 6 || Number(error && error.code) === 409;
}

function expirationTimestamp(expiresAt) {
  const value = Number(expiresAt);
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Refresh Token 만료 시각이 올바르지 않습니다.');
  return { seconds: Math.floor(value / 1000), nanos: (value % 1000) * 1_000_000 };
}

async function createOrUpdateSecret(client, secretName, expiresAt) {
  const secret = {
    name: secretName,
    replication: { userManaged: { replicas: [{ location: 'us-central1' }] } },
    expireTime: expirationTimestamp(expiresAt),
  };
  try {
    await client.createSecret({
      parent: secretName.slice(0, secretName.lastIndexOf('/')),
      secretId: secretName.slice(secretName.lastIndexOf('/') + 1),
      secret,
    });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    await client.updateSecret({ secret, updateMask: { paths: ['expire_time'] } });
  }
}

// OAuth 콜백이 state·인증 계정·SOOP 동의를 검증한 뒤에만 호출할 준비 함수다.
// Refresh Token 원문은 Secret Manager에만 쓰고 반환하지 않는다.
async function storeOnyuRefreshToken({ client, projectId, uid, soopConsentAt, preparationExpiresAt, refreshToken, now = Date.now() }) {
  const token = String(refreshToken || '');
  const consentAt = Number(soopConsentAt) || 0;
  const currentTime = Number(now);
  const expiresAt = Math.min(
    consentAt + DONATION_CONSENT_TTL_MS,
    Number(preparationExpiresAt) > 0 ? Number(preparationExpiresAt) : Number.MAX_SAFE_INTEGER,
  );
  if (!client || !token || token.length > 8192) throw new TypeError('저장할 Refresh Token이 올바르지 않습니다.');
  if (!Number.isSafeInteger(consentAt) || consentAt <= 0 || !Number.isSafeInteger(currentTime) || expiresAt <= currentTime) {
    throw new TypeError('유효한 SOOP 동의 기간이 없습니다.');
  }

  const secretId = onyuRefreshSecretId(uid, consentAt);
  const secretName = onyuRefreshSecretName(projectId, secretId);
  await createOrUpdateSecret(client, secretName, expiresAt);
  const [version] = await client.addSecretVersion({
    parent: secretName,
    payload: { data: Buffer.from(token, 'utf8') },
  });

  // 재시도나 향후 토큰 회전으로 새 버전을 쓰면, 이전 버전은 바로 폐기한다.
  // Secret 자체에도 동의 만료 시각을 설정해 API 작업 실패가 보관 상한을 넘기지 않게 한다.
  const [versions] = await client.listSecretVersions({ parent: secretName, filter: 'state:ENABLED' });
  const previousVersions = (versions || []).filter((item) => item && item.name && item.name !== version.name);
  for (const previous of previousVersions) await client.destroySecretVersion({ name: previous.name });

  return { secretId, secretVersion: version.name, expiresAt };
}

async function readOnyuRefreshToken({ client, projectId, secretId, secretVersion = 'latest' }) {
  if (!client) throw new TypeError('Secret Manager 연결이 필요합니다.');
  const secretName = onyuRefreshSecretName(projectId, secretId);
  const versionId = String(secretVersion || 'latest');
  if (!/^(latest|[1-9][0-9]*)$/.test(versionId)) throw new TypeError('온이유 Refresh Token 버전 정보가 올바르지 않습니다.');
  const [result] = await client.accessSecretVersion({ name: `${secretName}/versions/${versionId}` });
  const token = result && result.payload && result.payload.data;
  if (!token) throw new Error('온이유 Refresh Token을 읽을 수 없습니다.');
  return Buffer.isBuffer(token) ? token.toString('utf8') : Buffer.from(token).toString('utf8');
}

async function deleteOnyuRefreshTokenSecret({ client, projectId, secretId }) {
  const secretName = onyuRefreshSecretName(projectId, secretId);
  try {
    await client.deleteSecret({ name: secretName });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

module.exports = {
  ONYU_SOOP_REFRESH_SECRET_PREFIX,
  onyuRefreshSecretId,
  onyuRefreshSecretName,
  accessTokenExpiresAt,
  storeOnyuRefreshToken,
  readOnyuRefreshToken,
  deleteOnyuRefreshTokenSecret,
};
