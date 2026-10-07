import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

function pngSize(fileUrl) {
  const bytes = readFileSync(fileUrl);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('every manifest icon is a PNG of the stated size', () => {
  const expected = {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png'
  };

  assert.deepEqual(manifest.icons, expected);
  assert.equal(manifest.action.default_popup, 'popup/popup.html');
  assert.deepEqual(manifest.action.default_icon, expected);

  for (const [size, iconPath] of Object.entries(expected)) {
    const fileUrl = new URL(`../${iconPath}`, import.meta.url);
    assert.equal(existsSync(fileUrl), true, iconPath);
    const { width, height } = pngSize(fileUrl);
    assert.equal(width, Number(size), iconPath);
    assert.equal(height, Number(size), iconPath);
  }
});

test('every manifest content script is a .js file on disk', () => {
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);

  assert.ok(scripts.length > 0);

  for (const script of scripts) {
    assert.equal(script.endsWith('.js'), true, script);
    assert.equal(existsSync(new URL(`../${script}`, import.meta.url)), true, script);
  }
});
