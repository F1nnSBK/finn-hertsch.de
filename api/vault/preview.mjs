import {
  errorResponse,
  hasValidSession,
  securityHeaders,
  VaultAuthError,
} from '../../src/lib/vault/http.mjs';
import { renderVaultPreview } from '../../src/lib/vault/renderer.mjs';

export async function GET(request) {
  try {
    if (!hasValidSession(request)) {
      const accept = request.headers.get('accept') ?? '';
      if (accept.includes('text/html')) {
        return new Response(null, {
          status: 302,
          headers: securityHeaders({ Location: '/vault' }),
        });
      }
      throw new VaultAuthError();
    }

    const url = new URL(request.url);
    const slug = url.searchParams.get('slug') ?? '';
    const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'de';
    const mode = url.searchParams.get('mode') ?? 'default';

    const html = await renderVaultPreview(slug, lang, mode);
    return new Response(html, {
      status: 200,
      headers: securityHeaders({
        'Content-Type': 'text/html; charset=utf-8',
      }),
    });
  } catch (err) {
    console.error('[vault/preview GET]', err);
    return errorResponse(err);
  }
}
