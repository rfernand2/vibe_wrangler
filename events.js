'use strict';

/**
 * Change notifications, fanned out to every open tab over server-sent events.
 *
 * The payload deliberately carries no detail — it only says "something moved" and the browser
 * refetches. That makes a duplicated, reordered or dropped message harmless, which is what lets the
 * whole thing be this small.
 */

const HEARTBEAT_MS = 25000;
const COALESCE_MS = 60;

const clients = new Set();
let rev = 0;
let pending = null;

function subscribe(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Any proxy in front of us must not buffer the stream, or events arrive in useless clumps.
    'X-Accel-Buffering': 'no',
  });
  // Node times idle sockets out by default, which an EventSource reads as the server dying.
  req.socket.setTimeout(0);
  res.write(`retry: 2000\n\ndata: ${JSON.stringify({ rev })}\n\n`);
  clients.add(res);

  const beat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { drop(); }
  }, HEARTBEAT_MS);
  beat.unref?.();

  const drop = () => { clearInterval(beat); clients.delete(res); };
  req.on('close', drop);
  res.on('error', drop);
}

/** Coalesced, so a write batch touching five rows wakes the browser once rather than five times. */
function changed() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    rev++;
    const frame = `data: ${JSON.stringify({ rev })}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
  }, COALESCE_MS);
  pending.unref?.();
}

module.exports = { subscribe, changed };
