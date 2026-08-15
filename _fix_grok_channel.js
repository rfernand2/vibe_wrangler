const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/github/vibe_wrangler/data/vibe_wrangler.db');
const before = db.prepare("SELECT channel, harness, provider, model, COUNT(*) n FROM llm_usage GROUP BY 1,2,3,4").all();
console.log('before', JSON.stringify(before, null, 2));
const r = db.prepare("UPDATE llm_usage SET channel = 'api' WHERE harness = 'grok' AND channel = 'subscription'").run();
console.log('updated', r.changes);
const after = db.prepare("SELECT channel, harness, provider, model, COUNT(*) n FROM llm_usage GROUP BY 1,2,3,4").all();
console.log('after', JSON.stringify(after, null, 2));
db.close();
