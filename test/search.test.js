import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDuckDuckGoHtml, parseTavilyJson, webSearch } from '../lib/server/search.js';

const ENV = { TAVILY_API_KEY: 'tvly-test' };

test('search HTML from DuckDuckGo Lite is parsed into result links', () => {
  const lite = parseDuckDuckGoHtml(
    '<a class="result-link" href="https://www.glassdoor.com/Reviews/AMLI-Reviews.htm">AMLI reviews 4.4 out of 5</a>'
  );

  assert.equal(lite[0].url, 'https://www.glassdoor.com/Reviews/AMLI-Reviews.htm');
  assert.equal(lite[0].source, 'duckduckgo');
});

test('Tavily results map onto the shared search-result shape', () => {
  const rows = parseTavilyJson({
    query: 'TKO',
    answer: 'TKO has about 99,999 employees.',
    results: [
      { title: 'TKO Group Holdings', url: 'https://example.com/tko', content: 'TKO has\n 12,057  employees.', score: 0.9 },
      { title: 'No url', url: '', content: 'skip me' }
    ]
  });

  assert.deepEqual(rows, [{
    url: 'https://example.com/tko',
    title: 'TKO Group Holdings',
    snippet: 'TKO has 12,057 employees.',
    source: 'tavily'
  }]);
});

test('webSearch sends a basic-depth Tavily request with the key and no generated answer', async () => {
  const seen = [];
  const results = await webSearch('"TKO Group Holdings" number of employees', {
    env: ENV,
    fetch: async (url, init) => {
      seen.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ results: [{ title: 'TKO', url: 'https://example.com', content: 'snippet' }] }), { status: 200 });
    }
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.tavily.com/search');
  assert.equal(seen[0].auth, 'Bearer tvly-test');
  assert.equal(seen[0].body.search_depth, 'basic');
  assert.equal(seen[0].body.include_answer, false);
  assert.equal(seen[0].body.query, '"TKO Group Holdings" number of employees');
  assert.equal(results[0].source, 'tavily');
});

test('a Tavily response with no results is an empty list', async () => {
  const results = await webSearch('amli residential reviews', {
    env: ENV,
    fetch: async () => new Response(JSON.stringify({ results: [] }), { status: 200 })
  });

  assert.deepEqual(results, []);
});

test('webSearch throws on a Tavily HTTP error', async () => {
  await assert.rejects(
    () => webSearch('amli residential reviews', {
      env: ENV,
      fetch: async () => new Response('{"detail":"Unauthorized"}', { status: 401 })
    }),
    /Search failed \(401\)/
  );
});

test('webSearch throws without calling out when TAVILY_API_KEY is missing', async () => {
  let called = false;

  await assert.rejects(
    () => webSearch('amli residential reviews', {
      env: {},
      fetch: async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }
    }),
    /TAVILY_API_KEY is not set/
  );
  assert.equal(called, false);
});
