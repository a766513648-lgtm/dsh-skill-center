/**
 * Print the failing assertions from the most recent CI run.
 *
 * The job log is large and mostly progress noise, so this pulls out the test-runner's
 * failure blocks — the `not ok` line with the error that follows it — which is what
 * a human reads first.
 *
 * Usage: node scripts/dev/ci-failures.mjs <token> [repo]
 *
 * @module scripts/dev/ci-failures
 */

const token = process.argv[2];
const repo = process.argv[3] ?? 'a766513648-lgtm/dsh-skill-center';
const headers = {
  authorization: `Bearer ${token}`,
  'user-agent': 'dsh-skill-center',
  accept: 'application/vnd.github+json',
};

const runs = await (await fetch(`https://api.github.com/repos/${repo}/actions/runs`, { headers })).json();
const run = runs.workflow_runs?.[0];
console.log(`run #${run.run_number} ${run.head_sha.slice(0, 7)} ${run.conclusion ?? run.status}`);

const jobs = await (await fetch(run.jobs_url, { headers })).json();
const job = (jobs.jobs ?? []).find((entry) => entry.name.includes('24')) ?? jobs.jobs?.[0];
console.log(`job: ${job.name}`);

const log = await (
  await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${job.id}/logs`, { headers, redirect: 'follow' })
).text();

// Strip the timestamp prefix and the runner's own noise.
const lines = log
  .split('\n')
  .map((line) => line.replace(/^\S+\s/, '').trimEnd())
  .filter((line) => !/^\[command\]/.test(line));

const firstFailure = lines.findIndex((line) => /^not ok \d+ - /.test(line));
if (firstFailure < 0) {
  console.log('no failing test; showing the tail');
  for (const line of lines.slice(-25)) console.log(line.slice(0, 200));
} else {
  console.log('--- first failure and the 30 lines after it ---');
  for (const line of lines.slice(firstFailure, firstFailure + 30)) console.log(line.slice(0, 200));
}

// Every failing case, not just the first: the shape of the list says whether the
// cause is one bug or several.
const failedNames = lines.filter((line) => /^not ok \d+ - /.test(line)).map((line) => line.replace(/^not ok \d+ - /, ''));
console.log(`\n--- ${String(failedNames.length)} failing cases ---`);
for (const name of failedNames) console.log(`  ${name}`);

const summary = lines.filter((line) => /^# (tests|pass|fail|skipped)|^ℹ (tests|pass|fail|skipped)/.test(line));
if (summary.length > 0) {
  console.log('--- summary ---');
  for (const line of summary) console.log(line);
}
