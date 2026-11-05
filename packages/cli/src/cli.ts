#!/usr/bin/env node
import { setupCli } from "./start/setup.ts";
import { runUpdateCommand, UPDATE_USAGE } from "./start/update.ts";
import { main } from "./main.ts";

setupCli();

function runUpdate(args: string[]): Promise<number> {
	let wantsHelp = false;
	let checkOnly = false;
	let unknownArg: string | undefined;

	for (const arg of args) {
		if (arg === "--help" || arg === "-h") {
			wantsHelp = true;
		} else if (arg === "--check") {
			checkOnly = true;
		} else {
			unknownArg ??= arg;
		}
	}

	if (wantsHelp) {
		console.log(UPDATE_USAGE);
		return Promise.resolve(0);
	}

	if (unknownArg !== undefined) {
		console.error(`Unknown update option: ${unknownArg}\n`);
		console.error(UPDATE_USAGE);
		return Promise.resolve(1);
	}

	return runUpdateCommand({ checkOnly });
}

async function run(argv: string[]): Promise<void> {
	if (argv[0] === "update") {
		process.exitCode = await runUpdate(argv.slice(1));
		return;
	}

	await main(argv);
}

// Last resort
void run(process.argv.slice(2)).catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Error: ${message}`);
	process.exitCode = 1;
});
