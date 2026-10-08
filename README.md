# Ghost Job Detector

Chrome extension that flags possible ghost job postings on LinkedIn and Workday. Layoff and review lookups run on a small Vercel backend so API keys stay off the extension.

The score is a heuristic. It is not proof that a listing is fake.

## What the score uses

| Signal | Points | Source |
| --- | --- | --- |
| Vague description | 0-30 | On the server, from the posting text |
| Layoff coverage in the past year | 15-25 | NewsData.io, then DuckDuckGo if NewsData errors or has no matching article |
| Low public rating | 0-15 | Glassdoor snippet, then Indeed or SimplyHired |
| Many open jobs vs employees | 0-15 | Counted in the page when both numbers are visible |
| Reposts of the same role | 0 or 15 | Another LinkedIn posting of the same title, company, and city adds 15 |

0-34 is Not detected, 35-49 is Possible, and 50 or higher is Likely.

Subsidiary names are searched as well as the full company name. A Hyundai Supernal posting is also checked as Supernal, so a Hyundai Motor layoff article is not treated as a Supernal layoff.

NewsData's latest endpoint only covers recent articles. Older layoff reports come from the DuckDuckGo fallback. Ratings are parsed from public search snippets and can be missing or stale.

Job analyses are cached for 7 days. Company reviews are cached for 30 days. Each IP is limited to 50 requests per hour across both endpoints.

## Extension

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Choose "Load unpacked" and select this folder.
4. Open a LinkedIn job, a LinkedIn search result, or a `*.myworkdayjobs.com` posting.
5. Open the extension popup.

Search pages show a ghost badge on each job card, including cards that load as you scroll. Select a result before opening the popup. The badge saves that card; the popup prefers the detail pane when LinkedIn has loaded it.

"View Evidence" explains the score for the current posting. "How This Works" explains the signals and stores the backend URL. The repost button opens a duplicate listing when one was found. The review button opens the rating page, or DuckDuckGo when the backend has no page.

The extension sends title, company, description, URL, and platform. It does not contain the NewsData or Supabase keys.

## Backend setup

Create a [NewsData.io](https://newsdata.io/) key and a [Supabase](https://supabase.com/) project. In the Supabase SQL editor, run [`supabase/schema.sql`](supabase/schema.sql). Row level security is enabled and no anon policies are added, so only the service role key can read the cache.

From this folder:

```bash
npm install -g vercel
vercel
vercel env add NEWSDATA_API_KEY
vercel env add SUPABASE_URL
vercel env add SUPABASE_SERVICE_ROLE_KEY
vercel env add RATE_LIMIT_PER_HOUR
vercel env add RAPIDAPI_KEY
vercel --prod
```

Use the Supabase project URL (`https://YOUR_PROJECT.supabase.co`) and the service role key. Set `RATE_LIMIT_PER_HOUR` to `50`. Copy the same names into `.env` if you use `vercel dev`. See [`.env.example`](.env.example).

The extension calls `https://ghost-job-detector-nine.vercel.app` unless a different backend URL is saved under "How This Works". The manifest allows `https://*.vercel.app` and localhost for `vercel dev`.

### Endpoints

`POST /api/analyze-job`

```json
{ "title": "AI Engineer", "company": "Hyundai Supernal", "description": "...", "url": "https://...", "platform": "LINKEDIN" }
```

Returns `ghostScore` and `factors` for `reposts`, `layoffs`, `reviews`, `vagueness`, and `hiringRatio`. Layoffs can add 25, vagueness 30, hiring ratio 25, and reposts 15. A found rating can add up to 15 more, and the displayed score still caps at 100. Missing reviews add 0 and show "No public reviews found". Reposts add 20 when a public Greenhouse or Lever posting for the same title, company, and location was created more than 7 days ago. Otherwise two or more LinkedIn search matches add 15. No match, or a search that does not return, adds 0.

Employee counts are tried in order: Crunchbase, the company website, a search snippet, then Apollo. Each attempt is capped at 30 seconds, and the whole chain stops after about 8 seconds so enrichment can finish in under 10 seconds. A 402, 403, or 429 from Crunchbase or Apollo is treated as quota exhaustion and the next source is used. Results cache for 24 hours. The popup labels the source, for example `~1,001-5,000 employees (estimated, Crunchbase)`.

### Quotas

| Source | Planned free-tier budget | Where the key lives |
| --- | --- | --- |
| Crunchbase | 10,000 organization lookups per month on the free key. Crunchbase can enforce a lower limit on a basic key; a 429 response falls through. | `CRUNCHBASE_API_KEY` in Vercel only |
| Apollo | About 50 organization enrichments per month. Used only after Crunchbase, the company site, and search snippets miss. | `APOLLO_API_KEY` in Vercel only |
| Company website and search snippets | No key. Public pages only. | None |
| NewsData layoffs | Existing `NEWSDATA_API_KEY` quota | Vercel only |
| Glassdoor ratings | 1,000 RapidAPI calls per month on the free plan, also capped at 1,000 per hour. Cached for 24 hours per company. | `RAPIDAPI_KEY` in Vercel only |

The extension never receives these keys. Requests stay limited to 50 per IP per hour.

`POST /api/company-reviews`

```json
{ "company": "Hyundai Supernal" }
```

Accepts DuckDuckGo HTML in `clientHtml` from one `"company name" reviews` search. Returns a parsed rating from any public snippet, or `{ "rating": null, "score": 0, "detail": "No public reviews found" }` when none is present. The extension caches that search for 24 hours.

`GET /api/company-rating?company=Google`

Calls the Glassdoor ratings API on RapidAPI and returns `{ "overall": 3.85, "source": "glassdoor", "cached": false }`. `company` may be a name, a Glassdoor employer id, or a company page URL. A cache hit within 24 hours returns the same object with `"cached": true`. A failed, blocked, or rate-limited upstream call returns `{ "overall": null, "error": "unavailable" }` and is not cached. The RapidAPI key stays in `RAPIDAPI_KEY` on Vercel.

All three endpoints require header `X-GHD-Client: ghost-job-detector`. That header is not a secret. It stops ordinary web pages from spending the NewsData and RapidAPI quotas. Requests are also limited to 50 per IP per hour.

## Self-hosting

Create a Supabase project. In the SQL editor, run [`supabase/schema.sql`](supabase/schema.sql), then each dated file in this order:

1. [`supabase/2026-10-05-rate-limit-rpc.sql`](supabase/2026-10-05-rate-limit-rpc.sql)
2. [`supabase/2026-10-06-request-log.sql`](supabase/2026-10-06-request-log.sql)
3. [`supabase/2026-10-07-part-b.sql`](supabase/2026-10-07-part-b.sql)
4. [`supabase/2026-10-09-invite-keys.sql`](supabase/2026-10-09-invite-keys.sql)

Those files enable row level security and add no anon policies. Table and function access is granted to `service_role` only. Use that key as `SUPABASE_SERVICE_ROLE_KEY`.

Set the Vercel environment variables listed in [`.env.example`](.env.example). `vercel.json` calls `GET /api/cleanup` every day at 08:00 UTC. Set `CRON_SECRET` and send it as `Authorization: Bearer CRON_SECRET`; the route returns 401 until that secret is set.

`REQUIRE_INVITE_KEY` is off unless it is the string `true`, so a self-hosted server accepts checks without an invite key. To issue one, set `INVITE_KEY_SECRET` and run:

```bash
node scripts/create-invite-key.mjs --label "a desk" --limit 40
```

The script prints the key once and does not save it.

To point the extension at your server, open the popup, turn on Developer mode, enter the server URL, choose Save, and approve the browser permission prompt.

## Privacy

What the extension and the hosted backend keep is in [PRIVACY.md](PRIVACY.md). The same page is served at `/privacy.html`.

## Known limits

After an update, LinkedIn tabs that are already open are re-injected automatically. Chrome may still need the extension re-enabled before that runs.

## Tests

```bash
npm test
```

The tests cover Hyundai Supernal, Meta, and Amazon layoff matching, a company with no layoff coverage, review parsing, cache and rate-limit behavior, and a scan that the extension files do not embed API keys. They do not call NewsData or DuckDuckGo.

## Not in this version

- `/api/company-stats` for LinkedIn employee count vs open roles
- Indeed, Greenhouse, Lever, and Ashby page extraction

Those are the next places to extend support. LinkedIn and Workday are the pages the extension reads today.
