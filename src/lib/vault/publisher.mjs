import fs from 'node:fs';
import {
  computePostStateKey,
  getPublicationStatePath,
  readPublicationState,
} from '../publicationState.mjs';
import { syncMaterializedVaultPostsForBuild } from './archive.mjs';
import {
  getEnvValue,
  VaultBadRequestError,
  VaultConfigError,
  VaultNotFoundError,
  VaultUpstreamError,
} from './http.mjs';
import { assertValidSlug, listAllVaultPosts } from './repository.mjs';

const DEFAULT_GITHUB_REPO = 'F1nnSBK/finn-hertsch.de';
const DEFAULT_GITHUB_BRANCH = 'main';
const STATE_REPO_PATH = 'src/data/publication-state.json';

function buildUpdatedStateJson(slug, publish) {
  const current = readPublicationState();
  const key = computePostStateKey(slug);
  const existing = current.records[key] ?? {};
  const today = new Date().toISOString().slice(0, 10);

  const nextRecords = { ...current.records };
  if (publish) {
    nextRecords[key] = {
      published: true,
      publishedAt: existing.publishedAt ?? today,
    };
  } else {
    delete nextRecords[key];
  }

  const nextState = {
    version: 1,
    records: nextRecords,
  };

  return `${JSON.stringify(nextState, null, 2)}\n`;
}

async function commitStateViaGitHub(serializedJson) {
  const token = getEnvValue('GITHUB_PUBLISH_TOKEN');
  if (!token) {
    throw new VaultConfigError(
      'GITHUB_PUBLISH_TOKEN is not configured in Vercel Environment Variables. Cannot commit publication state in production.'
    );
  }

  const repo = getEnvValue('GITHUB_REPO') ?? DEFAULT_GITHUB_REPO;
  const branch = getEnvValue('GITHUB_BRANCH') ?? DEFAULT_GITHUB_BRANCH;
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${STATE_REPO_PATH}`;
  const commonHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'finn-hertsch-vault-publisher',
  };

  const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, {
    method: 'GET',
    headers: commonHeaders,
  });

  if (!getRes.ok) {
    const errText = await getRes.text();
    throw new VaultUpstreamError(
      `Failed to read ${STATE_REPO_PATH} from GitHub (${getRes.status}): ${errText.slice(0, 200)}`
    );
  }

  const fileMeta = await getRes.json();
  if (!fileMeta.sha) {
    throw new VaultUpstreamError('GitHub Contents API response did not include file SHA.');
  }

  const putRes = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      ...commonHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: 'chore(vault): update publication state',
      content: Buffer.from(serializedJson, 'utf8').toString('base64'),
      sha: fileMeta.sha,
      branch,
    }),
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new VaultUpstreamError(
      `Failed to commit publication state to GitHub (${putRes.status}): ${errText.slice(0, 200)}`
    );
  }

  const commitPayload = await putRes.json();
  return {
    mode: 'github',
    commitSha: commitPayload?.commit?.sha?.slice(0, 7) ?? null,
    repo,
    branch,
  };
}

function writeStateLocally(serializedJson) {
  const targetPath = getPublicationStatePath();
  const tmpPath = `${targetPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, serializedJson, 'utf8');
  fs.renameSync(tmpPath, targetPath);
  syncMaterializedVaultPostsForBuild();
  return { mode: 'local', commitSha: null };
}

export async function setPostPublicationStatus(slug, publish) {
  assertValidSlug(slug);
  if (typeof publish !== 'boolean') {
    throw new VaultBadRequestError('Field "published" must be a boolean.');
  }

  const knownPosts = listAllVaultPosts();
  if (!knownPosts.some((p) => p.slug === slug)) {
    throw new VaultNotFoundError(`Unknown post slug "${slug}".`);
  }

  const serializedJson = buildUpdatedStateJson(slug, publish);

  if (process.env.VERCEL === '1') {
    const ghResult = await commitStateViaGitHub(serializedJson);
    const optimisticPosts = knownPosts.map((p) =>
      p.slug === slug
        ? {
            ...p,
            published: publish,
            publishedAt: publish ? p.publishedAt ?? new Date().toISOString().slice(0, 10) : null,
          }
        : p
    );
    return {
      slug,
      published: publish,
      ...ghResult,
      posts: optimisticPosts,
    };
  }

  const localResult = writeStateLocally(serializedJson);
  return {
    slug,
    published: publish,
    ...localResult,
    posts: listAllVaultPosts(),
  };
}
