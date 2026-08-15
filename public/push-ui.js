'use strict';

/**
 * "Push needed" covers both halves of work that only exists on this machine: edits that were never
 * committed, and commits that never reached GitHub. A folder that is not a git repo — or a repo
 * with no remote and a clean tree — has neither, so it stays quiet.
 */
function uncommittedChanges(project) {
  return Math.max(0, Number(project?.uncommitted_changes) || 0);
}

function unpushedCommits(project) {
  return Math.max(0, Number(project?.unpushed_commits) || 0);
}

function shouldShowPushBadge(project) {
  return Boolean(project?.needs_push)
    || uncommittedChanges(project) > 0
    || unpushedCommits(project) > 0;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Says which half is outstanding, since committing and pushing are different next steps. */
function pushBadgeTitle(project) {
  const parts = [];
  const files = uncommittedChanges(project);
  const commits = unpushedCommits(project);
  if (files) parts.push(`${plural(files, 'file')} not committed`);
  if (commits) parts.push(`${plural(commits, 'commit')} not pushed to GitHub`);
  return parts.length ? `Push needed — ${parts.join(', ')}` : 'Push needed';
}

if (typeof module !== 'undefined') {
  module.exports = { uncommittedChanges, unpushedCommits, shouldShowPushBadge, pushBadgeTitle };
}
