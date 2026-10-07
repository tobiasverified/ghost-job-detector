import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCache } from '../lib/server/cache.js';
import { MemoryRateLimiter } from '../lib/server/rateLimit.js';
import { analysisCacheKey, analyzeJobPosting, createAnalyzeHandler, createReviewsHandler, FACTOR_VERSIONS, refreshIpCacheKey, resolveCompanyReview, resolveWorkforce, reviewCacheKey } from '../lib/server/analyze.js';

const NOW = new Date('2026-09-25T12:00:00Z');
const SECRET = 'super-secret-news-key';

function mockResponse() {
  return {
    headers: {},
    statusCode: 0,
    body: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(payload) {
      this.body = payload ? JSON.parse(payload) : null;
    }
  };
}

function mockRequest(body, headers = {}) {
  return {
    method: 'POST',
    headers: {
      'x-ghd-client': 'ghost-job-detector',
      'x-forwarded-for': '203.0.113.10',
      origin: 'chrome-extension://abcdefghijklmnop',
      ...headers
    },
    body
  };
}

function layoffDeps(extra = {}) {
  return {
    now: NOW,
    cache: new MemoryCache(),
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }),
    searchNews: async () => [],
    webSearch: async (query) => {
      if (/glassdoor|indeed|simplyhired/i.test(query)) {
        return [];
      }

      if (/supernal/i.test(query)) {
        return [
          {
            title: 'Supernal lays off workers',
            snippet: 'August 2, 2026 reports say Supernal is laying off staff.',
            url: 'https://example.com/supernal',
            source: 'duckduckgo'
          }
        ];
      }

      return [];
    },
    fetchCache: async () => 'It is a snapshot of the page as it appeared on Sep 20, 2026 12:00:00 GMT.',
    ...extra
  };
}

test('a known employee count is shown when open roles are missing', () => {
  const workforce = resolveWorkforce({
    employees: 3001,
    employeeLabel: '3,001',
    openJobs: null,
    employeeSource: 'glassdoor'
  });

  assert.equal(workforce.available, false);
  assert.equal(workforce.employees, 3001);
  assert.equal(workforce.openRoles, null);
  assert.equal(workforce.label, '3,001 employees · open roles unknown');
  assert.equal(resolveWorkforce({ openJobs: 12 }).label, 'Unavailable');

  const linkedin = resolveWorkforce({
    employees: 12057,
    employeeLabel: '12,057',
    employeeSource: 'linkedin',
    openJobs: 75
  });
  const bucket = resolveWorkforce({
    employees: 3001,
    employeeLabel: '3,001',
    openJobs: 75
  });

  assert.equal(linkedin.estimated, false);
  assert.equal(linkedin.employeeSource, 'linkedin');
  assert.equal(linkedin.employeeDiscrepancy, '');
  assert.match(linkedin.label, /^12,057 employees/);
  assert.doesNotMatch(linkedin.label, /estimated/i);
  assert.equal(bucket.estimated, true);
  assert.match(bucket.label, /^3,001 employees/);
});

test('analyze-job scores a Supernal layoff found through DuckDuckGo', async () => {
  const analysis = await analyzeJobPosting({
    title: 'AI Engineer',
    company: 'Hyundai Supernal',
    description: 'At Supernal, you will build Python, Java, and AWS services. 5 years of experience. Salary $180,000. The team owns flight software, simulation, and safety reviews across a detailed platform roadmap with specific deliverables for each quarter and documented on-call expectations.',
    url: 'https://www.linkedin.com/jobs/view/1',
    platform: 'LINKEDIN'
  }, layoffDeps());

  assert.equal(analysis.factors.layoffs.detected, true);
  assert.equal(analysis.factors.layoffs.source, 'duckduckgo');
  assert.equal(analysis.factors.reviews.rating, null);
  assert.equal(analysis.factors.hiringRatio.available, false);
  assert.equal(analysis.ghostScore, analysis.factors.layoffs.score + analysis.factors.vagueness.score);
  assert.ok(analysis.ghostScore >= 25);
});

test('a clean company with a specific description stays in the unlikely band', async () => {
  const description = Array.from({ length: 40 }, () => (
    'You will build Python, Java, React, AWS, SQL, and Kubernetes services with 5 years of experience and a salary of $160,000.'
  )).join(' ');
  const analysis = await analyzeJobPosting({
    title: 'Backend Engineer',
    company: 'Initech',
    description,
    url: 'https://example.com/job',
    platform: 'LINKEDIN'
  }, layoffDeps());

  assert.equal(analysis.factors.layoffs.detected, false);
  assert.equal(analysis.factors.layoffs.unavailable, false);
  assert.ok(analysis.ghostScore <= 34);
  assert.equal(analysis.label, 'Ghost Job: Not detected');
});

test('successful analyses are cached for the next request', async () => {
  let newsCalls = 0;
  const deps = layoffDeps({
    searchNews: async () => {
      newsCalls += 1;
      return [
        {
          title: 'Amazon plans job cuts across devices',
          description: 'Amazon is laying off staff.',
          publishedAt: '2026-08-15 00:00:00',
          url: 'https://example.com/amazon',
          source: 'Example News'
        }
      ];
    }
  });
  const job = {
    title: 'Software Engineer',
    company: 'Amazon',
    description: 'Design services.',
    url: 'https://example.com/amazon-job',
    platform: 'LINKEDIN'
  };

  const first = await analyzeJobPosting(job, deps);
  const second = await analyzeJobPosting(job, deps);

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(newsCalls, 1);
  assert.equal(second.factors.layoffs.detected, true);
});

test('the handler hides upstream errors and enforces the client header', async () => {
  const handler = createAnalyzeHandler({
    now: NOW,
    cache: new MemoryCache(),
    rateLimit: new MemoryRateLimiter(50),
    searchNews: async () => {
      throw new Error(`NewsData rejected ${SECRET}`);
    },
    webSearch: async () => [],
    fetchCache: async () => {
      throw new Error('offline');
    },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })
  });
  const res = mockResponse();

  await handler(mockRequest({
    title: 'Engineer',
    company: 'Meta',
    description: 'Build reliable services for a large product organization with clear ownership.',
    url: 'https://example.com/meta',
    platform: 'LINKEDIN'
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.stringify(res.body).includes(SECRET), false);
  assert.equal(res.body.factors.layoffs.unavailable, false);

  const forbidden = mockResponse();
  await handler(mockRequest({ title: 'Engineer', company: 'Meta' }, { 'x-ghd-client': 'browser' }), forbidden);
  assert.equal(forbidden.statusCode, 403);
});

test('rate limiting returns 429 after the hourly cap', async () => {
  const handler = createReviewsHandler({
    now: NOW,
    cache: new MemoryCache(),
    rateLimit: new MemoryRateLimiter(1),
    webSearch: async () => []
  });
  const first = mockResponse();
  const second = mockResponse();
  const request = () => mockRequest(
    { company: 'Meta' },
    { 'x-forwarded-for': '203.0.113.20' }
  );

  await handler(request(), first);
  await handler(request(), second);

  assert.equal(first.statusCode, 200);
  assert.equal(first.body.rating, null);
  assert.equal(second.statusCode, 429);
  assert.equal(JSON.stringify(second.body).includes(SECRET), false);
});

test('the handler ignores review HTML sent in the request', async () => {
  const handler = createAnalyzeHandler({
    now: NOW,
    cache: new MemoryCache(),
    rateLimit: new MemoryRateLimiter(10),
    searchNews: async () => [],
    webSearch: async () => {
      throw new Error('server search should not run');
    },
    fetchCache: async () => {
      throw new Error('offline');
    },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })
  });
  const res = mockResponse();

  await handler(mockRequest({
    title: 'Engineer',
    company: 'Axon',
    description: 'Build services.',
    url: 'https://www.linkedin.com/jobs/view/1',
    platform: 'LINKEDIN',
    clientHtml: {
      reviews: '<div class="result__body"><a class="result__a" href="https://www.glassdoor.com/Reviews/Axon-Reviews-E1597674.htm">Axon Reviews</a><a class="result__snippet" href="https://example.com">Axon has an employee rating of 3.6 out of 5 stars, based on 778 company reviews.</a></div>'
    }
  }), res);

  // Anyone can send that HTML. A rating read from it would be cached for
  // every user, so the server looks the reviews up itself instead.
  assert.equal(res.statusCode, 200);
  assert.notEqual(res.body.factors.reviews.rating, 3.6);
  assert.notEqual(res.body.factors.reviews.reviewCount, 778);
});

test('a RapidAPI rating is the Glassdoor review and skips search', async () => {
  let reviewSearches = 0;
  const deps = layoffDeps({
    lookupCompanyRating: async () => ({ overall: 3.6, source: 'glassdoor', cached: false }),
    webSearch: async (query) => {
      if (/reviews/i.test(query)) {
        reviewSearches += 1;
      }

      return [];
    }
  });
  const job = {
    title: 'Engineer',
    company: 'Capital One',
    description: 'Build Python and AWS services. 5 years of experience. Salary $150,000.',
    url: 'https://www.linkedin.com/jobs/view/9',
    platform: 'LINKEDIN'
  };

  const analysis = await analyzeJobPosting(job, deps);

  assert.equal(analysis.factors.reviews.platform, 'Glassdoor');
  assert.equal(analysis.factors.reviews.source, 'rapidapi');
  assert.equal(analysis.factors.reviews.rating, 3.6);
  assert.equal(analysis.factors.reviews.score, 4);
  assert.equal(reviewSearches, 0);
});

test('a RapidAPI miss falls back to the DuckDuckGo review snippet', async () => {
  const analysis = await analyzeJobPosting({
    title: 'Engineer',
    company: 'Axon',
    description: 'Build Python and AWS services. 5 years of experience. Salary $150,000.',
    url: 'https://www.linkedin.com/jobs/view/10',
    platform: 'LINKEDIN'
  }, layoffDeps({
    lookupCompanyRating: async () => ({ overall: null, error: 'not_found' }),
    webSearch: async (query) => {
      if (!/reviews/i.test(query)) {
        return [];
      }

      return [{
        title: 'Axon Reviews',
        snippet: 'Axon has an employee rating of 3.6 out of 5 stars, based on 778 company reviews on Glassdoor.',
        url: 'https://www.glassdoor.com/Reviews/Axon-Reviews-E1597674.htm'
      }];
    }
  }));

  assert.equal(analysis.factors.reviews.platform, 'Glassdoor');
  assert.equal(analysis.factors.reviews.source, 'duckduckgo');
  assert.equal(analysis.factors.reviews.rating, 3.6);
  assert.equal(analysis.factors.reviews.reviewCount, 778);
  assert.equal(analysis.factors.reviews.score, 4);
});

test('missing job fields are rejected', async () => {
  const handler = createAnalyzeHandler({
    now: NOW,
    cache: new MemoryCache(),
    rateLimit: new MemoryRateLimiter(10),
    searchNews: async () => [],
    webSearch: async () => [],
    fetchCache: async () => {
      throw new Error('offline');
    },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })
  });
  const res = mockResponse();

  await handler(mockRequest({ title: '' }), res);
  assert.equal(res.statusCode, 400);
});

test('a Workday career-portal name is resolved before the company check', async () => {
  let lookedUp = '';
  const analysis = await analyzeJobPosting({
    title: 'Epic Senior Analyst, HB',
    company: 'UMCareer Staff',
    description: `${'The University of Miami Health System ("UHealth") provides patient care across Miami-Dade. '.repeat(4)}`,
    url: '',
    hostname: 'umiami.wd1.myworkdayjobs.com',
    platform: 'WORKDAY'
  }, layoffDeps({
    ratioEnabled: true,
    lookupCompanyRating: async (company) => {
      lookedUp = company;
      return {
        overall: 3.8,
        employees: 10000,
        employeeLabel: '10,000+',
        employeesLowerBound: true,
        openJobs: 1984,
        source: 'glassdoor'
      };
    },
    fetch: async (url) => {
      const href = String(url);

      if (href.includes('wbsearchentities')) {
        return {
          ok: true,
          json: async () => ({ search: [{ id: 'Q738258', label: 'University of Miami' }] })
        };
      }

      if (href.includes('wbgetentities')) {
        return {
          ok: true,
          json: async () => ({
            entities: {
              Q738258: {
                labels: { en: { value: 'University of Miami' } },
                aliases: { en: [{ value: 'UMiami' }] }
              }
            }
          })
        };
      }

      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
  }));

  assert.equal(lookedUp, 'University of Miami');
  assert.equal(analysis.factors.hiringRatio.employees, 10000);
  assert.equal(analysis.factors.hiringRatio.available, true);
  assert.equal(analysis.factors.reviews.rating, 3.8);
});

test('deferred cache writes return at once and still reach the cache through waitUntil', async () => {
  const { deferWrites, MemoryCache } = await import('../lib/server/cache.js');
  const backing = new MemoryCache();
  let releaseWrite;
  const slow = {
    get: (key, now) => backing.get(key, now),
    set: (key, payload, ttl, now) => new Promise((resolve) => {
      releaseWrite = () => resolve(backing.set(key, payload, ttl, now));
    })
  };
  const handedOff = [];
  const cache = deferWrites(slow, (promise) => handedOff.push(promise));
  const now = new Date('2026-10-02T12:00:00Z');

  await cache.set('k', { v: 1 }, 60_000, now);
  assert.equal(handedOff.length, 1);
  assert.equal(await backing.get('k', now), null);

  releaseWrite();
  await handedOff[0];
  assert.deepEqual(await backing.get('k', now), { v: 1 });
});

test('without a waitUntil, cache writes are awaited as before', async () => {
  const { deferWrites, MemoryCache } = await import('../lib/server/cache.js');
  const backing = new MemoryCache();
  assert.equal(deferWrites(backing, null), backing);
});

test('a deferred full check leaves repost search to the follow-up request', async () => {
  const queries = [];
  const result = await analyzeJobPosting({
    title: 'Engineer',
    company: 'Initech',
    description: 'Build services for a large product organization with clear ownership and documented reviews.',
    deferReposts: true
  }, layoffDeps({
    webSearch: async (query) => {
      queries.push(query);
      return [];
    }
  }));

  assert.equal(result.factors.reposts.pending, true);
  assert.equal(result.factors.reposts.score, 0);
  assert.equal(queries.some((query) => /Engineer Initech/i.test(query)), false);
});

test('an analysis cache hit still rechecks reposts when the factor version matches', async () => {
  const cache = new MemoryCache();
  let repostReads = 0;
  const match = {
    url: 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4460918631',
    title: 'T-Mobile hiring Senior Data Science Engineer in New York, NY | LinkedIn',
    snippet: 'T-Mobile Advertising Solutions in New York, NY.'
  };
  const html = '<div class="result__body"><a class="result__a" href="https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4460918631">T-Mobile hiring Senior Data Science Engineer in New York, NY | LinkedIn</a><a class="result__snippet" href="https://example.com">T-Mobile Advertising Solutions in New York, NY.</a></div>';
  const job = {
    title: 'Senior Data Science Engineer',
    company: 'T-Mobile',
    description: 'Build Python and AWS services. 5 years of experience. Salary $150,000. The team owns a specific model and documented on-call expectations.',
    url: 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4474577888',
    platform: 'LINKEDIN',
    location: 'New York, NY',
    locationNormalized: 'New York, New York'
  };
  const deps = layoffDeps({
    cache,
    webSearch: async (query) => {
      if (String(query).includes('Senior Data Science Engineer')) {
        repostReads += 1;
        return [match];
      }

      return [];
    }
  });

  assert.equal(FACTOR_VERSIONS.reposts, 'v3');
  assert.match(analysisCacheKey(job), /^analyze:v29:/);
  // The server's own repost search: its result is shared and cached.
  const first = await analyzeJobPosting(job, deps);
  assert.equal(first.cached, false);
  assert.equal(first.factorVersions.reposts, 'v3');
  assert.equal(first.factors.reposts.count, 1);
  assert.equal(repostReads, 1);

  const stored = await cache.get(analysisCacheKey(job), NOW);
  stored.factorVersions.reposts = 'v3';
  stored.factors.reposts = { ...stored.factors.reposts, count: 0, score: 0, matches: [] };

  // The analysis is a cache hit, and reposts are read again from their own
  // cache entry, not from the stale copy on the analysis.
  const refreshed = await analyzeJobPosting(job, deps);
  assert.equal(refreshed.cached, true);
  assert.equal(refreshed.factors.reposts.count, 1);
  assert.equal(refreshed.factors.reposts.matches[0].url.includes('4460918631'), true);
  assert.equal(repostReads, 1);
  assert.equal(stored.factors.layoffs, refreshed.factors.layoffs);

  // Client HTML still answers the requester, without a search.
  for (const key of [...cache.store.keys()]) {
    if (String(key).startsWith('linkedin_repost_')) {
      cache.store.delete(key);
    }
  }

  const fromClient = await analyzeJobPosting({ ...job, clientHtml: { reposts: html } }, deps);
  assert.equal(fromClient.factors.reposts.count, 1);
  assert.equal(repostReads, 1);
});

test('a glassdoor profile keeps its review count and drops a missing one', async () => {
  const counted = await resolveCompanyReview('Harrison Clarke', {}, { overall: 4.5, reviewCount: 43 });
  const missing = await resolveCompanyReview('Harrison Clarke', {}, { overall: 3.7 });
  const zero = await resolveCompanyReview('Harrison Clarke', {}, { overall: 3.7, reviewCount: 0 });

  assert.equal(counted.rating, 4.5);
  assert.equal(counted.reviewCount, 43);
  assert.equal(counted.platform, 'Glassdoor');
  assert.equal(missing.rating, 3.7);
  assert.equal(missing.reviewCount, null);
  assert.equal(zero.reviewCount, null);
});

// The rate check now runs alongside the factors. These pin what that may and
// may not do while the decision is pending.
function slowRateLimit(allowed, delayMs = 30) {
  return {
    async consume() {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { allowed, count: allowed ? 1 : 51, limit: 50 };
    }
  };
}

function recordingDeps(log) {
  const writes = [];
  const cache = new MemoryCache();
  const set = cache.set.bind(cache);
  cache.set = async (...args) => {
    writes.push(args[0]);
    return set(...args);
  };

  return {
    writes,
    overrides: {
      now: NOW,
      cache,
      env: { RAPIDAPI_KEY: 'rapid-test', GROQ_API_KEY: 'groq-test' },
      searchNews: async () => {
        log.push('paid:newsdata');
        return [];
      },
      webSearch: async () => {
        log.push('paid:tavily');
        return [];
      },
      askGroq: async () => {
        log.push('paid:groq');
        return 'UNKNOWN';
      },
      fetch: async (url) => {
        const host = new URL(String(url)).hostname;
        log.push(/rapidapi\.com$/.test(host) ? `paid:${host}` : `free:${host}`);
        return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      }
    }
  };
}

const gateJob = {
  title: 'Analyst',
  company: 'Initech',
  description: 'You will build Python services with 5 years of experience. Salary $150,000. Specific duties are listed for each quarter.',
  url: 'https://www.linkedin.com/jobs/view/101',
  platform: 'LINKEDIN',
  deferReposts: true
};

test('a rejected request gets 429 with no results, no paid calls and no cache writes', async () => {
  const log = [];
  const { writes, overrides } = recordingDeps(log);
  const handler = createAnalyzeHandler({ ...overrides, rateLimit: slowRateLimit(false) });
  const res = mockResponse();

  await handler(mockRequest(gateJob), res);
  // Let any factor work still in flight settle before checking.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(res.statusCode, 429);
  assert.equal(res.body.factors, undefined);
  assert.equal(res.body.ghostScore, undefined);
  assert.deepEqual(log.filter((item) => item.startsWith('paid:')), []);
  assert.deepEqual(writes, []);
});

test('free reads start while the rate check is pending; paid calls wait for it', async () => {
  const log = [];
  const { overrides } = recordingDeps(log);
  const order = [];
  const decided = slowRateLimit(true, 40);
  const handler = createAnalyzeHandler({
    ...overrides,
    rateLimit: {
      async consume(...args) {
        const result = await decided.consume(...args);
        order.push('decided');
        return result;
      }
    },
    fetch: async (url, init) => {
      const host = new URL(String(url)).hostname;
      order.push(/rapidapi\.com$/.test(host) ? 'paid' : 'free');
      return overrides.fetch(url, init);
    }
  });
  const res = mockResponse();

  await handler(mockRequest(gateJob), res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.factors);
  const decidedAt = order.indexOf('decided');
  assert.ok(order.indexOf('free') >= 0 && order.indexOf('free') < decidedAt, `free work should start before the decision: ${order.join(',')}`);
  assert.ok(order.indexOf('paid') === -1 || order.indexOf('paid') > decidedAt, `paid calls must follow the decision: ${order.join(',')}`);
});

test('reviews uses the validated Glassdoor rating without waiting for the headcount merge', async () => {
  const { createTrace } = await import('../lib/server/trace.js');
  const trace = createTrace('test');
  const ends = {};
  const span = trace.span;
  trace.span = (name, work) => span(name, work).finally(() => {
    ends[name] = Date.now();
  });
  const deps = layoffDeps({
    trace,
    // The rating is final at once; the headcount (a paid search) takes 300ms more.
    lookupCompanyRating: async (company, options) => {
      options.onGlassdoorFields?.({ website: 'https://acme.example', openJobs: 12, glassdoorSize: '10000+ Employees', overall: 4.2, reviewCount: 900 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { overall: 4.2, reviewCount: 900, employees: 50000, employeeLabel: '50,000', openJobs: 12, website: 'https://acme.example' };
    }
  });

  const analysis = await analyzeJobPosting({
    title: 'Analyst',
    company: 'Acme',
    description: 'You will build Python services with 5 years of experience. Salary $150,000. Specific duties are listed for each quarter.',
    url: 'https://www.linkedin.com/jobs/view/1',
    platform: 'LINKEDIN',
    deferReposts: true
  }, deps);

  assert.equal(analysis.factors.reviews.rating, 4.2);
  const profileEnd = ends['factor: company profile (glassdoor+headcount)'];
  const reviewsEnd = ends['factor: reviews'];
  assert.ok(reviewsEnd + 200 < profileEnd, `reviews ended ${profileEnd - reviewsEnd}ms before the profile; expected about 300ms`);
});

test('negative reviews are capped from their write time and refresh skips them once', async () => {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const empty = {
    rating: null,
    reviewCount: null,
    platform: null,
    url: null,
    score: 0,
    unavailable: false,
    detail: 'No public reviews found'
  };
  const job = {
    title: 'Engineer',
    company: 'Acme',
    description: 'Build services for a large product organization with clear ownership and documented reviews.',
    jobId: 'acme-1',
    url: 'https://example.com/jobs/acme-1',
    deferReposts: true
  };
  const key = reviewCacheKey(job.company);
  const cache = new MemoryCache();
  await cache.set(key, empty, 30 * day, new Date(NOW.getTime() - (2 * hour)));
  const kept = await analyzeJobPosting(job, layoffDeps({ cache, webSearch: async () => [] }));
  assert.equal(kept.factors.reviews.detail, 'No public reviews found');
  assert.equal(kept.factors.reviews.rating, null);

  cache.store.get(key).updatedAt = new Date(NOW.getTime() - (25 * hour)).toISOString();
  cache.store.get(key).expiresAt = new Date(NOW.getTime() + day).toISOString();
  const expired = await analyzeJobPosting(job, layoffDeps({
    cache,
    webSearch: async () => [{
      title: 'Acme reviews',
      url: 'https://www.glassdoor.com/Reviews/Acme-Reviews-E1.htm',
      snippet: 'Rated 4.2 out of 5 from 80 reviews'
    }]
  }));
  assert.equal(expired.factors.reviews.rating, 4.2);

  const rejected = { ...empty, hitsRejected: true };
  await cache.set(key, rejected, 30 * day, new Date(NOW.getTime() - (30 * 60 * 1000)));
  const recentRejection = await analyzeJobPosting(job, layoffDeps({
    cache,
    webSearch: async () => [{
      title: 'Acme reviews',
      url: 'https://www.glassdoor.com/Reviews/Acme-Reviews-E1.htm',
      snippet: 'Rated 1.1 out of 5 from 80 reviews'
    }]
  }));
  assert.equal(recentRejection.factors.reviews.hitsRejected, true);
  assert.equal(recentRejection.factors.reviews.rating, null);

  cache.store.get(key).updatedAt = new Date(NOW.getTime() - (2 * hour)).toISOString();
  cache.store.get(key).expiresAt = new Date(NOW.getTime() + day).toISOString();
  const oldRejection = await analyzeJobPosting(job, layoffDeps({
    cache,
    webSearch: async () => [{
      title: 'Acme reviews',
      url: 'https://www.glassdoor.com/Reviews/Acme-Reviews-E1.htm',
      snippet: 'Rated 4.8 out of 5 from 80 reviews'
    }]
  }));
  assert.equal(oldRejection.factors.reviews.rating, 4.8);

  await cache.set(key, empty, 30 * day, new Date(NOW.getTime() - (60 * 1000)));
  const refreshed = await analyzeJobPosting({ ...job, refresh: true }, layoffDeps({
    cache,
    webSearch: async () => [{
      title: 'Acme reviews',
      url: 'https://www.glassdoor.com/Reviews/Acme-Reviews-E1.htm',
      snippet: 'Rated 4.2 out of 5 from 80 reviews'
    }]
  }));
  assert.equal(refreshed.factors.reviews.rating, 4.2);

  await cache.set(key, empty, 30 * day, NOW);
  const blocked = await analyzeJobPosting({ ...job, refresh: true }, layoffDeps({
    cache,
    webSearch: async () => [{
      title: 'Acme reviews',
      url: 'https://www.glassdoor.com/Reviews/Acme-Reviews-E1.htm',
      snippet: 'Rated 1.0 out of 5 from 80 reviews'
    }]
  }));
  assert.equal(blocked.factors.reviews.rating, null);
  assert.equal(blocked.factors.reviews.detail, 'No public reviews found');
});

test('refresh recomputes a partial analysis and keeps a positive review', async () => {
  const cache = new MemoryCache();
  const job = {
    title: 'Engineer',
    company: 'Initech',
    description: 'Build services for a large product organization with clear ownership and documented reviews.',
    jobId: 'initech-1',
    url: 'https://example.com/jobs/initech-1',
    deferReposts: true,
    refresh: true
  };
  await cache.set(analysisCacheKey(job), {
    partial: true,
    scoreWithheld: true,
    ghostScore: null,
    label: 'Some checks took too long',
    factors: {
      reviews: { rating: 1, unavailable: false, score: 0 },
      vagueness: { score: 0, label: 'Clear' },
      layoffs: { unavailable: false, detected: false, score: 0 },
      hiringRatio: { available: false, timedOut: true, score: 0 },
      reposts: { pending: true, score: 0, unavailable: true }
    },
    factorVersions: { ...FACTOR_VERSIONS },
    checkedAt: NOW.toISOString()
  }, 5 * 60 * 1000, NOW);
  await cache.set(reviewCacheKey(job.company), {
    rating: 4.4,
    reviewCount: 40,
    platform: 'Glassdoor',
    url: 'https://www.glassdoor.com/Reviews/Initech-Reviews-E9.htm',
    score: 5,
    unavailable: false
  }, 30 * 24 * 60 * 60 * 1000, new Date(NOW.getTime() - (10 * 24 * 60 * 60 * 1000)));

  const result = await analyzeJobPosting(job, layoffDeps({
    cache,
    webSearch: async () => [{
      title: 'Initech reviews',
      url: 'https://www.glassdoor.com/Reviews/Initech-Reviews-E9.htm',
      snippet: 'Rated 1.0 out of 5 from 40 reviews'
    }]
  }));

  assert.equal(result.cached, false);
  assert.equal(result.factors.reviews.rating, 4.4);
});

test('an IP can refresh ten times an hour and the next request is a normal check', async () => {
  const cache = new MemoryCache();
  const ip = '203.0.113.50';
  const empty = {
    rating: null,
    reviewCount: null,
    platform: null,
    url: null,
    score: 0,
    unavailable: false,
    detail: 'No public reviews found'
  };
  await cache.set(reviewCacheKey('Acme'), empty, 30 * 24 * 60 * 60 * 1000, NOW);
  await cache.set(refreshIpCacheKey(ip), { count: 9, windowStart: NOW.toISOString() }, 60 * 60 * 1000, NOW);
  let reviewSearches = 0;
  const webSearch = async (query) => {
    if (String(query).includes('reviews')) {
      reviewSearches += 1;
    }

    return [];
  };
  const job = (id) => ({
    title: 'Engineer',
    company: 'Acme',
    description: 'Build services for a large product organization with clear ownership and documented reviews.',
    jobId: id,
    url: `https://example.com/jobs/${id}`,
    deferReposts: true,
    refresh: true
  });
  await analyzeJobPosting(job('tenth'), layoffDeps({ cache, clientIp: ip, webSearch }));
  assert.ok(reviewSearches > 0);
  assert.equal((await cache.get(refreshIpCacheKey(ip), NOW)).count, 10);

  const afterCap = reviewSearches;
  const blocked = await analyzeJobPosting(job('eleventh'), layoffDeps({ cache, clientIp: ip, webSearch }));
  assert.equal(reviewSearches, afterCap);
  assert.equal(blocked.factors.reviews.rating, null);
  assert.equal(blocked.factors.reviews.detail, 'No public reviews found');
  assert.equal((await cache.get(refreshIpCacheKey(ip), NOW)).count, 10);

  await analyzeJobPosting(job('other-ip'), layoffDeps({ cache, clientIp: '203.0.113.51', webSearch }));
  assert.ok(reviewSearches > afterCap);
});

test('an analysis that includes reposts parsed from client HTML is not written to the shared cache', async () => {
  const cache = new MemoryCache();
  const html = '<div class="result__body"><a class="result__a" href="https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4460918631">T-Mobile hiring Senior Data Science Engineer in New York, NY | LinkedIn</a><a class="result__snippet" href="https://example.com">T-Mobile Advertising Solutions in New York, NY.</a></div>';
  const job = {
    title: 'Senior Data Science Engineer',
    company: 'T-Mobile',
    description: 'Build Python and AWS services.',
    url: 'https://www.linkedin.com/jobs/view/senior-data-science-engineer-at-t-mobile-4474577888',
    platform: 'LINKEDIN',
    location: 'New York, NY',
    locationNormalized: 'New York, New York'
  };
  const deps = layoffDeps({ cache, webSearch: async () => [] });

  const fromClient = await analyzeJobPosting({ ...job, clientHtml: { reposts: html } }, deps);
  assert.equal(fromClient.factors.reposts.count, 1);
  assert.equal(await cache.get(analysisCacheKey(job), NOW), null);

  // With reposts deferred to their own request, the analysis has no
  // client-built part and is cached as before.
  const deferred = await analyzeJobPosting({ ...job, deferReposts: true, clientHtml: { reposts: html } }, deps);
  assert.equal(deferred.cached, false);
  assert.notEqual(await cache.get(analysisCacheKey(job), NOW), null);
});
