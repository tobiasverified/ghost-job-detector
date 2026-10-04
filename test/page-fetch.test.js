import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadFetchTools() {
  const sandbox = { URL, console };
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(new URL('../lib/page-fetch.js', import.meta.url), 'utf8'),
    sandbox
  );
  return sandbox.GhdFetch;
}

function pad(html) {
  return `${html}${' '.repeat(500)}`;
}

test('LinkedIn authwall HTML is blocked and is not a company page', () => {
  const tools = loadFetchTools();
  const wall = pad('<title>Sign in | LinkedIn</title><a href="https://www.linkedin.com/uas/login">Sign in</a> authwall challenge');
  const company = pad('View all 727 employees. AMLI Residential jobs 46 open jobs.');

  assert.equal(tools.isLinkedInBlocked(wall), true);
  assert.equal(tools.isCompanyPage(wall), false);
  assert.equal(tools.isLinkedInBlocked(company), false);
  assert.equal(tools.isCompanyPage(company), true);
  assert.equal(tools.isLinkedInBlocked(''), false);
});

test('search falls through DuckDuckGo HTML to Lite and rejects a refused page', () => {
  const tools = loadFetchTools();
  const engines = tools.searchEngines('Axon layoffs');
  const refused = pad('<html>Your request has been refused by the server. If you are accessing this page from Tor, try changing the exit node.</html>');
  const litePage = pad('<a class="result-link" href="https://example.com">Axon layoffs</a>');

  assert.equal(JSON.stringify(engines.map((engine) => engine.name)), '["ddg-html","ddg-lite"]');
  assert.equal(engines[0].url.startsWith('https://html.duckduckgo.com/html/?q='), true);
  assert.equal(engines[1].url.startsWith('https://lite.duckduckgo.com/lite/?q='), true);
  assert.equal(tools.hasBotBlock(refused), true);
  assert.equal(tools.hasBotBlock(pad('<a class="result__a" href="https://example.com">Axon bot policy</a>')), false);
  assert.equal(tools.usablePageHtml(engines[0].url, refused), false);
  assert.equal(tools.usablePageHtml(engines[0].url, pad('<a class="result__a" href="https://example.com">Axon</a>')), true);
  assert.equal(tools.usablePageHtml(engines[1].url, litePage), true);
  assert.equal(tools.firstValidPage([
    { url: engines[0].url, html: refused },
    { url: engines[1].url, html: litePage }
  ]).url, engines[1].url);
  assert.equal(tools.firstValidPage([
    { url: engines[0].url, html: refused },
    { url: engines[1].url, html: refused }
  ]), null);
});

test('parallel company slug results keep the first validated page', () => {
  const tools = loadFetchTools();
  const picked = tools.pickCompanyResult([
    { slug: 'hive', jobs: '', about: '', status: 'missing' },
    { slug: 'axon', jobs: `${'View all 1,200 employees '}${'x'.repeat(500)}`, about: '', status: 'ok' }
  ]);
  const blocked = tools.pickCompanyResult([
    { slug: 'axon', jobs: '', about: '', status: 'blocked' },
    { slug: 'axon-enterprise', jobs: '', about: '', status: 'missing' }
  ]);

  assert.equal(picked.status, 'ok');
  assert.equal(picked.jobs.includes('1,200 employees'), true);
  assert.equal(blocked.status, 'blocked');
});

test('HTML cache hits, misses, expires, and clears', async () => {
  const tools = loadFetchTools();
  let now = 1_000;
  const store = new Map();
  const cache = tools.createHtmlCache({
    async get(key) {
      return store.get(key) || null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async remove(key) {
      store.delete(key);
    }
  }, 1000, () => now);

  assert.equal(await cache.get('ghd_co:amli:jobs'), null);
  await cache.set('ghd_co:amli:jobs', pad('View all 727 employees'));
  assert.equal((await cache.get('ghd_co:amli:jobs')).includes('727 employees'), true);

  now = 2_500;
  assert.equal(await cache.get('ghd_co:amli:jobs'), null);
  assert.equal(store.has('ghd_co:amli:jobs'), false);

  await cache.set('ghd_search:axon', pad('<a class="result__a">Axon</a>'));
  store.delete('ghd_search:axon');
  assert.equal(await cache.get('ghd_search:axon'), null);
  await cache.set('ghd_search:blank', '');
  assert.equal(store.size, 0);
});
