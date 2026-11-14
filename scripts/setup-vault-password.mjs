import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from '../src/lib/publicationState.mjs';
import { sealLocalVaultToEncryptedBundle } from '../src/lib/vault/archive.mjs';
import {
  generateContentKey,
  generateSessionSecret,
  generateStrongPassword,
  hashPassword,
} from '../src/lib/vault/crypto.mjs';

function upsertEnvVar(rawContent, key, value) {
  const escapedValue = `'${value}'`;
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(rawContent)) {
    return rawContent.replace(regex, () => `${key}=${escapedValue}`);
  }
  const suffix = rawContent.length > 0 && !rawContent.endsWith('\n') ? '\n' : '';
  return `${rawContent}${suffix}${key}=${escapedValue}\n`;
}

function readExistingEnvVar(rawContent, key) {
  const match = rawContent.match(new RegExp(`^${key}=["']?([^"'\\r\\n]+)["']?$`, 'm'));
  return match ? match[1] : null;
}

const root = resolveProjectRoot();
const envPath = path.join(root, '.env');
let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

const args = process.argv.slice(2);
const forceRotate = args.includes('--rotate');
const customPassword = args.find((arg) => !arg.startsWith('--'))?.trim();

const existingHash = readExistingEnvVar(envContent, 'VAULT_PASSWORD_HASH');
let printedPassword = null;
let passwordHash = existingHash;

if (forceRotate || customPassword || !existingHash) {
  printedPassword = customPassword || generateStrongPassword(5, 6);
  passwordHash = hashPassword(printedPassword);
}

const existingSecret = readExistingEnvVar(envContent, 'VAULT_SESSION_SECRET');
const sessionSecret =
  !forceRotate && existingSecret && existingSecret.length >= 32
    ? existingSecret
    : generateSessionSecret();

const existingContentKey = readExistingEnvVar(envContent, 'VAULT_CONTENT_KEY');
const contentKey =
  !forceRotate && existingContentKey && Buffer.from(existingContentKey, 'base64url').length === 32
    ? existingContentKey
    : generateContentKey();

envContent = upsertEnvVar(envContent, 'VAULT_PASSWORD_HASH', passwordHash);
envContent = upsertEnvVar(envContent, 'VAULT_SESSION_SECRET', sessionSecret);
envContent = upsertEnvVar(envContent, 'VAULT_CONTENT_KEY', contentKey);
fs.writeFileSync(envPath, envContent, { mode: 0o600 });

sealLocalVaultToEncryptedBundle(contentKey);

console.log('\n=== Vault Credentials Configured ===');
if (printedPassword) {
  console.log(`Password (save in password manager): ${printedPassword}`);
} else {
  console.log('Password: (unchanged existing VAULT_PASSWORD_HASH preserved)');
}
console.log('\nVercel Environment Variables to add:');
console.log(`VAULT_PASSWORD_HASH=${passwordHash}`);
console.log(`VAULT_SESSION_SECRET=${sessionSecret}`);
console.log(`VAULT_CONTENT_KEY=${contentKey}`);
console.log('GITHUB_PUBLISH_TOKEN=<fine-grained GitHub PAT with Contents: Read & Write on F1nnSBK/finn-hertsch.de>\n');
