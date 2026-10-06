import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { MemoryCache } from '../lib/server/cache.js';
import { companyQueries, shorterCompanyNames } from '../lib/server/companies.js';
import { detectLayoffs, parseArticleDate, selectLayoffs, verifyLayoffRelevance } from '../lib/server/layoffs.js';

function loadHeuristics() {
  const sandbox = { console };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../lib/heuristics.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.module.exports;
}

const heuristics = loadHeuristics();

function layoffSourceHref(layoff) {
  return heuristics.buildFactors(
    { score: 0, label: 'Clear' },
    layoff,
    { available: false },
    { rating: null, unavailable: false, score: 0 },
    { score: 0, available: false, unavailable: true }
  ).find((factor) => factor.label === 'Recent Layoffs').href;
}

function fyi404() {
  return {
    ok: false,
    status: 404,
    json: async () => ({}),
    text: async () => ''
  };
}

function hangUntilAbort(options) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fyi404()), 30000);
    const signal = options?.signal;

    if (!signal) {
      return;
    }

    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('timeout'));
    };

    if (signal.aborted) {
      abort();
      return;
    }

    signal.addEventListener('abort', abort, { once: true });
  });
}

const NOW = new Date('2026-09-25T12:00:00Z');

test('subsidiary queries include the distinctive name', () => {
  assert.deepEqual(companyQueries('Hyundai Supernal'), ['hyundai supernal', 'supernal']);
  assert.deepEqual(companyQueries('Meta Platforms, Inc.'), ['meta']);
  assert.deepEqual(companyQueries('Amazon'), ['amazon']);
  assert.deepEqual(companyQueries('University of Miami'), ['university miami']);
  assert.deepEqual(companyQueries('Bank of America'), ['bank america']);
  assert.equal(companyQueries('University of Miami').includes('miami'), false);
  assert.equal(companyQueries('Bank of America').includes('america'), false);
  assert.equal(companyQueries('UMCareer Staff').includes('staff'), false);
  assert.deepEqual(companyQueries('UMCareer Staff'), ['umcareer staff', 'umcareer']);
  assert.deepEqual(shorterCompanyNames('UMCareer Staff'), ['umcareer']);
});

test('Hyundai Supernal matches a Supernal layoff and ignores Hyundai Motor', () => {
  const detected = selectLayoffs('Hyundai Supernal', [
    {
      title: 'Hyundai Motor Company announces layoffs at its Alabama plant',
      description: 'Hyundai Motor laid off factory workers.',
      publishedAt: '2026-08-01 12:00:00',
      url: 'https://example.com/hyundai-motor',
      source: 'Example News'
    },
    {
      title: 'Supernal lays off staff as air taxi plans shrink',
      description: 'The Hyundai air-mobility unit cut jobs this summer.',
      publishedAt: '2026-08-02 12:00:00',
      url: 'https://example.com/supernal',
      source: 'Example News'
    }
  ], NOW);

  assert.equal(detected.detected, true);
  assert.equal(detected.score, 25);
  assert.equal(detected.date, '2026-08-02');
  assert.equal(detected.url, 'https://example.com/supernal');
});

test('Meta and Amazon layoff headlines match, and unrelated Amazon copy does not', () => {
  const meta = selectLayoffs('Meta', [
    {
      title: 'Meta lays off 1,000 employees in latest job cuts',
      description: 'The company confirmed the cuts on Monday.',
      publishedAt: '2026-07-01 00:00:00',
      url: 'https://example.com/meta',
      source: 'Example News'
    }
  ], NOW);
  const amazon = selectLayoffs('Amazon', [
    {
      title: 'How Amazon delivery works during the holidays',
      description: 'A look at warehouse operations.',
      publishedAt: '2026-08-01 00:00:00',
      url: 'https://example.com/amazon-ops'
    },
    {
      title: 'Amazon plans job cuts across devices',
      description: 'The retailer is laying off staff in several groups.',
      publishedAt: '2026-03-01 00:00:00',
      url: 'https://example.com/amazon-cuts'
    }
  ], NOW);
  const clean = selectLayoffs('Initech', [
    {
      title: 'Initech hosts its annual picnic',
      description: 'Employees brought dessert.',
      publishedAt: '2026-08-01 00:00:00'
    }
  ], NOW);

  assert.equal(meta.detected, true);
  assert.equal(meta.score, 25);
  assert.equal(amazon.detected, true);
  assert.equal(amazon.url, 'https://example.com/amazon-cuts');
  assert.equal(clean.detected, false);
  assert.equal(clean.score, 0);
});

test('a layoff signals guide is not a recent layoff', () => {
  const farm = selectLayoffs('Pearson', [
    {
      title: 'Pearson laid off staff according to an internal memo',
      description: 'Pearson announced job cuts this summer.',
      publishedAt: '2026-08-01 00:00:00',
      url: 'https://www.claveprep.com/blog/pearson-memo'
    }
  ], NOW);
  const template = selectLayoffs('GEICO', [
    {
      title: 'GEICO Layoff Signals Guide 2026: Job Security Checklist',
      description: 'GEICO employees should watch for layoffs and job cuts.',
      publishedAt: '2026-08-01 00:00:00',
      url: 'https://example.com/geico-guide'
    }
  ], NOW);

  assert.equal(farm.detected, false);
  assert.equal(farm.score, 0);
  assert.equal(template.detected, false);
  assert.equal(template.score, 0);
});

test('AMLI Residential does not match an HHS article that only says residential', () => {
  const result = selectLayoffs('AMLI Residential', [
    {
      title: 'HHS Program Operations Strained By Staffing',
      description: 'Federal residential treatment programs face layoffs after staffing cuts at HHS.',
      publishedAt: '2026-06-01 00:00:00',
      url: 'https://example.com/hhs-staffing'
    },
    {
      title: 'AMLI Residential lays off leasing staff at two communities',
      description: 'The apartment owner confirmed job cuts on June 2, 2026.',
      publishedAt: '2026-06-02 00:00:00',
      url: 'https://example.com/amli'
    }
  ], NOW);

  assert.equal(companyQueries('AMLI Residential').includes('residential'), false);
  assert.deepEqual(companyQueries('AMLI Residential'), ['amli residential', 'amli']);
  assert.equal(companyQueries('Argonne National Laboratory').includes('laboratory'), false);
  assert.deepEqual(companyQueries('Argonne National Laboratory'), ['argonne national laboratory', 'argonne national']);
  assert.deepEqual(companyQueries('Pearson Education'), ['pearson education', 'pearson']);
  assert.deepEqual(companyQueries('Hyundai Supernal'), ['hyundai supernal', 'supernal']);
  assert.equal(result.detected, true);
  assert.equal(result.headline, 'AMLI Residential lays off leasing staff at two communities');
  assert.equal(result.url, 'https://example.com/amli');
  assert.equal(result.matches.length, 1);
});

test('Pearson does not match Pearson\'s Candy Company', () => {
  const candy = selectLayoffs('Pearson', [
    {
      title: 'Pearson\'s Candy Company closing St. Paul facility',
      description: 'The candy maker is laying off about 80 workers in September 2026.',
      publishedAt: '2026-07-30 00:00:00',
      url: 'https://example.com/pearson-candy'
    }
  ], NOW);
  const publisher = selectLayoffs('Pearson', [
    {
      title: 'Pearson\'s Candy Company closing St. Paul facility',
      description: 'The candy maker is laying off about 80 workers.',
      publishedAt: '2026-07-30 00:00:00',
      url: 'https://example.com/pearson-candy'
    },
    {
      title: 'Pearson lays off workers in its education business',
      description: 'The publisher confirmed job cuts on May 1, 2026.',
      publishedAt: '2026-05-01 00:00:00',
      url: 'https://example.com/pearson-education'
    }
  ], NOW);
  const possessive = selectLayoffs('Amazon', [
    {
      title: 'Amazon\'s layoffs will affect devices teams',
      description: 'The retailer is cutting jobs this month.',
      publishedAt: '2026-08-01 00:00:00',
      url: 'https://example.com/amazon-possessive'
    }
  ], NOW);

  assert.equal(candy.detected, false);
  assert.equal(publisher.detected, true);
  assert.equal(publisher.url, 'https://example.com/pearson-education');
  assert.equal(possessive.detected, true);
  assert.equal(possessive.url, 'https://example.com/amazon-possessive');
});

test('a short company name must appear in the headline, not inside another word', () => {
  const result = selectLayoffs('Meta', [
    {
      title: 'Metadata startup lays off staff',
      description: 'A data vendor reduced headcount.',
      publishedAt: '2026-08-01 00:00:00'
    }
  ], NOW);

  assert.equal(result.detected, false);
});

test('a date still matches when the year is glued to the next word', () => {
  const glued = parseArticleDate(
    'Apr 7, 2026Sony Pictures Entertainment is restructuring its operations with plans for hundreds of layoffs.',
    NOW
  );
  const punctuated = parseArticleDate(
    'The cuts were announced Apr 7, 2026. Sony Pictures Entertainment is restructuring.',
    NOW
  );
  const continued = parseArticleDate('Apr 7, 20260 is not a year.', NOW);
  const afterPunctuation = parseArticleDate('.Apr 7, 2026 Sony announced layoffs.', NOW);

  assert.equal(glued.toISOString().slice(0, 10), '2026-04-07');
  assert.equal(punctuated.toISOString().slice(0, 10), '2026-04-07');
  assert.equal(continued, null);
  assert.equal(afterPunctuation.toISOString().slice(0, 10), '2026-04-07');
});

test('a news URL month is used when the snippet has no date', () => {
  const date = parseArticleDate(
    'Sony Entertainment Layoffs Hit TV, Film and Corporate. Sony Pictures Entertainment is restructuring with plans for hundreds of layoffs.',
    NOW,
    'https://variety.com/2026/04/film/news/sony-entertainment-layoffs-tv-film-1236710554/'
  );

  assert.equal(date.toISOString().slice(0, 10), '2026-04-01');
});

test('a year-only news URL uses a month named in the snippet', () => {
  const varietyUrl = 'https://variety.com/2026/tv/news/sony-entertainment-layoffs-tv-film-1236710554/';
  const dated = parseArticleDate(
    'Sony Pictures Entertainment said the cuts begin April 7.',
    NOW,
    varietyUrl
  );
  const undated = parseArticleDate(
    'Sony Pictures Entertainment is restructuring its operations with plans for hundreds of layoffs across its film, TV and corporate divisions in the coming months.',
    NOW,
    varietyUrl
  );

  assert.equal(dated.toISOString().slice(0, 10), '2026-04-07');
  assert.equal(undated, null);
});

test('a bare month and year is not treated as today', () => {
  const date = parseArticleDate(
    'Inside the June 2026 layoffs and PlayStation fallout.',
    NOW,
    'https://tech-insider.org/sony-bungie-writedown-765-million-2026/'
  );
  const result = selectLayoffs('Sony', [
    {
      title: 'Sony Bungie Writedown',
      snippet: 'Inside the June 2026 layoffs and PlayStation fallout.',
      url: 'https://tech-insider.org/sony-bungie-writedown-765-million-2026/'
    }
  ], NOW);

  assert.equal(date, null);
  assert.equal(result.detected, false);
  assert.notEqual(result.date, NOW.toISOString().slice(0, 10));
});

test('layoffs older than a year are ignored', () => {
  const result = selectLayoffs('Amazon', [
    {
      title: 'Amazon job cuts hit several teams',
      publishedAt: '2024-01-01 00:00:00',
      url: 'https://example.com/old'
    }
  ], NOW);

  assert.equal(result.detected, false);
});

test('NewsData misses fall back to DuckDuckGo', async () => {
  let webQueries = [];
  const result = await detectLayoffs('Hyundai Supernal', {
    now: NOW,
    description: 'Join the team at Supernal, where we design electric aircraft.',
    fetch: async () => fyi404(),
    searchNews: async () => [],
    webSearch: async (query) => {
      webQueries.push(query);
      return [
        {
          title: 'Supernal lays off workers',
          snippet: 'Reports on August 2, 2026 say Supernal is laying off staff.',
          url: 'https://example.com/ddg-supernal',
          source: 'duckduckgo'
        }
      ];
    }
  });

  // Both grounded name variants are searched at once (a second Tavily credit),
  // and the shorter variant's results are still taken first, as before.
  assert.deepEqual(webQueries, ['supernal layoffs', 'hyundai supernal layoffs']);
  assert.equal(result.detected, true);
  assert.equal(result.source, 'duckduckgo');
  assert.equal(result.unavailable, false);
});

test('a NewsData match wins over a web search that ran alongside it', async () => {
  let called = false;
  const result = await detectLayoffs('Meta', {
    now: NOW,
    fetch: async () => fyi404(),
    searchNews: async () => [
      {
        title: 'Meta lays off 1,000 employees',
        description: 'Job cuts were announced today.',
        publishedAt: '2026-09-01 00:00:00',
        url: 'https://example.com/meta',
        source: 'Reuters'
      }
    ],
    webSearch: async () => {
      called = true;
      return [];
    }
  });

  // The web search starts at the same time now; NewsData's match is still used.
  assert.equal(called, true);
  assert.equal(result.source, 'newsdata');
  assert.equal(result.detected, true);
});

test('layoff HTML from the extension skips the server web search', async () => {
  let webCalls = 0;
  const result = await detectLayoffs('Sony', {
    now: NOW,
    fetch: async () => fyi404(),
    clientHtml: '<html><title>No layoff article</title></html>',
    searchNews: async () => [],
    webSearch: async () => {
      webCalls += 1;
      return [{
        title: 'Sony Pictures lays off hundreds',
        snippet: 'April 7, 2026 Sony Pictures Entertainment is restructuring with plans for hundreds of layoffs.',
        url: 'https://variety.com/sony',
        source: 'duckduckgo'
      }];
    }
  });

  assert.equal(webCalls, 0);
  assert.equal(result.detected, false);
});

test('DuckDuckGo HTML supplied by the extension is used when the server cannot search', async () => {
  const html = `
    <div class="result__body">
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fmeta">Meta lays off 8,000 employees</a>
      <a class="result__snippet" href="https://example.com">Meta cut jobs on April 24, 2026.</a>
    </div>`;
  const result = await detectLayoffs('Meta', {
    now: NOW,
    fetch: async () => fyi404(),
    clientHtml: html,
    searchNews: async () => [],
    webSearch: async () => {
      throw new Error('blocked');
    }
  });

  assert.equal(result.detected, true);
  assert.equal(result.source, 'duckduckgo');
  assert.equal(result.date, '2026-04-24');
});

test('a slow layoffs.fyi response falls through to NewsData', async () => {
  let newsCalled = false;
  const started = Date.now();
  const result = await detectLayoffs('Meta', {
    now: NOW,
    layoffFyiTimeoutMs: 40,
    fetch: (_url, options) => hangUntilAbort(options),
    searchNews: async () => {
      newsCalled = true;
      return [
        {
          title: 'Meta lays off 1,000 employees',
          description: 'Job cuts were announced today.',
          publishedAt: '2026-09-01 00:00:00',
          url: 'https://example.com/meta',
          source: 'Reuters'
        }
      ];
    },
    webSearch: async () => []
  });

  assert.ok(Date.now() - started < 1000);
  assert.equal(newsCalled, true);
  assert.equal(result.detected, true);
  assert.equal(result.source, 'newsdata');
  assert.equal(result.url, 'https://example.com/meta');
  assert.equal(layoffSourceHref(result), 'https://example.com/meta');
});

test('layoffs.fyi uses the newest event and keeps a real description', async () => {
  const calls = [];
  const result = await detectLayoffs('Meta', {
    now: NOW,
    fetch: async (url) => {
      calls.push(url);

      if (String(url).includes('/api/company/meta-platforms')) {
        return fyi404();
      }

      if (String(url).includes('/api/company/meta')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            events: [
              { date: '2026-01-15', count: 800, percent: 0.04, source: 'https://example.com/older' },
              { date: '2026-08-20', count: 1200, percent: 0.13, source: 'https://example.com/newer' }
            ]
          })
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ description: 'Meta cut about 1,200 roles in August.' })
      };
    },
    searchNews: async () => {
      throw new Error('NewsData should not run');
    },
    webSearch: async () => {
      throw new Error('DuckDuckGo should not run');
    }
  });

  assert.equal(calls.filter((url) => String(url).includes('/api/event-description')).length, 1);
  assert.match(calls.at(-1), /url=https%3A%2F%2Fexample\.com%2Fnewer/);
  assert.equal(result.detected, true);
  assert.equal(result.source, 'layoffs.fyi');
  assert.equal(result.score, 25);
  assert.equal(result.date, '2026-08-20');
  assert.equal(result.headline, 'Meta cut about 1,200 roles in August.');
  assert.equal(result.detail, result.headline);
  assert.equal(result.url, 'https://example.com/newer');
  assert.equal(layoffSourceHref(result), 'https://example.com/newer');
});

test('a missing layoffs.fyi description falls back to the constructed headline', async () => {
  let newsCalled = false;
  const result = await detectLayoffs('Meta', {
    now: NOW,
    fetch: async (url) => {
      if (String(url).includes('/api/company/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            events: [
              { date: '2026-02-01', count: 500, percent: 0.1, source: 'https://example.com/meta-cuts' }
            ]
          })
        };
      }

      return fyi404();
    },
    searchNews: async () => {
      newsCalled = true;
      return [];
    },
    webSearch: async () => []
  });

  // NewsData now starts alongside layoffs.fyi; layoffs.fyi's answer still wins.
  assert.equal(newsCalled, true);
  assert.equal(result.detected, true);
  assert.equal(result.source, 'layoffs.fyi');
  assert.equal(result.headline, `${(500).toLocaleString()} employees (10%) laid off`);
  assert.equal(result.score, 15);
});

test('a layoffs.fyi miss is remembered for a day, and a hit keeps its description', async () => {
  const cache = new MemoryCache();
  let fetches = 0;
  const miss = async () => {
    fetches += 1;
    return fyi404();
  };

  await detectLayoffs('Initech', {
    now: NOW,
    cache,
    fetch: miss,
    searchNews: async () => [],
    webSearch: async () => []
  });
  await detectLayoffs('Initech', {
    now: NOW,
    cache,
    fetch: miss,
    searchNews: async () => [],
    webSearch: async () => []
  });
  assert.equal(fetches, 1);

  await detectLayoffs('Initech', {
    now: new Date(NOW.getTime() + (25 * 60 * 60 * 1000)),
    cache,
    fetch: miss,
    searchNews: async () => [],
    webSearch: async () => []
  });
  assert.equal(fetches, 2);

  let descriptionFetches = 0;
  const hit = async (url) => {
    if (String(url).includes('/api/event-description')) {
      descriptionFetches += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ description: 'Initech laid off 40 people.' })
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        events: [
          { date: '2026-08-01', count: 40, percent: null, source: 'https://example.com/initech' }
        ]
      })
    };
  };

  const first = await detectLayoffs('Pearson', {
    now: NOW,
    cache,
    fetch: hit,
    searchNews: async () => [],
    webSearch: async () => []
  });
  const second = await detectLayoffs('Pearson', {
    now: NOW,
    cache,
    fetch: hit,
    searchNews: async () => [],
    webSearch: async () => []
  });

  assert.equal(descriptionFetches, 1);
  assert.equal(first.headline, 'Initech laid off 40 people.');
  assert.equal(second.headline, first.headline);
  assert.equal(second.source, 'layoffs.fyi');
});

test('both layoff sources failing is an unavailable check, not a clean record', async () => {
  const result = await detectLayoffs('Amazon', {
    now: NOW,
    fetch: async () => fyi404(),
    searchNews: async () => {
      throw new Error('NewsData request failed');
    },
    webSearch: async () => {
      throw new Error('DuckDuckGo search failed');
    }
  });

  assert.equal(result.detected, false);
  assert.equal(result.unavailable, true);
  assert.equal(result.score, 0);
});

test('a passing mention of University of Miami is rejected when Groq says no', async () => {
  let calls = 0;
  const result = await detectLayoffs('University of Miami', {
    now: NOW,
    cache: new MemoryCache(),
    fetch: async () => fyi404(),
    searchNews: async () => [
      {
        title: 'University of Maine announces layoffs',
        description: 'The cuts are local. A passing mention of university miami notes that peer is still hiring.',
        publishedAt: '2026-09-01 12:00:00',
        url: 'https://example.com/umaine'
      },
      {
        title: 'University Miami lays off staff',
        description: 'University Miami confirmed it is laying off employees this summer.',
        publishedAt: '2026-08-01 12:00:00',
        url: 'https://example.com/miami'
      }
    ],
    webSearch: async () => [],
    askGroq: async (prompt) => {
      calls += 1;
      assert.match(prompt, /Answer only YES or NO/);
      return /Maine/.test(prompt) ? 'NO' : 'YES';
    }
  });

  assert.equal(result.detected, true);
  assert.equal(result.url, 'https://example.com/miami');
  assert.equal(calls, 2);

  const onlyMention = await detectLayoffs('University of Miami', {
    now: NOW,
    cache: new MemoryCache(),
    fetch: async () => fyi404(),
    searchNews: async () => [{
      title: 'University of Maine announces layoffs',
      description: 'The cuts are local. A passing mention of university miami notes that peer is still hiring.',
      publishedAt: '2026-08-01 12:00:00',
      url: 'https://example.com/umaine-only'
    }],
    webSearch: async () => [],
    askGroq: async () => 'NO'
  });

  assert.equal(onlyMention.detected, false);
  assert.equal(onlyMention.score, 0);
});

test('a genuine layoff passes through when Groq says yes', async () => {
  const cache = new MemoryCache();
  let calls = 0;
  const deps = {
    now: NOW,
    cache,
    fetch: async () => fyi404(),
    searchNews: async () => [{
      title: 'Meta lays off 1,000 employees',
      description: 'Meta confirmed the job cuts on Monday.',
      publishedAt: '2026-09-01 00:00:00',
      url: 'https://example.com/meta'
    }],
    webSearch: async () => [],
    askGroq: async () => {
      calls += 1;
      return 'YES';
    }
  };

  const first = await detectLayoffs('Meta', deps);
  const second = await detectLayoffs('Meta', deps);

  assert.equal(first.detected, true);
  assert.equal(first.url, 'https://example.com/meta');
  assert.equal(first.score, 25);
  assert.equal(second.detected, true);
  assert.equal(calls, 1);
  assert.equal(await verifyLayoffRelevance('Meta', {
    title: 'Meta lays off 1,000 employees',
    url: 'https://example.com/meta'
  }, deps), true);
});

test('a Groq timeout drops the layoff the same way a NO does', async () => {
  const result = await detectLayoffs('Meta', {
    now: NOW,
    cache: new MemoryCache(),
    fetch: async () => fyi404(),
    searchNews: async () => [{
      title: 'Meta lays off 1,000 employees',
      description: 'Meta confirmed the job cuts on Monday.',
      publishedAt: '2026-09-01 00:00:00',
      url: 'https://example.com/meta'
    }],
    webSearch: async () => [],
    askGroq: async () => {
      throw new Error('timeout');
    }
  });

  assert.equal(result.detected, false);
  assert.equal(result.url, null);
  assert.equal(result.score, 0);
});

test('On Location never searches or matches the plain word "location"', async () => {
  const webQueries = [];
  const newsQueries = [];
  const result = await detectLayoffs('On Location', {
    now: NOW,
    description: 'On Location is the premium experiential hospitality company. Work Location: New York.',
    fetch: async (url) => {
      if (String(url).includes('wikidata.org')) {
        return { ok: true, json: async () => ({ search: [] }) };
      }

      return fyi404();
    },
    searchNews: async (query) => {
      newsQueries.push(query);
      return [{
        title: 'Location services firm lays off 200 workers',
        description: 'The location data company announced job cuts on August 2, 2026.',
        publishedAt: '2026-08-02 00:00:00'
      }];
    },
    webSearch: async (query) => {
      webQueries.push(query);
      return [{
        title: 'Location tech startup lays off staff',
        snippet: 'Reports on August 2, 2026 say a location startup is laying off staff.',
        url: 'https://example.com/location-layoffs'
      }];
    }
  });

  assert.deepEqual(newsQueries, ['on location layoffs']);
  assert.deepEqual(webQueries, ['on location layoffs']);
  assert.equal(result.detected, false);
});

test('a one-word short form is kept when the posting uses it as the company name', async () => {
  const { groundedCompanyQueries } = await import('../lib/server/layoffs.js');
  const deps = { fetch: async () => ({ ok: true, json: async () => ({ search: [] }) }) };

  assert.deepEqual(
    await groundedCompanyQueries('Hyundai Supernal', { ...deps, description: 'At Supernal, we design aircraft.' }),
    ['hyundai supernal', 'supernal']
  );
  assert.deepEqual(
    await groundedCompanyQueries('Hyundai Supernal', { ...deps, description: 'Hyundai Supernal designs aircraft.' }),
    ['hyundai supernal']
  );
});

test('a slow layoffs.fyi does not hold up the other sources', async () => {
  const started = [];
  let releaseFyi;
  const fyiGate = new Promise((resolve) => {
    releaseFyi = resolve;
  });
  const result = detectLayoffs('Bright Horizons', {
    now: NOW,
    fetch: async (url) => {
      if (String(url).includes('wikidata.org')) {
        return { ok: true, json: async () => ({ search: [] }) };
      }

      started.push('fyi');
      await fyiGate;
      return fyi404();
    },
    searchNews: async () => {
      started.push('news');
      return [];
    },
    webSearch: async () => {
      started.push('web');
      return [];
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(started.includes('news') && started.includes('web'), 'other sources wait on layoffs.fyi');
  releaseFyi();
  assert.equal((await result).detected, false);
});
