'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DIR = process.env.VIBE_WRANGLER_ATTACHMENTS || path.join(__dirname, 'data', 'attachments');
const MAX_BYTES = Number(process.env.ATTACHMENT_MAX_BYTES) || 25 * 1024 * 1024;

/** The URL prefix that both the browser and the prompt rewriter recognise. */
const URL_PREFIX = '/attachments/';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

function mimeFor(name) {
  return MIME[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';
}

/**
 * Stored names are `<random>-<sanitised original>`: the random half keeps two files of the same name
 * apart, and the readable half means a path pasted into a prompt still tells the agent what it is.
 */
function storedName(original) {
  const base = path.basename(String(original || 'file')).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
  return `${crypto.randomBytes(6).toString('hex')}-${base || 'file'}`;
}

function save(original, buffer) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = storedName(original);
  fs.writeFileSync(path.join(DIR, file), buffer);
  return { name: path.basename(String(original || file)), url: URL_PREFIX + file, size: buffer.length };
}

/** Resolves a public URL to a file on disk, or null if it points anywhere else. */
function resolve(url) {
  if (!String(url).startsWith(URL_PREFIX)) return null;
  let file;
  try { file = decodeURIComponent(String(url).slice(URL_PREFIX.length)); } catch { return null; }
  const full = path.resolve(DIR, file);
  if (path.dirname(full) !== path.resolve(DIR) || !fs.existsSync(full)) return null;
  return full;
}

/** Matches the markdown reference the browser writes into a description or comment. */
const REF = /(!?)\[([^\]\n]*)\]\((\/attachments\/[^)\s]+)\)/g;

const LOCAL_FILE_TAG = 'local file: ';

/**
 * An agent has no browser and cannot fetch `/attachments/...`, so every reference is swapped for the
 * path of the file on disk. References that no longer resolve are left alone rather than turned into
 * a path that would send the agent looking for a file that is not there.
 */
function toLocalPaths(text) {
  return String(text ?? '').replace(REF, (whole, bang, label, url) => {
    const file = resolve(url);
    return file ? `${label || 'attachment'} (${LOCAL_FILE_TAG}${file})` : whole;
  });
}

module.exports = { DIR, MAX_BYTES, URL_PREFIX, LOCAL_FILE_TAG, mimeFor, save, resolve, toLocalPaths };
