'use strict';

/**
 * Submit a comment on an unmodified Return. Shift-Return is deliberately left to the textarea so
 * the browser inserts a newline at the cursor. Composition confirmation must also stay in the
 * textarea; otherwise choosing an IME candidate could accidentally post a half-written comment.
 */
function handleCommentKeydown(event, form) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return false;
  event.preventDefault();
  form.requestSubmit();
  return true;
}

if (typeof module !== 'undefined') module.exports = { handleCommentKeydown };
