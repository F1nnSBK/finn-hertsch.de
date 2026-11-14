import {
  assertSameOrigin,
  errorResponse,
  jsonResponse,
  requireSession,
  VaultBadRequestError,
} from '../../src/lib/vault/http.mjs';
import { setPostPublicationStatus } from '../../src/lib/vault/publisher.mjs';

export async function POST(request) {
  try {
    assertSameOrigin(request);
    requireSession(request);

    let body;
    try {
      body = await request.json();
    } catch {
      throw new VaultBadRequestError('Request body must be valid JSON.');
    }

    const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
    const published = body?.published;

    const result = await setPostPublicationStatus(slug, published);
    return jsonResponse(result, 200);
  } catch (err) {
    console.error('[vault/publish POST]', err);
    return errorResponse(err);
  }
}
