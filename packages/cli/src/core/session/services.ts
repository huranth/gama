import { join } from "node:path";
import type { ThinkingLevel } from "@huranth/gama-agent-core";
import type { Model } from "@huranth/gama-ai";
import { getAgentDir } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { SessionStartEvent, ToolDefinition } from "../ext/index.ts";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
} from "../kit.ts";
import { ModelHub } from "../model-run.ts";
import {
	DefaultResourceLoader,
	type DefaultResourceLoaderOptions,
	type ResourceLoader,
	type ResourceLoaderReloadOptions,
} from "../resource-loader.ts";
import type { SessionStore } from "../sessions.ts";
import { SettingsStore } from "../settings.ts";

export interface AgentSessionRuntimeDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

export interface CreateAgentSessionServicesOptions {
	cwd: string;
	agentDir?: string;
	settingsManager?: SettingsStore;
	modelRuntime?: ModelHub;
	modelRuntimeSignal?: AbortSignal;
	extensionFlagValues?: Map<string, boolean | string>;
	resourceLoaderOptions?: Omit<
		DefaultResourceLoaderOptions,
		"cwd" | "agentDir" | "settingsManager"
	>;
	resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
}

export interface CreateAgentSessionFromServicesOptions {
	services: AgentSessionServices;
	sessionManager: SessionStore;
	sessionStartEvent?: SessionStartEvent;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
	excludeTools?: CreateAgentSessionOptions["excludeTools"];
	noTools?: CreateAgentSessionOptions["noTools"];
	customTools?: ToolDefinition[];
	enableHands?: boolean;
}

export interface AgentSessionServices {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelHub;
	settingsManager: SettingsStore;
	resourceLoader: ResourceLoader;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

// Safe register
function runRegistration(
	diagnostics: AgentSessionRuntimeDiagnostic[],
	extensionPath: string,
	register: () => void,
): void {
	try {
		register();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		diagnostics.push({
			type: "error",
			message: `Extension "${extensionPath}" error: ${message}`,
		});
	}
}

// Flag values
function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) return [];

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();

	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];

	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);

		if (!flag) {
			unknownFlags.push(name);
			continue;
		}

		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}

		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}

		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message:
				`Unknown option${unknownFlags.length === 1 ? "" : "s"}: ` +
				unknownFlags.map((name) => `--${name}`).join(", "),
		});
	}

	return diagnostics;
}

function registerPendingProviders(
	modelRuntime: ModelHub,
	runtime: ReturnType<ResourceLoader["getExtensions"]>["runtime"],
	diagnostics: AgentSessionRuntimeDiagnostic[],
): void {
	for (const item of runtime.pendingProviderRegistrations) {
		runRegistration(diagnostics, item.extensionPath, () =>
			modelRuntime.registerProvider(item.name, item.config),
		);
	}
	runtime.pendingProviderRegistrations = [];

	for (const item of runtime.pendingNativeProviderRegistrations) {
		runRegistration(diagnostics, item.extensionPath, () =>
			modelRuntime.registerNativeProvider(item.provider),
		);
	}
	runtime.pendingNativeProviderRegistrations = [];

	for (const item of runtime.pendingVirtualModelRegistrations) {
		runRegistration(diagnostics, item.extensionPath, () =>
			modelRuntime.registerVirtualModel(item.definition),
		);
	}
	runtime.pendingVirtualModelRegistrations = [];
}

export async function createAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	return createAgentSession({
		cwd: options.services.cwd,
		agentDir: options.services.agentDir,
		modelRuntime: options.services.modelRuntime,
		settingsManager: options.services.settingsManager,
		resourceLoader: options.services.resourceLoader,
		sessionManager: options.sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		scopedModels: options.scopedModels,
		tools: options.tools,
		excludeTools: options.excludeTools,
		noTools: options.noTools,
		customTools: options.customTools,
		enableHands: options.enableHands,
		sessionStartEvent: options.sessionStartEvent,
	});
}

export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const cwd = resolvePath(options.cwd);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();

	const modelRuntime =
		options.modelRuntime ??
		(await ModelHub.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			signal: options.modelRuntimeSignal,
		}));

	const settingsManager = options.settingsManager ?? SettingsStore.create(cwd, agentDir);

	const resourceLoader = new DefaultResourceLoader({
		...(options.resourceLoaderOptions ?? {}),
		cwd,
		agentDir,
		settingsManager,
	});
	await resourceLoader.reload(options.resourceLoaderReloadOptions);

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const runtime = resourceLoader.getExtensions().runtime;

	registerPendingProviders(modelRuntime, runtime, diagnostics);

	await modelRuntime.refresh({ allowNetwork: false });
	diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

	return {
		cwd,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader,
		diagnostics,
	};
}
