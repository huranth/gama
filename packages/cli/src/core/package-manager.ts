import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { spawnProcess, spawnProcessSync } from "../utils/child-process.ts";
import { resolvePath } from "../utils/paths.ts";
import { isStdoutTakenOver } from "./output-guard.ts";
import * as install from "./pkg/install.ts";
import * as sources from "./pkg/source.ts";
import type {
	CaptureOptions,
	ConfiguredPackage,
	MissingSourceAction,
	NpmRootCache,
	PackageContext,
	PackageManager,
	PackageManagerOptions,
	PackageUpdate,
	ProgressCallback,
	ProgressEvent,
	ResolvedPaths,
} from "./pkg/types.ts";
import { getEnv, getExtensionTempFolder } from "./resource-scan.ts";
import type { SettingsStore } from "./settings.ts";

export { getExtensionTempFolder };

export type {
	ConfiguredPackage,
	MissingSourceAction,
	PackageManager,
	PackageUpdate,
	PathMetadata,
	ProgressCallback,
	ProgressEvent,
	ResolvedPaths,
	ResolvedResource,
} from "./pkg/types.ts";

export class DefaultPackageManager implements PackageManager {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsStore;
	private builtinExtensions: string[];
	private npmRoot: NpmRootCache = {};
	private progressCallback: ProgressCallback | undefined;

	constructor(options: PackageManagerOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager;
		this.builtinExtensions = options.builtinExtensions ?? [];
	}

	setProgressCallback(callback: ProgressCallback | undefined): void {
		this.progressCallback = callback;
	}

	addSourceToSettings(source: string, options?: { local?: boolean }): boolean {
		return sources.addSourceToSettings(this.context(), source, options);
	}

	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean {
		return sources.removeSourceFromSettings(this.context(), source, options);
	}

	getInstalledPath(source: string, scope: "user" | "project"): string | undefined {
		return sources.getInstalledPath(this.context(), source, scope);
	}

	listConfiguredPackages(): ConfiguredPackage[] {
		return sources.listConfiguredPackages(this.context());
	}

	resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths> {
		return sources.resolvePaths(this.context(), onMissing);
	}

	resolveExtensionSources(
		sourceList: string[],
		options?: { local?: boolean; temporary?: boolean },
	): Promise<ResolvedPaths> {
		return sources.resolveExtensionSources(this.context(), sourceList, options);
	}

	install(source: string, options?: { local?: boolean }): Promise<void> {
		return install.install(this.context(), source, options);
	}

	installAndPersist(source: string, options?: { local?: boolean }): Promise<void> {
		return install.installAndPersist(this.context(), source, options);
	}

	remove(source: string, options?: { local?: boolean }): Promise<void> {
		return install.remove(this.context(), source, options);
	}

	removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean> {
		return install.removeAndPersist(this.context(), source, options);
	}

	update(source?: string): Promise<void> {
		return install.update(this.context(), source);
	}

	checkForAvailableUpdates(): Promise<PackageUpdate[]> {
		return install.checkForAvailableUpdates(this.context());
	}

	private context(): PackageContext {
		return {
			cwd: this.cwd,
			agentDir: this.agentDir,
			settings: this.settingsManager,
			builtinExtensions: this.builtinExtensions,
			npmRoot: this.npmRoot,
			emit: (event) => this.emitProgress(event),
			withProgress: (action, source, message, operation) =>
				this.withProgress(action, source, message, operation),
			runCommand: (command, args, options) => this.runCommand(command, args, options),
			runCommandCapture: (command, args, options) =>
				this.runCommandCapture(command, args, options),
			runCommandSync: (command, args) => this.runCommandSync(command, args),
		};
	}

	private emitProgress(event: ProgressEvent): void {
		this.progressCallback?.(event);
	}

	private async withProgress(
		action: ProgressEvent["action"],
		source: string,
		message: string,
		operation: () => Promise<void>,
	): Promise<void> {
		this.emitProgress({ type: "start", action, source, message });
		try {
			await operation();
			this.emitProgress({ type: "complete", action, source });
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.emitProgress({ type: "error", action, source, message: errorMessage });
			throw error;
		}
	}

	private spawnCommand(
		command: string,
		args: string[],
		options?: { cwd?: string },
	): ChildProcess {
		const env = getEnv();
		return spawnProcess(command, args, {
			cwd: options?.cwd,
			stdio: isStdoutTakenOver() ? ["ignore", 2, 2] : "inherit",
			env,
		});
	}

	private spawnCaptureCommand(
		command: string,
		args: string[],
		options?: { cwd?: string; env?: Record<string, string> },
	): ChildProcessByStdio<null, Readable, Readable> {
		const baseEnv = getEnv();
		const env = options?.env ? { ...baseEnv, ...options.env } : baseEnv;
		return spawnProcess(command, args, {
			cwd: options?.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});
	}

	private runCommandCapture(
		command: string,
		args: string[],
		options?: CaptureOptions,
	): Promise<string> {
		return new Promise((resolvePromise, reject) => {
			const child = this.spawnCaptureCommand(command, args, options);
			let stdout = "";
			let timedOut = false;
			const timeout =
				typeof options?.timeoutMs === "number"
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, options.timeoutMs)
					: undefined;

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			child.once("error", (error) => {
				if (timeout) clearTimeout(timeout);
				reject(error);
			});
			child.once("close", (code, signal) => {
				if (timeout) clearTimeout(timeout);
				if (timedOut) {
					reject(new Error(`Command timed out: ${command}`));
					return;
				}
				if (code === 0) {
					resolvePromise(stdout.trim());
					return;
				}
				const exitStatus = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
				reject(new Error(`Command failed: ${command} (${exitStatus})`));
			});
		});
	}

	private runCommand(
		command: string,
		args: string[],
		options?: { cwd?: string },
	): Promise<void> {
		return new Promise((resolvePromise, reject) => {
			const child = this.spawnCommand(command, args, options);
			child.on("error", reject);
			child.on("exit", (code) => {
				if (code === 0) {
					resolvePromise();
				} else {
					reject(new Error(`Command failed: ${command}`));
				}
			});
		});
	}

	private runCommandSync(command: string, args: string[]): string {
		const env = getEnv();
		const result = spawnProcessSync(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf-8",
			env,
		});
		if (result.error || result.status !== 0) {
			throw new Error(`Command failed: ${command}`);
		}
		return (result.stdout || result.stderr || "").trim();
	}
}
