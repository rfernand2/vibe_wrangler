'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Runs git with argv (never a shell string), so branch names and paths can't inject. */
function git(cwd, args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    // A missing credential helper must fail the call, not sit waiting for a password.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return {
    ok: !r.error && r.status === 0,
    code: r.status,
    out: (r.stdout || '').trim(),
    err: (r.error?.message || r.stderr || '').trim(),
  };
}

function isRepo(dir) {
  return git(dir, ['rev-parse', '--is-inside-work-tree']).out === 'true';
}

/** Null when detached or when the repo has no commits yet — neither can host a task branch. */
function currentBranch(dir) {
  const r = git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!r.ok || !r.out) return null;
  return git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok ? r.out : null;
}

function branchExists(dir, branch) {
  return git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
}

/**
 * Picks a branch name for a task, stepping aside when the obvious one still holds commits that
 * never made it back to base — a retry must never destroy the work the failed attempt saved.
 */
function pickTaskBranch(dir, base, taskId) {
  const first = `llm-task/${taskId}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? first : `${first}-retry${n}`;
    if (!branchExists(dir, name) || !shortLog(dir, base, name).length) return name;
  }
}

/** Clears anything a previous crashed run left behind, then creates a fresh branch + worktree. */
function addWorktree(dir, wtPath, branch, base) {
  // remove + prune walk every worktree; only do that work when this path is already there
  // or when the first add fails because git still has a stale registration.
  if (fs.existsSync(wtPath)) git(dir, ['worktree', 'remove', '--force', wtPath]);
  if (branchExists(dir, branch)) git(dir, ['branch', '-D', branch]);
  const added = git(dir, ['worktree', 'add', '--quiet', wtPath, '-b', branch, base]);
  if (added.ok) return added;
  git(dir, ['worktree', 'prune']);
  if (branchExists(dir, branch)) git(dir, ['branch', '-D', branch]);
  return git(dir, ['worktree', 'add', '--quiet', wtPath, '-b', branch, base]);
}

function removeWorktree(dir, wtPath, branch) {
  git(dir, ['worktree', 'remove', '--force', wtPath]);
  git(dir, ['worktree', 'prune']);
  git(dir, ['branch', '-D', branch]);
}

function isDirty(wtPath) {
  return git(wtPath, ['status', '--porcelain']).out !== '';
}

function mergeInProgress(wtPath) {
  return git(wtPath, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).ok;
}

function commitAll(wtPath, message) {
  // A merge still needs its commit even when resolving it produced no net change.
  if (!isDirty(wtPath) && !mergeInProgress(wtPath)) return { ok: true, out: '', err: '', empty: true };
  const add = git(wtPath, ['add', '-A']);
  if (!add.ok) return add;
  return git(wtPath, ['-c', 'user.name=vibe_wrangler', '-c', 'user.email=vibe_wrangler@localhost',
    'commit', '-m', message]);
}

/** Merges base into the task branch inside the worktree, where a conflict is harmless. */
function mergeBaseIn(wtPath, base) {
  const r = git(wtPath, ['-c', 'user.name=vibe_wrangler', '-c', 'user.email=vibe_wrangler@localhost',
    'merge', '--no-edit', base]);
  if (r.ok) return { ok: true, conflicted: false };
  return { ok: false, conflicted: conflictedFiles(wtPath).length > 0, err: r.err };
}

function conflictedFiles(wtPath) {
  const r = git(wtPath, ['diff', '--name-only', '--diff-filter=U']);
  return r.out ? r.out.split(/\r?\n/).filter(Boolean) : [];
}

/** The index keeps unmerged stages until the files are staged, so check the text itself. */
function stillConflicted(wtPath, files) {
  return files.filter((f) => {
    try { return fs.readFileSync(path.join(wtPath, f), 'utf8').includes('<<<<<<<'); } catch { return false; }
  });
}

function abortMerge(wtPath) {
  git(wtPath, ['merge', '--abort']);
}

/** Guaranteed not to conflict: git refuses rather than touching the user's working copy. */
function fastForward(dir, branch) {
  return git(dir, ['merge', '--ff-only', branch]);
}

function shortLog(dir, base, branch) {
  const r = git(dir, ['log', '--oneline', `${base}..${branch}`]);
  return r.out ? r.out.split(/\r?\n/).filter(Boolean) : [];
}

function headSha(dir) {
  const r = git(dir, ['rev-parse', 'HEAD']);
  return r.ok && r.out ? r.out : null;
}

function hasRemote(dir, name = 'origin') {
  return git(dir, ['remote', 'get-url', name]).ok;
}

/** The last SHA we know GitHub (or whichever remote) has for this branch — no network. */
function remoteSha(dir, remote, branch) {
  if (!branch) return null;
  const r = git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`]);
  return r.ok && r.out ? r.out : null;
}

function push(dir, remote, branch) {
  return git(dir, ['push', '-u', '--quiet', remote, branch]);
}

/**
 * A repo the user works in themselves already has an author name; only a folder that has never
 * been committed from needs the board to stand in for one, and then only so the commit succeeds.
 */
function identityArgs(dir) {
  if (git(dir, ['config', '--get', 'user.email']).out) return [];
  return ['-c', 'user.name=vibe_wrangler', '-c', 'user.email=vibe_wrangler@localhost'];
}

/**
 * What this checkout still owes GitHub: files changed but never committed, and commits that sit
 * on no remote branch. Refs only, never the network, so the board can ask as often as it repaints.
 */
function localWork(dir, remote = 'origin') {
  if (!dir || !isRepo(dir)) return { is_repo: false, has_remote: false, uncommitted: 0, unpushed: 0 };
  const status = git(dir, ['status', '--porcelain']);
  const uncommitted = status.out ? status.out.split(/\r?\n/).filter(Boolean).length : 0;
  // With no remote there is nowhere to push to, so unpushed commits are not a thing to count.
  const remoteExists = hasRemote(dir, remote);
  // Measured against every ref of the remote rather than just this branch's upstream: a branch
  // that was never pushed would otherwise report its whole shared history as unpushed work.
  const ahead = remoteExists
    ? git(dir, ['rev-list', '--count', 'HEAD', '--not', `--remotes=${remote}`])
    : null;
  return {
    is_repo: true,
    has_remote: remoteExists,
    uncommitted,
    // No commits yet (or an unreadable HEAD) means nothing is waiting to go out.
    unpushed: ahead?.ok ? Number(ahead.out) || 0 : 0,
  };
}

/**
 * The whole of what "Push needed" asks for, in one go: commit everything in the working tree, then
 * send the branch to the remote. Both halves are optional — a repo can owe a commit, a push, both,
 * or (pressing the button twice) neither — so the result says which ones actually happened rather
 * than claiming success in the abstract.
 */
function commitAndPush(dir, message, remote = 'origin') {
  const done = { ok: true, committed: false, pushed: false, files: 0, commits: 0, branch: null, remote };
  if (!dir || !isRepo(dir)) {
    return { ...done, ok: false, error: 'This project folder is not a git repository' };
  }

  const before = localWork(dir, remote);
  done.files = before.uncommitted;
  if (before.uncommitted > 0 || mergeInProgress(dir)) {
    const add = git(dir, ['add', '-A']);
    if (!add.ok) return { ...done, ok: false, error: add.err || 'git add failed' };
    const commit = git(dir, [...identityArgs(dir), 'commit', '-m', message]);
    if (!commit.ok) return { ...done, ok: false, error: commit.err || 'git commit failed' };
    done.committed = true;
  }

  const after = localWork(dir, remote);
  done.commits = after.unpushed;
  // Nowhere to push to is not a failure: the commit is still saved, and the badge says as much.
  if (!after.has_remote) return { ...done, has_remote: false };
  if (after.unpushed === 0) return { ...done, has_remote: true };

  const branch = currentBranch(dir);
  if (!branch) {
    return { ...done, has_remote: true, ok: false, error: 'This repository is not on a branch, so there is nothing to push' };
  }
  done.branch = branch;
  const sent = push(dir, remote, branch);
  if (!sent.ok) return { ...done, has_remote: true, ok: false, error: sent.err || `git push to ${remote} failed` };
  done.pushed = true;
  return { ...done, has_remote: true };
}

module.exports = {
  git, isRepo, currentBranch, branchExists, pickTaskBranch, addWorktree, removeWorktree,
  isDirty, commitAll, mergeBaseIn, conflictedFiles, stillConflicted, abortMerge, fastForward, shortLog,
  headSha, hasRemote, remoteSha, push, localWork, commitAndPush,
};
