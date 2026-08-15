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

/**
 * The badge is also the button that clears it. It only ever offers the one action — commit
 * everything and push — so the label states what is outstanding and the title says what pressing
 * it will do. Nothing outstanding, or a folder git knows nothing about, leaves it disabled rather
 * than hidden, so the board does not shuffle its buttons around between repaints.
 */
function pushButtonState(project, { busy = false } = {}) {
  if (busy) return { disabled: true, text: 'Pushing…', title: 'A push is already running' };
  if (project?.is_repo === false) {
    return { disabled: true, text: 'Push', title: 'This project folder is not a git repository' };
  }
  if (!shouldShowPushBadge(project)) {
    return { disabled: true, text: 'Push', title: 'Nothing to commit or push' };
  }
  return {
    disabled: false,
    text: 'Push needed',
    title: `${pushBadgeTitle(project)} — commit and push everything now`,
  };
}

/** Says what the push actually did, since either half of it may have had nothing to do. */
function pushResultMessage(result) {
  const parts = [];
  if (result?.committed) parts.push(`committed ${plural(result.files, 'change')}`);
  if (result?.pushed) parts.push(`pushed ${plural(result.commits, 'commit')} to ${result.remote || 'origin'}`);
  // A commit that could not go anywhere is still a success, but the board must not imply it shipped.
  if (result?.committed && !result?.pushed && result?.has_remote === false) parts.push('no remote to push to');
  if (!parts.length) return 'Nothing to commit or push';
  return parts.join(', ').replace(/^./, (c) => c.toUpperCase());
}

if (typeof module !== 'undefined') {
  module.exports = {
    uncommittedChanges,
    unpushedCommits,
    shouldShowPushBadge,
    pushBadgeTitle,
    pushButtonState,
    pushResultMessage,
  };
}
