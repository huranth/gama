# SSRF protection

`packages/cli/src/core/tools/web/security/ssrf.ts` blocks private and reserved addresses.

- `assertUrlAllowed` checks every redirect hop.
- `validatingLookup` pins the checked address to the socket.
- `pinnedFetch` uses that lookup and no pooled agent.
- `compileAllowlist` supports exact, `*`, `**` and `?` patterns.
- IPv4, IPv6, mapped and reserved ranges are refused by default.

The fetch tool calls `assertUrlAllowed` before each request. The browser path
also checks every request URL before Chrome continues it.
