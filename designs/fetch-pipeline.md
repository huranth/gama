# Fetch pipeline

`fetchPage` in `packages/cli/src/core/tools/web/get.ts` is the single entry point.

1. Validate the URL and block private addresses.
2. Fetch with redirects and a 2 MB body cap.
3. Reject challenge pages and unsupported types.
4. Extract readable text and truncate to `maxChars`.
5. Fall back to local Chrome when the static read is blocked or empty.

`FetchPageInput` accepts `url`, `maxChars`, `signal`, `timeoutMs`, `fetchImpl`,
`dnsResolve`, `maxRedirects`, `maxBytes`, `lookupHost`, `isBlocked`, `fullText`
and `browserFallback`. `FetchPageResult` adds `fetchedAt`, `totalChars` and an
optional note.

Browser requests are checked one by one through CDP. A private subresource is
failed before it connects. Full text is capped by the same 2 MB body limit.
