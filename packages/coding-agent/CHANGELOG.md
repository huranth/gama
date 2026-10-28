# Changelog

## [Unreleased]

### Added

- `/compact [instructions]` slash command.
- Terminal bell when a run of 20 s or more finishes (`notifyOnTurnEnd`, on by default, toggle with `/bell`).
- `LICENSE` is now shipped in the package.

### Changed

- Exported `Args` has a new required field, `unknownFlagValueArgs`.
- Anthropic streams time out when idle, using `httpIdleTimeoutMs` (default 120 s).
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

## 1.0.1

- Public release.

## 1.0.0

- First public release.
