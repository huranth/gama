#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

function muteWarnings(): void {}

process.title = `${APP_NAME}-rpc`;
process.env.GAMA_CODING_AGENT = "true";
process.env.AI_AGENT = "gama";
process.emitWarning = muteWarnings as typeof process.emitWarning;

configureHttpDispatcher();

void main(["--mode", "rpc", ...process.argv.slice(2)]).catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Error: ${message}`);
	process.exitCode = 1;
});
