import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '@astrojs/markdown-remark';
import {
  getPostRecord,
  resolveProjectRoot,
} from '../publicationState.mjs';
import { openEncryptedVaultBundle } from './archive.mjs';
import { VaultBadRequestError, VaultNotFoundError } from './http.mjs';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MIME_BY_EXT = {
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bib': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
};

export function assertValidSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    throw new VaultBadRequestError('Invalid post slug.');
  }
}

function parseRawMarkdown(raw) {
  if (typeof raw !== 'string') return null;
  const { frontmatter, content } = parseFrontmatter(raw);
  return { frontmatter, content };
}

function readPublicMarkdown(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return parseRawMarkdown(fs.readFileSync(filePath, 'utf8'));
}

export function listAllVaultPosts() {
  const root = resolveProjectRoot();
  const blogDir = path.join(root, 'src/content/blog');
  const enDir = path.join(blogDir, 'en');
  const bundle = openEncryptedVaultBundle();

  const dePublic = fs.existsSync(blogDir)
    ? fs.readdirSync(blogDir).filter((f) => f.endsWith('.md'))
    : [];
  const enPublic = fs.existsSync(enDir)
    ? fs.readdirSync(enDir).filter((f) => f.endsWith('.md'))
    : [];

  const slugs = new Set([
    ...dePublic.map((f) => f.replace(/\.md$/, '')),
    ...enPublic.map((f) => f.replace(/\.md$/, '')),
    ...Object.keys(bundle.markdownPosts),
  ]);

  const items = [];
  for (const slug of slugs) {
    const vaultEntry = bundle.markdownPosts[slug];
    const deEntry = vaultEntry?.de
      ? parseRawMarkdown(vaultEntry.de)
      : readPublicMarkdown(path.join(blogDir, `${slug}.md`));
    const enEntry = vaultEntry?.en
      ? parseRawMarkdown(vaultEntry.en)
      : readPublicMarkdown(path.join(enDir, `${slug}.md`));

    const record = getPostRecord(slug);
    const distillBundle = vaultEntry?.distillBundle ?? null;
    const date = deEntry?.frontmatter?.date ?? enEntry?.frontmatter?.date ?? '1970-01-01';

    items.push({
      slug,
      date,
      published: Boolean(record.published),
      publishedAt: record.publishedAt ?? null,
      distillBundle,
      hasDe: Boolean(deEntry),
      hasEn: Boolean(enEntry),
      titleDe: deEntry?.frontmatter?.title ?? null,
      titleEn: enEntry?.frontmatter?.title ?? null,
      descriptionDe: deEntry?.frontmatter?.description ?? null,
      descriptionEn: enEntry?.frontmatter?.description ?? null,
      publicUrlDe: deEntry?.frontmatter?.url ?? `/blog/${slug}/`,
      publicUrlEn: enEntry?.frontmatter?.url ?? `/en/blog/${slug}/`,
    });
  }

  items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return items;
}

export function loadPostForPreview(slug, lang) {
  assertValidSlug(slug);
  const normalizedLang = lang === 'en' ? 'en' : 'de';
  const root = resolveProjectRoot();
  const bundle = openEncryptedVaultBundle();
  const vaultEntry = bundle.markdownPosts[slug];

  let mdEntry = null;
  if (vaultEntry) {
    const raw = normalizedLang === 'en' ? vaultEntry.en : vaultEntry.de;
    mdEntry = parseRawMarkdown(raw);
  } else {
    const mdPath =
      normalizedLang === 'en'
        ? path.join(root, 'src/content/blog/en', `${slug}.md`)
        : path.join(root, 'src/content/blog', `${slug}.md`);
    mdEntry = readPublicMarkdown(mdPath);
  }

  if (!mdEntry) {
    throw new VaultNotFoundError(`Post "${slug}" (${normalizedLang}) does not exist.`);
  }

  const distillBundle = vaultEntry?.distillBundle ?? null;
  let distillHtml = null;
  if (distillBundle) {
    const encodedHtml = bundle.distillBundles?.[distillBundle]?.[normalizedLang]?.['index.html'];
    if (encodedHtml) {
      distillHtml = Buffer.from(encodedHtml, 'base64').toString('utf8');
    }
  }

  const record = getPostRecord(slug);
  return {
    slug,
    lang: normalizedLang,
    published: Boolean(record.published),
    distillBundle,
    frontmatter: mdEntry.frontmatter,
    markdownContent: mdEntry.content,
    distillHtml,
  };
}

export function resolveVaultAsset(bundleName, lang, assetRelativePath) {
  if (typeof bundleName !== 'string' || !SLUG_PATTERN.test(bundleName)) {
    throw new VaultBadRequestError('Invalid bundle identifier.');
  }
  const normalizedLang = lang === 'en' ? 'en' : 'de';
  if (
    typeof assetRelativePath !== 'string' ||
    !assetRelativePath.trim() ||
    assetRelativePath.includes('..') ||
    assetRelativePath.startsWith('/') ||
    assetRelativePath.includes('\\')
  ) {
    throw new VaultBadRequestError('Asset path traversal blocked.');
  }

  const normalizedRel = path.posix.normalize(assetRelativePath);
  if (normalizedRel.startsWith('..') || normalizedRel.startsWith('/')) {
    throw new VaultBadRequestError('Asset path traversal blocked.');
  }

  const bundle = openEncryptedVaultBundle();
  const base64Data = bundle.distillBundles?.[bundleName]?.[normalizedLang]?.[normalizedRel];
  if (!base64Data) {
    throw new VaultNotFoundError('Asset not found.');
  }

  const ext = path.posix.extname(normalizedRel).toLowerCase();
  const contentType = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  const buffer = Buffer.from(base64Data, 'base64');
  return { buffer, contentType };
}
