'use strict';

// Minimal in-memory sliding-window limiter for the two credential-entry endpoints
// (/login, /admin/login). No new dependency, no Redis — this app runs as one process
// on the free tier, so per-process memory is the right scope. Purely a brute-force
// speed bump: it does not replace bcrypt, it just stops unlimited guessing.
//
// Keyed by IP (trust proxy is already set in production — see server.js — so req.ip
// reflects the real client behind Render/a tunnel, not the proxy hop).
function makeLimiter({ windowMs, max }) {
  const hits = new Map(); // ip -> [timestamps]

  // Sweep old entries occasionally so the map can't grow unbounded across the
  // process lifetime from one-off/scanning IPs that never come back.
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, times] of hits) {
      const kept = times.filter(t => t > cutoff);
      if (kept.length) hits.set(ip, kept); else hits.delete(ip);
    }
  }, windowMs).unref();

  return function rateLimit(req, res, next) {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const cutoff = now - windowMs;
    const times = (hits.get(ip) || []).filter(t => t > cutoff);

    if (times.length >= max) {
      return res.status(429).send('Too many attempts. Please wait a few minutes and try again.');
    }
    times.push(now);
    hits.set(ip, times);
    next();
  };
}

module.exports = { makeLimiter };
