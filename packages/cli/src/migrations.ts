import chalk from "chalk";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "fs";
import { basename, dirname, join } from "path";
import { CONFIG_DIR_NAME, getAgentDir, getBinDir } from "./config.ts";
import { migrateKeybindingsConfig } from "./core/hotkeys.ts";
import { writeFileAtomicSync } from "./utils/atomic-write.ts";
import { stripBom } from "./utils/text.ts";

const EXTENSIONS_DOC_URL =
	"https://github.com/huranth/gama/tree/main/packages/cli/examples/extensions";

const MANAGED_BINARIES = ["fd", "rg", "fd.exe", "rg.exe"];

function migrateExtensionSystem(cwd: string): string[] {
	const agentDir = getAgentDir();
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	migrateCommandsToPrompts(agentDir, "Global");
	migrateCommandsToPrompts(projectDir, "Project");

	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	return warnings;
}

export function runMigrations(cwd: string): {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
} {
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateSessionsFromAgentRoot();
	migrateToolsToBin();
	migrateKeybindingsConfigFile();
	const deprecationWarnings = migrateExtensionSystem(cwd);
	return { migratedAuthProviders, deprecationWarnings };
}

export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log(chalk.dim(`\nPress any key to continue...`));

	await new Promise<void>((resolve) => {
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.setRawMode?.(false);
			process.stdin.pause();
			resolve();
		});
	});
	console.log();
}

function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated: ${label}`));
			return true;
		} catch {
			console.log(chalk.yellow(`Migration failed: ${label}`));
		}
	}
	return false;
}

function migrateKeybindingsConfigFile(): void {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return;

	try {
		const parsed = JSON.parse(stripBom(readFileSync(configPath, "utf-8"))) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		writeFileAtomicSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
	} catch {}
}

function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	if (existsSync(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	if (existsSync(toolsDir)) {
		try {
			const entries = readdirSync(toolsDir);

			const customTools = entries.filter((entry) => {
				const lower = entry.toLowerCase();
				return !MANAGED_BINARIES.includes(lower) && !entry.startsWith(".");
			});

			if (customTools.length > 0) {
				warnings.push(`Custom tools merged: ${label}`);
			}
		} catch {}
	}

	return warnings;
}

function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	let movedAny = false;

	for (const bin of MANAGED_BINARIES) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {}
			} else {
				try {
					rmSync(oldPath, { force: true });
				} catch {}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green("Migrated binaries"));
	}
}

export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			const content = readFileSync(file, "utf8");
			const firstLine = content.split("\n")[0];
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			if (header.type !== "session" || !header.cwd) continue;

			const correctDir = join(agentDir, "sessions");

			if (!existsSync(correctDir)) {
				mkdirSync(correctDir, { recursive: true });
			}

			const fileName = basename(file);
			const newPath = join(correctDir, fileName);

			if (existsSync(newPath)) continue;

			renameSync(file, newPath);
		} catch {}
	}
}

export function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const settingsPath = join(agentDir, "settings.json");

	let auth: Record<string, unknown> = {};
	if (existsSync(authPath)) {
		try {
			const parsed = JSON.parse(stripBom(readFileSync(authPath, "utf-8")));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
			auth = parsed as Record<string, unknown>;
		} catch {
			return [];
		}
	}

	const migrated: Record<string, unknown> = {};
	const providers: string[] = [];
	let settingsWithoutKeys: Record<string, unknown> | undefined;

	if (existsSync(settingsPath)) {
		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(stripBom(content));
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				const remaining: Record<string, unknown> = {};
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					if (typeof key !== "string") {
						remaining[provider] = key;
						continue;
					}
					if (!(provider in auth)) {
						migrated[provider] = { type: "api_key", key };
						providers.push(provider);
					}
				}
				if (
					providers.length > 0 ||
					Object.keys(remaining).length < Object.keys(settings.apiKeys).length
				) {
					if (Object.keys(remaining).length > 0) settings.apiKeys = remaining;
					else delete settings.apiKeys;
					settingsWithoutKeys = settings;
				}
			}
		} catch {}
	}

	if (Object.keys(migrated).length > 0) {
		mkdirSync(dirname(authPath), { recursive: true });
		writeFileAtomicSync(authPath, JSON.stringify({ ...auth, ...migrated }, null, 2), 0o600);
	}

	if (settingsWithoutKeys) {
		try {
			writeFileAtomicSync(settingsPath, JSON.stringify(settingsWithoutKeys, null, 2));
		} catch {}
	}

	return providers;
}
