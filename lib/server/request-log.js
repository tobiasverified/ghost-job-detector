// One row per analyze-job check, kept 30 days in ghd_checks. The posting text
// and the client IP are not fields on that row. A failed write is logged and
// then dropped, so it cannot change the HTTP response.

const REQUEST_LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function clip(value, max = 200) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : '';
}

function finiteInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

export function requestLogRow(input = {}) {
  const job = input.job || {};
  const outcome = input.outcome || {};
  const hiring = outcome.factors?.hiringRatio || {};

  return {
    company: clip(outcome.company || job.company),
    platform: clip(job.platform, 40),
    job_id: clip(job.jobId, 80),
    status: finiteInt(input.status) ?? 0,
    cached: Boolean(outcome.cached),
    partial: Boolean(outcome.partial),
    score_withheld: outcome.scoreWithheld === true,
    timed_out: Array.isArray(outcome.timedOut) ? outcome.timedOut.map((item) => clip(item, 40)).filter(Boolean).slice(0, 8) : [],
    ghost_score: finiteInt(outcome.ghostScore),
    employees: finiteInt(hiring.employees),
    employee_source: clip(hiring.employeeSource, 40) || null,
    open_roles: finiteInt(hiring.openRoles),
    open_roles_source: clip(hiring.openJobsSource, 40) || null,
    open_roles_lower_bound: hiring.openJobsLowerBound === true,
    total_ms: finiteInt(input.totalMs),
    deployment_id: clip(input.deploymentId, 80) || null,
    tavily_calls: finiteInt(input.paid?.tavily) ?? 0,
    groq_calls: finiteInt(input.paid?.groq) ?? 0,
    rapidapi_calls: finiteInt(input.paid?.rapidapi) ?? 0,
    newsdata_calls: finiteInt(input.paid?.newsdata) ?? 0,
    rate_limited: input.paid?.rateLimited === true,
    key_id: clip(input.keyId, 80) || null
  };
}

export function requestLogCutoff(now = new Date()) {
  return new Date(now.getTime() - REQUEST_LOG_TTL_MS).toISOString();
}

export async function logCheck(env, input) {
  const row = requestLogRow(input);

  try {
    const url = String(env?.SUPABASE_URL || '').replace(/\/$/, '');
    const key = env?.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
      return row;
    }

    const response = await fetch(`${url}/rest/v1/rpc/ghd_log_check`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_row: row }),
      signal: AbortSignal.timeout(2500)
    });

    if (!response.ok) {
      console.info('[GHD] request log failed', { status: response.status });
    }
  } catch (error) {
    console.info('[GHD] request log failed', { error: error instanceof Error ? error.message : String(error) });
  }

  return row;
}

// Hands the write to waitUntil when the platform provides one. The returned
// promise never rejects.
export function scheduleRequestLog(waitUntil, env, input, write = logCheck) {
  const run = Promise.resolve().then(() => write(env, input)).catch((error) => {
    console.info('[GHD] request log failed', { error: error instanceof Error ? error.message : String(error) });
  });

  try {
    if (typeof waitUntil === 'function') {
      waitUntil(run);
    }
  } catch (error) {
    console.info('[GHD] request log failed', { error: error instanceof Error ? error.message : String(error) });
  }

  return run;
}
