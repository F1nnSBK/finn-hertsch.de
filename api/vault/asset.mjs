import {
  errorResponse,
  requireSession,
  securityHeaders,
} from '../../src/lib/vault/http.mjs';
import { resolveVaultAsset } from '../../src/lib/vault/repository.mjs';

export async function GET(request) {
  try {
    requireSession(request);

    const url = new URL(request.url);
    const bundle = url.searchParams.get('bundle') ?? '';
    const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'de';
    const assetPath = url.searchParams.get('path') ?? '';

    const { buffer, contentType } = resolveVaultAsset(bundle, lang, assetPath);
    return new Response(buffer, {
      status: 200,
      headers: securityHeaders({
        'Content-Type': contentType,
      }),
    });
  } catch (err) {
    console.error('[vault/asset GET]', err);
    return errorResponse(err);
  }
}
