const fs = require('fs');
const p = 'C:/github/vibe_wrangler/public/usage-report.js';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/if \(n == null \|\| !Number\.isFinite\(Number\(n\)\)\) return '[^']+';/,
  "if (n == null || !Number.isFinite(Number(n))) return '-';");
fs.writeFileSync(p, s);
console.log('fixed formatUsd');
