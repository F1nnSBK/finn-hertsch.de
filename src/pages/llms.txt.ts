import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { canonicalizeSlug, isPostPublished } from '../lib/publicationState.mjs';

export const GET: APIRoute = async () => {
  const researchLines = [
    '- [Kairos: Numerically Robust News Recommendation under Item Cold-Start via Cholesky-based LinUCB](https://finn-hertsch.de/research/kairos/): Explorable interactive Distill working paper presenting numerically stable LinUCB multi-armed bandits with rank-1 Cholesky updates on live streaming data. Accepted for publication at SKILL 2026 (INFORMATIK Festival Dresden).',
  ];

  const publishedPosts = await getCollection(
    'blog',
    ({ id, data }) => data.lang === 'de' && isPostPublished(id)
  );
  publishedPosts.sort(
    (a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime()
  );

  const blogLines = publishedPosts.map((post) => {
    const slug = canonicalizeSlug(post.id);
    const targetPath = post.data.url ?? `/blog/${slug}/`;
    const fullUrl = new URL(targetPath, 'https://finn-hertsch.de').href;
    return `- [${post.data.title}](${fullUrl}): ${post.data.description}`;
  });

  const body = [
    '# Finn Hertsch',
    '',
    '> Dual student in Data Science & Artificial Intelligence at DHBW Ravensburg. Researcher focusing on Representation Learning, Self-Supervised Computer Vision, Linear Attention Architectures, and High-Throughput Stream Processing. Based in Wangen im Allgäu, Germany.',
    '',
    '## Research & Publications',
    '',
    ...researchLines,
    '',
    '## Blog & Essays',
    '',
    ...blogLines,
    '',
    '## External Profiles & Codebases',
    '',
    '- [GitHub Profile (F1nnSBK)](https://github.com/F1nnSBK): Open-source repositories, system architectures, and research implementations.',
    '- [Google Scholar: Finn Hertsch](https://scholar.google.com/citations?user=JZoMIcMAAAAJ&hl=en): Academic citations, papers, and peer-reviewed works.',
    '- [Personal Website](https://finn-hertsch.de/): Canonical home page with bilingual support (German and English).',
    '',
  ].join('\n');

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
};
