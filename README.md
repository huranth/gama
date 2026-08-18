# gama

A coding agent for the terminal. It reads files, runs commands, edits code and keeps
sessions that can be resumed later.

## Install

```sh
npm install -g @huranth/gama-harness
gama
```

Node 22.19 or newer.

## Packages

| Package | Path | Contents |
| --- | --- | --- |
| `@huranth/gama-harness` | `packages/coding-agent` | The CLI: tools, sessions, providers, terminal UI |
| `@huranth/gama-agent-core` | `packages/agent` | Agent loop, tool execution and state |
| `@huranth/gama-ai` | `packages/ai` | Streaming API over model providers |
| `@huranth/gama-tui` | `packages/tui` | Cells, layout, input and rendering |
| `@huranth/gama-codemode` | `packages/codemode` | QuickJS sandbox for scripted tool calls |
| `@huranth/gama-durable` | `packages/durable` | Durable conversations, tasks and documents |
| `@huranth/chord` | `packages/chord` | Service and state runtime |
| `@huranth/gama-telemetry` | `packages/telemetry` | Telemetry contracts and test recorders |
| `@huranth/gama-evals` | `packages/evals` | Evals and documentation checks |

Only `@huranth/gama-harness` is published to npm. The other packages are internal and are
bundled into the CLI at build time.

## Development

```sh
npm install
npm run build
npm run check
npm test
```

`npm run check` formats, lints and type-checks the repository. `npm test` runs the unit
tests, the script tests and the update service tests.

## License

MIT
