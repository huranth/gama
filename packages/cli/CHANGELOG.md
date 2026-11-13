# Changelog

## [1.0.3] - 2026-11-13

### Added

- `hands`, the default workers: the model starts scout, digger, runner, critic or builder on its own for anything past a quick lookup, each hand gets a card you can open, and it works alone only for a one-step job or when you say no hands
- `hands` shipped in `1.0.2` and that changelog skipped it, so this is its intro

### Changed

- hand cards show `3 of 4 collected` instead of dots
- `version:patch`, `version:minor` and `version:major` bump only the CLI now
- other packages keep their versions, and their dependency ranges follow

### Fixed

- the native builds compile again, the clipboard constants and the export macros were missing
- Anthropic keeps the effort you picked when thinking starts mid-conversation
- CJK punctuation keeps its curly quotes
- the bench container looks in `packages/bench` now, so it stops rejecting every start
- `/cache` prints each turn count once
- a `FAIL` line is found even when it is not the first line of the output
- the ripgrep example runs without a shell, and the trigger watcher closes when gama shuts down
- bench uses the workspace versions for its dependencies
- a state container that is aliased is rejected instead of quietly diverging
- a leftover bundle backup is ignored after the swap
- service calls reject arguments that are not strict JSON
- a property read on a service no longer creates a member slot
- the entry sources stay out of the bundle output directory
- bench checks traversal flags and worker output, and keeps its fixtures out of the package
- the examples block `find -delete`, `find -exec` and short `rm -r` flags
- remote ssh paths are quoted, and IPv6 hosts parse correctly
- the examples handle Windows paths, `cmd.exe` and provider log directories
- the game and overlay examples stop their timers, find Doom outside the package, and restart cleanly
- an empty questionnaire, a failed issue load, a tiny terminal and an aborted subagent no longer misbehave
- a failed subagent says it failed instead of showing a blank status
- a folder next to your home no longer shows as `~2` in the session list
- two gama processes can install the same tool without one of them failing

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
