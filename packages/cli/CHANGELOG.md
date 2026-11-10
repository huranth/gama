# Changelog

## [Unreleased]

### Changed

- Release notes for 1.0.2 now cover the `hands` tool, `/stats`, `/compact` and the terminal bell, and the 1.0.1 notes now cover `/changelog`.
- `version:patch`, `version:minor` and `version:major` now bump only the published CLI; the other workspace packages keep their versions, and inter-package dependency ranges follow those versions.

### Fixed

- The bench package dependency ranges now point at the workspace versions.

## [1.0.2] - 2026-11-10

### Added

- The `hands` tool. The model can delegate work to scout, digger, runner, critic and builder hands, and the terminal shows a card for each one that you can open.
- `/stats` slash command to show context usage, session size, message and tool-call counts, and token totals.
- `/compact [instructions]` slash command.
- Terminal bell when a run of 20 s or more finishes (`notifyOnTurnEnd`, on by default, toggle with `/bell`).
- `LICENSE` is now shipped in the package.

### Changed

- Compaction writes a terse handoff checkpoint (Goal, Now, Rules, Decisions, Open, Verified), caps the model summary at 2000 tokens, and appends session requests, file excerpts, commands and answers without a model call.
- Exported `Args` has a new required field, `unknownFlagValueArgs`.
- Anthropic streams time out when idle, using `httpIdleTimeoutMs` (default 300 s).
- Retries now cover `ECONNRESET`, `ETIMEDOUT` and premature close errors.
- `RpcClient` no longer applies a fixed 30 s timeout to long commands; stdin EOF waits up to 30 s for in-flight work.
- Print and RPC modes handle SIGINT with cleanup, then exit 130.
- API key input is masked.
- Undo history is capped at 200 entries.
- Project settings are ignored until the project is trusted.

### Fixed

- `edit` refuses non-UTF-8 files, keeps line endings, and keeps unmatched text on fuzzy edits.
- `edit` enforces read-before-edit.
- A second compaction keeps the earlier summary.
- No compaction runs when the context window is unknown.
- Control characters are stripped from model text and pasted input.
- `grep` and `find` skip `.git`; `grep` keeps its matches when some paths are unreadable.
- `--session-id` refuses an id already used by another session.
- Session write failures are reported instead of silently dropped.
- Auth, trust and models files are written atomically.
- Gemini parallel tool results stay in one turn.
- RPC `session_start` fires once.
- `exec` reports signal-killed children as failures (128 + signal number).
- Bundled builds include the native prebuilds again.

## [1.0.1] - 2026-10-28

### Added

- `/changelog` slash command to show the release notes.

## [1.0.0] - 2026-10-28

- First public release.
