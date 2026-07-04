# Security fixes (2026-07-04)

A full-codebase security review found and fixed the issues below. All were verified
against the running app (not just read) — booted the server, hit real endpoints,
round-tripped an actual XSS payload through login → page render to confirm it's now
inert, and confirmed the rate limiter returns 429 under a live flood test.

## Fixed

### 1. Stored XSS via `<script>` tag breakout
**Where:** `views/chat.ejs`, `views/onboarding.ejs`

Owner-controlled fields — pet name, saved vet name/clinic — were embedded into inline
`<script>` blocks with plain `JSON.stringify()`. That never escapes a literal
`</script>` sequence, and a browser's HTML tokenizer closes the script tag on that
sequence regardless of JS string quoting. A pet or vet name containing
`</script><script>alert(1)</script>` would execute arbitrary JS on page load.

**Fix:** added `app.locals.safeJson()` in `server.js` — escapes `<`, `>`, `&`, and the
two JS line-terminator characters (U+2028/U+2029) before JSON-encoding. Used everywhere
a value is embedded into a `<script>` block.

### 2. Sanitizer fail-open
**Where:** `public/chat-client.js`

`renderMarkdown()` fell back to **raw, unsanitized** HTML if the DOMPurify CDN script
failed to load (network hiccup, ad-blocker, CDN outage) — silently disabling all XSS
protection for every chat message, including web-search content.

**Fix:** now fails **closed** — if DOMPurify (or marked) isn't available, the text is
HTML-escaped instead of rendered as markup.

### 3. No integrity check on CDN scripts
**Where:** `views/chat.ejs`

`marked.js` and `DOMPurify` were loaded from jsdelivr with no Subresource Integrity
hash — a compromised or MITM'd CDN response could substitute arbitrary JavaScript
that runs in every logged-in session.

**Fix:** added `integrity` + `crossorigin` attributes with real SHA-384 hashes fetched
directly from the CDN. The browser now refuses to run either script if the response
doesn't match.

### 4. No rate limiting on login endpoints
**Where:** `routes/auth.js`, `routes/admin.js`

Neither `/login` (owner access codes) nor `/admin/login` (the single password gating
**every** tester's conversation history) had any limit on attempts. bcrypt slows each
guess, but an automated client could still run unlimited attempts.

**Fix:** added a small dependency-free sliding-window limiter
(`middleware/rateLimit.js`) — 10 attempts/10 min for owner login, 8/10 min for admin.

### 5. Account enumeration + timing leak on login
**Where:** `routes/auth.js`

"Email not recognised" and "Incorrect access code" were distinct messages, and the
not-found path skipped `bcrypt.compare` entirely — both the message and the faster
response time let an attacker enumerate which emails belong to registered testers.

**Fix:** unified the error message, and the not-found path now runs `bcrypt.compare`
against a dummy hash so both paths look identical in content and timing.

### 6. Timing-unsafe admin secret comparison
**Where:** `routes/admin.js`

`ADMIN_SECRET` was compared with plain `===`, which short-circuits on the first
mismatched byte — a textbook timing side-channel against a single high-value shared
secret.

**Fix:** switched to `crypto.timingSafeEqual`.

### 7. Missing baseline security headers
**Where:** `server.js`

No `X-Content-Type-Options`, `X-Frame-Options`, or `Referrer-Policy` anywhere.

**Fix:** added all three app-wide (no new dependency) — stops MIME-sniffing, blocks
framing the login/admin pages (clickjacking), and stops the full URL leaking to
third-party links.

### 8. Dead code causing a client-side crash
**Where:** `views/onboarding.ejs`

Leftover from an earlier reskin: an inline script still called
`document.getElementById('theme-toggle').addEventListener(...)`, but the theme-toggle
button had been removed from the page in that same reskin — throwing an uncaught
`TypeError` on every onboarding page load.

**Fix:** removed the dead block.

## Flagged, not fixed

**`npm audit`** shows known CVEs in `xlsx` (prototype pollution + ReDoS, no fix
available upstream) and the `protobufjs` chain pulled in transitively by
`@xenova/transformers`. Verified **not exploitable** in this codebase: `xlsx` is only
ever used to *write* (`XLSX.utils.aoa_to_sheet` + `writeFile`), never to parse
untrusted input — there's no `XLSX.read`/`readFile` call anywhere — and the embeddings
model files aren't attacker-supplied. Left as-is since there's no reachable exploit
path today and no safe replacement exists yet.

## Checked and already clean

- **SQL injection** — every query across `routes/` and `lib/` is parameterized; no
  string-built SQL anywhere in the codebase.
- **SSRF** — Google Places and Tavily calls use fixed URLs; no user-controlled fetch
  targets.
- **Path traversal** — the Excel export path is fixed; no user input reaches a
  filesystem path.
- **Secrets** — nothing hardcoded, `.env` never committed, no committed API keys.
- **Command injection** — `execSync`/`spawnSync` only appear in local dev/build
  scripts (git hooks, PDF ingestion tooling); no user input reaches them.
- **CSRF** — mitigated by `sameSite: strict` session cookies and no state-changing
  `GET` routes.
- **Auth/ownership scoping** — every chat/vet/decision route re-derives the pet from
  the session and checks ownership before touching a row; one tester can't read or
  modify another's data.
