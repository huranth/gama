import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBinDir } from "../src/config.ts";
import { getShellConfig, getShellEnv } from "../src/utils/shell.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "gama-shell-config-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("Windows shell discovery", () => {
	it.runIf(process.platform === "win32")(
		"finds a per-user Git for Windows install under LOCALAPPDATA",
		() => {
			const programFiles = makeTempDir();
			const programFilesX86 = makeTempDir();
			const localAppData = makeTempDir();
			const bashPath = join(localAppData, "Programs", "Git", "bin", "bash.exe");
			mkdirSync(join(localAppData, "Programs", "Git", "bin"), { recursive: true });
			writeFileSync(bashPath, "");

			const previous = {
				ProgramFiles: process.env.ProgramFiles,
				"ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
				LOCALAPPDATA: process.env.LOCALAPPDATA,
			};
			try {
				process.env.ProgramFiles = programFiles;
				process.env["ProgramFiles(x86)"] = programFilesX86;
				process.env.LOCALAPPDATA = localAppData;

				expect(getShellConfig()).toEqual({ shell: bashPath, args: ["-c"] });
			} finally {
				for (const [key, value] of Object.entries(previous)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}
		},
	);

	it.runIf(process.platform === "win32")(
		"does not duplicate the bin directory when PATH casing differs",
		() => {
			const previousPath = process.env.PATH;
			const binDir = getBinDir();
			try {
				process.env.PATH = `${binDir.toUpperCase()}${delimiter}C:\\Other`;
				const env = getShellEnv();
				const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
				const entries = (env[pathKey!] ?? "").split(delimiter).filter(Boolean);
				const occurrences = entries.filter(
					(entry) => entry.toLowerCase() === binDir.toLowerCase(),
				);
				expect(occurrences).toHaveLength(1);
			} finally {
				if (previousPath === undefined) delete process.env.PATH;
				else process.env.PATH = previousPath;
			}
		},
	);
});
