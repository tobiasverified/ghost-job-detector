import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCache } from '../lib/server/cache.js';
import { resolveWorkforce } from '../lib/server/analyze.js';
import { createCompanyRatingHandler, glassdoorEntityMatches, lookupCompanyRating, parseEmployeeSize } from '../lib/server/company-rating.js';
import { scoreHiringRatio } from '../lib/server/workforce.js';
import { MemoryRateLimiter } from '../lib/server/rateLimit.js';

const NOW = new Date('2026-09-27T12:00:00Z');
const SECRET = 'rapid-test-key-should-not-leak';

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

function mockRequest(company, headers = {}) {
  return {
    method: 'GET',
    url: `/api/company-rating?company=${encodeURIComponent(company)}`,
    headers: {
      'x-ghd-client': 'ghost-job-detector',
      'x-forwarded-for': '203.0.113.40',
      origin: 'chrome-extension://abcdefghijklmnop',
      ...headers
    }
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    }
  };
}

function handlerWith(fetchImpl, cache = new MemoryCache()) {
  return {
    cache,
    handler: createCompanyRatingHandler({
      now: NOW,
      cache,
      rateLimit: new MemoryRateLimiter(50),
      env: { RAPIDAPI_KEY: SECRET },
      fetch: fetchImpl
    })
  };
}

test('a ratings response returns the overall score and caches it for a day', async () => {
  const calls = [];
  const { cache, handler } = handlerWith(async (url, options) => {
    calls.push({ url: String(url), key: options.headers['x-rapidapi-key'] });
    return jsonResponse(200, {
      ratings: { overall: 3.849, career_opportunities: 3.7 }
    });
  });
  const res = mockResponse();

  await handler(mockRequest('Google'), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    overall: 3.85,
    employees: null,
    employeeLabel: null,
    openJobs: null,
    source: 'glassdoor',
    cached: false
  });
  assert.equal(calls.filter((call) => call.url.includes('rapidapi.com')).length, 1);
  assert.match(calls[0].url, /\/companies\/details\?company=Google$/);
  assert.equal(calls[0].key, SECRET);
  assert.equal(JSON.stringify(res.body).includes(SECRET), false);

  const again = mockResponse();
  await handler(mockRequest('Google'), again);
  assert.deepEqual(again.body, {
    overall: 3.85,
    employees: null,
    employeeLabel: null,
    openJobs: null,
    source: 'glassdoor',
    cached: true
  });
  assert.equal(calls.filter((call) => call.url.includes('rapidapi.com')).length, 1);

  const stored = await cache.get('glassdoor_rating_v2_google', new Date(NOW.getTime() + (23 * 60 * 60 * 1000)));
  assert.equal(stored.ratings.overall, 3.849);
  assert.equal(await cache.get('glassdoor_rating_v2_google', new Date(NOW.getTime() + (25 * 60 * 60 * 1000))), null);
});

test('parseEmployeeSize reads Glassdoor size buckets', () => {
  assert.equal(parseEmployeeSize('10000+ Employees'), 10000);
  assert.equal(parseEmployeeSize('10,000+ Employees'), 10000);
  assert.equal(parseEmployeeSize('1,001 to 5,000 Employees'), 3001);
  assert.equal(parseEmployeeSize('1-50 Employees'), 26);
  assert.equal(parseEmployeeSize('5,001 to 10,000 Employees'), 7501);
  assert.equal(parseEmployeeSize('Unknown'), null);
});

test('company details include the rating, size bucket, and open jobs', async () => {
  const rating = await lookupCompanyRating('Capital One', {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: SECRET },
    fetch: async (url) => {
      const href = String(url);

      if (href.includes('wikidata.org')) {
        return jsonResponse(200, { search: [] });
      }

      assert.match(href, /\/companies\/details\?company=Capital\+One$/);
      return jsonResponse(200, {
        ratings: { overall: 3.6, career_opportunities: 3.4 },
        size: '10000+ Employees',
        counts: { open_jobs: 1844 }
      });
    }
  });

  assert.deepEqual(rating, {
    overall: 3.6,
    employees: 10000,
    employeeLabel: '10,000+',
    employeesLowerBound: true,
    openJobs: 1844,
    source: 'glassdoor',
    cached: false
  });
});

test('403 stays unavailable and 429 is quota with no retry', async () => {
  const cases = [
    [403, 'unavailable'],
    [429, 'quota']
  ];

  for (const [status, error] of cases) {
    const cache = new MemoryCache();
    let calls = 0;
    const rating = await lookupCompanyRating('Acme', {
      now: NOW,
      cache,
      env: { RAPIDAPI_KEY: SECRET },
      fetch: async () => {
        calls += 1;
        return jsonResponse(status, { error: 'blocked' });
      }
    });

    assert.deepEqual(rating, { overall: null, error });
    assert.equal(calls, 1);
    assert.equal(await cache.get('glassdoor_rating_v2_acme', NOW), null);
  }
});

test('a career-portal name does not retry the generic word staff', async () => {
  const calls = [];
  const rating = await lookupCompanyRating('UMCareer Staff', {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: SECRET },
    fetch: async (url) => {
      calls.push(String(url));
      return jsonResponse(404, { error: 'not found' });
    }
  });

  const ratingCalls = calls.filter((url) => url.includes('rapidapi.com'));
  assert.equal(ratingCalls.some((url) => /[?&]company=staff(?:&|$)/i.test(url)), false);
  assert.match(ratingCalls[0], /company=UMCareer\+Staff$/);
  assert.equal(rating.error, 'not_found');
});

test('a missing full name retries the shorter alias and caches it under the original company', async () => {
  const cache = new MemoryCache();
  const calls = [];
  const deps = {
    now: NOW,
    cache,
    env: { RAPIDAPI_KEY: SECRET },
    fetch: async (url) => {
      calls.push(String(url));

      if (String(url).endsWith('company=amli')) {
        return jsonResponse(200, {
          ratings: { overall: 3.9 },
          size: '1,001 to 5,000 Employees',
          counts: { open_jobs: 12 }
        });
      }

      return jsonResponse(404, { error: 'not found' });
    }
  };

  const rating = await lookupCompanyRating('AMLI Residential', deps);
  const again = await lookupCompanyRating('AMLI Residential', deps);

  const ratingCalls = calls.filter((url) => url.includes('rapidapi.com'));
  assert.equal(ratingCalls.length, 2);
  assert.match(ratingCalls[0], /company=AMLI\+Residential$/);
  assert.match(ratingCalls[1], /company=amli$/);
  assert.equal(rating.overall, 3.9);
  assert.equal(rating.employees, 3001);
  assert.equal(rating.openJobs, 12);
  assert.equal(again.cached, true);
  assert.equal(again.overall, 3.9);
});

test('429 does not try a shorter alias', async () => {
  let calls = 0;
  const rating = await lookupCompanyRating('AMLI Residential', {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: SECRET },
    fetch: async () => {
      calls += 1;
      return jsonResponse(429, { error: 'quota' });
    }
  });

  assert.equal(calls, 1);
  assert.deepEqual(rating, { overall: null, error: 'quota' });
});

test('both the full name and the shorter alias missing returns not_found', async () => {
  const cache = new MemoryCache();
  let glassdoorCalls = 0;
  const rating = await lookupCompanyRating('AMLI Residential', {
    now: NOW,
    cache,
    env: { RAPIDAPI_KEY: SECRET },
    fetch: async (url) => {
      if (String(url).includes('rapidapi.com')) {
        glassdoorCalls += 1;
      }

      return jsonResponse(404, { error: 'not found' });
    }
  });

  assert.equal(glassdoorCalls, 2);
  assert.deepEqual(rating, { overall: null, error: 'not_found' });
  assert.equal(await cache.get('glassdoor_rating_v2_amli residential', NOW), null);
});

test('a missing key or a thrown request returns unavailable', async () => {
  const cache = new MemoryCache();
  const missing = await lookupCompanyRating('Acme', {
    now: NOW,
    cache,
    env: {},
    fetch: async () => {
      throw new Error('should not be called');
    }
  });
  const thrown = await lookupCompanyRating('Acme', {
    now: NOW,
    cache,
    env: { RAPIDAPI_KEY: SECRET },
    fetch: async () => {
      throw new Error('network');
    }
  });

  assert.deepEqual(missing, { overall: null, error: 'unavailable' });
  assert.deepEqual(thrown, { overall: null, error: 'unavailable' });
});

test('a Wikidata employee count above 10,000 replaces the Glassdoor bucket', async () => {
  const rating = await lookupCompanyRating('University of Miami', {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: SECRET },
    fetch: async (url) => {
      const href = String(url);

      if (href.includes('wbsearchentities')) {
        return jsonResponse(200, { search: [{ id: 'Q738258', label: 'University of Miami' }] });
      }

      if (href.includes('wbgetentities')) {
        return jsonResponse(200, {
          entities: {
            Q738258: {
              claims: {
                P1128: [{
                  rank: 'preferred',
                  mainsnak: { datavalue: { value: { amount: '+19000' } } }
                }]
              }
            }
          }
        });
      }

      return jsonResponse(200, {
        ratings: { overall: 3.8 },
        size: '10000+ Employees',
        counts: { open_jobs: 400 }
      });
    }
  });

  assert.equal(rating.employees, 19000);
  assert.equal(rating.employeeLabel, '19,000');
  assert.equal(rating.employeeSource, 'wikidata');
  assert.equal(rating.employeesLowerBound, undefined);
});

test('an implausible Wikidata employee count does not replace a much larger Glassdoor bucket', async () => {
  const rating = await lookupCompanyRating('University of Miami', {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: SECRET },
    fetch: async (url) => {
      const href = String(url);

      if (href.includes('wbsearchentities')) {
        return jsonResponse(200, { search: [{ id: 'Q738258', label: 'University of Miami' }] });
      }

      if (href.includes('wbgetentities')) {
        return jsonResponse(200, {
          entities: {
            Q738258: {
              claims: {
                P1128: [{
                  rank: 'preferred',
                  mainsnak: { datavalue: { value: { amount: '+2681' } } }
                }]
              }
            }
          }
        });
      }

      return jsonResponse(200, {
        ratings: { overall: 3.8 },
        size: '10,000+ Employees',
        counts: { open_jobs: 1984 }
      });
    }
  });
  const workforce = resolveWorkforce(rating);

  assert.equal(rating.employees, 10000);
  assert.equal(rating.employeeLabel, '10,000+');
  assert.equal(rating.employeeSource, undefined);
  assert.equal(rating.employeesLowerBound, true);
  assert.equal(rating.employeeDiscrepancy, 'A conflicting headcount was set aside and is not included in this ratio.');
  assert.equal(workforce.employees, 10000);
  assert.doesNotMatch(workforce.detail, /2,681|Wikidata|Glassdoor/);
  assert.match(workforce.tooltip, /conflicting headcount was set aside/);
  assert.doesNotMatch(workforce.tooltip, /Wikidata|2,681/);
});

test('an implausible Wikidata count is an empty signal so employee search can run', async () => {
  let groqCalls = 0;
  const fetchImpl = async (url) => {
    const href = String(url);

    if (href.includes('wbsearchentities')) {
      return jsonResponse(200, { search: [{ id: 'Q738258', label: 'University of Miami' }] });
    }

    if (href.includes('wbgetentities')) {
      return jsonResponse(200, {
        entities: {
          Q738258: {
            claims: {
              P1128: [{
                rank: 'preferred',
                mainsnak: { datavalue: { value: { amount: '+2681' } } }
              }]
            }
          }
        }
      });
    }

    return jsonResponse(200, {
      ratings: { overall: 3.8 },
      size: '10,000+ Employees',
      counts: { open_jobs: 1984 }
    });
  };
  const found = await lookupCompanyRating('University of Miami', {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: SECRET },
    fetch: fetchImpl,
    webSearch: async () => [{
      title: 'University of Miami employees',
      snippet: 'The university reports 21,698 employees.',
      url: 'https://example.com/umiami-employees'
    }],
    askGroq: async () => {
      groqCalls += 1;
      return 'Result 1 states 21,698 employees.';
    }
  });
  const declined = await lookupCompanyRating('University of Miami', {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: SECRET },
    fetch: fetchImpl,
    webSearch: async () => [{
      title: 'University of Miami employees',
      snippet: 'Estimates range from 8,800 to 21,000 employees.',
      url: 'https://example.com/umiami-range'
    }],
    askGroq: async () => {
      groqCalls += 1;
      return 'UNKNOWN';
    }
  });

  assert.equal(groqCalls, 2);
  assert.equal(found.employees, 21698);
  assert.equal(found.employeeSource, 'search');
  assert.equal(found.employeeSourceUrl, 'https://example.com/umiami-employees');
  assert.notEqual(found.employees, 2681);
  assert.equal(found.rejectedEmployeeCount, undefined);
  assert.equal(declined.employees, 10000);
  assert.equal(declined.employeeLabel, '10,000+');
  assert.equal(declined.employeesLowerBound, true);
  assert.match(declined.employeeDiscrepancy, /conflicting headcount was set aside/);
  assert.doesNotMatch(declined.employeeDiscrepancy, /Wikidata|2,681/);
});

test('a Glassdoor 10,000+ bucket with no Wikidata figure still runs employee search', async () => {
  let groqCalls = 0;
  const rating = await lookupCompanyRating('Acme', {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: SECRET },
    fetch: async (url) => {
      if (String(url).includes('wikidata.org')) {
        return jsonResponse(200, { search: [] });
      }

      return jsonResponse(200, {
        ratings: { overall: 3.4 },
        size: '10,000+ Employees',
        counts: { open_jobs: 80 }
      });
    },
    webSearch: async () => [{
      title: 'Acme company profile',
      snippet: 'Acme has 12,400 employees worldwide.',
      url: 'https://example.com/acme-employees'
    }],
    askGroq: async () => {
      groqCalls += 1;
      return 'Result 1 states 12,400 employees.';
    }
  });

  assert.equal(groqCalls, 1);
  assert.equal(rating.employees, 12400);
  assert.equal(rating.employeeLabel, '12,400');
  assert.equal(rating.employeeSource, 'search');
  assert.equal(rating.employeeSourceUrl, 'https://example.com/acme-employees');
  assert.equal(rating.employeesLowerBound, undefined);
});

test('an open-ended Glassdoor 10,000+ bucket keeps the plus when Wikidata has no count', async () => {
  const rating = await lookupCompanyRating('Acme', {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: SECRET },
    fetch: async (url) => {
      if (String(url).includes('wikidata.org')) {
        return jsonResponse(200, { search: [] });
      }

      return jsonResponse(200, {
        ratings: { overall: 3.4 },
        size: '10,000+ Employees',
        counts: { open_jobs: 80 }
      });
    }
  });
  const ratio = scoreHiringRatio({
    employees: rating.employees,
    openRoles: rating.openJobs,
    employeeLabel: rating.employeeLabel,
    lowerBound: rating.employeesLowerBound
  });

  assert.equal(rating.employees, 10000);
  assert.equal(rating.employeeLabel, '10,000+');
  assert.equal(rating.employeesLowerBound, true);
  assert.match(ratio.label, /10,000\+ employees/);
  assert.match(ratio.tooltip, /lower-bound estimate/i);
});

test('the route requires a company and the extension client header', async () => {
  const { handler } = handlerWith(async () => {
    throw new Error('should not be called');
  });
  const missing = mockResponse();
  const forbidden = mockResponse();

  await handler(mockRequest(''), missing);
  await handler(mockRequest('Google', { 'x-ghd-client': 'browser' }), forbidden);

  assert.equal(missing.statusCode, 400);
  assert.equal(forbidden.statusCode, 403);
});


const TKO_SEARCH = {
  webSearch: async (query) => {
    assert.match(query, /number of employees/);
    return [{
      title: 'TKO Group Holdings Number of Employees 2026 | Headcount Data',
      snippet: 'TKO Group Holdings has 12,400 employees worldwide.',
      url: 'https://example.com/companies/tko-group-holdings/employees'
    }];
  }
};

function employeeSearchDeps(fetch, askGroq, extra = {}) {
  return {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: SECRET },
    askGroq,
    webSearch: async (query) => {
      assert.match(query, /number of employees/);
      return [{
        title: 'Acme company profile',
        snippet: 'Acme has 12,400 employees worldwide.',
        url: 'https://example.com/acme-employees'
      }];
    },
    fetch,
    ...extra
  };
}

test('employee search runs only when Glassdoor and Wikidata have no usable count', async () => {
  let groqCalls = 0;
  const askGroq = async (prompt) => {
    groqCalls += 1;
    assert.match(prompt, /Acme/);
    assert.match(prompt, /12,400 employees/);
    assert.match(prompt, /respond UNKNOWN/);
    return 'Result 1 states 12,400 employees.';
  };
  const emptyFetch = async (url) => {
    const href = String(url);

    if (href.includes('wikidata.org')) {
      return jsonResponse(200, { search: [] });
    }

    return jsonResponse(200, {
      ratings: { overall: 3.2 },
      counts: { open_jobs: 10 }
    });
  };
  const found = await lookupCompanyRating('Acme', employeeSearchDeps(emptyFetch, askGroq));

  assert.equal(found.employees, 12400);
  assert.equal(found.employeeLabel, '12,400');
  assert.equal(found.employeeSource, 'search');
  assert.equal(found.employeeSourceUrl, 'https://example.com/acme-employees');
  assert.equal(groqCalls, 1);

  const workforce = resolveWorkforce(found);
  assert.equal(workforce.employeeSource, 'search');
  assert.match(workforce.detail, /Estimated from search: https:\/\/example\.com\/acme-employees/);

  groqCalls = 0;
  const glassdoor = await lookupCompanyRating('Capital One', employeeSearchDeps(async (url) => {
    const href = String(url);

    if (href.includes('wikidata.org')) {
      return jsonResponse(200, { search: [] });
    }

    return jsonResponse(200, {
      ratings: { overall: 3.9 },
      size: '5,001 to 10,000 Employees',
      counts: { open_jobs: 40 }
    });
  }, async () => {
    groqCalls += 1;
    throw new Error('search tier should not run');
  }));
  const wikidata = await lookupCompanyRating('University of Miami', employeeSearchDeps(async (url) => {
    const href = String(url);

    if (href.includes('wbsearchentities')) {
      return jsonResponse(200, { search: [{ id: 'Q738258' }] });
    }

    if (href.includes('wbgetentities')) {
      return jsonResponse(200, {
        entities: {
          Q738258: {
            claims: {
              P1128: [{ mainsnak: { datavalue: { value: { amount: '+19000' } } } }]
            }
          }
        }
      });
    }

    return jsonResponse(200, {
      ratings: { overall: 3.8 },
      size: '10000+ Employees',
      counts: { open_jobs: 40 }
    });
  }, async () => {
    groqCalls += 1;
    throw new Error('search tier should not run');
  }));

  assert.equal(glassdoor.employees, 7501);
  assert.equal(glassdoor.employeeSource, undefined);
  assert.equal(wikidata.employees, 19000);
  assert.equal(wikidata.employeeSource, 'wikidata');
  assert.equal(groqCalls, 0);
});

test('an implausibly small Glassdoor count with no Wikidata figure falls through to search', async () => {
  const logs = [];
  const original = console.info;
  console.info = (message, details) => {
    logs.push({ message, details });
    original.call(console, message, details);
  };

  try {
    const rating = await lookupCompanyRating('TKO Group Holdings', employeeSearchDeps(async (url) => {
      if (String(url).includes('wikidata.org')) {
        return jsonResponse(200, { search: [] });
      }

      return jsonResponse(200, {
        ratings: { overall: 3.7 },
        name: 'TKO Farms',
        id: 999,
        url: 'https://www.glassdoor.com/Overview/Working-at-TKO-Farms-EI_IE999.htm',
        size: '51 to 200 Employees',
        counts: { open_jobs: 4 }
      });
    }, async () => 'Result 1 states 12,400 employees.', TKO_SEARCH));
    const entity = logs.find((entry) => entry.message === '[GHD] glassdoor entity')?.details;

    assert.equal(rating.employees, 12400);
    assert.equal(rating.employeeSource, 'search');
    assert.equal(rating.employeeSourceUrl, 'https://example.com/companies/tko-group-holdings/employees');
    assert.notEqual(rating.employees, 126);
    // The whole wrong-company match is dropped, not just its headcount.
    assert.equal(rating.overall, null);
    assert.equal(rating.openJobs ?? null, null);
    assert.ok(logs.some((entry) => entry.message === '[GHD] glassdoor entity rejected' && entry.details?.entity === 'TKO Farms'));
    assert.equal(entity?.name, 'TKO Farms');
    assert.equal(entity?.id, '999');
    assert.equal(entity?.size, '51 to 200 Employees');
  } finally {
    console.info = original;
  }
});

test('a captured headcount that disagrees with a narrow Glassdoor bucket is not used in place of search', async () => {
  const rating = await lookupCompanyRating('TKO Group Holdings', {
    ...employeeSearchDeps(async (url) => {
      if (String(url).includes('wikidata.org')) {
        return jsonResponse(200, { search: [] });
      }

      return jsonResponse(200, {
        ratings: { overall: 3.7 },
        size: '51 to 200 Employees',
        counts: { open_jobs: 40 }
      });
    }, async () => 'Result 1 states 12,400 employees.', TKO_SEARCH),
    capturedHeadcount: { employees: 5000, capturedAt: NOW.getTime() }
  });

  assert.equal(rating.employees, 12400);
  assert.equal(rating.employeeSource, 'search');
  assert.match(rating.employeeDiscrepancy, /conflicting headcount was set aside/);
  assert.notEqual(rating.employees, 5000);
});

test('a wide Glassdoor bucket yields to a cached LinkedIn capture outside its range', async () => {
  let lookups = 0;
  const rating = await lookupCompanyRating('TKO Group Holdings', {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: SECRET },
    capturedHeadcount: { slug: 'tkogroup', employees: 12057, capturedAt: NOW.getTime() },
    fetch: async (url) => {
      lookups += 1;
      assert.doesNotMatch(String(url), /wikidata\.org/);
      return jsonResponse(200, {
        ratings: { overall: 3.7 },
        name: 'TKO',
        size: '1,001 to 5,000 Employees'
      });
    }
  });

  assert.equal(lookups, 1);
  assert.equal(rating.employees, 12057);
  assert.equal(rating.employeeLabel, '12,057');
  assert.equal(rating.employeeSource, 'linkedin');
  assert.equal(rating.estimated, false);
  assert.equal(rating.employeesLowerBound, undefined);
  assert.equal(rating.employeeDiscrepancy, undefined);
  assert.equal(rating.employeeRangeMin, undefined);
});

test('a wide Glassdoor bucket yields to a cached LinkedIn capture inside its range', async () => {
  const rating = await lookupCompanyRating('TKO Group Holdings', {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: SECRET },
    capturedHeadcount: { slug: 'tkogroup', employees: 2500, capturedAt: NOW.getTime() },
    fetch: async () => jsonResponse(200, {
      ratings: { overall: 3.7 },
      name: 'TKO',
      size: '1,001 to 5,000 Employees'
    })
  });

  assert.equal(rating.employees, 2500);
  assert.equal(rating.employeeLabel, '2,500');
  assert.equal(rating.employeeSource, 'linkedin');
  assert.equal(rating.estimated, false);
  assert.equal(rating.employeeDiscrepancy, undefined);
});

test('a wide Glassdoor bucket without a cached capture keeps the midpoint', async () => {
  const rating = await lookupCompanyRating('TKO Group Holdings', {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: SECRET },
    fetch: async (url) => {
      if (String(url).includes('wikidata.org')) {
        return jsonResponse(200, { search: [] });
      }

      return jsonResponse(200, {
        ratings: { overall: 3.7 },
        name: 'TKO',
        size: '1,001 to 5,000 Employees'
      });
    }
  });

  assert.equal(rating.employees, 3001);
  assert.equal(rating.employeeLabel, '3,001');
  assert.equal(rating.employeeSource, undefined);
  assert.equal(rating.employeeDiscrepancy, undefined);
});

test('an unbounded Glassdoor bucket yields to a cached LinkedIn capture below its floor', async () => {
  const rating = await lookupCompanyRating('TKO Group Holdings', {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: SECRET },
    capturedHeadcount: { slug: 'tkogroup', employees: 4000, capturedAt: NOW.getTime() },
    fetch: async () => jsonResponse(200, {
      ratings: { overall: 3.7 },
      name: 'TKO',
      size: '10,000+ Employees'
    })
  });

  assert.equal(rating.employees, 4000);
  assert.equal(rating.employeeLabel, '4,000');
  assert.equal(rating.employeeSource, 'linkedin');
  assert.equal(rating.estimated, false);
  assert.equal(rating.employeeDiscrepancy, undefined);
});

test('a captured headcount within range of a small Glassdoor figure is kept', async () => {
  let searches = 0;
  const rating = await lookupCompanyRating('Small Co', {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: SECRET },
    capturedHeadcount: { employees: 140, capturedAt: NOW.getTime() },
    askGroq: async () => {
      searches += 1;
      return 'Result 1 states 1,100 employees.';
    },
    fetch: async (url) => {
      if (String(url).includes('wikidata.org')) {
        searches += 1;
        return jsonResponse(200, { search: [] });
      }

      return jsonResponse(200, {
        ratings: { overall: 3.2 },
        size: '51 to 200 Employees',
        counts: { open_jobs: 2 }
      });
    }
  });

  assert.equal(searches, 0);
  assert.equal(rating.employees, 140);
  assert.equal(rating.employeeSource, 'linkedin');
});

test('a failed employee-count search leaves the rating without a made-up number', async () => {
  const rating = await lookupCompanyRating('Acme', employeeSearchDeps(async (url) => {
    if (String(url).includes('wikidata.org')) {
      return jsonResponse(200, { search: [] });
    }

    return jsonResponse(200, {
      ratings: { overall: 3.2 },
      counts: { open_jobs: 10 }
    });
  }, async () => {
    throw new Error('timeout');
  }));

  assert.equal(rating.employees, null);
  assert.equal(rating.employeeSource, undefined);
  assert.equal(rating.overall, 3.2);
});

test('a Glassdoor employer name must not add distinctive words to the company looked up', () => {
  assert.equal(glassdoorEntityMatches('TKO Group Holdings', 'TKo Hospitality'), false);
  assert.equal(glassdoorEntityMatches('TKO Group Holdings', 'TKO Farms'), false);
  assert.equal(glassdoorEntityMatches('TKO Group Holdings', 'TKO'), true);
  assert.equal(glassdoorEntityMatches('TKO Group Holdings', 'TKO Group Holdings, Inc.'), true);
  assert.equal(glassdoorEntityMatches('Capital One', 'Capital One'), true);
  assert.equal(glassdoorEntityMatches('University of Miami', 'University of Miami'), true);
  assert.equal(glassdoorEntityMatches('University of Miami Health System', 'University of Miami'), true);
  assert.equal(glassdoorEntityMatches('JPMorgan Chase', 'JP Morgan Chase'), true);
  assert.equal(glassdoorEntityMatches('Procter & Gamble', 'Procter and Gamble'), true);
  assert.equal(glassdoorEntityMatches('Acme', 'Acme Corporation'), true);
  assert.equal(glassdoorEntityMatches('Acme', 'Group Inc'), false);
  assert.equal(glassdoorEntityMatches('Acme', ''), true);
});

test('a rejected Glassdoor entity is remembered, so the next lookup does not ask RapidAPI again', async () => {
  let rapidCalls = 0;
  const deps = {
    now: NOW,
    cache: new MemoryCache(),
    env: { RAPIDAPI_KEY: SECRET },
    fetch: async (url) => {
      if (String(url).includes('wikidata.org')) {
        return jsonResponse(200, { search: [] });
      }

      rapidCalls += 1;
      return jsonResponse(200, {
        name: 'TKo Hospitality',
        ratings: { overall: 4.4 },
        size: '51 to 200 Employees',
        counts: { open_jobs: 0 }
      });
    }
  };

  const first = await lookupCompanyRating('TKO Group Holdings', deps);
  const callsAfterFirst = rapidCalls;
  const second = await lookupCompanyRating('TKO Group Holdings', deps);

  assert.equal(first.overall, null);
  assert.equal(first.openJobs ?? null, null);
  assert.equal(second.overall, null);
  assert.ok(callsAfterFirst >= 1);
  assert.equal(rapidCalls, callsAfterFirst);
});

test('a wrong-company payload cached before the entity check is not served', async () => {
  const cache = new MemoryCache();
  const deps = {
    now: NOW,
    cache,
    env: { RAPIDAPI_KEY: SECRET },
    fetch: async (url) => {
      if (String(url).includes('wikidata.org')) {
        return jsonResponse(200, { search: [] });
      }

      return jsonResponse(404, {});
    }
  };
  const { ratingCacheKey } = await import('../lib/server/company-rating.js');
  const { cacheSet } = await import('../lib/server/cache.js');
  await cacheSet(cache, ratingCacheKey('TKO Group Holdings'), {
    name: 'TKo Hospitality',
    ratings: { overall: 4.4 },
    size: '51 to 200 Employees',
    counts: { open_jobs: 0 }
  }, 60_000, NOW);

  const rating = await lookupCompanyRating('TKO Group Holdings', deps);

  assert.equal(rating.overall, null);
  assert.equal(rating.openJobs ?? null, null);
});
