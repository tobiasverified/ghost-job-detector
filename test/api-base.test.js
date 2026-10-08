import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
require('../lib/api-base.js');
const {
  DEFAULT_API_BASE,
  acceptedApiOrigin,
  apiBaseDecision,
  applyApiBaseChoice,
  resolveStoredApiBase
} = globalThis.GhdApiBase;

const LOOKALIKE = 'https://ghost-job-detector-nine.vercel.app.evil.com';
const USERINFO = 'https://user:pass@ghost-job-detector-nine.vercel.app/api';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async set(values) {
      Object.assign(data, values);
    },
    async remove(key) {
      delete data[key];
    }
  };
}

test('look-alike and userinfo URLs are rejected', () => {
  const lookalike = apiBaseDecision(LOOKALIKE);
  const userinfo = apiBaseDecision(USERINFO, { developerMode: true });
  const localUser = apiBaseDecision('http://user:pass@localhost:3000', { developerMode: true });

  assert.equal(lookalike.action, 'reject');
  assert.equal(lookalike.origin, '');
  assert.match(lookalike.message, /not the default backend/);
  assert.equal(userinfo.action, 'reject');
  assert.match(userinfo.message, /username and password/);
  assert.equal(localUser.action, 'reject');
  assert.equal(acceptedApiOrigin(USERINFO, { developerMode: true }), '');
  assert.equal(acceptedApiOrigin(LOOKALIKE), '');
});

test('localhost and 127.0.0.1 are accepted on any port', () => {
  assert.deepEqual(apiBaseDecision('http://localhost:3000/'), {
    action: 'save',
    value: 'http://localhost:3000',
    origin: 'http://localhost:3000',
    needsPermission: false,
    message: ''
  });
  assert.equal(apiBaseDecision('http://127.0.0.1:8787').origin, 'http://127.0.0.1:8787');
  assert.equal(apiBaseDecision('http://localhost').origin, 'http://localhost');
  assert.equal(apiBaseDecision('http://localhost.evil.com').action, 'reject');
  assert.equal(apiBaseDecision('http://example.com').action, 'reject');
});

test('developer mode off rejects an arbitrary https server', () => {
  const decision = apiBaseDecision('https://example.com/check', { developerMode: false });

  assert.equal(decision.action, 'reject');
  assert.equal(decision.needsPermission, false);
  assert.match(decision.message, /Developer mode/);
  assert.equal(apiBaseDecision('https://example.com', { developerMode: true }).origin, 'https://example.com');
  assert.equal(apiBaseDecision(`  ${DEFAULT_API_BASE}/api  `).origin, DEFAULT_API_BASE);
});

test('a bad stored value falls back to the default backend', () => {
  assert.equal(resolveStoredApiBase(LOOKALIKE, { developerMode: false }), DEFAULT_API_BASE);
  assert.equal(resolveStoredApiBase(USERINFO, { developerMode: true }), DEFAULT_API_BASE);
  assert.equal(resolveStoredApiBase('http://example.com', { developerMode: true }), DEFAULT_API_BASE);
  assert.equal(resolveStoredApiBase('not a url', { developerMode: true }), DEFAULT_API_BASE);
  assert.equal(resolveStoredApiBase('', { developerMode: true }), DEFAULT_API_BASE);
  assert.equal(resolveStoredApiBase('http://localhost:4173', { developerMode: false }), 'http://localhost:4173');
  assert.equal(resolveStoredApiBase('https://example.com', { developerMode: true }), 'https://example.com');
});

test('the manifest grants the exact backend origin and no vercel.app wildcard', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const joined = JSON.stringify(manifest);

  assert.equal(joined.includes('*.vercel.app'), false);
  assert.equal(manifest.host_permissions.includes('https://ghost-job-detector-nine.vercel.app/*'), true);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
});

test('the permission request fires only when a custom https backend is saved', async () => {
  const calls = [];
  const requestPermission = async (permission) => {
    calls.push(permission);
    return true;
  };
  const storage = memoryStorage();

  apiBaseDecision('https://example.com', { developerMode: true });
  await applyApiBaseChoice('http://127.0.0.1:8080', {
    developerMode: false,
    storage,
    requestPermission
  });
  await applyApiBaseChoice(LOOKALIKE, {
    developerMode: false,
    storage,
    requestPermission
  });
  await applyApiBaseChoice(DEFAULT_API_BASE, {
    developerMode: false,
    storage,
    requestPermission
  });

  assert.equal(calls.length, 0);

  const saved = await applyApiBaseChoice('https://jobs.example.com/backend', {
    developerMode: true,
    storage,
    requestPermission
  });

  assert.equal(saved.saved, true);
  assert.equal(saved.base, 'https://jobs.example.com');
  assert.deepEqual(calls, [{ origins: ['https://jobs.example.com/*'] }]);
  assert.equal(storage.data.ghd_api_base, 'https://jobs.example.com');
  assert.equal(storage.data.ghd_developer_mode, true);

  const declined = await applyApiBaseChoice('https://other.example.com', {
    developerMode: true,
    storage: memoryStorage(),
    requestPermission: async () => false
  });

  assert.equal(declined.saved, false);
  assert.equal(declined.requested, true);
  assert.equal(declined.base, DEFAULT_API_BASE);
  assert.match(declined.message, /default backend/);
});

test('the popup asks Chrome for permission from the save button', () => {
  const source = readFileSync(new URL('../popup/popup.js', import.meta.url), 'utf8');
  const saveAt = source.indexOf("getElementById('saveApiBase')");
  const requestAt = source.indexOf('permissions.request');

  assert.ok(saveAt > 0);
  assert.equal(source.indexOf('permissions.request', requestAt + 1), -1);
  assert.ok(requestAt > saveAt);
});
