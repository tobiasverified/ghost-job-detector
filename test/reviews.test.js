import assert from 'node:assert/strict';
import test from 'node:test';
import { findCompanyReviews, parseReviewSnippet, pickReview, platformFromUrl, scoreRating } from '../lib/server/reviews.js';
import { parseDuckDuckGoHtml } from '../lib/server/search.js';

const GLASSDOOR_HTML = `
<div class="result__body">
  <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.glassdoor.com%2FReviews%2FAcme-Reviews-E123.htm&amp;rut=abc">Acme Reviews | Glassdoor</a>
  <a class="result__snippet" href="https://example.com">Rating 3.2 out of 5 stars, based on 1,240 reviews of Acme.</a>
</div>
<div class="result__body">
  <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.indeed.com%2Fcmp%2FAcme">Acme Careers</a>
  <a class="result__snippet" href="https://example.com">Rated 4.4 out of 5 from 300 reviews.</a>
</div>`;

test('DuckDuckGo HTML keeps Glassdoor ratings and unwraps redirect links', () => {
  const results = parseDuckDuckGoHtml(GLASSDOOR_HTML);
  const review = pickReview(results);

  assert.equal(results.length, 2);
  assert.equal(review.platform, 'Glassdoor');
  assert.equal(review.rating, 3.2);
  assert.equal(review.reviewCount, 1240);
  assert.equal(review.score, 10);
  assert.equal(review.url, 'https://www.glassdoor.com/Reviews/Acme-Reviews-E123.htm');
});

test('Axon ratings ignore a different company that shares the name', () => {
  const review = pickReview([
    {
      title: 'AXON-ACTIVE Reviews',
      snippet: 'Rating 3.4 out of 5 stars, based on 20 reviews of AXON-ACTIVE.',
      url: 'https://www.glassdoor.com/Reviews/AXON-ACTIVE-Reviews-E1063309.htm'
    },
    {
      title: 'Axon Reviews',
      snippet: 'Axon has an employee rating of 3.6 out of 5 stars, based on 778 company reviews on Glassdoor.',
      url: 'https://www.glassdoor.com/Reviews/Axon-Reviews-E1597674.htm'
    }
  ], 'Axon');

  assert.equal(review.rating, 3.6);
  assert.equal(review.reviewCount, 778);
  assert.equal(review.score, 4);
  assert.match(review.url, /Axon-Reviews-E1597674/);
});

test('Pearson reviews ignore the candy company', () => {
  const review = pickReview([
    {
      title: 'Pearson\'s Candy Company Reviews',
      snippet: 'Pearson\'s Candy Company has an employee rating of 3.1 out of 5 stars, based on 40 reviews.',
      url: 'https://www.glassdoor.com/Reviews/Pearsons-Candy-Company-Reviews-E1.htm'
    },
    {
      title: 'Pearson Reviews',
      snippet: 'Pearson has an employee rating of 3.7 out of 5 stars, based on 2,400 company reviews on Glassdoor.',
      url: 'https://www.glassdoor.com/Reviews/Pearson-Reviews-E5500.htm'
    }
  ], 'Pearson');

  assert.equal(review.rating, 3.7);
  assert.match(review.url, /Pearson-Reviews-E5500/);
});

test('AMLI Residential reviews require the full company name', () => {
  const review = pickReview([
    {
      title: 'AMLI Program Reviews',
      snippet: 'AMLI has an employee rating of 2.2 out of 5 stars, based on 15 reviews.',
      url: 'https://www.glassdoor.com/Reviews/AMLI-Program-Reviews-E9.htm'
    },
    {
      title: 'AMLI Residential Reviews',
      snippet: 'AMLI Residential has an employee rating of 3.9 out of 5 stars, based on 295 company reviews on Glassdoor.',
      url: 'https://www.glassdoor.com/Reviews/AMLI-Residential-Reviews-E2514.htm'
    }
  ], 'AMLI Residential');

  assert.equal(review.rating, 3.9);
  assert.equal(review.reviewCount, 295);
  assert.match(review.url, /AMLI-Residential-Reviews-E2514/);
});

test('AMLI Residential matches a Glassdoor page that only names AMLI', async () => {
  const queries = [];
  const review = await findCompanyReviews('AMLI Residential', {
    webSearch: async (query, options = {}) => {
      queries.push({ query, includeDomains: options.includeDomains });

      if (query !== '"AMLI Residential" reviews' || options.includeDomains?.[0] !== 'glassdoor.com') {
        return [];
      }

      return [
        {
          title: 'AMLI Reviews',
          snippet: 'AMLI has an employee rating of 3.9 out of 5 stars, based on 295 company reviews.',
          url: 'https://www.glassdoor.com/Reviews/AMLI-Reviews-E2514.htm'
        }
      ];
    }
  });

  assert.deepEqual(queries, [
    { query: '"AMLI Residential" reviews', includeDomains: ['glassdoor.com'] },
    { query: '"AMLI Residential" reviews', includeDomains: ['indeed.com'] }
  ]);
  assert.equal(review.rating, 3.9);
  assert.equal(review.reviewCount, 295);
  assert.equal(review.platform, 'Glassdoor');
  assert.equal(review.unavailable, false);
  assert.match(review.url, /AMLI-Reviews-E2514/);
});

test('a missed full-name review search retries the shorter alias', async () => {
  const queries = [];
  const review = await findCompanyReviews('AMLI Residential', {
    webSearch: async (query, options = {}) => {
      queries.push({ query, includeDomains: options.includeDomains });

      if (query !== '"amli" reviews' || options.includeDomains?.[0] !== 'glassdoor.com') {
        return [];
      }

      return [
        {
          title: 'AMLI Reviews',
          snippet: 'AMLI has an employee rating of 3.9 out of 5 stars, based on 295 company reviews.',
          url: 'https://www.glassdoor.com/Reviews/AMLI-Reviews-E2514.htm'
        }
      ];
    }
  });

  assert.deepEqual(queries, [
    { query: '"AMLI Residential" reviews', includeDomains: ['glassdoor.com'] },
    { query: '"AMLI Residential" reviews', includeDomains: ['indeed.com'] },
    { query: '"amli" reviews', includeDomains: ['glassdoor.com'] },
    { query: '"amli" reviews', includeDomains: ['indeed.com'] }
  ]);
  assert.equal(review.rating, 3.9);
  assert.equal(review.platform, 'Glassdoor');
});

test('review parsing rejects ratings outside 1 to 5', () => {
  assert.equal(parseReviewSnippet({
    title: 'Acme',
    snippet: 'Rated 8.2 out of 5 by fans'
  }), null);
});

test('the rating with more reviews is kept when Glassdoor and Indeed both match', async () => {
  const queries = [];
  const review = await findCompanyReviews('Acme', {
    webSearch: async (query, options = {}) => {
      queries.push({ query, includeDomains: options.includeDomains });

      return [
        {
          title: 'Acme Reviews',
          snippet: '3.0 out of 5 from 220 reviews',
          url: 'https://www.indeed.com/cmp/Acme/reviews'
        },
        {
          title: 'Acme Reviews',
          snippet: '4.2 out of 5 from 100 reviews',
          url: 'https://www.glassdoor.com/Reviews/Acme-Reviews-E1.htm'
        }
      ];
    }
  });

  assert.deepEqual(queries, [
    { query: '"Acme" reviews', includeDomains: ['glassdoor.com'] },
    { query: '"Acme" reviews', includeDomains: ['indeed.com'] }
  ]);
  assert.equal(review.platform, 'Indeed');
  assert.equal(review.rating, 3);
  assert.equal(review.reviewCount, 220);
  assert.equal(review.score, 15);
});

test('a search outage reports reviews as unavailable', async () => {
  const review = await findCompanyReviews('Acme', {
    webSearch: async () => {
      throw new Error('blocked');
    }
  });

  assert.equal(review.rating, null);
  assert.equal(review.score, 0);
  assert.equal(review.unavailable, false);
  assert.equal(review.detail, 'No public reviews found');
});

test('review snippets accept common rating formats', () => {
  assert.equal(parseReviewSnippet({
    title: 'Acme',
    snippet: 'Rated 3.8 out of 5 by employees'
  }).rating, 3.8);
  assert.equal(parseReviewSnippet({
    title: 'The Local',
    snippet: 'rated 4.1 of 5 on Tripadvisor'
  }).rating, 4.1);
  assert.equal(parseReviewSnippet({
    title: 'Starbucks Reviews',
    snippet: 'Rated 2.6/5'
  }).rating, 2.6);
  assert.equal(parseReviewSnippet({
    title: 'Joe\'s Pizza',
    snippet: 'Joe\'s Pizza has an average rating of 4.1 from 8835 reviews.'
  }).rating, 4.1);
  assert.equal(parseReviewSnippet({
    title: 'Diner',
    snippet: 'Customers left ★☆☆☆☆'
  }).rating, 1);
  assert.equal(parseReviewSnippet({
    title: 'Acme',
    snippet: 'Out of 647 Acme employee reviews, 85% were positive.'
  }), null);
});

test('a Trustpilot URL is rejected as a review source', () => {
  assert.equal(platformFromUrl('https://www.trustpilot.com/review/harrisonclarke.com'), null);
  assert.equal(pickReview([
    {
      title: 'Harrison Clarke Reviews',
      snippet: 'Rated 5 out of 5 stars, based on 80 reviews.',
      url: 'https://www.trustpilot.com/review/harrisonclarke.com'
    }
  ], 'Harrison Clarke'), null);
});

test('the Harrison Clarke Glassdoor snippet parses to 4.5 and 43 reviews', () => {
  const parsed = parseReviewSnippet({
    title: 'Harrison Clarke International Reviews',
    snippet: 'Harrison Clarke International has an employee rating of 4.5 out of 5 stars, based on 43 company reviews.'
  });

  assert.equal(parsed.rating, 4.5);
  assert.equal(parsed.reviewCount, 43);
});

test('a 1 out of 5 rating with 1 review adds no points', () => {
  const review = pickReview([
    {
      title: 'Acme Reviews',
      snippet: 'Acme has an employee rating of 1 out of 5 stars, based on 1 company review.',
      url: 'https://www.glassdoor.com/Reviews/Acme-Reviews-E1.htm'
    }
  ], 'Acme');

  assert.equal(review.rating, 1);
  assert.equal(review.reviewCount, 1);
  assert.equal(review.score, 0);
  assert.equal(scoreRating(1, 1), 0);
  assert.equal(scoreRating(1, 5), 15);
});

test('an Indeed page for a different employer is not this company', () => {
  const review = pickReview([
    {
      title: 'University of Chicago Reviews',
      snippet: 'Rated 4.0 out of 5 stars by Argonne, based on 4168 reviews.',
      url: 'https://www.indeed.com/cmp/University-of-Chicago/reviews'
    },
    {
      title: 'Argonne National Laboratory Reviews',
      snippet: 'Argonne National Laboratory has an employee rating of 4.1 out of 5 stars, based on 80 reviews.',
      url: 'https://www.indeed.com/cmp/Argonne-National-Laboratory/reviews'
    },
    {
      title: 'Argonne Reviews',
      snippet: 'Argonne has an employee rating of 3.9 out of 5 stars, based on 12 reviews.',
      url: 'https://www.indeed.com/cmp/Argonne/reviews'
    }
  ], 'Argonne');

  assert.equal(review.platform, 'Indeed');
  assert.equal(review.rating, 3.9);
  assert.equal(review.reviewCount, 12);
  assert.equal(review.url, 'https://www.indeed.com/cmp/Argonne/reviews');
});

test('a review fallback searches Glassdoor before Indeed and skips Trustpilot', async () => {
  const calls = [];
  const review = await findCompanyReviews('Harrison Clarke', {
    webSearch: async (query, options = {}) => {
      calls.push({ query, includeDomains: options.includeDomains });

      if (options.includeDomains?.[0] === 'glassdoor.com') {
        return [
          {
            title: 'Harrison Clarke Reviews',
            snippet: 'Rated 5 out of 5 stars, based on 80 reviews.',
            url: 'https://www.trustpilot.com/review/harrisonclarke.com'
          },
          {
            title: 'Harrison Clarke International Reviews',
            snippet: 'Harrison Clarke International has an employee rating of 4.5 out of 5 stars, based on 43 company reviews.',
            url: 'https://www.glassdoor.com/Reviews/Harrison-Clarke-International-Reviews-E1905496.htm'
          }
        ];
      }

      return [
        {
          title: 'Harrison Clarke Reviews',
          snippet: 'Rated 3.2 out of 5 stars, based on 40 reviews.',
          url: 'https://www.indeed.com/cmp/Harrison-Clarke/reviews'
        }
      ];
    }
  });

  assert.deepEqual(calls, [
    { query: '"Harrison Clarke" reviews', includeDomains: ['glassdoor.com'] },
    { query: '"Harrison Clarke" reviews', includeDomains: ['indeed.com'] }
  ]);
  assert.equal(review.platform, 'Glassdoor');
  assert.equal(review.rating, 4.5);
  assert.equal(review.reviewCount, 43);
  assert.equal(review.score, 0);
});

test('the Argonne Glassdoor snippet is chosen over a 2-review Indeed rating', async () => {
  const snippet = '4.3 out of 5 stars, based on over 683 reviews';
  const parsed = parseReviewSnippet({
    title: 'Argonne National Laboratory Reviews',
    snippet
  });
  const calls = [];
  const review = await findCompanyReviews('Argonne National Laboratory', {
    webSearch: async (query, options = {}) => {
      calls.push({ query, includeDomains: options.includeDomains });

      if (options.includeDomains?.[0] === 'glassdoor.com') {
        return [{
          title: 'Argonne National Laboratory Reviews',
          snippet,
          url: 'https://www.glassdoor.com/Reviews/Argonne-National-Laboratory-Reviews-E35240.htm'
        }];
      }

      return [{
        title: 'Argonne National Laboratory Reviews',
        snippet: 'Rated 4 out of 5 stars, based on 2 reviews.',
        url: 'https://www.indeed.com/cmp/Argonne-National-Laboratory/locations/IL/Chicago'
      }];
    }
  });

  assert.equal(parsed.rating, 4.3);
  assert.equal(parsed.reviewCount, 683);
  assert.equal(review.platform, 'Glassdoor');
  assert.equal(review.rating, 4.3);
  assert.equal(review.reviewCount, 683);
  assert.equal(review.url.includes('E35240'), true);
  assert.equal(review.url.includes('/Jobs/'), false);
  assert.equal(calls[0].query, '"Argonne National Laboratory" reviews');
  assert.deepEqual(calls.map((call) => call.includeDomains[0]), ['glassdoor.com', 'indeed.com']);
});

test('the Argonne company reviews page beats a jobs snippet with more reviews', () => {
  const review = pickReview([
    {
      title: 'Argonne National Laboratory Reviews (683)',
      snippet: '4.3 out of 5 stars, based on 683 reviews',
      url: 'https://www.glassdoor.com/Reviews/Argonne-National-Laboratory-Reviews-E35240.htm'
    },
    {
      title: 'Argonne National Laboratory Software Engineer jobs',
      snippet: '3.9 out of 5 stars, based on 980 reviews',
      url: 'https://www.glassdoor.com/Jobs/Argonne-National-Laboratory-Software-Engineer-Jobs-EI_IE35240.0,27_KO28,45.htm'
    },
    {
      title: 'UChicago Argonne Reviews',
      snippet: '3.9 out of 5 stars, based on 980 reviews',
      url: 'https://www.glassdoor.com/Reviews/UChicago-Argonne-Reviews-E999.htm'
    }
  ], 'Argonne National Laboratory');

  assert.equal(review.rating, 4.3);
  assert.equal(review.reviewCount, 683);
  assert.equal(review.url, 'https://www.glassdoor.com/Reviews/Argonne-National-Laboratory-Reviews-E35240.htm');
});

test('a company reviews page beats a jobs snippet from the other search', async () => {
  const review = await findCompanyReviews('Argonne National Laboratory', {
    webSearch: async (query, options = {}) => {
      if (options.includeDomains?.[0] === 'glassdoor.com') {
        return [{
          title: 'Argonne National Laboratory jobs',
          snippet: '3.9 out of 5 stars, based on 980 reviews',
          url: 'https://www.glassdoor.com/Jobs/Argonne-National-Laboratory-Jobs-E35240.htm'
        }];
      }

      return [{
        title: 'Argonne National Laboratory Reviews',
        snippet: '4.3 out of 5 stars, based on 683 reviews',
        url: 'https://www.indeed.com/cmp/Argonne-National-Laboratory/reviews'
      }];
    }
  });

  assert.equal(review.rating, 4.3);
  assert.equal(review.reviewCount, 683);
  assert.equal(review.url, 'https://www.indeed.com/cmp/Argonne-National-Laboratory/reviews');
});
