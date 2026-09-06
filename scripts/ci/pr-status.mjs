#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PR-STATUS - answer "is my branch green, red, or still running" truthfully.
//
// WHY THIS EXISTS (measured 2026-09-06).
//
// An agent reported "checks pending" on a branch whose CI had been RED for
// three pushes. The report was not careless. It was what the API said.
//
// There are three routes to a commit's check state and on this estate two of
// them lie to you:
//
//   GET /repos/:o/:r/commits/:sha/check-runs
//        -> 403 "Resource not accessible by personal access token".
//        The estate PAT has no `checks:read`. A script that does
//        `(await res.json()).check_runs` gets `undefined`, treats it as an
//        empty list, and concludes there is nothing wrong.
//
//   GET /repos/:o/:r/commits/:sha/status
//        -> 200 {"state":"pending","total_count":0}
//        THIS IS THE ONE THAT CAUSED THE WRONG REPORT. It is the legacy
//        COMMIT STATUS API. Every check in this estate is a GitHub Actions
//        check-run, and check-runs are not commit statuses, so this endpoint
//        has nothing to report and says so as `pending`. It answers `pending`
//        for a commit that is green, for a commit that is red, and for a
//        commit nobody has ever built. Verified against PR #3163, whose
//        `CI - Build & Type Safety` had been `completed failure` for fifteen
//        hours: /status said `pending`, total_count 0, HTTP 200.
//
//   GET /repos/:o/:r/actions/runs?head_sha=:sha        <- the truth
//        -> 200, readable with the same token, and it is the same data the
//        Checks tab renders. Its /jobs child names the failing JOB and STEP.
//
// AGENT-PLAYBOOK.md already documented the 403 and already named the Actions
// API as the answer. It did not help, because all four commands it offered
// were `gh` commands and `gh` IS NOT INSTALLED ON THIS MAC (CLAUDE.md 1.2.5).
// So an agent following the playbook got `command not found` four times, fell
// back to curl, hit the 403, fell back again to /status, and got a well-formed
// 200 saying `pending`. Every step of that is reasonable. The outcome is a
// false all-clear that outlived three pushes.
//
// THE RULE THIS FILE ENCODES: a fallback that cannot tell you the answer must
// SAY SO. "Pending" is a claim about the world, and this tool only makes it
// after seeing a run that is genuinely in progress. When it cannot tell, it
// prints UNKNOWN and exits 3, which is impossible to mistake for good news.
//
// USAGE
//   node scripts/ci/pr-status.mjs                 # PR for the current branch
//   node scripts/ci/pr-status.mjs 3163            # by PR number
//   node scripts/ci/pr-status.mjs --branch fix/x  # by branch name
//   node scripts/ci/pr-status.mjs --sha abc123    # by commit
//   node scripts/ci/pr-status.mjs --json          # machine-readable
//   node scripts/ci/pr-status.mjs --all           # every open PR, ranked
//
// EXIT CODES (branch on these, do not parse the prose)
//   0  GREEN    every required check passed; autopilot will merge it
//   1  RED      at least one check failed - the job and step are named
//   2  RUNNING  something is genuinely still in progress, nothing failed yet
//   3  UNKNOWN  could not determine. NOT a synonym for pending. Read the note.
//   4  DIRTY    the branch conflicts with main; CI state is moot until resolved
//
// The token needs `actions:read` + `pull_requests:read` only. It deliberately
// does NOT need `checks:read` - that scope is missing from the estate token,
// and waiting for someone to add it is how this stayed broken.
// ---------------------------------------------------------------------------

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};

const JSON_OUT = has('--json');
const ALL = has('--all');
// Fetch and distil the failing job's log in the same call. Cached on disk, so
// asking twice costs one request - repeated log reads are the heavy endpoint
// that exhausts the quota.
const WANT_LOG = has('--log');
/**
 * Which repository am I asking about?
 *
 * This used to default to `Smarter-Poker/Smarter-Poker-Club-Arena`. That is
 * fine in Club Arena and a trap everywhere else: AGENT-PLAYBOOK.md is
 * byte-identical in seven repos, so the moment it started naming this tool,
 * an agent in the World Hub running it with no arguments would have been told,
 * confidently and in the right format, about Club Arena's pull requests.
 *
 * A wrong answer that looks right is the whole subject of this file's header,
 * so the repo is DERIVED from the checkout instead. Explicit --repo or $REPO
 * still win; a directory with no git remote gets no guess at all.
 */
function repoFromGitRemote() {
  try {
    const url = execSync('git remote get-url origin', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // git@github.com:owner/name.git | https://github.com/owner/name(.git)
    const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

const REPO = argOf('--repo', process.env.REPO || repoFromGitRemote());
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_PAT || process.env.GH_TOKEN;

// A conclusion that is not one of these is a failure. Listing the GOOD ones
// rather than the bad ones means a conclusion GitHub adds later defaults to
// "tell the human" instead of "silently pass".
const GOOD = new Set(['success', 'skipped', 'neutral']);

const EXIT = { GREEN: 0, RED: 1, RED_NON_BLOCKING: 1, RUNNING: 2, UNKNOWN: 3, DIRTY: 4 };

function die(msg, code = EXIT.UNKNOWN) {
  if (JSON_OUT) console.log(JSON.stringify({ state: 'UNKNOWN', reason: msg }, null, 2));
  else console.error(`\n  UNKNOWN - ${msg}\n`);
  process.exit(code);
}

if (!TOKEN) {
  die(
    'no GITHUB_TOKEN / GH_PAT / GH_TOKEN in the environment.\n' +
      '  It lives in ~/Documents/club-arena/.env - load it with:\n' +
      "    export GITHUB_TOKEN=$(grep -m1 '^GITHUB_TOKEN=' ~/Documents/club-arena/.env | cut -d= -f2-)"
  );
}

if (!REPO) {
  die(
    'could not tell which repository to ask about.\n' +
      '  There is no `origin` remote here and neither --repo nor $REPO was given.\n' +
      "  Guessing one would report, in a convincing format, on somebody else's\n" +
      '  pull requests. Run this inside a checkout, or pass --repo owner/name.'
  );
}

// ---------------------------------------------------------------------------
// HTTP. Every non-200 is surfaced, never coerced into an empty result. This is
// the whole point of the file: the 403 that started all this returned a
// perfectly good JSON body, and the caller read `.check_runs` off it.
// ---------------------------------------------------------------------------
// Quota as last observed, so the footer can warn before the next agent runs
// into the wall rather than after.
let lastQuota = null;

/**
 * A 403 has TWO completely different meanings here and telling them apart is
 * not optional. Missing scope is permanent and needs a different token; rate
 * limiting is temporary and needs a clock. On 2026-09-06 an agent polling a
 * failing job exhausted the quota, and a tool that blamed "missing scope"
 * would have sent them to rotate a credential that was fine. GitHub says which
 * it is in the headers: `x-ratelimit-remaining: 0`, or `retry-after` for the
 * secondary limit.
 */
function rateLimitOf(res) {
  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
  const limit = Number(res.headers.get('x-ratelimit-limit') ?? NaN);
  const reset = Number(res.headers.get('x-ratelimit-reset') ?? NaN);
  const retryAfter = Number(res.headers.get('retry-after') ?? NaN);
  if (Number.isFinite(remaining) && Number.isFinite(limit)) lastQuota = { remaining, limit, reset };
  const limited =
    res.status === 429 || (res.status === 403 && (remaining === 0 || Number.isFinite(retryAfter)));
  if (!limited) return null;
  const waitMin = Number.isFinite(retryAfter)
    ? retryAfter / 60
    : Number.isFinite(reset)
      ? Math.max(0, (reset * 1000 - Date.now()) / 60000)
      : null;
  return {
    resource: res.headers.get('x-ratelimit-resource') || 'core',
    waitMin,
    resetAt: Number.isFinite(reset)
      ? new Date(reset * 1000).toISOString().slice(11, 19) + ' UTC'
      : null,
  };
}

async function gh(path, { allow404 = false } = {}) {
  const url = path.startsWith('http') ? path : `https://api.github.com/repos/${REPO}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  rateLimitOf(res); // record quota even on success
  if (res.status === 404 && allow404) return null;
  if (!res.ok) {
    const rl = rateLimitOf(res);
    if (rl) {
      die(
        `RATE LIMITED on the "${rl.resource}" quota.\n` +
          `  This is NOT a permissions problem and NOT a broken token - do not\n` +
          `  rotate a credential over it.\n` +
          (rl.waitMin !== null
            ? `  The quota resets in ${rl.waitMin.toFixed(1)} minute(s)${rl.resetAt ? ` (${rl.resetAt})` : ''}.\n`
            : '') +
          '  You almost certainly got here by POLLING. Do not: push, open the PR,\n' +
          '  report the number, end the session (AGENT-PLAYBOOK 7b, CLAUDE.md\n' +
          '  10.8.3). Autopilot merges and the watchdogs verify, server-side.\n' +
          '  To read a failing job once, cheaply: node scripts/ci/pr-status.mjs <pr> --log'
      );
    }
    const body = await res.text().catch(() => '');
    let detail = '';
    try {
      detail = JSON.parse(body).message || '';
    } catch {
      detail = body.slice(0, 200);
    }
    die(
      `GitHub answered ${res.status} for ${url}\n  ${detail}\n\n` +
        (res.status === 403
          ? '  A 403 with quota remaining means the token lacks a scope. This tool\n' +
            '  needs actions:read and pull_requests:read. Do NOT "work around" it\n' +
            '  by falling back to /commits/:sha/status - that endpoint reports\n' +
            '  "pending" for commits that have already failed. See the header.'
          : '')
    );
  }
  return res.json();
}

/**
 * Fetch a job's log ONCE and cache it. An agent reading the same failure twice
 * should pay for it once; log endpoints are heavy and repeated reads are what
 * exhausts the quota in the first place.
 */
async function jobLog(jobId) {
  const cache = `${tmpdir()}/ca-joblog-${jobId}.txt`;
  if (existsSync(cache)) return readFileSync(cache, 'utf8');
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/jobs/${jobId}/logs`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  const rl = rateLimitOf(res);
  if (rl)
    die(`RATE LIMITED fetching the log for job ${jobId}; resets in ${rl.waitMin?.toFixed(1)} min.`);
  if (!res.ok) die(`could not read the log for job ${jobId}: HTTP ${res.status}`);
  const text = await res.text();
  try {
    writeFileSync(cache, text);
  } catch {
    /* cache is a convenience, never a requirement */
  }
  return text;
}

/**
 * The lines that actually say what broke. A 1MB job log is mostly the stderr of
 * tests that PASS while deliberately exercising failure paths - on 2026-09-06
 * the real failure sat under ~40 lines of expected "[Supabase] FATAL" noise,
 * and grepping for /Error:/ finds the noise first.
 */
function failureLines(log) {
  const clean = log.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  const hits = [];
  for (let i = 0; i < clean.length; i++) {
    const l = clean[i];
    if (
      /^\s*\S*\s*(FAIL|✕|×)\s/.test(l) ||
      /Failed Tests/.test(l) ||
      /Test Files\s+\d+ failed/.test(l) ||
      /Tests\s+\d+ failed/.test(l) ||
      /Test timed out in/.test(l) ||
      /^\s*##\[error\]/.test(l) ||
      /AssertionError/.test(l)
    ) {
      hits.push(l.replace(/^\S+Z\s/, '').trimEnd());
    }
  }
  return [...new Set(hits)];
}

// A read whose absence is survivable: returns null instead of exiting.
async function ghSoft(path) {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// GitHub computes mergeability lazily. On a PR it has not looked at yet,
// `mergeable` is null and `mergeable_state` is "unknown" - which is NOT the
// same as mergeable, and must never be rendered as though it were. The list
// endpoint omits both fields entirely, which is the same trap one level down.
function mergeLabel(pr) {
  if (!pr) return 'UNCOMPUTED';
  if (pr.mergeable_state === 'dirty') return 'DIRTY';
  if (pr.mergeable === null || pr.mergeable_state === undefined || pr.mergeable_state === 'unknown')
    return 'UNCOMPUTED';
  return String(pr.mergeable_state).toUpperCase();
}

// ---------------------------------------------------------------------------
// Which checks does the ruleset actually require? Read it rather than
// hardcoding, so a check added to the ruleset is honoured here the same hour.
// If the token cannot read rulesets we fall back to "every check must pass",
// which is stricter, never looser.
// ---------------------------------------------------------------------------
async function requiredChecks() {
  const rules = await ghSoft('/rules/branches/main');
  if (!Array.isArray(rules)) return null;
  const rule = rules.find((r) => r.type === 'required_status_checks');
  const list = rule?.parameters?.required_status_checks?.map((c) => c.context).filter(Boolean);
  return list?.length ? new Set(list) : null;
}

// ---------------------------------------------------------------------------
// The state of one commit, from the one endpoint that answers.
// ---------------------------------------------------------------------------
async function commitState(sha, required) {
  const data = await gh(`/actions/runs?head_sha=${sha}&per_page=100`);
  const runs = data.workflow_runs || [];

  if (runs.length === 0) {
    return {
      state: 'UNKNOWN',
      reason:
        `no workflow run has ever been recorded for ${sha.slice(0, 9)}.\n` +
        'That is not "pending" - a queued run appears here within seconds.\n' +
        'Most likely the commit was never pushed, or was pushed to a fork, or\n' +
        'the workflows are gated off for this branch. Check:\n' +
        '  git rev-parse HEAD   and   git ls-remote origin <branch>',
      runs: [],
      failures: [],
      activeRuns: [],
    };
  }

  // One run per workflow: the newest. Re-runs create new rows, and an old
  // failure sitting beside a fresh success would otherwise read as red forever.
  const latest = new Map();
  for (const r of runs) {
    const prev = latest.get(r.name);
    if (!prev || new Date(r.created_at) > new Date(prev.created_at)) latest.set(r.name, r);
  }
  const list = [...latest.values()];

  const failedRuns = list.filter((r) => r.conclusion && !GOOD.has(r.conclusion));
  const activeRuns = list.filter((r) => r.status !== 'completed');

  // Name the job and the step. This is the part an agent actually needs, and
  // the part /commits/:sha/status could never give even if it worked.
  const failures = [];
  for (const run of failedRuns) {
    const jobs = await gh(`/actions/runs/${run.id}/jobs?per_page=100`);
    const badJobs = (jobs.jobs || []).filter((j) => j.conclusion && !GOOD.has(j.conclusion));
    if (badJobs.length === 0) {
      failures.push({
        workflow: run.name,
        job: '(run failed before any job started)',
        step: null,
        conclusion: run.conclusion,
        runId: run.id,
        url: run.html_url,
        required: false,
      });
      continue;
    }
    for (const j of badJobs) {
      const step = (j.steps || []).find((s) => s.conclusion && !GOOD.has(s.conclusion));
      failures.push({
        workflow: run.name,
        job: j.name,
        step: step?.name || null,
        conclusion: j.conclusion,
        runId: run.id,
        jobId: j.id,
        url: j.html_url || run.html_url,
        // The ruleset names JOBS, not workflows - "TypeScript Check" is a job
        // inside "CI - Build & Type Safety". Getting that backwards is why
        // agents mis-read which reds actually block a merge.
        required: required ? required.has(j.name) : true,
      });
    }
  }

  const blocking = failures.filter((f) => f.required);
  let state;
  if (blocking.length) state = 'RED';
  else if (failures.length && activeRuns.length === 0) state = 'RED_NON_BLOCKING';
  else if (activeRuns.length) state = 'RUNNING';
  else state = 'GREEN';

  return { state, runs: list, failures, activeRuns, required };
}

/**
 * Say something BEFORE the wall, not after it. An agent who has burned 80% of
 * the hour's quota is one poll loop away from being unable to read CI at all,
 * and the failure mode when that happens is a 403 that looks like a broken
 * token.
 */
function quotaWarning(line) {
  if (!lastQuota || !Number.isFinite(lastQuota.limit) || lastQuota.limit === 0) return;
  const frac = lastQuota.remaining / lastQuota.limit;
  if (frac > 0.2) return;
  const mins = Number.isFinite(lastQuota.reset)
    ? Math.max(0, (lastQuota.reset * 1000 - Date.now()) / 60000).toFixed(0)
    : '?';
  line('');
  line(
    `  QUOTA LOW: ${lastQuota.remaining}/${lastQuota.limit} GitHub API calls left, resets in ${mins} min.`
  );
  line('  Stop polling. Push, open the PR, report the number, end the session.');
}

// ---------------------------------------------------------------------------
function render(pr, st) {
  const line = (s) => console.log(s);
  const head = pr ? `PR #${pr.number}  ${pr.head.ref}` : `commit ${st.sha}`;
  line('');
  line('  ' + head);
  if (pr) line(`  ${pr.html_url}`);
  line('  ' + '-'.repeat(Math.max(20, head.length)));

  if (pr && mergeLabel(pr) === 'DIRTY') {
    line('  DIRTY - this branch conflicts with main. Resolve the conflict first;');
    line('  CI state is not the thing standing in your way.');
    line('  (Merge main in - do NOT rebase: CLAUDE.md 12 and a ref-guard hook.)');
    line('');
    return EXIT.DIRTY;
  }

  if (st.state === 'UNKNOWN') {
    line('  UNKNOWN - ' + st.reason.split('\n').join('\n  '));
    line('');
    return EXIT.UNKNOWN;
  }

  for (const r of st.runs) {
    const tag =
      r.status !== 'completed'
        ? 'RUNNING'
        : GOOD.has(r.conclusion)
          ? 'ok'
          : String(r.conclusion).toUpperCase();
    line(`  ${tag.padEnd(9)} ${r.name}`);
  }

  if (st.failures.length) {
    line('');
    line('  FAILING:');
    for (const f of st.failures) {
      line(`    ${f.required ? '[BLOCKS MERGE]' : '[not required]'} ${f.workflow} -> ${f.job}`);
      if (f.step) line(`        failed step: ${f.step}`);
      line(`        ${f.url}`);
      if (f.detail?.length) {
        line('        ---- what the log says ----');
        for (const d of f.detail.slice(-12)) line(`        ${d}`);
      } else if (f.jobId && !WANT_LOG) {
        line(`        re-run with --log to name the failing test (cached, one request)`);
      }
    }
  }

  quotaWarning(line);
  line('');
  if (st.state === 'RED') {
    line(
      `  RED - ${st.failures.filter((f) => f.required).length} required check(s) failed. This will not merge.`
    );
    line('');
    return EXIT.RED;
  }
  if (st.state === 'RED_NON_BLOCKING') {
    line('  RED (non-blocking) - a check failed but the ruleset does not require it.');
    line('  Autopilot can still merge this. Fix it anyway: CLAUDE.md 10.83 - a red');
    line('  nobody is required to look at is how a gate rots for two days.');
    line('');
    return EXIT.RED;
  }
  if (st.state === 'RUNNING') {
    line(`  RUNNING - ${st.activeRuns.length} run(s) in progress, nothing has failed yet.`);
    line('  Open the PR and stop. Autopilot merges it when they go green');
    line('  (AGENT-PLAYBOOK 7b / CLAUDE.md 10.8.3 - never sit in a poll loop).');
    line('');
    return EXIT.RUNNING;
  }
  line('  GREEN - every required check passed.');
  if (pr && mergeLabel(pr) === 'BLOCKED')
    line('  (GitHub still says "blocked" - that clears when autopilot enables auto-merge.)');
  if (pr && mergeLabel(pr) === 'UNCOMPUTED')
    line(
      '  (GitHub has not computed mergeability yet - that is not a problem, just not an answer.)'
    );
  line('');
  return EXIT.GREEN;
}

// ---------------------------------------------------------------------------
async function main() {
  const required = await requiredChecks();

  if (ALL) {
    const list = await gh('/pulls?state=open&per_page=100');
    const rows = [];
    for (const stub of list) {
      // The LIST endpoint does not compute `mergeable_state` - it is only
      // filled in on a single-PR GET, and even then GitHub computes it
      // asynchronously. Reading it off the list row makes every conflicted
      // branch look clean, so the same PR reported DIRTY on its own and RED
      // in this table. Fetch the detail; treat an uncomputed answer as
      // uncomputed rather than as "fine".
      const pr = (await ghSoft(`/pulls/${stub.number}`)) || stub;
      const st = await commitState(pr.head.sha, required);
      rows.push({ pr, st, merge: mergeLabel(pr) });
    }
    const rank = { DIRTY: -1, RED: 0, RED_NON_BLOCKING: 1, UNKNOWN: 2, RUNNING: 3, GREEN: 4 };
    const stateOf = (r) => (r.merge === 'DIRTY' ? 'DIRTY' : r.st.state);
    rows.sort((a, b) => rank[stateOf(a)] - rank[stateOf(b)] || a.pr.number - b.pr.number);
    if (JSON_OUT) {
      console.log(
        JSON.stringify(
          rows.map(({ pr, st, merge }) => ({
            number: pr.number,
            branch: pr.head.ref,
            state: stateOf({ st, merge }),
            mergeable_state: merge,
            failures: st.failures,
          })),
          null,
          2
        )
      );
      return 0;
    }
    console.log('');
    for (const row of rows) {
      const { pr, st, merge } = row;
      const state = stateOf(row);
      const note =
        merge === 'UNCOMPUTED' && state !== 'DIRTY' ? '  (mergeability not yet computed)' : '';
      console.log(
        `  ${state.padEnd(18)} #${String(pr.number).padEnd(5)} ${pr.head.ref.slice(0, 56)}${note}`
      );
      if (state === 'DIRTY') continue; // the conflict is the finding; CI is moot
      for (const f of st.failures)
        console.log(`       ${f.required ? 'X' : '-'} ${f.job}${f.step ? ` :: ${f.step}` : ''}`);
    }
    console.log('');
    const dirty = rows.filter((r) => stateOf(r) === 'DIRTY').length;
    const red = rows.filter((r) => stateOf(r) === 'RED').length;
    console.log(
      `  ${rows.length} open, ${red} with a failing required check, ${dirty} conflicting with main.`
    );
    console.log('');
    return red || dirty ? EXIT.RED : EXIT.GREEN;
  }

  // Resolve what we were asked about.
  let pr = null;
  let sha = argOf('--sha', null);
  const positional = args.find((a) => /^\d+$/.test(a));
  const branch = argOf('--branch', null);

  if (positional) {
    pr = await gh(`/pulls/${positional}`);
  } else if (branch || !sha) {
    let ref = branch;
    if (!ref) {
      try {
        ref = sh('git rev-parse --abbrev-ref HEAD');
      } catch {
        die('not in a git repository and no PR number, --branch or --sha given.');
      }
      if (ref === 'main' || ref === 'HEAD')
        die(
          `the current branch is "${ref}". Give a PR number, --branch, or --sha.\n` +
            '  (Work never originates on main - CLAUDE.md 12.)'
        );
    }
    const owner = REPO.split('/')[0];
    const found = await gh(`/pulls?state=open&head=${owner}:${ref}&per_page=1`);
    if (found?.length) pr = found[0];
    else {
      // No PR yet. Judge the branch head itself rather than inventing a state.
      const b = await gh(`/branches/${encodeURIComponent(ref)}`, { allow404: true });
      if (!b)
        die(
          `no open PR for "${ref}" and origin has no such branch.\n` +
            '  If you have not pushed yet, that is the answer - push it, and\n' +
            '  agent-open-pr.yml opens the PR within seconds.'
        );
      sha = b.commit.sha;
    }
  }

  if (pr) sha = pr.head.sha;
  const st = await commitState(sha, required);
  st.sha = sha;

  // --log: name the failing test, not just the failing job. Without this the
  // agent runs a second curl, and if they run it in a loop they land on the
  // rate limit - which is exactly how PR #3272 went three pushes with nobody
  // able to say which of its 6,192 tests had failed.
  if (WANT_LOG) {
    for (const f of st.failures ?? []) {
      if (!f.jobId) continue;
      f.detail = failureLines(await jobLog(f.jobId));
    }
  }

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          pr: pr?.number ?? null,
          branch: pr?.head.ref ?? branch ?? null,
          sha,
          state: pr && mergeLabel(pr) === 'DIRTY' ? 'DIRTY' : st.state,
          mergeable_state: pr ? mergeLabel(pr) : null,
          failures: st.failures,
          reason: st.reason ?? null,
        },
        null,
        2
      )
    );
    return pr && mergeLabel(pr) === 'DIRTY' ? EXIT.DIRTY : (EXIT[st.state] ?? EXIT.RED);
  }

  return render(pr, st);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => die(`unexpected: ${err?.stack || err}`));
