/**
 * Set a repository's About panel: the description and the topic list.
 *
 * Both are part of how a repository is found and understood — the description is what
 * a search result shows and the topics are what a browse page filters on — so they are
 * set through the API rather than left to be clicked in by hand.
 *
 * The token is read from `GITHUB_TOKEN`, never from an argument, so it cannot end up
 * in a shell history.
 *
 * Usage: $env:GITHUB_TOKEN = 'github_pat_...'; node scripts/dev/set-about.mjs
 *
 * @module scripts/dev/set-about
 */

const token = process.env.GITHUB_TOKEN;
if (typeof token !== 'string' || token === '') {
  console.error('Set GITHUB_TOKEN first.');
  process.exit(2);
}

const repo = 'a766513648-lgtm/dsh-skill-center';
const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-skill-center',
  'content-type': 'application/json',
};

// The description names the five things the panel does, because that is the question
// a search result has to answer without being opened.
const description = 'DSH 技能中心：查看、开关、新建、按链接安装、删除（进回收站可恢复）DSH 技能。';

// Topics are ASCII-only and lowercase, and they are what a browse page filters on.
const topics = ['dsh', 'deepseek-harness', 'dsh-plugin', 'skill', 'skills-manager', 'cordis', 'plugin', 'typescript'];

const patch = await fetch(`https://api.github.com/repos/${repo}`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({ description, homepage: 'https://www.npmjs.com/package/@suifengshiqu/skill-center' }),
});
console.log(`description: ${String(patch.status)} ${patch.ok ? 'ok' : await patch.text()}`);

const put = await fetch(`https://api.github.com/repos/${repo}/topics`, {
  method: 'PUT',
  headers: { ...headers, accept: 'application/vnd.github.mercy-preview+json' },
  body: JSON.stringify({ names: topics }),
});
console.log(`topics:      ${String(put.status)} ${put.ok ? 'ok' : await put.text()}`);

// Read back, so the result is the API's answer rather than this script's intention.
const check = await (await fetch(`https://api.github.com/repos/${repo}`, { headers })).json();
console.log('--- as the API now reports it ---');
console.log(`  description: ${check.description ?? '(none)'}`);
console.log(`  homepage:    ${check.homepage ?? '(none)'}`);
console.log(`  topics:      ${(check.topics ?? []).join(', ') || '(none)'}`);
