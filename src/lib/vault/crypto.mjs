import crypto from 'node:crypto';

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 14;
const MIN_SECRET_LENGTH = 32;
const TOKEN_VERSION = 'v1';
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function generateStrongPassword(groups = 5, groupLength = 6) {
  const segments = [];
  for (let g = 0; g < groups; g += 1) {
    let part = '';
    for (let i = 0; i < groupLength; i += 1) {
      part += PASSWORD_ALPHABET[crypto.randomInt(0, PASSWORD_ALPHABET.length)];
    }
    segments.push(part);
  }
  return segments.join('-');
}

export function generateSessionSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

export function generateContentKey() {
  return crypto.randomBytes(32).toString('base64url');
}

function decodeAesKey(keyBase64Url) {
  if (typeof keyBase64Url !== 'string' || !keyBase64Url.trim()) {
    throw new Error('Missing VAULT_CONTENT_KEY.');
  }
  const key = Buffer.from(keyBase64Url.trim(), 'base64url');
  if (key.length !== 32) {
    throw new Error('VAULT_CONTENT_KEY must decode to exactly 32 bytes (256 bits).');
  }
  return key;
}

export function encryptVaultPayload(plaintextUtf8, keyBase64Url) {
  const key = decodeAesKey(keyBase64Url);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintextUtf8, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    alg: 'AES-256-GCM',
    v: 1,
    iv: iv.toString('base64url'),
    tag: authTag.toString('base64url'),
    ct: ciphertext.toString('base64'),
  };
}

export function decryptVaultPayload(envelope, keyBase64Url) {
  if (
    !envelope ||
    envelope.alg !== 'AES-256-GCM' ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.tag !== 'string' ||
    typeof envelope.ct !== 'string'
  ) {
    throw new Error('Invalid encrypted vault bundle envelope.');
  }
  const key = decodeAesKey(keyBase64Url);
  const iv = Buffer.from(envelope.iv, 'base64url');
  const authTag = Buffer.from(envelope.tag, 'base64url');
  const ciphertext = Buffer.from(envelope.ct, 'base64');
  if (iv.length !== 12 || authTag.length !== 16) {
    throw new Error('Malformed AES-GCM IV or authentication tag.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plainBuf = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plainBuf.toString('utf8');
}

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64url')}:${derived.toString('base64url')}`;
}

export function verifyPassword(password, encodedHash) {
  if (typeof password !== 'string' || typeof encodedHash !== 'string') {
    return false;
  }
  const trimmed = encodedHash.trim();
  const parts = trimmed.includes(':') ? trimmed.split(':') : trimmed.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    throw new Error('Malformed VAULT_PASSWORD_HASH format.');
  }

  const n = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || n < 16384) {
    throw new Error('Invalid scrypt cost parameters in VAULT_PASSWORD_HASH.');
  }

  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (salt.length < 16 || expected.length < 32) {
    throw new Error('Invalid salt or digest length in VAULT_PASSWORD_HASH.');
  }

  const actual = crypto.scryptSync(password.normalize('NFKC'), salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });

  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

export function createSessionToken(secret, ttlSeconds = 43200) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new Error('VAULT_SESSION_SECRET must be at least 32 characters long.');
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlSeconds;
  const nonce = crypto.randomBytes(16).toString('base64url');
  const payload = `${TOKEN_VERSION}.${now}.${exp}.${nonce}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySessionToken(token, secret) {
  if (typeof token !== 'string' || typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    return false;
  }
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== TOKEN_VERSION) {
    return false;
  }

  const iat = Number.parseInt(parts[1], 10);
  const exp = Number.parseInt(parts[2], 10);
  const nonce = parts[3];
  const providedSig = parts[4];
  if (!Number.isFinite(iat) || !Number.isFinite(exp) || !nonce || !providedSig) {
    return false;
  }

  const payload = `${parts[0]}.${parts[1]}.${parts[2]}.${nonce}`;
  const expectedBuf = crypto.createHmac('sha256', secret).update(payload).digest();
  const providedBuf = Buffer.from(providedSig, 'base64url');

  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  return exp > now && iat <= now + 60;
}
