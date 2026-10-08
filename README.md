# Ghost Job Detector

A Chromium extension that scores a LinkedIn or Workday posting for signs it may be a ghost job.

Unofficial: not affiliated with LinkedIn, Workday, Glassdoor or any data provider. The score is a heuristic, not proof a posting is fake.

## Demo

<https://github.com/user-attachments/assets/2f2cb137-c32e-4bf2-a578-8403e620d8ae>

A short 21-second clip of an extension check.

## What a check shows

The card stays on the posting. Scoring runs only after you press **Run full check**. On some pages, before that click, the extension may send a company name and a description excerpt so the backend can resolve the employer. That step is described in [PRIVACY.md](PRIVACY.md).

The score adds four rows, then stops at 100. `lib/server/score.js` labels the total:

| Total | Label |
| --- | --- |
| 0–34 | Ghost Job: Not detected |
| 35–49 | Ghost Job: Possible |
| 50–100 | Ghost Job: Likely |

When the check has none of a rating with at least 5 reviews, a company size, a confirmed repost, or an accepted layoff, the card says **Not enough data to score** and does not show a number.

| Row | What it is | Points added |
| --- | --- | --- |
| Description Clarity | How specific the posting text is. A description under 50 characters scores 30. Longer text is scored for length, missing pay, question marks, buzzwords, and missing specifics, then capped. | 0–30 |
| Recent Layoffs | A layoff report for this employer from layoffs.fyi, NewsData, or DuckDuckGo, dated within the past year. Within 180 days scores 25. Older than that, and still inside the year, scores 15. | 0, 15, or 25 |
| Company Reviews | A public employer rating. 3.0 or lower scores 15, above 3 through 3.5 scores 10, above 3.5 through 3.8 scores 4, and above 3.8 scores 0. Fewer than 5 reviews scores 0. | 0, 4, 10, or 15 |
| Company size | The size shown for the employer. A hiring ratio from 0 to 25 is calculated for that line and is not added to the total. | none |
| Reposts | Another public posting of the role. An identical title scores 40, any other kept match scores 15, and a public Greenhouse, Lever, or Ashby posting older than 7 days scores 25. The row is capped at 40. | 0–40 |

## Supported sites

The extension reads LinkedIn job pages and Workday (`*.myworkdayjobs.com`) today.

Planned: Indeed, Greenhouse, Ashby, ZipRecruiter and others.

## Getting access

The hosted backend is invite-only.

Request an invite: <https://app.formbricks.com/s/cmuz9dtugyt7y01sqr00drtw6>

The form asks for a name, email, and optional GitHub username. You receive a key by email. Open the extension popup, open Advanced, paste the key, and click **Save key**. The key stays on your computer and is sent only to the backend.

## Install

This extension is not on the Chrome Web Store. Chromium browsers can load it unpacked. It has been tested on Brave.

1. Download the ZIP from GitHub, or clone this repository, and unzip it if needed.
2. Open `chrome://extensions`.
3. Turn on Developer mode.
4. Choose Load unpacked and select this folder.

## Self-hosting

Create a Supabase project. In the SQL editor, run [`supabase/schema.sql`](supabase/schema.sql), then each dated file in this order:

1. [`supabase/2026-10-05-rate-limit-rpc.sql`](supabase/2026-10-05-rate-limit-rpc.sql)
2. [`supabase/2026-10-06-request-log.sql`](supabase/2026-10-06-request-log.sql)
3. [`supabase/2026-10-07-part-b.sql`](supabase/2026-10-07-part-b.sql)
4. [`supabase/2026-10-09-invite-keys.sql`](supabase/2026-10-09-invite-keys.sql)

Those files enable row level security and add no anon policies. Table and function access is granted to `service_role` only. Use that key as `SUPABASE_SERVICE_ROLE_KEY`.

Set the server environment variables listed in [`.env.example`](.env.example). API keys stay there. The extension does not contain them. Each request must send the header `X-GHD-Client: ghost-job-detector`.

The default limit is 300 requests per IP per hour. Set `RATE_LIMIT_PER_HOUR` to a positive number to override it. An empty value keeps 300.

`vercel.json` calls `GET /api/cleanup` every day at 08:00 UTC. Set `CRON_SECRET` and send it as `Authorization: Bearer CRON_SECRET`. The route returns 401 until that secret is set.

`REQUIRE_INVITE_KEY` is off unless it is the string `true`, so a self-hosted server accepts checks without an invite key. To issue one, set `INVITE_KEY_SECRET` and run:

```bash
node scripts/create-invite-key.mjs --label "a desk" --limit 40
```

The script prints the key once and does not save it.

The manifest allows the exact hosted origin `https://ghost-job-detector-nine.vercel.app`, plus LinkedIn, Workday, DuckDuckGo, Wikidata, `http://localhost`, and `http://127.0.0.1`. To point the extension at another https server, open the popup, turn on Developer mode, enter the server URL, choose Save, and approve the permission prompt.

## Privacy

What the extension and the hosted backend keep is in [PRIVACY.md](PRIVACY.md). The same page is served at `/privacy.html`.

## Known limits

After an update, LinkedIn tabs that are already open are re-injected automatically. Chrome may still need the extension re-enabled before that runs.

## Tests

```bash
npm test
```

The suite covers layoff matching, reviews, the score and the evidence gate, LinkedIn and Workday page extraction, reposts, workforce and headcount, company identity, vagueness, pay parsing, the widget and popup, reload and open-tab injection, rate limits, paid daily caps, invite keys, the request log, careers pages, and a scan that extension files do not embed API keys. Outbound calls are mocked. `npm test` makes no live API calls.

## License

[MIT](LICENSE). Copyright 2026 Bias V.
