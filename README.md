# gama

a coding agent for your terminal, it reads the repo, runs commands, edits files, and keeps the session around so you can pick it up tomorrow

no browser tab, no IDE plugin, no copy-pasting files into a chat window, just gama, a prompt, and a model that can actually touch the code

## Install

```sh
npm install -g @huranth/gama-harness
gama
```

node 22.19 or newer, you'll need a provider and a key, Anthropic, OpenAI, Gemini, Mistral, Bedrock, Azure and anything OpenAI-compatible will work

keys live in `~/.gama/agent`, `/provider` is where you change them later

## What it does

- reads, greps, finds, lists and outlines files
- runs bash or powershell
- edits and writes files, with a read before edits
- keeps sessions, so `gama -c` continues the last one
- one-shot runs with `gama -p`, or RPC for editors and scripts
- hands: delegate work to scout, digger, runner, critic and builder
- loads extensions, skills, prompt templates and themes

`gama --help` lists the flags, the TUI has the slash commands

## Handy commands

```text
/model      switch models mid-session
/compact    squeeze a long conversation
/stats      context, session and token numbers
/changelog  what changed
/history    sessions from this folder
```

project `.gama` files stay ignored until you trust the folder, context files like `AGENTS.md` and `CLAUDE.md` load either way

## Development

```sh
git clone https://github.com/huranth/gama.git
cd gama
npm install
npm run build
npm test
```

`npm run check` runs biome, the dependency and import checks, tsc and a browser smoke test

`npm run build:public-release` builds the npm package

## License

MIT, do what you want with it
