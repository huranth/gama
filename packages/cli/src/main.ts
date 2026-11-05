import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type ImageContent, modelsAreEqual } from "@huranth/gama-ai";
import { setCapabilityOverrides } from "@huranth/gama-tui";
import chalk from "chalk";
import {
	APP_NAME,
	ENV_AGENT_DIR,
	ENV_SESSION_DIR,
	expandTildePath,
	getAgentDir,
	VERSION,
} from "./config.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import type { InlineExtension } from "./core/ext/types.ts";
import { exportFromFile } from "./core/html/index.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
import type { CreateAgentSessionOptions } from "./core/kit.ts";
import type { ModelHub } from "./core/model-run.ts";
import { formatNotice } from "./core/notices.ts";
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/pick.ts";
import { isTruthyEnvFlag } from "./core/ping.ts";
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "./core/session/runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/session/services.ts";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.ts";
import { assertValidSessionId, SessionStore } from "./core/sessions.ts";
import { SettingsStore } from "./core/settings.ts";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "./core/settings-err.ts";
import { printTimings, resetTimings, time } from "./core/timings.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { builtInExtensions } from "./ext/index.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { runPrintMode } from "./print.ts";
import { runRpcMode } from "./rpc/server.ts";
import {
	type Args,
	type Mode,
	normalizeSessionName,
	parseArgs,
	printHelp,
	restoreBooleanFlagValues,
} from "./start/args.ts";
import { processFileArguments } from "./start/files.ts";
import { buildInitialMessage } from "./start/message.ts";
import { listModels } from "./start/models.ts";
import { selectSession } from "./start/picker.ts";
import { createProjectTrustContext } from "./start/trust.ts";
import { showStartupSelector } from "./start/ui.ts";
import { TermApp } from "./term/app.ts";
import { initTheme, setThemeJsonValidator, stopThemeWatcher } from "./term/theme/theme.ts";
import { validateThemeJson } from "./term/theme/theme-json.ts";
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.ts";

const MODEL_LOAD_TIMEOUT_MS = 15_000;

const BENCH_SETTLE_MS = 150;

const SESSION_FILE_EXTENSIONS = [".gama", ".jsonl"];

const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:/;

const EXTENSION_LOAD_FAILURE_HINT = `Hint: Start without extensions using "${APP_NAME} -ne"`;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type ResolvedSession =
	| { type: "path"; path: string }
	| { type: "local"; path: string }
	| { type: "global"; path: string; cwd: string }
	| { type: "not_found"; arg: string };

export interface MainOptions {
	extensionFactories?: InlineExtension[];
}

async function readPipedStdin(): Promise<string | undefined> {
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		let settled = false;
		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			process.stdin.off("data", onData);
			process.stdin.off("end", onEnd);
			process.stdin.off("error", onError);
			resolve(value);
		};
		const onData = (chunk: string) => {
			data += chunk;
		};
		const onEnd = () => finish(data.trim() || undefined);
		const onError = () => finish(undefined);
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", onData);
		process.stdin.on("end", onEnd);
		process.stdin.on("error", onError);
		process.stdin.resume();
	});
}

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const isError = diagnostic.type === "error";
		const isWarning = diagnostic.type === "warning";
		const color = isError ? chalk.red : isWarning ? chalk.yellow : chalk.dim;
		const prefix = isError ? "Error: " : isWarning ? "Warning: " : "";

		console.error(color(`${prefix}${formatNotice(diagnostic.message)}`));
	}
}

function reportArgsDiagnostics(parsed: Args): void {
	if (parsed.diagnostics.length === 0) return;

	for (const diagnostic of parsed.diagnostics) {
		const isError = diagnostic.type === "error";
		const color = isError ? chalk.red : chalk.yellow;
		const label = isError ? "Error" : "Warning";

		console.error(color(`${label}: ${formatNotice(diagnostic.message)}`));
	}

	if (parsed.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
		process.exit(1);
	}
}

async function exportSessionOrExit(sessionFile: string, outputPath?: string): Promise<never> {
	let result: string;

	try {
		result = await exportFromFile(sessionFile, outputPath);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Export failed";
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}

	console.log(`Exported to: ${result}`);
	process.exit(0);
}

// Trust check
export function isProjectTrustedAtStartup(
	cwd: string,
	trustOverride: boolean | undefined,
	trustStore: ProjectTrustStore,
): boolean {
	return (
		trustOverride ?? (!hasTrustRequiringProjectResources(cwd) || trustStore.get(cwd) === true)
	);
}

function resolveSessionDir(parsed: Args, settingsManager: SettingsStore): string | undefined {
	const explicit = parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined;
	if (explicit) return explicit;

	const fromEnv = process.env[ENV_SESSION_DIR];
	if (fromEnv) return expandTildePath(fromEnv);

	return settingsManager.getSessionDir();
}

function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
		return "print";
	}
	return "interactive";
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
	return appMode === "json" ? "json" : "text";
}

function isPlainRuntimeMetadataCommand(parsed: Args): boolean {
	return parsed.mode === undefined && (parsed.help === true || parsed.listModels !== undefined);
}

async function prepareInitialMessage(
	parsed: Args,
	stdinContent?: string,
	cwd?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, {
		autoResizeImages: false,
		cwd,
	});
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

function findLocalSessionByExactId(
	sessionId: string,
	cwd: string,
	sessionDir?: string,
): { type: "local"; path: string } | undefined {
	const path = SessionStore.findById(cwd, sessionId, sessionDir);
	return path ? { type: "local", path } : undefined;
}

function looksLikeSessionPath(value: string): boolean {
	const lower = value.toLowerCase();
	return (
		value.includes("/") ||
		value.includes("\\") ||
		WINDOWS_DRIVE_PATH.test(value) ||
		SESSION_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension))
	);
}

async function resolveSessionPath(
	sessionArg: string,
	cwd: string,
	sessionDir?: string,
): Promise<ResolvedSession> {
	if (looksLikeSessionPath(sessionArg)) {
		return { type: "path", path: resolvePath(sessionArg, cwd) };
	}

	const exactLocalMatch = findLocalSessionByExactId(sessionArg, cwd, sessionDir);
	if (exactLocalMatch) {
		return exactLocalMatch;
	}

	const localSessions = await SessionStore.list(cwd, sessionDir);
	const localMatch = localSessions.find((session) => session.id.startsWith(sessionArg));

	if (localMatch) {
		return { type: "local", path: localMatch.path };
	}

	const allSessions = await SessionStore.listAll(sessionDir);
	const globalMatch =
		allSessions.find((session) => session.id === sessionArg) ??
		allSessions.find((session) => session.id.startsWith(sessionArg));

	if (globalMatch) {
		return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
	}

	return { type: "not_found", arg: sessionArg };
}

async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		let settled = false;
		let interfaceClosed = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			resolve(value);
			if (!interfaceClosed) {
				interfaceClosed = true;
				rl.close();
			}
		};
		// Handle close
		rl.on("close", () => {
			interfaceClosed = true;
			finish(false);
		});
		rl.question(`${message} [y/N] `, (answer) => {
			finish(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

function conflictingFlags(parsed: Args, includeNoSession: boolean): string[] {
	const flags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		includeNoSession && parsed.noSession ? "--no-session" : undefined,
	];

	return flags.filter((flag): flag is string => flag !== undefined);
}

function assertNoConflicts(_owner: string, flags: string[]): void {
	if (flags.length === 0) return;

	console.error(chalk.red(`Conflicting flags: ${flags.join(", ")}`));
	process.exit(1);
}

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	assertNoConflicts("--fork", conflictingFlags(parsed, true));
}

function validateSessionIdFlags(parsed: Args): void {
	if (parsed.sessionId === undefined) return;

	assertNoConflicts("--session-id", conflictingFlags(parsed, false));

	try {
		assertValidSessionId(parsed.sessionId);
	} catch (error: unknown) {
		console.error(chalk.red(`Error: ${errorText(error)}`));
		process.exit(1);
	}
}

function openSessionOrExit(path: string, sessionDir?: string): SessionStore {
	try {
		return SessionStore.open(path, sessionDir);
	} catch (error: unknown) {
		console.error(chalk.red(`Error: ${errorText(error)}`));
		process.exit(1);
	}
}

function forkSessionOrExit(
	sourcePath: string,
	cwd: string,
	sessionDir?: string,
	sessionId?: string,
): SessionStore {
	try {
		return SessionStore.forkFrom(sourcePath, cwd, sessionDir, { id: sessionId });
	} catch (error: unknown) {
		console.error(chalk.red(`Error: ${errorText(error)}`));
		process.exit(1);
	}
}

export async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsStore,
): Promise<SessionStore> {
	if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
		return SessionStore.inMemory(
			cwd,
			parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined,
		);
	}

	if (parsed.fork) {
		if (parsed.sessionId) {
			const existingTarget = findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
			if (existingTarget) {
				console.error(chalk.red(`Session exists: ${parsed.sessionId}`));
				process.exit(1);
			}
		}

		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir, parsed.sessionId);

			case "not_found":
				console.error(chalk.red(`Session not found: ${resolved.arg}`));
				process.exit(1);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return openSessionOrExit(resolved.path, sessionDir);

			case "global": {
				console.log(chalk.yellow(`Other project: ${resolved.cwd}`));
				// Keep stdin.
				const shouldFork = process.stdin.isTTY
					? await promptConfirm("Fork this session into current directory?")
					: true;
				if (!shouldFork) {
					console.log(chalk.dim("Aborted"));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
			}

			case "not_found":
				console.error(chalk.red(`Session not found: ${resolved.arg}`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		try {
			const selectedPath = await selectSession(
				(onProgress, signal) => SessionStore.list(cwd, sessionDir, onProgress, signal),
				(onProgress, signal) => SessionStore.listAll(sessionDir, onProgress, signal),
				settingsManager,
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return SessionStore.open(selectedPath, sessionDir);
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		return SessionStore.continueRecent(cwd, sessionDir);
	}

	if (parsed.sessionId) {
		const existingSession = findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
		if (existingSession) {
			return SessionStore.open(existingSession.path, sessionDir);
		}
		console.error(chalk.yellow(`Session missing: ${parsed.sessionId}`));
	}

	try {
		return SessionStore.create(cwd, sessionDir, { id: parsed.sessionId });
	} catch (error: unknown) {
		console.error(chalk.red(`Error: ${errorText(error)}`));
		process.exit(1);
	}
}

function findSavedScopedModel(
	settingsManager: SettingsStore,
	modelRuntime: ModelHub,
	scopedModels: ScopedModel[],
): ScopedModel | undefined {
	const provider = settingsManager.getDefaultProvider();
	const modelId = settingsManager.getDefaultModel();
	if (!provider || !modelId) return undefined;

	const model = modelRuntime.getModel(provider, modelId);
	if (!model) return undefined;

	return scopedModels.find((scoped) => modelsAreEqual(scoped.model, model));
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRuntime: ModelHub,
	settingsManager: SettingsStore,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	if (parsed.provider && !parsed.model) {
		diagnostics.push({
			type: "error",
			message:
				"--provider requires --model " +
				`(for example: --provider ${parsed.provider} --model <pattern>)`,
		});
	}
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			cliThinking: parsed.thinking,
			modelRuntime,
		});

		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}

		if (resolved.model) {
			options.model = resolved.model;
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		const saved = findSavedScopedModel(settingsManager, modelRuntime, scopedModels);
		const selected = saved ?? scopedModels[0];

		options.model = selected.model;

		if (!parsed.thinking && selected.thinkingLevel) {
			options.thinkingLevel = selected.thinkingLevel;
		}
	}

	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((scoped) => ({
			model: scoped.model,
			thinkingLevel: scoped.thinkingLevel,
		}));
	}

	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}
	if (parsed.excludeTools) {
		options.excludeTools = [...parsed.excludeTools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsStore,
): Promise<string | undefined> {
	return showStartupSelector(settingsManager, formatMissingSessionCwdPrompt(issue), [
		{ label: "Continue", value: issue.fallbackCwd },
		{ label: "Cancel", value: undefined },
	]);
}

function useFirstRunState(): void {
	const dir = mkdtempSync(join(tmpdir(), `${APP_NAME}-first-run-`));
	process.env[ENV_AGENT_DIR] = dir;
	process.once("exit", () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	});
}

export async function main(args: string[], options?: MainOptions) {
	resetTimings();
	const parsed = parseArgs(args);
	reportArgsDiagnostics(parsed);
	time("parseArgs");

	if (parsed.firstRun) useFirstRunState();
	const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])];
	const offlineMode = parsed.offline === true || isTruthyEnvFlag(process.env.GAMA_OFFLINE);
	if (offlineMode) {
		process.env.GAMA_OFFLINE = "1";
		process.env.GAMA_SKIP_VERSION_CHECK = "1";
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const bootstrapSettingsManager = SettingsStore.create(cwd, agentDir, {
		projectTrusted: false,
	});
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.export) {
		await exportSessionOrExit(parsed.export, parsed.messages[0]);
	}

	let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Invalid @files"));
		process.exit(1);
	}

	validateForkFlags(parsed);
	validateSessionIdFlags(parsed);

	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd);
	time("runMigrations");

	const trustStore = new ProjectTrustStore(agentDir);
	const startupSettingsManager = SettingsStore.create(cwd, agentDir, {
		projectTrusted: isProjectTrustedAtStartup(cwd, parsed.projectTrustOverride, trustStore),
	});
	const startupSettingsDiagnostics = collectSettingsDiagnostics(startupSettingsManager);

	if (appMode === "interactive" && parsed.useTheme !== undefined) {
		startupSettingsManager.applyOverrides({ theme: parsed.useTheme });
	}

	const sessionDir = resolveSessionDir(parsed, startupSettingsManager);
	let sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			const selectedCwd = await promptForMissingSessionCwd(
				missingSessionCwdIssue,
				startupSettingsManager,
			);
			if (!selectedCwd) {
				process.exit(0);
			}
			sessionManager = SessionStore.open(
				missingSessionCwdIssue.sessionFile!,
				sessionDir,
				selectedCwd,
			);
		} else {
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	if (parsed.name !== undefined) {
		const name = normalizeSessionName(parsed.name);
		if (name === undefined) {
			console.error(chalk.red("Name required"));
			process.exit(1);
		}
		sessionManager.appendSessionInfo(name);
	}

	const skippedLines = sessionManager.getSkippedLines();
	if (skippedLines > 0) {
		startupSettingsDiagnostics.push({
			type: "warning",
			message: `Skipped lines: ${skippedLines}`,
		});
	}
	time("createSessionManager");

	const sessionCwd = sessionManager.getCwd();
	const autoTrustOnReloadCwd =
		parsed.projectTrustOverride === undefined && !hasTrustRequiringProjectResources(sessionCwd)
			? sessionCwd
			: undefined;
	const trustPromptMode: AppMode =
		parsed.help || parsed.listModels !== undefined ? "print" : appMode;
	const projectTrustByCwd = new Map<string, boolean>();

	const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
	const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
	const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
	const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
		projectTrustContext,
	}) => {
		const isInitialRuntime = sessionStartEvent === undefined;
		const projectTrustDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
		const cachedProjectTrust = projectTrustByCwd.get(cwd);
		const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
		const shouldResolveProjectTrust =
			parsed.projectTrustOverride === undefined &&
			cachedProjectTrust === undefined &&
			hasTrustRequiringResources;
		const projectTrusted = shouldResolveProjectTrust
			? false
			: (cachedProjectTrust ??
				parsed.projectTrustOverride ??
				(!hasTrustRequiringResources || trustStore.get(cwd) === true));
		const runtimeSettingsManager = SettingsStore.create(cwd, agentDir, { projectTrusted });
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager: runtimeSettingsManager,
			modelRuntimeSignal: AbortSignal.timeout(MODEL_LOAD_TIMEOUT_MS),
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderReloadOptions: shouldResolveProjectTrust
				? {
						resolveProjectTrust: async ({ extensionsResult }) => {
							const trustContext =
								projectTrustContext ??
								createProjectTrustContext({
									cwd,
									mode: isInitialRuntime ? trustPromptMode : appMode,
									settingsManager: startupSettingsManager,
									hasUI: isInitialRuntime && trustPromptMode === "interactive",
								});
							const trusted = await resolveProjectTrusted({
								cwd,
								trustStore,
								trustOverride: parsed.projectTrustOverride,
								defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
								extensionsResult,
								projectTrustContext: trustContext,
								onExtensionError: (message) =>
									projectTrustDiagnostics.push({ type: "warning", message }),
							});
							if (
								!trusted &&
								parsed.projectTrustOverride === undefined &&
								!trustContext.hasUI &&
								startupSettingsManager.getDefaultProjectTrust() === "ask" &&
								trustStore.get(cwd) === null
							) {
								projectTrustDiagnostics.push({
									type: "warning",
									message:
										`Project ${cwd} is not trusted; project settings, extensions,` +
										` and resources were skipped. Run interactively to approve it` +
										` or pass --approve.`,
								});
							}
							projectTrustByCwd.set(cwd, trusted);
							return trusted;
						},
					}
				: undefined,
			resourceLoaderOptions: {
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				noExtensions: parsed.noExtensions,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories,
			},
		});
		const { settingsManager, modelRuntime, resourceLoader } = services;
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...projectTrustDiagnostics,
			...services.diagnostics,
			...collectSettingsDiagnostics(settingsManager),
			...resourceLoader.getExtensions().errors.map(({ path }) => ({
				type: "error" as const,
				message: `Extension failed: ${path}`,
			})),
			...(resourceLoader.getExtensions().warnings ?? []).map(({ path }) => ({
				type: "warning" as const,
				message: `Extension warning: ${path}`,
			})),
		];

		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		const scopedModels =
			modelPatterns && modelPatterns.length > 0
				? await resolveModelScope(modelPatterns, modelRuntime, {
						signal: AbortSignal.timeout(MODEL_LOAD_TIMEOUT_MS),
					})
				: [];
		const {
			options: sessionOptions,
			cliThinkingFromModel,
			diagnostics: sessionOptionDiagnostics,
		} = buildSessionOptions(
			parsed,
			scopedModels,
			sessionManager.buildSessionContext().messages.length > 0,
			modelRuntime,
			settingsManager,
		);
		diagnostics.push(...sessionOptionDiagnostics);

		if (parsed.apiKey) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message:
						"--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				await modelRuntime.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
			}
		}

		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			excludeTools: sessionOptions.excludeTools,
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
			enableHands: sessionOptions.tools === undefined && sessionOptions.noTools !== "all",
		});
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		return {
			...created,
			services,
			diagnostics,
		};
	};
	time("createRuntime");
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});
	time("createAgentSessionRuntime");
	const { services, session, modelFallbackMessage } = runtime;
	const { settingsManager, modelRuntime, resourceLoader } = services;
	restoreBooleanFlagValues(
		parsed,
		new Set(
			resourceLoader
				.getExtensions()
				.extensions.flatMap((extension) => [...extension.flags])
				.filter(([, flag]) => flag.type === "boolean")
				.map(([name]) => name),
		),
	);
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

	if (parsed.help) {
		reportDiagnostics(startupSettingsDiagnostics);
		const extensionFlags = resourceLoader
			.getExtensions()
			.extensions.flatMap((extension) => Array.from(extension.flags.values()));
		printHelp(extensionFlags);
		process.exit(0);
	}

	if (parsed.listModels !== undefined) {
		reportDiagnostics(startupSettingsDiagnostics);
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRuntime, searchPattern, AbortSignal.timeout(MODEL_LOAD_TIMEOUT_MS));
		process.exit(0);
	}

	let stdinContent: string | undefined;
	if (appMode !== "rpc") {
		stdinContent = await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
	}
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		stdinContent,
		sessionManager.getCwd(),
	);
	time("prepareInitialMessage");
	setThemeJsonValidator(validateThemeJson);
	initTheme(settingsManager.getTheme(), appMode === "interactive");
	time("initTheme");

	if (appMode === "interactive" && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	time("resolveModelScope");
	const startupDiagnostics = deduplicateDiagnostics([
		...startupSettingsDiagnostics,
		...runtime.diagnostics,
	]);
	const hasRuntimeErrors = runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");
	if (appMode !== "interactive" || hasRuntimeErrors) {
		reportDiagnostics(startupDiagnostics);
	}
	if (hasRuntimeErrors) {
		if (
			runtime.diagnostics.some((diagnostic) => diagnostic.message.includes("Extension failed"))
		) {
			console.error(chalk.yellow(EXTENSION_LOAD_FAILURE_HINT));
		}
		process.exit(1);
	}
	time("createAgentSession");

	if (appMode !== "interactive" && !session.model) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		process.exit(1);
	}

	const startupBenchmark = isTruthyEnvFlag(process.env.GAMA_STARTUP_BENCHMARK);
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red("Interactive mode only"));
		process.exit(1);
	}

	if (!offlineMode && appMode === "rpc") {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), MODEL_LOAD_TIMEOUT_MS);
		void modelRuntime
			.refresh({ signal: controller.signal })
			.catch(() => {})
			.finally(() => clearTimeout(timeout));
	}

	if (appMode === "rpc") {
		printTimings();
		await runRpcMode(runtime);
	} else if (appMode === "interactive") {
		const interactiveMode = new TermApp(runtime, {
			migratedProviders,
			startupDiagnostics,
			modelFallbackMessage,
			autoTrustOnReloadCwd,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
			tuiMode: parsed.tuiMode,
			initialThemeSetting: parsed.useTheme,
		});
		if (startupBenchmark) {
			await interactiveMode.init();
			time("interactiveMode.init");
			await new Promise((resolve) => setTimeout(resolve, BENCH_SETTLE_MS));
			interactiveMode.stop();
			stopThemeWatcher();
			printTimings();
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			return;
		}

		printTimings();
		await interactiveMode.run();
	} else {
		printTimings();
		const exitCode = await runPrintMode(runtime, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return;
	}
}
