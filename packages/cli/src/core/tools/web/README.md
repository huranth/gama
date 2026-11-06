# web

Helpers behind the `fetch` tool.

- `fetch.ts` - page fetch, challenge rejection, browser fallback.
- `read-url.ts` - shared types, transport, body cap, decode and errors.
- `security/ssrf.ts` - private and reserved address checks.
- `pinned-fetch.ts` - DNS-pinned transport.
- `extract/` - HTML, JSON, markdown and text extraction.
- `browser.ts` - local Chrome fallback.

Tests: `test/web-fetch.test.ts`, `test/web-extract.test.ts`,
`test/web-ssrf.test.ts`, `test/web-tools.test.ts`.

Limits: a response over 2 MB is rejected. `find` shows the first 20 matching
lines and reports the total. `max_chars` must be between 1000 and 50000.
