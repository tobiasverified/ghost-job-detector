import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

test('every manifest content script is a .js file on disk', () => {
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);

  assert.ok(scripts.length > 0);

  for (const script of scripts) {
    assert.equal(script.endsWith('.js'), true, script);
    assert.equal(existsSync(new URL(`../${script}`, import.meta.url)), true, script);
  }
});
