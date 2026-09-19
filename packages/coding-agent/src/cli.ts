#!/usr/bin/env node
import { setupCli } from "./cli/setup.ts";
import { runUpdateCommand, UPDATE_USAGE } from "./cli/update-command.ts";
import { main } from "./main.ts";

setupCli();

async function runUpdate(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(UPDATE_USAGE);
		return 0;
	}

	const unknown = args.filter((arg) => arg !== "--check");
	if (unknown.length > 0) {
		console.error(`Unknown update option: ${unknown[0]}\n`);
		console.error(UPDATE_USAGE);
		return 1;
	}

	return runUpdateCommand({ checkOnly: args.includes("--check") });
}

async function run(argv: string[]): Promise<void> {
	if (argv[0] === "update") {
		process.exitCode = await runUpdate(argv.slice(1));
		return;
	}

	await main(argv);
}

// Terminal catch
void run(process.argv.slice(2)).catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Error: ${message}`);
	process.exitCode = 1;
});
