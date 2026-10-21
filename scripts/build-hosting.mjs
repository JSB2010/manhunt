#!/usr/bin/env node
// Firebase Hosting predeploy: copies hosting/public to hosting/dist with the public contact
// email filled in for {{CONTACT_EMAIL}}. The address stays out of git: it comes from
// CONTACT_EMAIL, or the first line of hosting/contact-email.local (git-ignored).
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'hosting/public');
const out = join(root, 'hosting/dist');
const localFile = join(root, 'hosting/contact-email.local');

const email = (process.env.CONTACT_EMAIL ?? (existsSync(localFile) ? readFileSync(localFile, 'utf8').split('\n')[0] : '')).trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('build-hosting: set CONTACT_EMAIL or write the address to hosting/contact-email.local before publishing the privacy policy.');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
for (const f of walk(out).filter((f) => f.endsWith('.html'))) {
  writeFileSync(f, readFileSync(f, 'utf8').replaceAll('{{CONTACT_EMAIL}}', email));
}
console.log(`build-hosting: hosting/dist ready (contact ${email.replace(/^(.).*@/, '$1…@')})`);
