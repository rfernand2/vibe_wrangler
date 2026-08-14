'use strict';

/**
 * Deploy chrome is only meaningful when the project folder has a fly.toml. Without one there
 * is nothing to ship, so the badge stays hidden and the button stays disabled.
 */
function canDeploy(project) {
  return Boolean(project?.can_deploy);
}

function pendingPushes(project) {
  return Math.max(0, Number(project?.pending_pushes) || 0);
}

function deployIsDue(project) {
  return pendingPushes(project) > 0
    || Boolean(project?.needs_deploy)
    || Boolean(project?.deployment_needed);
}

function shouldShowDeployBadge(project) {
  return canDeploy(project) && pendingPushes(project) > 0;
}

function deployButtonState(project, { busy = false } = {}) {
  const allowed = canDeploy(project);
  const pushes = pendingPushes(project);
  if (!allowed) {
    return {
      disabled: true,
      text: `Deploy: ${pushes} pushes`,
      title: 'This project has no fly.toml to deploy',
    };
  }
  if (busy) {
    return {
      disabled: true,
      text: 'Deploying…',
      title: 'A deploy is already running',
    };
  }
  return {
    disabled: false,
    text: `Deploy: ${pushes} pushes`,
    title: deployIsDue(project)
      ? 'A change is waiting to be deployed'
      : 'Deploy this project',
  };
}

/** Close the progress popup once fly is done; leave it open on failure so the log is still readable. */
function shouldCloseDeployDialog(status) {
  return status === 'ok';
}

if (typeof module !== 'undefined') {
  module.exports = {
    canDeploy,
    pendingPushes,
    deployIsDue,
    shouldShowDeployBadge,
    deployButtonState,
    shouldCloseDeployDialog,
  };
}
