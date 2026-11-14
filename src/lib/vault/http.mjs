import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from '../publicationState.mjs';
import { verifySessionToken } from './crypto.mjs';

const PROD_COOKIE_NAME = '__Host-fh_vault';
const DEV_COOKIE_NAME = 'fh_vault';
const SESSION_TTL_SECONDS = 43200;
const MAX_FAILED_ATTEMPTS = 6;
const WINDOW_MS = 10 * 60 * 1000;

const failedAttemptBuckets = new Map();

export class VaultHttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class VaultConfigError extends VaultHttpError {
  constructor(message) {
    super(503, message, 'VAULT_NOT_CONFIGURED');
  }
}

export class VaultAuthError extends VaultHttpError {
  constructor(message = 'Authentication required.') {
    super(401, message, 'UNAUTHORIZED');
  }
}

export class VaultForbiddenError extends VaultHttpError {
  constructor(message = 'Cross-origin request rejected.') {
    super(403, message, 'FORBIDDEN');
  }
}

export class VaultBadRequestError extends VaultHttpError {
  constructor(message) {
    super(400, message, 'BAD_REQUEST');
  }
}

export class VaultNotFoundError extends VaultHttpError {
  constructor(message = 'Requested resource not found.') {
    super(404, message, 'NOT_FOUND');
  }
}

export class VaultRateLimitError extends VaultHttpError {
  constructor(retryAfterSec) {
    super(429, `Too many failed unlock attempts. Try again in ${retryAfterSec}s.`, 'RATE_LIMITED');
    this.retryAfterSec = retryAfterSec;
  }
}

export class VaultUpstreamError extends VaultHttpError {
  constructor(message) {
    super(502, message, 'UPSTREAM_ERROR');
  }
}

function readLocalDotEnv() {
  if (process.env.VERCEL === '1') {
    return {};
  }
  const envPath = path.join(resolveProjectRoot(), '.env');
  if (!fs.existsSync(envPath)) {
    return {};
  }
  const entries = {};
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let val = line.slice(eqIndex + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    entries[key] = val;
  }
  return entries;
}

export function getEnvValue(name) {
  if (process.env[name] && process.env[name].trim().length > 0) {
    return process.env[name].trim();
  }
  const local = readLocalDotEnv();
  return local[name] ? local[name].trim() : undefined;
}

export function loadVaultCredentials() {
  const passwordHash = getEnvValue('VAULT_PASSWORD_HASH');
  const sessionSecret = getEnvValue('VAULT_SESSION_SECRET');
  if (!passwordHash || !sessionSecret) {
    throw new VaultConfigError(
      'Vault credentials missing. Set VAULT_PASSWORD_HASH and VAULT_SESSION_SECRET (run `npm run vault:setup` locally or configure Vercel Environment Variables).'
    );
  }
  if (sessionSecret.length < 32) {
    throw new VaultConfigError('VAULT_SESSION_SECRET must be at least 32 characters long.');
  }
  return { passwordHash, sessionSecret };
}

export function isSecureRequest(request) {
  if (process.env.VERCEL === '1') return true;
  const proto = request.headers.get('x-forwarded-proto');
  if (proto && proto.split(',')[0].trim() === 'https') return true;
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseCookies(cookieHeader) {
  const map = new Map();
  if (!cookieHeader) return map;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    map.set(k, decodeURIComponent(v));
  }
  return map;
}

export function hasValidSession(request) {
  const { sessionSecret } = loadVaultCredentials();
  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies.get(PROD_COOKIE_NAME) ?? cookies.get(DEV_COOKIE_NAME);
  if (!token) return false;
  return verifySessionToken(token, sessionSecret);
}

export function requireSession(request) {
  if (!hasValidSession(request)) {
    throw new VaultAuthError('Invalid or expired vault session.');
  }
}

export function assertSameOrigin(request) {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new VaultForbiddenError();
  }
  const origin = request.headers.get('origin');
  if (origin) {
    const reqOrigin = new URL(request.url).origin;
    const forwardedHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
    const originHost = new URL(origin).host;
    if (origin !== reqOrigin && originHost !== forwardedHost) {
      throw new VaultForbiddenError();
    }
  }
}

export function buildSessionCookie(token, request) {
  const secure = isSecureRequest(request);
  const name = secure ? PROD_COOKIE_NAME : DEV_COOKIE_NAME;
  const parts = [
    `${name}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function buildClearSessionCookie(request) {
  const secure = isSecureRequest(request);
  const name = secure ? PROD_COOKIE_NAME : DEV_COOKIE_NAME;
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function getClientKey(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? 'local';
}

export function checkLoginRateLimit(request) {
  const key = getClientKey(request);
  const now = Date.now();
  const bucket = failedAttemptBuckets.get(key);
  if (!bucket) return;
  const recent = bucket.filter((ts) => now - ts < WINDOW_MS);
  if (recent.length === 0) {
    failedAttemptBuckets.delete(key);
    return;
  }
  failedAttemptBuckets.set(key, recent);
  if (recent.length >= MAX_FAILED_ATTEMPTS) {
    const oldest = recent[0];
    const retryAfterSec = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));
    throw new VaultRateLimitError(retryAfterSec);
  }
}

export function recordFailedLogin(request) {
  const key = getClientKey(request);
  const now = Date.now();
  const bucket = (failedAttemptBuckets.get(key) ?? []).filter((ts) => now - ts < WINDOW_MS);
  bucket.push(now);
  failedAttemptBuckets.set(key, bucket);
}

export function clearFailedLogins(request) {
  failedAttemptBuckets.delete(getClientKey(request));
}

export function securityHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  };
}

export function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: securityHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    }),
  });
}

export function errorResponse(err) {
  if (err instanceof VaultHttpError) {
    const extra = {};
    if (err instanceof VaultRateLimitError) {
      extra['Retry-After'] = String(err.retryAfterSec);
    }
    return jsonResponse({ error: err.message, code: err.code }, err.status, extra);
  }
  console.error('[vault] Unhandled server error:', err);
  return jsonResponse(
    { error: 'Internal server error in vault handler.', code: 'INTERNAL_ERROR' },
    500
  );
}
