# Changelog

## [Unreleased]

### Changed

- `version:patch`, `version:minor` and `version:major` bump only the CLI now
- other packages keep their versions, and dependency ranges follow them

### Fixed

- the native targets compile again, the clipboard constants and the export macros were missing
- Anthropic keeps the effort you picked when thinking starts mid-conversation
- CJK punctuation keeps the curly quotes
- the bench container checks for `packages/bench`, so it stops rejecting every start
- `/cache` prints the turn counts once each
- a `FAIL` line is found even when it is not the first line of the output
- the ripgrep example runs without a shell, and the trigger watcher closes on shutdown
- bench points its dependency ranges at the workspace versions
- aliased state containers are rejected instead of silently diverging
- a stranded bundle backup is ignored after the swap
- service calls reject arguments that are not strict JSON
- a service facade read no longer creates a member slot
- entry sources stay out of the bundle output directory
- bench validates traversal flags and worker output, and keeps fixtures out of the package
- the examples block `find -delete`, `find -exec` and short `rm -r` flags
- remote ssh paths are quoted, and IPv6 hosts parse correctly
- the examples handle Windows paths, `cmd.exe`, and provider log directories
- game and overlay examples stop their timers, find Doom outside the package, and restart cleanly
- empty questionnaire options, failed issue loads, tiny terminals and aborted subagents no longer misbehave

## [1.0.2] - 2026-11-10

### Added

- `hands`: the model can hand work off to scout, digger, runner, critic or builder, each one gets a card you can open
- `/stats` shows context use, session size, message and tool counts, and token totals
- `/compact [instructions]`
- a bell when a run takes 20 s or more, on by default, `/bell` turns it off
- `LICENSE` ships with the package now

### Changed

- compaction writes a short checkpoint (Goal, Now, Rules, Decisions, Open, Verified)
- the model summary stops at 2000 tokens
- compaction also appends requests, file excerpts, commands and answers, no extra model call
- `Args` has a new required field, `unknownFlagValueArgs`
- Anthropic streams time out after 300 s idle (`httpIdleTimeoutMs`)
- retries cover `ECONNRESET`, `ETIMEDOUT` and premature close
- `RpcClient` doesn't kill long commands after 30 s anymore
- stdin EOF waits up to 30 s for work in flight
- print and RPC modes clean up on SIGINT, then exit 130
- API key input is masked
- undo history stops at 200 entries
- project settings stay ignored until you trust the project

### Fixed

- `edit` refuses non-UTF-8 files, keeps line endings, and keeps unmatched text on fuzzy edits
- `edit` needs a read before a write
- a second compaction keeps the first summary
- nothing compacts when the context window is unknown
- control characters are stripped from model text and pasted input
- `grep` and `find` skip `.git`
- `grep` keeps its matches when some paths can't be read
- `--session-id` refuses an id another session uses
- session write failures are reported instead of dropped
- auth, trust and models files are written atomically
- Gemini parallel tool results stay in one turn
- RPC `session_start` fires once
- `exec` reports signal-killed children as failures (128 + signal)
- bundled builds include the native prebuilds again

## [1.0.1] - 2026-10-28

### Added

- `/changelog`, so you can see what changed

## [1.0.0] - 2026-10-28

- first public release
