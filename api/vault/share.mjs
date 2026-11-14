import { createShareToken, verifyShareToken } from '../../src/lib/vault/crypto.mjs';
import {
  assertSameOrigin,
  buildShareCookie,
  errorResponse,
  findShareGrantForSlug,
  isSecureRequest,
  jsonResponse,
  loadVaultCredentials,
  requireSession,
  securityHeaders,
  VaultBadRequestError,
  VaultNotFoundError,
} from '../../src/lib/vault/http.mjs';
import { renderShareExpiredPage, renderVaultPreview } from '../../src/lib/vault/renderer.mjs';
import { assertValidSlug, listAllVaultPosts } from '../../src/lib/vault/repository.mjs';

const ALLOWED_TTL_HOURS = new Set([24, 48, 72, 168, 336, 720]);

function resolveRequestOrigin(request) {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (host) {
    const proto = isSecureRequest(request) ? 'https' : 'http';
    return `${proto}://${host.split(',')[0].trim()}`;
  }
  return new URL(request.url).origin;
}

export async function POST(request) {
  try {
    assertSameOrigin(request);
    requireSession(request);
    const { sessionSecret } = loadVaultCredentials();

    let body;
    try {
      body = await request.json();
    } catch {
      throw new VaultBadRequestError('Ungültiger Request-Body.');
    }

    const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
    assertValidSlug(slug);

    const ttlHours = Number.parseInt(String(body?.ttlHours ?? '48'), 10);
    if (!ALLOWED_TTL_HOURS.has(ttlHours)) {
      throw new VaultBadRequestError('Ungültige Gültigkeitsdauer.');
    }

    const langSuffix = body?.lang === 'en' ? '?lang=en' : '';
    const post = listAllVaultPosts().find((p) => p.slug === slug);
    if (!post) {
      throw new VaultNotFoundError('Artikel nicht gefunden.');
    }

    const ttlSeconds = ttlHours * 3600;
    const token = createShareToken(
      {
        slug: post.slug,
        bundle: post.distillBundle,
        ttlSeconds,
      },
      sessionSecret
    );

    const origin = resolveRequestOrigin(request);
    const shareUrl = `${origin}/share/${encodeURIComponent(token)}${langSuffix}`;
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;

    return jsonResponse({
      slug: post.slug,
      ttlHours,
      expiresAt,
      url: shareUrl,
    });
  } catch (err) {
    console.error('[vault/share POST]', err);
    return errorResponse(err);
  }
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'de';
    const mode = url.searchParams.get('mode') ?? 'default';
    const tokenParam = url.searchParams.get('t');

    if (tokenParam) {
      const { sessionSecret } = loadVaultCredentials();
      const grant = verifyShareToken(tokenParam, sessionSecret);
      if (!grant) {
        return new Response(renderShareExpiredPage(lang), {
          status: 410,
          headers: securityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }),
        });
      }

      const targetLocation = `/share?slug=${encodeURIComponent(grant.slug)}&lang=${lang}`;
      return new Response(null, {
        status: 302,
        headers: securityHeaders({
          Location: targetLocation,
          'Set-Cookie': buildShareCookie(grant, request),
        }),
      });
    }

    const slugParam = url.searchParams.get('slug') ?? '';
    const grant = findShareGrantForSlug(request, slugParam);
    if (!grant) {
      return new Response(renderShareExpiredPage(lang), {
        status: 410,
        headers: securityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }),
      });
    }

    const html = await renderVaultPreview(grant.slug, lang, mode, {
      viewerMode: 'share',
      expiresAt: grant.exp,
    });
    return new Response(html, {
      status: 200,
      headers: securityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }),
    });
  } catch (err) {
    console.error('[vault/share GET]', err);
    return errorResponse(err);
  }
}
