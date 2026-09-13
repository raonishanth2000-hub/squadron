import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = join(root, 'data');
const KEY = join(dir, 'dev-key.pem');
const CRT = join(dir, 'dev-cert.pem');

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/* getUserMedia and getDisplayMedia only run in a secure context. localhost counts;
   a LAN address does not — so for anyone joining from another device we need TLS. */
export function ensureCert() {
  mkdirSync(dir, { recursive: true });
  if (existsSync(KEY) && existsSync(CRT)) {
    return { key: readFileSync(KEY), cert: readFileSync(CRT) };
  }
  const alts = ['DNS:localhost', 'IP:127.0.0.1', ...lanAddresses().map(a => `IP:${a}`)].join(',');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825',
      '-keyout', KEY, '-out', CRT,
      '-subj', '/CN=squadron.local',
      '-addext', `subjectAltName=${alts}`
    ], { stdio: 'ignore' });
    return { key: readFileSync(KEY), cert: readFileSync(CRT) };
  } catch {
    return null;          // openssl unavailable: caller falls back to http
  }
}
