import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCache } from '../lib/server/cache.js';
import { resolveCompanyIdentity } from '../lib/server/company-identity.js';

const NOW = new Date('2026-09-30T12:00:00Z');

function wikidataFetch(handler) {
  return async (url) => {
    const href = String(url);
    return {
      ok: true,
      async json() {
        return handler(href);
      }
    };
  };
}

test('LinkedIn TKO resolves to TKO Group Holdings from the description', async () => {
  const description = `${'TKO Group Holdings is hiring a coordinator for live events. '.repeat(8)}`;
  let groqCalls = 0;
  const deps = {
    now: NOW,
    cache: new MemoryCache(),
    fetch: wikidataFetch(() => ({ search: [] })),
    askGroq: async (prompt) => {
      groqCalls += 1;
      assert.match(prompt, /www\.linkedin\.com/);
      assert.match(prompt, /TKO Group Holdings/);
      assert.match(prompt, /respond exactly UNKNOWN/);
      return 'TKO Group Holdings';
    }
  };
  const signals = {
    rawName: 'TKO',
    description,
    hostname: 'www.linkedin.com',
    platform: 'LINKEDIN',
    slug: 'tko'
  };

  const company = await resolveCompanyIdentity(signals, deps);
  const again = await resolveCompanyIdentity(signals, deps);

  assert.equal(company, 'TKO Group Holdings');
  assert.equal(again, 'TKO Group Holdings');
  assert.equal(groqCalls, 1);
});

test('an UNKNOWN or failed Groq answer keeps the local company name', async () => {
  const signals = {
    rawName: 'TKO',
    description: `${'TKO Group Holdings is hiring a coordinator for live events. '.repeat(8)}`,
    hostname: 'www.linkedin.com',
    platform: 'LINKEDIN',
    slug: 'unknown-case'
  };
  const unknown = await resolveCompanyIdentity(signals, {
    now: NOW,
    cache: new MemoryCache(),
    fetch: wikidataFetch(() => ({ search: [] })),
    askGroq: async () => 'UNKNOWN'
  });
  const failed = await resolveCompanyIdentity({ ...signals, slug: 'failed-case' }, {
    now: NOW,
    cache: new MemoryCache(),
    fetch: wikidataFetch(() => ({ search: [] })),
    askGroq: async () => {
      throw new Error('timeout');
    }
  });

  assert.equal(unknown, 'TKO');
  assert.equal(failed, 'TKO');
});

test('a normal company name does not call Wikidata or Groq', async () => {
  const company = await resolveCompanyIdentity({
    rawName: 'Sony Interactive Entertainment',
    description: 'Build platform services.',
    hostname: 'www.linkedin.com',
    platform: 'LINKEDIN',
    slug: 'sony'
  }, {
    fetch: async () => {
      throw new Error('wikidata should not be called');
    },
    askGroq: async () => {
      throw new Error('groq should not be called');
    }
  });

  assert.equal(company, 'Sony Interactive Entertainment');
});

test('an empty Workday slug uses the hostname fragment instead of skipping Wikidata', async () => {
  const logs = [];
  const original = console.info;
  console.info = (...args) => {
    logs.push(args.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
  };
  const searches = [];

  try {
    const company = await resolveCompanyIdentity({
      rawName: 'UMCareer Staff',
      description: 'The University of Miami Health System ("UHealth") provides patient care across Miami-Dade.',
      hostname: 'umiami.wd1.myworkdayjobs.com',
      platform: 'LINKEDIN',
      slug: ''
    }, {
      now: NOW,
      cache: new MemoryCache(),
      askGroq: async () => {
        throw new Error('Groq should not run after Wikidata corroborates');
      },
      fetch: async (url) => {
        const href = String(url);
        const params = new URL(href).searchParams;
        const search = params.get('search');
        const ids = params.get('ids');

        if (search) {
          searches.push(search);
        }

        if (search === 'University of Miami Health System') {
          return { ok: true, json: async () => ({ search: [{ id: 'Q30281730', label: 'University of Miami Health System' }] }) };
        }

        if (search === 'University of Miami') {
          return { ok: true, json: async () => ({ search: [{ id: 'Q738258', label: 'University of Miami' }] }) };
        }

        if (ids === 'Q30281730') {
          return {
            ok: true,
            json: async () => ({
              entities: {
                Q30281730: {
                  labels: { en: { value: 'University of Miami Health System' } },
                  aliases: { en: [] }
                }
              }
            })
          };
        }

        if (ids === 'Q738258') {
          return {
            ok: true,
            json: async () => ({
              entities: {
                Q738258: {
                  labels: { en: { value: 'University of Miami' } },
                  aliases: { en: [{ value: 'U Miami (FL)' }] }
                }
              }
            })
          };
        }

        return { ok: true, json: async () => ({ search: [] }) };
      }
    });

    assert.equal(company, 'University of Miami');
    assert.equal(logs.some((line) => line.includes('[GHD] identity wikidata skipped')), false);
    assert.deepEqual(searches, ['University of Miami Health System', 'University of Miami']);
  } finally {
    console.info = original;
  }
});

test('a health-system phrase falls through to the university alias U Miami (FL)', async () => {
  const calls = [];
  const company = await resolveCompanyIdentity({
    rawName: 'UMCareer Staff',
    description: 'The University of Miami Health System ("UHealth") provides patient care across Miami-Dade.',
    hostname: 'umiami.wd1.myworkdayjobs.com',
    platform: 'WORKDAY'
  }, {
    now: NOW,
    cache: new MemoryCache(),
    askGroq: async () => {
      throw new Error('Groq should not run after Wikidata corroborates');
    },
    fetch: async (url, options) => {
      const href = String(url);
      calls.push({
        href,
        userAgent: options?.headers?.['User-Agent'] || ''
      });
      const params = new URL(href).searchParams;
      const search = params.get('search');
      const ids = params.get('ids');

      if (search === 'University of Miami Health System') {
        return { ok: true, json: async () => ({ search: [{ id: 'Q30281730', label: 'University of Miami Health System' }] }) };
      }

      if (search === 'University of Miami') {
        return { ok: true, json: async () => ({ search: [{ id: 'Q738258', label: 'University of Miami' }] }) };
      }

      if (ids === 'Q30281730') {
        return {
          ok: true,
          json: async () => ({
            entities: {
              Q30281730: {
                labels: { en: { value: 'University of Miami Health System' } },
                aliases: { en: [] }
              }
            }
          })
        };
      }

      if (ids === 'Q738258') {
        return {
          ok: true,
          json: async () => ({
            entities: {
              Q738258: {
                labels: { en: { value: 'University of Miami' } },
                aliases: {
                  en: [
                    { value: 'UM' },
                    { value: 'U of M' },
                    { value: 'The U' },
                    { value: 'U Miami (FL)' }
                  ]
                }
              }
            }
          })
        };
      }

      throw new Error(`unexpected Wikidata request ${href}`);
    }
  });

  assert.equal(company, 'University of Miami');
  assert.deepEqual(
    calls.map((call) => new URL(call.href).searchParams.get('search')).filter(Boolean),
    ['University of Miami Health System', 'University of Miami']
  );
  assert.equal(calls.every((call) => call.userAgent.startsWith('GhostJobDetector/')), true);
});

function argonnePosting(includeLaboratory) {
  const opening = 'We are seeking an operational expert to drive the implementation of artificial intelligence (AI) capabilities within Argonne’s Physical Sciences and Engineering Operations division. ';
  const middle = 'The team supports model deployment, monitoring, and incident response for research computing platforms. '.repeat(12);
  const partners = 'Research is supported by the Department of Energy and operated with the University of Chicago Medical Center.';
  const closing = includeLaboratory
    ? `Argonne National Laboratory is committed to a safe and welcoming workplace. ${partners}`
    : partners;
  return `${opening}${middle}${closing}`;
}

test('a bare company name resolves from a laboratory phrase past the first 800 characters', async () => {
  const description = argonnePosting(true);
  const searches = [];
  let groqCalls = 0;
  const company = await resolveCompanyIdentity({
    rawName: 'Argonne',
    description,
    organization: 'UChicago Argonne, LLC',
    hostname: 'argonne.wd1.myworkdayjobs.com',
    platform: 'WORKDAY'
  }, {
    now: NOW,
    cache: new MemoryCache(),
    askGroq: async () => {
      groqCalls += 1;
      return 'University of Chicago';
    },
    fetch: async (url) => {
      const params = new URL(String(url)).searchParams;
      const search = params.get('search');
      const ids = params.get('ids');

      if (search) {
        searches.push(search);
      }

      if (search === 'Argonne National Laboratory') {
        return {
          ok: true,
          async json() {
            return { search: [{ id: 'Q6446', label: 'Argonne National Laboratory' }] };
          }
        };
      }

      if (ids === 'Q6446') {
        return {
          ok: true,
          async json() {
            return {
              entities: {
                Q6446: {
                  labels: { en: { value: 'Argonne National Laboratory' } },
                  aliases: { en: [{ value: 'Argonne' }] }
                }
              }
            };
          }
        };
      }

      return { ok: true, async json() { return { search: [] }; } };
    }
  });

  assert.equal(description.replace(/\s+/g, ' ').trim().slice(0, 800).includes('Argonne National Laboratory'), false);
  assert.equal(company, 'Argonne National Laboratory');
  assert.equal(company === 'University of Chicago' || company === 'Department of Energy', false);
  assert.deepEqual(searches, ['Argonne National Laboratory']);
  assert.equal(groqCalls, 0);
});

test('Department of Energy and University of Chicago do not replace a bare name', async () => {
  const searches = [];
  let groqCalls = 0;
  const company = await resolveCompanyIdentity({
    rawName: 'Argonne',
    description: argonnePosting(false),
    organization: 'UChicago Argonne, LLC',
    hostname: 'argonne.wd1.myworkdayjobs.com',
    platform: 'WORKDAY'
  }, {
    now: NOW,
    cache: new MemoryCache(),
    askGroq: async () => {
      groqCalls += 1;
      return 'Department of Energy';
    },
    fetch: async (url) => {
      const params = new URL(String(url)).searchParams;
      const search = params.get('search');
      const ids = params.get('ids');

      if (search) {
        searches.push(search);
      }

      if (search === 'UChicago Argonne, LLC') {
        return {
          ok: true,
          async json() {
            return { search: [{ id: 'Q131252', label: 'University of Chicago' }] };
          }
        };
      }

      if (ids === 'Q131252') {
        return {
          ok: true,
          async json() {
            return {
              entities: {
                Q131252: {
                  labels: { en: { value: 'University of Chicago' } },
                  aliases: { en: [] }
                }
              }
            };
          }
        };
      }

      return { ok: true, async json() { return { search: [] }; } };
    }
  });

  assert.equal(company, 'Argonne');
  assert.equal(company === 'University of Chicago' || company === 'Department of Energy', false);
  assert.equal(searches.includes('University of Chicago'), false);
  assert.equal(searches.includes('Department of Energy'), false);
  assert.deepEqual(searches, ['UChicago Argonne, LLC']);
  assert.equal(groqCalls, 0);
});
