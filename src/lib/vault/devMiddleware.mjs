import fs from 'node:fs';
import path from 'node:path';
import { isPostPublished, resolveProjectRoot } from '../publicationState.mjs';
import {
  openEncryptedVaultBundle,
  sealLocalVaultToEncryptedBundle,
  syncMaterializedVaultPostsForBuild,
} from './archive.mjs';
import * as sessionHandler from '../../../api/vault/session.mjs';
import * as publishHandler from '../../../api/vault/publish.mjs';
import * as previewHandler from '../../../api/vault/preview.mjs';
import * as assetHandler from '../../../api/vault/asset.mjs';
import * as shareHandler from '../../../api/vault/share.mjs';

const API_ROUTES = {
  '/api/vault/session': sessionHandler,
  '/api/vault/publish': publishHandler,
  '/api/vault/preview': previewHandler,
  '/api/vault/asset': assetHandler,
  '/api/vault/share': shareHandler,
  '/share': shareHandler,
};

const DISTILL_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.bib': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
};

function readNodeBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function toWebRequest(req) {
  const host = req.headers.host || 'localhost:4321';
  const url = `http://${host}${req.url || '/'}`;
  const method = (req.method || 'GET').toUpperCase();
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) {
      headers.set(k, v.join(', '));
    } else if (typeof v === 'string') {
      headers.set(k, v);
    }
  }
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? await readNodeBody(req) : undefined;
  return new Request(url, { method, headers, body });
}

async function sendWebResponse(webRes, res) {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const arrayBuf = await webRes.arrayBuffer();
  res.end(Buffer.from(arrayBuf));
}

function findPublishedDistillBuffer(pathname) {
  const match = pathname.match(/^\/(en\/)?blog\/([a-z0-9-]+)(?:\/(.*))?$/);
  if (!match) return null;
  const lang = match[1] ? 'en' : 'de';
  const bundleName = match[2];
  const rawSub = match[3] || 'index.html';
  if (rawSub.includes('..') || rawSub.startsWith('/')) return null;
  const relPath = rawSub === '' || rawSub.endsWith('/') ? `${rawSub}index.html` : rawSub;

  let bundle;
  try {
    bundle = openEncryptedVaultBundle();
  } catch {
    return null;
  }

  const matchingSlug = Object.entries(bundle.markdownPosts).find(
    ([, meta]) => meta?.distillBundle === bundleName
  )?.[0];
  if (!matchingSlug || !isPostPublished(matchingSlug)) {
    return null;
  }

  const base64Data = bundle.distillBundles?.[bundleName]?.[lang]?.[relPath];
  if (!base64Data) return null;

  const ext = path.posix.extname(relPath).toLowerCase();
  return {
    buffer: Buffer.from(base64Data, 'base64'),
    contentType: DISTILL_MIME[ext] ?? 'application/octet-stream',
  };
}

export function vaultDevServerPlugin(publicDir) {
  return {
    name: 'vault-and-public-dir-middleware',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();
        let [pathname, query] = req.url.split('?');

        if (pathname.startsWith('/share/') && pathname.length > '/share/'.length) {
          const rawToken = pathname.slice('/share/'.length);
          req.url = `/api/vault/share?t=${rawToken}${query ? `&${query}` : ''}`;
          [pathname, query] = req.url.split('?');
        }

        const routeModule = API_ROUTES[pathname];
        if (routeModule) {
          const method = (req.method || 'GET').toUpperCase();
          const handler = routeModule[method];
          if (typeof handler !== 'function') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: `Method ${method} not allowed.` }));
            return;
          }
          try {
            const webReq = await toWebRequest(req);
            const webRes = await handler(webReq);
            await sendWebResponse(webRes, res);
          } catch (err) {
            console.error('[vault dev middleware]', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: 'Internal dev middleware error.' }));
          }
          return;
        }

        const distillAsset = findPublishedDistillBuffer(pathname);
        if (distillAsset) {
          res.statusCode = 200;
          res.setHeader('Content-Type', distillAsset.contentType);
          res.end(distillAsset.buffer);
          return;
        }

        if (pathname && pathname !== '/' && pathname.endsWith('/')) {
          const candidate = path.join(publicDir, pathname, 'index.html');
          if (fs.existsSync(candidate)) {
            req.url = `${pathname}index.html${query ? `?${query}` : ''}`;
          }
        }

        return next();
      });
    },
  };
}

export function vaultDistillBuildIntegration() {
  return {
    name: 'vault-distill-static-copy',
    hooks: {
      'astro:config:setup': () => {
        try {
          sealLocalVaultToEncryptedBundle();
        } catch {
          // Skip auto-seal if VAULT_CONTENT_KEY is not present in build env
        }
        syncMaterializedVaultPostsForBuild();
      },
      'astro:build:done': async ({ dir }) => {
        const outDir = path.resolve(dir.pathname);
        let bundle;
        try {
          bundle = openEncryptedVaultBundle();
        } catch {
          return;
        }

        for (const [slug, meta] of Object.entries(bundle.markdownPosts)) {
          if (!meta?.distillBundle || !isPostPublished(slug)) continue;
          const bundleName = meta.distillBundle;
          const langs = bundle.distillBundles?.[bundleName] ?? {};

          for (const [lang, files] of Object.entries(langs)) {
            const baseTarget =
              lang === 'en'
                ? path.join(outDir, 'en', 'blog', bundleName)
                : path.join(outDir, 'blog', bundleName);
            for (const [relFile, base64Content] of Object.entries(files)) {
              const targetFile = path.join(baseTarget, relFile);
              fs.mkdirSync(path.dirname(targetFile), { recursive: true });
              fs.writeFileSync(targetFile, Buffer.from(base64Content, 'base64'));
            }
          }
        }

        const root = resolveProjectRoot();
        fs.rmSync(path.join(root, 'src/content/blog/_published'), {
          recursive: true,
          force: true,
        });
      },
    },
  };
}
