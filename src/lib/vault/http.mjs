import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from '../publicationState.mjs';
import { verifySessionToken, verifyShareToken } from './crypto.mjs';

const PROD_COOKIE_NAME = '__Host-fh_vault';
const DEV_COOKIE_NAME = 'fh_vault';
const PROD_SHARE_COOKIE_NAME = '__Host-fh_share';
const DEV_SHARE_COOKIE_NAME = 'fh_share';
const SESSION_TTL_SECONDS = 43200;
const MAX_SHARE_GRANTS = 6;
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

function stripOuterQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function getEnvValue(name) {
  if (process.env[name] && process.env[name].trim().length > 0) {
    return stripOuterQuotes(process.env[name]);
  }
  const local = readLocalDotEnv();
  return local[name] ? stripOuterQuotes(local[name]) : undefined;
}

export function loadVaultCredentials() {
  const passwordHash = getEnvValue('VAULT_PASSWORD_HASH');
  const sessionSecret = getEnvValue('VAULT_SESSION_SECRET');
  if (!passwordHash || !sessionSecret) {
    console.error('[vault] Missing VAULT_PASSWORD_HASH or VAULT_SESSION_SECRET in environment.');
    throw new VaultConfigError('Zugang momentan nicht verfügbar.');
  }
  if (sessionSecret.length < 32) {
    console.error('[vault] VAULT_SESSION_SECRET is shorter than 32 characters.');
    throw new VaultConfigError('Zugang momentan nicht verfügbar.');
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
    try {
      map.set(k, decodeURIComponent(v));
    } catch {
      continue;
    }
  }
  return map;
}

export function getValidShareGrants(request) {
  const { sessionSecret } = loadVaultCredentials();
  const cookies = parseCookies(request.headers.get('cookie'));
  const raw = cookies.get(PROD_SHARE_COOKIE_NAME) ?? cookies.get(DEV_SHARE_COOKIE_NAME);
  if (!raw) return [];
  const grants = [];
  for (const part of raw.split('|')) {
    const parsed = verifyShareToken(part, sessionSecret);
    if (parsed) {
      grants.push(parsed);
    }
  }
  return grants;
}

export function findShareGrantForSlug(request, slug) {
  if (!slug) return null;
  const grants = getValidShareGrants(request);
  return grants.find((g) => g.slug === slug) ?? null;
}

export function hasShareBundleAccess(request, bundleName) {
  if (!bundleName) return false;
  const grants = getValidShareGrants(request);
  return grants.some((g) => g.bundle === bundleName);
}

export function buildShareCookie(newGrant, request) {
  const existing = getValidShareGrants(request).filter((g) => g.slug !== newGrant.slug);
  const merged = [newGrant, ...existing].slice(0, MAX_SHARE_GRANTS);
  const now = Math.floor(Date.now() / 1000);
  const maxExp = Math.max(...merged.map((g) => g.exp));
  const maxAge = Math.max(60, maxExp - now);
  const serialized = merged.map((g) => g.token).join('|');

  const secure = isSecureRequest(request);
  const name = secure ? PROD_SHARE_COOKIE_NAME : DEV_SHARE_COOKIE_NAME;
  const parts = [
    `${name}=${encodeURIComponent(serialized)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
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
