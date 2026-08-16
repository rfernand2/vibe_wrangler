'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Files a human asked to read — a named document, or a report the agent was told to write.
 * Ordinary code edits are left out even when the brief happens to mention a `.js` path.
 */
const DOC_EXT = new Set(['.md', '.html', '.htm', '.pdf', '.csv', '.rst', '.adoc']);
const TXT_DOC_NAME = /^(readme|changelog|license|report|review|notes?|write-?up|summary|doc)(?:[-_.].*)?$/i;
const REPORT_DIR = /(^|\/)(reviews|docs|reports|notes)\//;
const REPORT_NAME = /\b(report|review|write-?up|notes?|readme|summary)\b/i;

/** A path token: `docs/guide.md`, `README.md`, or a Windows-style `docs\guide.md`. */
const PATH_TOKEN = /(?<![A-Za-z0-9.])((?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]+|[\w.-]+\.(?:md|html|htm|pdf|csv|rst|adoc|txt))\b/g;

function normalize(rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function extOf(rel) {
  return path.posix.extname(normalize(rel)).toLowerCase();
}

function baseOf(rel) {
  return path.posix.basename(normalize(rel), extOf(rel));
}

function isDocument(rel) {
  const file = normalize(rel);
  if (!file || file.includes('..')) return false;
  const ext = extOf(file);
  if (DOC_EXT.has(ext)) return true;
  if (ext === '.txt') {
    return file.includes('/') || TXT_DOC_NAME.test(baseOf(file));
  }
  return false;
}

function isReportLike(rel) {
  const file = normalize(rel).toLowerCase();
  return REPORT_DIR.test(file) || REPORT_NAME.test(baseOf(file));
}

/**
 * The brief is asking for a written deliverable, not a code change that happens to say "report"
 * in passing (a bug report, a code review).
 */
function wantsDocument(brief) {
  const text = String(brief || '');
  if (/\b(write|create|draft|prepare|produce|update)\b[^.\n]{0,60}\b(report|write-?ups?|reviews?)\b/i.test(text)) {
    return true;
  }
  if (/\b(report|write-?up)\b[^.\n]{0,40}\b(in|at|to|file|document|here)\b/i.test(text)) return true;
  const title = text.split(/\n/)[0];
  return /\b(report|write-?up|review)\b/i.test(title) && !/\bcode review\b/i.test(title);
}

function mentionedFiles(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(PATH_TOKEN)) {
    const file = normalize(m[1]);
    if (!isDocument(file) || seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}

function existsIn(projectDir, rel) {
  if (!projectDir) return false;
  const full = resolve(projectDir, rel);
  return Boolean(full);
}

/**
 * A path is only served when it stays inside the project folder and is a document.
 * Absolute paths, `..`, and code files are rejected the same way.
 */
function resolve(projectDir, rel) {
  if (!projectDir || !rel) return null;
  let decoded = String(rel);
  try { decoded = decodeURIComponent(decoded); } catch { /* keep the raw string */ }
  const file = normalize(decoded);
  if (!file || path.isAbsolute(file) || !isDocument(file)) return null;
  const root = path.resolve(projectDir);
  const full = path.resolve(root, file);
  const relToRoot = path.relative(root, full);
  if (!relToRoot || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return null;
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  } catch { return null; }
  return full;
}

function unique(files) {
  const seen = new Set();
  const out = [];
  for (const f of files) {
    const file = normalize(f);
    if (!file || seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}

/**
 * Named documents that exist on disk, plus — when the brief asked for a report — document
 * files the agent actually wrote. Code files never make the list.
 */
function selectDocuments({ brief, changedFiles = [], projectDir }) {
  const mentioned = mentionedFiles(brief).filter((f) => existsIn(projectDir, f));
  const implicit = [];
  if (wantsDocument(brief)) {
    const changed = changedFiles.map(normalize).filter((f) => isDocument(f) && existsIn(projectDir, f));
    implicit.push(...changed.filter(isReportLike));
    if (!implicit.length) implicit.push(...changed);
  }
  return unique([...mentioned, ...implicit]);
}

function fileUrl(projectId, rel) {
  return `/api/projects/${Number(projectId)}/files?path=${encodeURIComponent(normalize(rel))}`;
}

function commentBody(projectId, files) {
  const links = files.map((f) => {
    const label = normalize(f).replace(/[[\]()]/g, '_');
    return `[${label}](${fileUrl(projectId, f)})`;
  });
  if (links.length === 1) return `You can view the file here: ${links[0]}`;
  return `You can view these files here:\n${links.join('\n')}`;
}

/** The one shape the board turns into a clickable document link. */
const FILE_REF = /(!?)\[([^\]\n]*)\]\((\/api\/projects\/\d+\/files\?path=[^)\s]+)\)/g;

module.exports = {
  DOC_EXT, FILE_REF,
  isDocument, isReportLike, wantsDocument, mentionedFiles,
  resolve, selectDocuments, fileUrl, commentBody,
};
