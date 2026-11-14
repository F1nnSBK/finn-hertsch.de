import fs from 'node:fs';
import path from 'node:path';
import { isPostPublished, resolveProjectRoot } from '../publicationState.mjs';
import { decryptVaultPayload, encryptVaultPayload } from './crypto.mjs';
import { getEnvValue, VaultConfigError } from './http.mjs';

const ENCRYPTED_BUNDLE_REL = 'vault-encrypted/bundle.enc.json';
const LOCAL_VAULT_REL = '.vault-local';

function collectFilesRecursively(baseDir, prefix = '') {
  const result = {};
  if (!fs.existsSync(baseDir)) return result;
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, collectFilesRecursively(full, rel));
    } else if (entry.isFile()) {
      result[rel] = fs.readFileSync(full).toString('base64');
    }
  }
  return result;
}

export function sealLocalVaultToEncryptedBundle(explicitKey) {
  const root = resolveProjectRoot();
  const localDir = path.join(root, LOCAL_VAULT_REL);
  if (!fs.existsSync(localDir)) {
    return false;
  }

  const key = explicitKey ?? getEnvValue('VAULT_CONTENT_KEY');
  if (!key) {
    throw new VaultConfigError('VAULT_CONTENT_KEY is required to seal .vault-local.');
  }

  const blogDir = path.join(localDir, 'blog');
  const blogEnDir = path.join(blogDir, 'en');
  const distillRoot = path.join(localDir, 'distill');

  const markdownPosts = {};
  if (fs.existsSync(blogDir)) {
    for (const file of fs.readdirSync(blogDir).filter((f) => f.endsWith('.md'))) {
      const slug = file.replace(/\.md$/, '');
      markdownPosts[slug] = markdownPosts[slug] ?? { de: null, en: null, distillBundle: null };
      markdownPosts[slug].de = fs.readFileSync(path.join(blogDir, file), 'utf8');
    }
  }
  if (fs.existsSync(blogEnDir)) {
    for (const file of fs.readdirSync(blogEnDir).filter((f) => f.endsWith('.md'))) {
      const slug = file.replace(/\.md$/, '');
      markdownPosts[slug] = markdownPosts[slug] ?? { de: null, en: null, distillBundle: null };
      markdownPosts[slug].en = fs.readFileSync(path.join(blogEnDir, file), 'utf8');
    }
  }

  for (const [slug, entry] of Object.entries(markdownPosts)) {
    const sample = entry.de ?? entry.en ?? '';
    const urlMatch = sample.match(/^url:\s*["']?\/blog\/([a-z0-9-]+)\/?["']?$/m);
    if (urlMatch) {
      entry.distillBundle = urlMatch[1];
    }
  }

  const distillBundles = {};
  if (fs.existsSync(distillRoot)) {
    for (const bundleName of fs.readdirSync(distillRoot)) {
      const bundlePath = path.join(distillRoot, bundleName);
      if (!fs.statSync(bundlePath).isDirectory()) continue;
      distillBundles[bundleName] = {
        de: collectFilesRecursively(path.join(bundlePath, 'de')),
        en: collectFilesRecursively(path.join(bundlePath, 'en')),
      };
    }
  }

  const payloadJson = JSON.stringify({ markdownPosts, distillBundles });
  const envelope = encryptVaultPayload(payloadJson, key);
  const outPath = path.join(root, ENCRYPTED_BUNDLE_REL);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  return true;
}

export function openEncryptedVaultBundle() {
  const root = resolveProjectRoot();
  const bundlePath = path.join(root, ENCRYPTED_BUNDLE_REL);
  if (!fs.existsSync(bundlePath)) {
    return { markdownPosts: {}, distillBundles: {} };
  }
  const key = getEnvValue('VAULT_CONTENT_KEY');
  if (!key) {
    console.error('[vault] Missing VAULT_CONTENT_KEY in environment.');
    throw new VaultConfigError('Zugang momentan nicht verfügbar.');
  }
  const envelope = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  const decrypted = decryptVaultPayload(envelope, key);
  return JSON.parse(decrypted);
}

export function syncMaterializedVaultPostsForBuild() {
  const root = resolveProjectRoot();
  const materializedDir = path.join(root, 'src/content/blog/_published');
  fs.rmSync(materializedDir, { recursive: true, force: true });

  const bundlePath = path.join(root, ENCRYPTED_BUNDLE_REL);
  if (!fs.existsSync(bundlePath)) {
    return;
  }

  const key = getEnvValue('VAULT_CONTENT_KEY');
  if (!key) {
    return;
  }

  const { markdownPosts } = openEncryptedVaultBundle();
  for (const [slug, entry] of Object.entries(markdownPosts)) {
    if (!isPostPublished(slug)) continue;
    if (entry.de) {
      const deTarget = path.join(materializedDir, `${slug}.md`);
      fs.mkdirSync(path.dirname(deTarget), { recursive: true });
      fs.writeFileSync(deTarget, entry.de, 'utf8');
    }
    if (entry.en) {
      const enTarget = path.join(materializedDir, 'en', `${slug}.md`);
      fs.mkdirSync(path.dirname(enTarget), { recursive: true });
      fs.writeFileSync(enTarget, entry.en, 'utf8');
    }
  }
}
