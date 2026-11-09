# Content extraction

`packages/cli/src/core/tools/web/extract/` turns a response body into readable text.

- `readability.ts` picks the main HTML block and converts it to markdown.
- `boilerplate.ts` strips scripts, navigation and page chrome.
- `entities.ts` decodes HTML entities.
- `frontmatter.ts` reads markdown titles.
- `text.ts` normalizes and truncates text.

HTML goes through `removeBoilerplate`, then candidate scoring, then markdown
rendering. JSON is pretty-printed. Markdown keeps its frontmatter fields. XML
and plain text are normalized.

`extractReadableHtml(html, maxChars)` returns the title, description, text and
a truncated flag. Empty text throws `No readable text found at URL`.
