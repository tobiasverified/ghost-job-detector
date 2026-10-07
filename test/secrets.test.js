import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const CLIENT_PATHS = [
  'manifest.json',
  'background.js',
  'content.js',
  'content/workday.js',
  'content/linkedin-company.js',
  'lib/company-headcount.js',
  'popup/popup.js',
  'popup/popup.html',
  'popup/config.js',
  'lib/widget.js',
  'lib/heuristics.js',
  'lib/job-page.js',
  'lib/page-fetch.js'
];

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    const info = statSync(path);

    if (info.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') {
        return [];
      }

      return walk(path);
    }

    return [path];
  });
}

test('the extension bundle does not call Google search or embed API keys', () => {
  const offenders = [];

  for (const relativePath of CLIENT_PATHS) {
    const source = readFileSync(new URL(relativePath, ROOT), 'utf8');

    if (/google\.com\/search/i.test(source)) {
      offenders.push(`${relativePath} still links to Google search`);
    }

    if (/NEWSDATA_API_KEY|SUPABASE_SERVICE_ROLE|X-ACCESS-KEY|RAPIDAPI_KEY|GROQ_API_KEY|newsdata\.io\/api|supabase\.co|rapidapi\.com|api\.groq\.com/i.test(source)) {
      offenders.push(`${relativePath} references a server credential or API host`);
    }
  }

  assert.deepEqual(offenders, []);
});

test('server source does not hard-code credential values', () => {
  const files = walk(join(ROOT_PATH, 'lib', 'server')).concat(walk(join(ROOT_PATH, 'api')));
  const leaked = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');

    if (/NEWSDATA_API_KEY\s*[:=]\s*['"][A-Za-z0-9]{8,}/.test(source)) {
      leaked.push(file);
    }

    if (/SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*['"][A-Za-z0-9]/.test(source)) {
      leaked.push(file);
    }

    if (/RAPIDAPI_KEY\s*[:=]\s*['"][A-Za-z0-9]/.test(source)) {
      leaked.push(file);
    }

    if (/GROQ_API_KEY\s*[:=]\s*['"][A-Za-z0-9]/.test(source)) {
      leaked.push(file);
    }
  }

  assert.deepEqual(leaked, []);
});
