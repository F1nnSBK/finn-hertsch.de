import assert from 'node:assert/strict';
import test from 'node:test';
import * as sessionRoute from '../api/vault/session.mjs';
import * as previewRoute from '../api/vault/preview.mjs';
import * as assetRoute from '../api/vault/asset.mjs';
import * as publishRoute from '../api/vault/publish.mjs';
import { hashPassword, verifyPassword } from '../src/lib/vault/crypto.mjs';
import { isPostPublished } from '../src/lib/publicationState.mjs';

import { getEnvValue } from '../src/lib/vault/http.mjs';

const TEST_PASSWORD = 'UnitTest-Vault-StrongPass-9921';
const TEST_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef';

process.env.VAULT_CONTENT_KEY = getEnvValue('VAULT_CONTENT_KEY');
process.env.VAULT_PASSWORD_HASH = hashPassword(TEST_PASSWORD);
process.env.VAULT_SESSION_SECRET = TEST_SECRET;

test('scrypt password hashing and verification rejects wrong passwords', () => {
  assert.equal(verifyPassword(TEST_PASSWORD, process.env.VAULT_PASSWORD_HASH), true);
  assert.equal(verifyPassword('wrong-password-12345', process.env.VAULT_PASSWORD_HASH), false);
});

test('unauthenticated requests to session, preview, asset, and publish are rejected', async () => {
  const sessionRes = await sessionRoute.GET(new Request('http://localhost:4321/api/vault/session'));
  assert.equal(sessionRes.status, 401);

  const previewHtmlRes = await previewRoute.GET(
    new Request('http://localhost:4321/api/vault/preview?slug=example-draft', {
      headers: { Accept: 'text/html' },
    })
  );
  assert.equal(previewHtmlRes.status, 302);
  assert.equal(previewHtmlRes.headers.get('location'), '/vault');

  const assetRes = await assetRoute.GET(
    new Request('http://localhost:4321/api/vault/asset?bundle=example&lang=de&path=assets/fig.svg')
  );
  assert.equal(assetRes.status, 401);

  const publishRes = await publishRoute.POST(
    new Request('http://localhost:4321/api/vault/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'example-draft', published: true }),
    })
  );
  assert.equal(publishRes.status, 401);
});

test('authenticated session decrypts AES-256-GCM bundle, previews drafts, blocks path traversal, and toggles publish state', async () => {
  const wrongLogin = await sessionRoute.POST(
    new Request('http://localhost:4321/api/vault/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ password: 'incorrect-password' }),
    })
  );
  assert.equal(wrongLogin.status, 401);

  const loginRes = await sessionRoute.POST(
    new Request('http://localhost:4321/api/vault/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    })
  );
  assert.equal(loginRes.status, 200);
  const loginData = await loginRes.json();
  assert.ok(Array.isArray(loginData.posts));
  assert.ok(loginData.posts.length >= 3);

  const setCookie = loginRes.headers.get('set-cookie') || '';
  assert.match(setCookie, /fh_vault=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookieHeader = setCookie.split(';')[0];

  const distillDraft = loginData.posts.find((p) => !p.published && p.distillBundle);
  const mdDraft = loginData.posts.find((p) => !p.published && !p.distillBundle);
  assert.ok(distillDraft);
  assert.ok(mdDraft);

  const crossOriginRes = await publishRoute.POST(
    new Request('http://localhost:4321/api/vault/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ slug: mdDraft.slug, published: true }),
    })
  );
  assert.equal(crossOriginRes.status, 403);

  const distillPreview = await previewRoute.GET(
    new Request(`http://localhost:4321/api/vault/preview?slug=${distillDraft.slug}&lang=de`, {
      headers: { Cookie: cookieHeader },
    })
  );
  assert.equal(distillPreview.status, 200);
  const distillBody = await distillPreview.text();
  assert.match(distillBody, /id="fh-vault-banner"/);
  assert.match(distillBody, /\/api\/vault\/asset\?bundle=/);

  const mdPreview = await previewRoute.GET(
    new Request(`http://localhost:4321/api/vault/preview?slug=${mdDraft.slug}&lang=de`, {
      headers: { Cookie: cookieHeader },
    })
  );
  assert.equal(mdPreview.status, 200);
  const mdBody = await mdPreview.text();
  assert.match(mdBody, /katex/);
  assert.match(mdBody, /Inhaltsverzeichnis/);

  const svgRes = await assetRoute.GET(
    new Request(
      `http://localhost:4321/api/vault/asset?bundle=${distillDraft.distillBundle}&lang=de&path=assets/architecture.svg`,
      { headers: { Cookie: cookieHeader } }
    )
  );
  assert.equal(svgRes.status, 200);
  assert.match(svgRes.headers.get('content-type') || '', /image\/svg\+xml/);

  const traversalRes = await assetRoute.GET(
    new Request(
      `http://localhost:4321/api/vault/asset?bundle=${distillDraft.distillBundle}&lang=de&path=../../../../.env`,
      { headers: { Cookie: cookieHeader } }
    )
  );
  assert.equal(traversalRes.status, 400);

  assert.equal(isPostPublished(mdDraft.slug), false);
  try {
    const pubRes = await publishRoute.POST(
      new Request('http://localhost:4321/api/vault/publish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
          Origin: 'http://localhost:4321',
        },
        body: JSON.stringify({ slug: mdDraft.slug, published: true }),
      })
    );
    assert.equal(pubRes.status, 200);
    assert.equal(isPostPublished(mdDraft.slug), true);
  } finally {
    const unpubRes = await publishRoute.POST(
      new Request('http://localhost:4321/api/vault/publish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
          Origin: 'http://localhost:4321',
        },
        body: JSON.stringify({ slug: mdDraft.slug, published: false }),
      })
    );
    assert.equal(unpubRes.status, 200);
    assert.equal(isPostPublished(mdDraft.slug), false);
  }

  process.env.VERCEL = '1';
  delete process.env.GITHUB_PUBLISH_TOKEN;
  try {
    const prodLogin = await sessionRoute.POST(
      new Request('https://finn-hertsch.de/api/vault/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://finn-hertsch.de' },
        body: JSON.stringify({ password: TEST_PASSWORD }),
      })
    );
    const prodCookie = (prodLogin.headers.get('set-cookie') || '').split(';')[0];
    assert.match(prodCookie, /^__Host-fh_vault=/);

    const failClosedRes = await publishRoute.POST(
      new Request('https://finn-hertsch.de/api/vault/publish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: prodCookie,
          Origin: 'https://finn-hertsch.de',
        },
        body: JSON.stringify({ slug: mdDraft.slug, published: true }),
      })
    );
    assert.equal(failClosedRes.status, 503);
  } finally {
    delete process.env.VERCEL;
  }
});
