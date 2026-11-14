import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RELATIVE_STATE_PATH = 'src/data/publication-state.json';

export function resolveProjectRoot() {
  const cwdCandidate = process.cwd();
  if (fs.existsSync(path.join(cwdCandidate, RELATIVE_STATE_PATH))) {
    return cwdCandidate;
  }
  return path.resolve(MODULE_DIR, '../..');
}

export function getPublicationStatePath() {
  return path.join(resolveProjectRoot(), RELATIVE_STATE_PATH);
}

export function canonicalizeSlug(entryId) {
  return String(entryId)
    .replace(/^_published\//, '')
    .replace(/^en\//, '')
    .replace(/\.md$/, '');
}

export function computePostStateKey(entryId) {
  const slug = canonicalizeSlug(entryId);
  return crypto.createHash('sha256').update(`fh-vault-v1:${slug}`).digest('hex').slice(0, 24);
}

export function readPublicationState() {
  const raw = fs.readFileSync(getPublicationStatePath(), 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.records !== 'object') {
    throw new Error('Invalid publication state schema.');
  }
  return parsed;
}

export function isPostPublished(entryId) {
  const key = computePostStateKey(entryId);
  const state = readPublicationState();
  const record = state.records[key];
  return Boolean(record && record.published === true);
}

export function getPostRecord(entryId) {
  const key = computePostStateKey(entryId);
  const state = readPublicationState();
  return state.records[key] ?? { published: false, publishedAt: null };
}
