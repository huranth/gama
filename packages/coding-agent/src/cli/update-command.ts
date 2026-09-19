import { spawn } from "cross-spawn";
import { valid } from "semver";
import {
	APP_NAME,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	PACKAGE_NAME,
	type SelfUpdateCommand,
	VERSION,
} from "../config.ts";
import type { LatestGamaRelease } from "../utils/version-check.ts";
import { getLatestGamaRelease, isNewerPackageVersion } from "../utils/version-check.ts";

export interface UpdateCommandOptions {
	currentVersion?: string;
	checkOnly?: boolean;
	fetchLatest?: (version: string) => Promise<LatestGamaRelease | undefined>;
	getCommand?: (version: string) => SelfUpdateCommand | undefined;
	run?: (command: string, args: string[]) => Promise<number>;
}

export const UPDATE_USAGE = `Usage: ${APP_NAME} update [--check]

Update ${APP_NAME} to the latest published release.

Options:
  --check   Check the update service without installing
  --help    Show this help`;

function runStep(command: string, args: string[]): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: "inherit" });

		child.on("error", () => resolve(1));
		child.on("close", (code) => resolve(code ?? 1));
	});
}

export async function runUpdateCommand(options: UpdateCommandOptions = {}): Promise<number> {
	const currentVersion = options.currentVersion ?? VERSION;
	const fetchLatest = options.fetchLatest ?? ((version: string) => getLatestGamaRelease(version));
	const getCommand =
		options.getCommand ??
		((version: string) =>
			getSelfUpdateCommand(PACKAGE_NAME, undefined, {
				packageName: PACKAGE_NAME,
				installSpec: `${PACKAGE_NAME}@${version}`,
			}));
	const run = options.run ?? runStep;

	let release: LatestGamaRelease | undefined;
	let reason = "";
	try {
		release = await fetchLatest(currentVersion);
	} catch (error) {
		release = undefined;
		reason = error instanceof Error && error.message ? `: ${error.message}` : "";
	}

	if (!release) {
		console.error(`Could not check for updates${reason}`);
		return 1;
	}

	if (!valid(release.version)) {
		console.error(`Update check returned an invalid version: ${release.version}`);
		return 1;
	}

	if (!isNewerPackageVersion(release.version, currentVersion)) {
		console.log(`${APP_NAME} is up to date (${currentVersion})`);
		return 0;
	}

	if (options.checkOnly) {
		console.log(`Update available: ${currentVersion} -> ${release.version}`);
		return 0;
	}

	const command = getCommand(release.version);
	if (!command) {
		console.error(getSelfUpdateUnavailableInstruction(PACKAGE_NAME));
		return 1;
	}

	console.log(`Updating ${APP_NAME} ${currentVersion} -> ${release.version}`);
	console.log(command.display);

	try {
		for (const step of command.steps ?? [command]) {
			const exitCode = await run(step.command, step.args);
			if (exitCode !== 0) {
				console.error("Update failed");
				return exitCode;
			}
		}
	} catch (error) {
		const message = error instanceof Error && error.message ? `: ${error.message}` : "";
		console.error(`Update failed${message}`);
		return 1;
	}

	console.log(`Updated ${currentVersion} -> ${release.version}. Restart ${APP_NAME}`);
	return 0;
}
