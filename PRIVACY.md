# Ghost Job Detector Privacy Policy

Last updated: 2026-10-08

Ghost Job Detector is a browser extension that estimates how likely a job posting on LinkedIn or Workday is to be a "ghost job." This policy describes what the extension and its hosted backend do with data. If you run your own backend, this policy does not cover that server; the operator of that server decides what it keeps.

Contact: ghostjobdetector@atomicmail.io

## Summary

- There are no accounts. The extension does not ask for your name, email, or login. The invite form under Waitlist form does.
- We don't sell your data, and we don't use it for advertising, profiling, or analytics.
- Job postings are sent to the backend only as needed to produce a check (details below).
- Some data goes to third-party services that help produce the check. They are listed below.
- The extension keeps some data on your own computer. You can clear it by removing the extension.

## What the extension reads

The extension runs on LinkedIn and Workday job pages and reads the job's title, company, description, location, salary, URL, job ID, and posted date. On LinkedIn company pages it also reads the employee count shown on the page and saves it on your computer for later checks. It does not read your LinkedIn account details, messages, or other pages.

## What is sent to our backend

**When you click "Run full check":** the job's title, company, description, salary, URL, host, platform, job ID, posted label, location, and company slug are sent to our backend, along with any open-role and headcount figures the extension captured. Search-results pages that your browser fetched from DuckDuckGo (used to look for reposts) are also sent. The full LinkedIn or Workday page HTML is not sent.

**Before you click, on some pages:** when the employer's name on the page is not a normal company name (for example, a short Workday site name or an acronym), the extension sends the company name and an excerpt of the job description (up to about 8,000 characters, of which about 1,000 are used) to our backend so it can work out the employer's real name. This can happen when a page loads, without you clicking anything. Normal LinkedIn company names do not trigger it.

**Your invite key** (if you have one) is sent with each request to our backend so we can check it and apply its daily limit.

**Your IP address** is visible to our backend and to our hosting provider, as with any web request. We do not store it in raw form (see below).

## What we store, and for how long

| Data | What it contains | Retention |
|---|---|---|
| Check log | Company, platform, job ID, score, timings, number of paid-service calls, invite key ID | 30 days |
| Rate-limit counters | A keyed hash of your IP address and a request count | About 2 hours |
| Daily usage counters | Date, service name, call counts; per-key call counts | 35 days |
| Cached results | Results for a company, job, or search (for example Glassdoor rating fields, review ratings, layoff results, open-role counts, parsed repost matches, analysis scores). Keyed by company, title, or job; the job description is not stored, only a one-way fingerprint inside a cache key | Mostly 5 minutes to 30 days |
| Resolved employer names | The employer's resolved name, keyed by LinkedIn slug or Workday host | 90 days |

The job description text is not written to our database or cache. Search-results HTML that your browser sends is read for that request and is not cached.

**Server logs.** Our hosting provider (Vercel) keeps function logs and request logs. These can include company names, search queries, result URLs, and, for the employer-name step above, short excerpts of job-posting text (up to about 1,000 characters). Request logs can include IP addresses. How long Vercel keeps these depends on our hosting plan and Vercel's own policy, not on a setting we control. We read these logs only to fix problems that are reported to us, to prevent abuse, and to manage service quotas.

**Expired data.** A daily cleanup job removes expired rows.

## Who receives data

We don't sell your data and we don't share it with anyone for their own purposes. To produce a check, data goes to the services that run it:

| Service | What it receives | From where |
|---|---|---|
| Vercel (hosting) | Your requests and our function logs | Your browser, our backend |
| Supabase (database) | The stored data listed above | Our backend |
| Groq (language model) | For employer-name resolution: the website host and an excerpt of up to about 1,000 characters of the posting. For other checks: company names plus titles and snippets of public news or search results. The full job posting is never sent to Groq | Our backend |
| Tavily (web search) | Search queries built from the job title, company, and city, or from the company name | Our backend |
| NewsData (news search) | The company name plus the word "layoffs" | Our backend |
| RapidAPI / Glassdoor | The company name; job title, location, and an experience bucket if the optional pay comparison is on | Our backend |
| Wikidata (Wikimedia Foundation) | A company name, or a short phrase taken from the posting, as a search | Your browser directly, and our backend |
| DuckDuckGo | A search query of the job title, company, and city. If your browser cannot fetch it directly, the extension opens a hidden tab to the same address | Your browser directly |
| layoffs.fyi, company career sites, public job boards | The company name or already-public page addresses | Our backend |
| Formbricks (formbricks.com, hosted in Germany) | The name, email address, and optional GitHub username submitted on the invite form | The form |

When your browser contacts Wikidata or DuckDuckGo directly, those services can see your IP address, as they would for any site you visit. These services have their own privacy policies.

## Waitlist form

The invite request form is run by Formbricks (formbricks.com), which hosts it in Germany. If you submit it, Formbricks collects the name and email address you enter, plus an optional GitHub username. We use that only to send you an invite key and to reply about the project. We don't sell or share it. We keep it until the beta ends or you ask us to delete it, whichever comes first. You can ask for deletion by emailing ghostjobdetector@atomicmail.io. Formbricks processes the data under its own privacy policy.

## Data kept on your computer

The extension stores the following in your browser's extension storage:

- The last job you viewed (title, company, description, URL, and so on), until it is replaced by the next one
- Job ID age records, saved company headcounts, and resolved employer names
- Search-results pages fetched for repost checks (saved for up to 24 hours)
- Your widget position and display choices, your chosen backend address, and your invite key if you entered one

Some expired records stay in storage until they are next read. Removing the extension deletes all of this. You can clear your invite key from the extension popup.

## Browser permissions

The extension has access to LinkedIn and Workday job pages so it can show its card, and to our backend address so it can request checks. If you set a custom backend, the browser asks you to approve that address first. It also contacts DuckDuckGo and Wikidata as described above.

## Your choices

- Don't click "Run full check" to avoid sending job details for scoring. Note that the employer-name step can still run on some pages when they load.
- Remove the extension to delete locally stored data.
- To ask about or request deletion of data tied to your invite key or a specific check, contact ghostjobdetector@atomicmail.io. Check logs do not contain your name or account, so we may need the company and job ID you checked.

## Security

Requests use HTTPS. IP addresses are stored only as keyed hashes. Invite keys are signed, and our database stores only a key ID, never the key itself. 

## Children

The extension is not directed at children under 13 and we don't knowingly collect data from them.

## Changes

If this policy changes, we will update the date at the top and note material changes in the project repository.

## Self-hosting

The extension's source code lets you run your own backend. If you do, you are responsible for that server's data handling.