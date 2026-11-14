import { createSessionToken, verifyPassword } from '../../src/lib/vault/crypto.mjs';
import {
  assertSameOrigin,
  buildClearSessionCookie,
  buildSessionCookie,
  checkLoginRateLimit,
  clearFailedLogins,
  errorResponse,
  hasValidSession,
  jsonResponse,
  loadVaultCredentials,
  recordFailedLogin,
  VaultAuthError,
  VaultBadRequestError,
} from '../../src/lib/vault/http.mjs';
import { listAllVaultPosts } from '../../src/lib/vault/repository.mjs';

export async function GET(request) {
  try {
    if (!hasValidSession(request)) {
      return jsonResponse({ authenticated: false }, 401);
    }
    const posts = listAllVaultPosts();
    return jsonResponse({
      authenticated: true,
      environment: process.env.VERCEL === '1' ? 'vercel' : 'local',
      posts,
    });
  } catch (err) {
    console.error('[vault/session GET]', err);
    return errorResponse(err);
  }
}

export async function POST(request) {
  try {
    assertSameOrigin(request);
    checkLoginRateLimit(request);
    const { passwordHash, sessionSecret } = loadVaultCredentials();

    let body;
    try {
      body = await request.json();
    } catch {
      throw new VaultBadRequestError('Request body must be valid JSON.');
    }

    const password = typeof body?.password === 'string' ? body.password.trim() : '';
    if (!password) {
      throw new VaultBadRequestError('Passwort erforderlich.');
    }

    const valid = verifyPassword(password, passwordHash);
    if (!valid) {
      recordFailedLogin(request);
      throw new VaultAuthError('Zugriff verweigert.');
    }

    clearFailedLogins(request);
    const token = createSessionToken(sessionSecret);
    const posts = listAllVaultPosts();

    return jsonResponse(
      {
        authenticated: true,
        environment: process.env.VERCEL === '1' ? 'vercel' : 'local',
        posts,
      },
      200,
      { 'Set-Cookie': buildSessionCookie(token, request) }
    );
  } catch (err) {
    console.error('[vault/session POST]', err);
    return errorResponse(err);
  }
}

export async function DELETE(request) {
  try {
    assertSameOrigin(request);
    return jsonResponse(
      { authenticated: false },
      200,
      { 'Set-Cookie': buildClearSessionCookie(request) }
    );
  } catch (err) {
    console.error('[vault/session DELETE]', err);
    return errorResponse(err);
  }
}
