'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Runs git with argv (never a shell string), so branch names and paths can't inject. */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
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
  git(dir, ['worktree', 'remove', '--force', wtPath]);
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
  return git(wtPath, ['-c', 'user.name=llm_tasks', '-c', 'user.email=llm_tasks@localhost',
    'commit', '-m', message]);
}

/** Merges base into the task branch inside the worktree, where a conflict is harmless. */
function mergeBaseIn(wtPath, base) {
  const r = git(wtPath, ['-c', 'user.name=llm_tasks', '-c', 'user.email=llm_tasks@localhost',
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

module.exports = {
  git, isRepo, currentBranch, branchExists, pickTaskBranch, addWorktree, removeWorktree,
  isDirty, commitAll, mergeBaseIn, conflictedFiles, stillConflicted, abortMerge, fastForward, shortLog,
};
