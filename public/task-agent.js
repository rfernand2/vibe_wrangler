'use strict';

/**
 * The board names the agent that produced a finished run, but a ready task names the agent that
 * would run next. Keeping that choice independent of the DOM makes the subtle retry case testable.
 */
function taskAgentId(task, defaultHarness) {
  if (task.last_harness && ['active', 'completed', 'failed'].includes(task.status)) {
    return task.last_harness;
  }
  return task.harness || defaultHarness;
}

if (typeof module !== 'undefined') module.exports = { taskAgentId };

