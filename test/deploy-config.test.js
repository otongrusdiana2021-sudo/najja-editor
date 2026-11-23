// (v1.13.2) The Docker Compose setups the installer and production use (docker-compose.yml, deploy/compose.proxy.yml).
// Skipped where `docker compose` is not installed; runs in CI. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// (placeholders: the compose file requires a token; nothing is started)
const env = { ...process.env, COMPOSE_FILE: '', NAJJA_TOKEN: 'test-token', DOMAIN: 'example.test' };
const compose = (...args) => execFileSync('docker', ['compose', ...args], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
let skip = false;
try { compose('version'); } catch { skip = 'docker compose is not installed'; }

const services = (...files) => compose(...files.flatMap((f) => ['-f', f]), 'config', '--services').trim().split('\n').sort();
const proxy = ['docker-compose.yml', 'deploy/compose.proxy.yml'];

test('proxy mode (aaPanel, nginx…): Caddy is never started, Najja listens on 127.0.0.1 only', { skip }, () => {
  assert.deepEqual(services(...proxy), ['ai', 'najja'], 'a plain `docker compose up -d` must not start Caddy next to the web server that holds 80/443');
  const najja = compose(...proxy.flatMap((f) => ['-f', f]), 'config', 'najja');
  assert.match(najja, /host_ip: 127\.0\.0\.1/);
  assert.match(najja, /published: "3333"/);
  assert.doesNotMatch(najja, /host_ip: 0\.0\.0\.0/);
});

test('Caddy mode (no other web server) is unchanged: Caddy, Najja and the AI service', { skip }, () => {
  assert.deepEqual(services('docker-compose.yml'), ['ai', 'caddy', 'najja']);
});
