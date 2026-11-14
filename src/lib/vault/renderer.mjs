import fs from 'node:fs';
import path from 'node:path';
import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRawHtmlMath from '../rehypeRawHtmlMath.mjs';
import { resolveProjectRoot } from '../publicationState.mjs';
import { loadPostForPreview } from './repository.mjs';

let processorPromise = null;

function getMarkdownProcessor() {
  if (!processorPromise) {
    processorPromise = createMarkdownProcessor({
      remarkPlugins: [remarkMath],
      rehypePlugins: [rehypeKatex, rehypeRawHtmlMath],
      shikiConfig: {
        theme: 'github-dark',
        wrap: true,
      },
    });
  }
  return processorPromise;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatExpiryLabel(expiresAtUnixSec, lang) {
  if (!Number.isFinite(expiresAtUnixSec)) return '';
  const dt = new Date(expiresAtUnixSec * 1000);
  const formatted = dt.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return lang === 'en' ? ` · valid until ${formatted}` : ` · gültig bis ${formatted}`;
}

function buildVaultBannerHtml({
  slug,
  lang,
  published,
  isDistill,
  hasDistill,
  viewerMode = 'admin',
  expiresAt = null,
}) {
  const otherLang = lang === 'de' ? 'en' : 'de';
  const isShare = viewerMode === 'share';
  const baseRoute = isShare ? '/share' : '/api/vault/preview';
  const leftHref = isShare ? (lang === 'en' ? '/en/' : '/') : '/vault';
  const leftLabel = isShare ? '← finn-hertsch.de' : '← /vault';

  const statusLabel = isShare
    ? (lang === 'de' ? 'GETEILTER ENTWURF · NUR LESEN' : 'SHARED DRAFT · READ ONLY') +
      formatExpiryLabel(expiresAt, lang)
    : published
      ? lang === 'de'
        ? 'LIVE · ÖFFENTLICH'
        : 'LIVE · PUBLIC'
      : lang === 'de'
        ? 'ENTWURF · PASSWORTGESCHÜTZT'
        : 'DRAFT · PASSWORD PROTECTED';
  const statusColor = !isShare && published ? '#16a34a' : '#d97706';
  const modeToggleHtml = hasDistill
    ? isDistill
      ? `<a href="${baseRoute}?slug=${encodeURIComponent(slug)}&lang=${lang}&mode=markdown" style="color:#cbd5e1;text-decoration:none;margin-right:0.9rem;">[Markdown]</a>`
      : `<a href="${baseRoute}?slug=${encodeURIComponent(slug)}&lang=${lang}" style="color:#cbd5e1;text-decoration:none;margin-right:0.9rem;">[Distill]</a>`
    : '';
  const modeParam = !isDistill && hasDistill ? '&mode=markdown' : '';

  return `
<div id="fh-vault-banner" style="position:sticky;top:0;z-index:9999;width:100%;background:#111111;color:#f5f5f4;border-bottom:1px solid #292524;padding:0.55rem 1.25rem;font-family:'JetBrains Mono','SF Mono',Menlo,monospace;font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:1rem;box-sizing:border-box;">
  <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">
    <a href="${leftHref}" style="color:#f5f5f4;text-decoration:none;font-weight:600;">${leftLabel}</a>
    <span style="opacity:0.35;">|</span>
    <span style="display:inline-flex;align-items:center;gap:0.4rem;color:${statusColor};font-weight:600;">
      <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${statusColor};"></span>
      ${escapeHtml(statusLabel)}
    </span>
  </div>
  <div style="display:flex;align-items:center;">
    ${modeToggleHtml}
    <a href="${baseRoute}?slug=${encodeURIComponent(slug)}&lang=${otherLang}${modeParam}" style="color:#f5f5f4;text-decoration:underline;text-underline-offset:3px;">[${otherLang.toUpperCase()}]</a>
  </div>
</div>`;
}

function rewriteDistillPreviewHtml(
  html,
  { slug, bundle, lang, published, viewerMode = 'admin', expiresAt = null }
) {
  const otherLang = lang === 'de' ? 'en' : 'de';
  const isShare = viewerMode === 'share';
  const baseRoute = isShare ? '/share' : '/api/vault/preview';
  const backLinkHtml = isShare
    ? `<a href="${lang === 'en' ? '/en/' : '/'}">← finn-hertsch.de</a>`
    : '<a href="/vault">← /vault</a>';
  let output = html;

  output = output.replace(
    /<!-- Automatic Language Detection[\s\S]*?<\/script>/i,
    '<!-- Language auto-redirect disabled inside preview -->'
  );

  output = output.replace(
    /<!-- Cookieless Vercel Web Analytics -->[\s\S]*?\/_vercel\/insights\/script\.js"><\/script>/i,
    ''
  );

  output = output.replace(
    /(src|href)="assets\/([^"]+)"/g,
    (_match, attr, assetFile) =>
      `${attr}="/api/vault/asset?bundle=${encodeURIComponent(bundle)}&lang=${lang}&path=${encodeURIComponent(`assets/${assetFile}`)}"`
  );

  output = output.replace(/<a href="\/(?:en\/)?blog">← \/(?:en\/)?blog<\/a>/g, backLinkHtml);

  const escapedBundle = bundle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  output = output.replace(
    new RegExp(`<a href="\\/(?:en\\/)?blog\\/${escapedBundle}\\/\\?lang=(?:en|de)" class="lang-toggle">`, 'g'),
    `<a href="${baseRoute}?slug=${encodeURIComponent(slug)}&lang=${otherLang}" class="lang-toggle">`
  );

  const banner = buildVaultBannerHtml({
    slug,
    lang,
    published,
    isDistill: true,
    hasDistill: true,
    viewerMode,
    expiresAt,
  });

  output = output.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
  return output;
}

function rewriteMarkdownVaultAssets(renderedHtml, lang) {
  return renderedHtml.replace(
    /\/(?:en\/)?blog\/([a-z0-9-]+)\/assets\/([^"'\s>]+)/g,
    (_match, bundle, file) =>
      `/api/vault/asset?bundle=${encodeURIComponent(bundle)}&lang=${lang}&path=${encodeURIComponent(`assets/${file}`)}`
  );
}

function formatPreviewDate(dateStr, lang) {
  const date = new Date(dateStr);
  return date.toLocaleDateString(lang === 'en' ? 'en-US' : 'de-DE', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export async function renderVaultPreview(slug, lang, mode = 'default', options = {}) {
  const viewerMode = options.viewerMode === 'share' ? 'share' : 'admin';
  const expiresAt = options.expiresAt ?? null;
  const post = loadPostForPreview(slug, lang);

  if (post.distillHtml && post.distillBundle && mode !== 'markdown') {
    return rewriteDistillPreviewHtml(post.distillHtml, {
      slug: post.slug,
      bundle: post.distillBundle,
      lang: post.lang,
      published: post.published,
      viewerMode,
      expiresAt,
    });
  }

  const processor = await getMarkdownProcessor();
  const { code: rawHtml, metadata } = await processor.render(post.markdownContent);
  const htmlBody = rewriteMarkdownVaultAssets(rawHtml, post.lang);
  const headings = (metadata?.headings ?? []).filter((h) => h.depth === 2);

  const globalCssPath = path.join(resolveProjectRoot(), 'src/styles/global.css');
  const globalCss = fs.readFileSync(globalCssPath, 'utf8');

  const banner = buildVaultBannerHtml({
    slug: post.slug,
    lang: post.lang,
    published: post.published,
    isDistill: false,
    hasDistill: Boolean(post.distillHtml),
    viewerMode,
    expiresAt,
  });

  const titlePrefix = viewerMode === 'share' ? '[Entwurf]' : '[Vault]';
  const bottomHref = viewerMode === 'share' ? (post.lang === 'en' ? '/en/' : '/') : '/vault';
  const bottomLabel = viewerMode === 'share' ? '← finn-hertsch.de' : '← /vault';

  const tocLabel = post.lang === 'en' ? 'Table of Contents' : 'Inhaltsverzeichnis';
  const tocHtml =
    headings.length > 1
      ? `<nav class="toc-card" aria-label="${tocLabel}">
          <div class="toc-title mono">${tocLabel}</div>
          <ol class="toc-list">
            ${headings
              .map(
                (h, idx) => `<li>
                  <a href="#${escapeHtml(h.slug)}">
                    <span class="toc-num mono">${String(idx + 1).padStart(2, '0')}</span>
                    <span>${escapeHtml(String(h.text).replace(/^\d+\.\s*/, ''))}</span>
                  </a>
                </li>`
              )
              .join('')}
          </ol>
        </nav>`
      : '';

  return `<!DOCTYPE html>
<html lang="${post.lang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow, noarchive" />
  <title>${titlePrefix} ${escapeHtml(post.frontmatter.title)} | Finn Hertsch</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" crossorigin="anonymous" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;1,400;1,500&display=swap" rel="stylesheet" />
  <style>
${globalCss}
    body { padding-top: 0; }
    .vault-main-wrap { width: 100%; display: flex; flex-direction: column; align-items: center; padding: 2.5rem 1.5rem 3rem 1.5rem; }
    .essay-header { margin-bottom: 2rem; }
    .date { margin-bottom: 0.5rem; }
    .title { font-size: 2.1rem; line-height: 1.25; margin-bottom: 1rem; letter-spacing: -0.02em; }
    .summary { font-size: 1.1rem; line-height: 1.6; color: var(--fg-muted); font-style: italic; }
    .essay-content { margin: 2.5rem 0; }
    .toc-card { background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 0.95rem 1.2rem; margin: 1.75rem 0 2rem 0; }
    .toc-title { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-muted); margin-bottom: 0.55rem; }
    .toc-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 0.35rem 1.25rem; }
    .toc-list li { font-size: 0.9rem; line-height: 1.45; }
    .toc-list a { color: var(--fg); text-decoration: none; border-bottom: 1px solid transparent; }
    .toc-list a:hover { border-bottom-color: var(--fg); }
    .toc-num { font-size: 0.78rem; color: var(--fg-muted); margin-right: 0.4rem; }
    .bottom-nav { margin-top: 3rem; padding-bottom: 2rem; }
    .back-link { font-size: 0.9rem; color: var(--fg-muted); text-decoration: none; }
    .back-link:hover { color: var(--fg); text-decoration: underline; }
  </style>
</head>
<body>
  ${banner}
  <div class="vault-main-wrap">
    <main class="container">
      <article class="essay-article">
        <header class="essay-header">
          <div class="date mono muted text-sm">${escapeHtml(formatPreviewDate(post.frontmatter.date, post.lang))}</div>
          <h1 class="title">${escapeHtml(post.frontmatter.title)}</h1>
          <p class="summary">${escapeHtml(post.frontmatter.description)}</p>
        </header>
        <hr />
        ${tocHtml}
        <div class="essay-content">
          ${htmlBody}
        </div>
        <hr />
        <div class="bottom-nav">
          <a href="${bottomHref}" class="back-link mono">${bottomLabel}</a>
        </div>
      </article>
    </main>
  </div>
</body>
</html>`;
}

export function renderShareExpiredPage(lang = 'de') {
  const globalCssPath = path.join(resolveProjectRoot(), 'src/styles/global.css');
  const globalCss = fs.readFileSync(globalCssPath, 'utf8');
  const isEn = lang === 'en';
  const heading = isEn ? 'Link expired or invalid' : 'Teilen-Link abgelaufen oder ungültig';
  const message = isEn
    ? 'This temporary read-only draft link is no longer valid. Please ask the author for a new link if needed.'
    : 'Dieser zeitlich begrenzte Lese-Link für einen unveröffentlichten Entwurf ist abgelaufen oder ungültig.';
  const homeHref = isEn ? '/en/' : '/';

  return `<!DOCTYPE html>
<html lang="${isEn ? 'en' : 'de'}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow, noarchive" />
  <title>${heading} | Finn Hertsch</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
${globalCss}
    .expired-box { margin-top: 3rem; padding: 1.5rem; border: 1px solid var(--border); border-radius: 6px; background: var(--code-bg); }
    .expired-box h1 { font-size: 1.45rem; margin: 0.35rem 0 0.65rem 0; }
    .expired-box p { margin: 0 0 1.25rem 0; color: var(--fg-muted); }
  </style>
</head>
<body>
  <main class="container">
    <div class="expired-box">
      <div class="mono text-sm muted">[410 · EXPIRED]</div>
      <h1>${heading}</h1>
      <p>${message}</p>
      <a href="${homeHref}" class="mono text-sm">← finn-hertsch.de</a>
    </div>
  </main>
</body>
</html>`;
}
