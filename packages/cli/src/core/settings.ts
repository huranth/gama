import type { ThinkingLevel } from "@huranth/gama-agent-core";
import {
	type CacheRetention,
	DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
	type Model,
	type Transport,
} from "@huranth/gama-ai";
import type {
	TuiMode as RendererTuiMode,
	ScrollViewScrollbar,
	TerminalCapabilities,
	WheelScrollLines,
} from "@huranth/gama-tui";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { writeFileAtomicSync } from "../utils/atomic-write.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { sleepSync } from "../utils/sleep.ts";
import { stripBom } from "../utils/text.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "./comp/compact.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";

export interface CompactionModelOverride {
	reserveTokens?: number;
	keepRecentTokens?: number;
}

export interface CompactionSettings {
	enabled?: boolean;
	reserveTokens?: number;
	keepRecentTokens?: number;
	modelOverrides?: Record<string, CompactionModelOverride>;
}

export interface BranchSummarySettings {
	reserveTokens?: number;
	skipPrompt?: boolean;
}

export interface ProviderRetrySettings {
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
}

export interface RetrySettings {
	enabled?: boolean;
	maxRetries?: number;
	baseDelayMs?: number;
	maxAgentDelayMs?: number;
	provider?: ProviderRetrySettings;
}

export type TuiMode = RendererTuiMode;

export type FullscreenExitOutput = "transcript" | "resume-hint";

export interface TerminalSettings {
	showImages?: boolean;
	imageWidthCells?: number;
	clearOnShrink?: boolean;
	showTerminalProgress?: boolean;
	hyperlinks?: boolean | "auto";
	images?: "kitty" | "iterm2" | "auto" | false;
	trueColor?: boolean | "auto";
}

export interface ImageSettings {
	autoResize?: boolean;
	blockImages?: boolean;
}

export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export type MermaidRenderingMode = "off" | "final" | "streaming";

export const CACHE_WARMING_MODES = ["off", "streaming", "idle"] as const;

export type CacheWarmingMode = (typeof CACHE_WARMING_MODES)[number];

const CACHE_RETENTIONS: readonly CacheRetention[] = ["short", "long", "none"];

const DEFAULT_ASSUMED_CACHE_TTL_SECONDS = 300;

export const DEFAULT_CACHE_WARM_SAVINGS_RATIO = 3;

export interface MarkdownSettings {
	codeBlockIndent?: string;
	mermaid?: MermaidRenderingMode;
}

export interface WarningSettings {
	anthropicExtraUsage?: boolean;
}

export type CodemodeMode = "on" | "only";

export interface CodemodeSettings {
	mode?: CodemodeMode;
	inlineBudget?: number;
}

export type DefaultProjectTrust = "ask" | "always" | "never";

export type QuietStartup = boolean | "header";

export type TransportSetting = Transport;

export interface PackageSourceObject {
	source: string;
	autoload?: boolean;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export type PackageSource = string | PackageSourceObject;

export interface Settings {
	lastChangelogVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelThinkingLevels?: Record<string, ThinkingLevel>;
	transport?: TransportSetting;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	defaultDeliveryMode?: "steer" | "followUp";
	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	promptSummaries?: boolean;
	notifyOnTurnEnd?: boolean;
	externalEditor?: string;
	shellPath?: string;
	quietStartup?: QuietStartup;
	defaultProjectTrust?: DefaultProjectTrust;
	shellCommandPrefix?: string;
	npmCommand?: string[];
	collapseChangelog?: boolean;
	enableInstallTelemetry?: boolean;
	deviceId?: string;
	packages?: PackageSource[];
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
	enableSkillCommands?: boolean;
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[];
	defaultTools?: string[];
	doubleEscapeAction?: "fork" | "none";
	thinkingBudgets?: ThinkingBudgetsSettings;
	editorPaddingX?: number;
	outputPad?: 0 | 1;
	autocompleteMaxVisible?: number;
	showHardwareCursor?: boolean;
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	codemode?: CodemodeSettings;
	sessionDir?: string;
	httpProxy?: string;
	httpIdleTimeoutMs?: number;
	cacheWarming?: CacheWarmingMode;
	cacheTtlSeconds?: number;
	cacheWarmSavingsRatio?: number;
	cacheRetention?: CacheRetention;
	websocketConnectTimeoutMs?: number;
	tuiMode?: TuiMode;
	fullscreenExitOutput?: FullscreenExitOutput;
	fullscreenScrollbar?: ScrollViewScrollbar;
	fullscreenCopyOnSelect?: boolean;
	fullscreenWheelScrollLines?: WheelScrollLines;
}

export type SettingsScope = "global" | "project";

export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean;
}

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

export interface SettingsError {
	scope: SettingsScope;
	path?: string;
	error: Error;
}

type SettingsPaths = Partial<Record<SettingsScope, string>>;

const DEFAULT_COMPACTION_TOKEN_SETTINGS: Required<CompactionModelOverride> = {
	reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
	keepRecentTokens: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
};

const DEFAULT_MAX_RETRIES = 3;

const DEFAULT_RETRY_BASE_DELAY_MS = 2000;

const MS_PER_SECOND = 1000;

const MIN_WHEEL_SCROLL_LINES = 1;

const MAX_WHEEL_SCROLL_LINES = 100;

const LOCK_ATTEMPTS = 10;

const LOCK_RETRY_DELAY_MS = 20;

const DIR_MODE = 0o700;

const DEFAULT_IMAGE_WIDTH_CELLS = 60;

const MIN_IMAGE_WIDTH_CELLS = 1;

const MIN_EDITOR_PADDING_X = 0;

const MAX_EDITOR_PADDING_X = 3;

const MIN_AUTOCOMPLETE_VISIBLE = 3;

const MAX_AUTOCOMPLETE_VISIBLE = 20;

const DEFAULT_AUTOCOMPLETE_VISIBLE = 5;

const DEFAULT_CODE_BLOCK_INDENT = "  ";

const DEFAULT_EDITORS = { windows: "notepad", unix: "nano" } as const;

export const DEFAULT_TOOL_NAMES: readonly string[] = [
	"read",
	"bash",
	"edit",
	"write",
	"fetch",
];

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function clampWheelScrollLines(lines: number): number {
	return clamp(lines, MIN_WHEEL_SCROLL_LINES, MAX_WHEEL_SCROLL_LINES);
}

function clampEditorPaddingX(padding: number): number {
	return clamp(padding, MIN_EDITOR_PADDING_X, MAX_EDITOR_PADDING_X);
}

function clampAutocompleteVisible(count: number): number {
	return clamp(count, MIN_AUTOCOMPLETE_VISIBLE, MAX_AUTOCOMPLETE_VISIBLE);
}

function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnsafeMergeKey(key: string): boolean {
	return key === "__proto__" || key === "constructor" || key === "prototype";
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
	return isNonNegativeInteger(value) ? value : fallback;
}

function readOptionalNonNegativeInteger(value: unknown): number | undefined {
	return isNonNegativeInteger(value) ? value : undefined;
}

function markField(
	fields: Set<keyof Settings>,
	nestedFields: Map<keyof Settings, Set<string>>,
	field: keyof Settings,
	nestedKey?: string,
): void {
	fields.add(field);
	if (!nestedKey) return;

	const nested = nestedFields.get(field) ?? new Set<string>();
	nested.add(nestedKey);
	nestedFields.set(field, nested);
}

function mergeNestedFields(
	base: unknown,
	inMemory: unknown,
	nestedKeys: Set<string>,
): Record<string, unknown> {
	const merged = { ...(base as Record<string, unknown>) };
	const source = inMemory as Record<string, unknown>;

	for (const key of nestedKeys) {
		if (isUnsafeMergeKey(key)) continue;
		merged[key] = source[key];
	}

	return merged;
}

function readTokenSetting(value: unknown, label: string): number | undefined {
	assertNonNegativeInteger(value, label);

	return typeof value === "number" ? value : undefined;
}

function assertNonNegativeInteger(value: unknown, label: string): void {
	if (value === undefined) return;
	if (isNonNegativeInteger(value)) return;

	throw new Error(`Invalid setting: ${label}`);
}

function getErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	if (!("code" in error)) return undefined;

	return String((error as { code?: unknown }).code);
}

function deepMergeObjects(
	base: Record<string, unknown>,
	overrides: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...base };

	for (const key of Object.keys(overrides)) {
		if (isUnsafeMergeKey(key)) continue;

		const overrideValue = overrides[key];
		if (overrideValue === undefined) continue;

		const baseValue = base[key];
		const canMerge = isMergeableObject(baseValue) && isMergeableObject(overrideValue);
		result[key] = canMerge
			? deepMergeObjects(
					baseValue as Record<string, unknown>,
					overrideValue as Record<string, unknown>,
				)
			: overrideValue;
	}

	return result;
}

function isToolModifier(entry: unknown): boolean {
	return typeof entry === "string" && (entry.startsWith("+") || entry.startsWith("-"));
}

function mergeDefaultTools(
	base: string[] | undefined,
	overrides: string[] | undefined,
): string[] | undefined {
	if (overrides === undefined) return base;
	if (!Array.isArray(base)) return overrides;
	if (!overrides.every(isToolModifier)) return overrides;

	return [...base, ...overrides];
}

function resolveDefaultTools(entries: string[]): string[] {
	const plain = entries.filter((entry) => !isToolModifier(entry));
	const tools = plain.length > 0 || entries.length === 0 ? plain : [...DEFAULT_TOOL_NAMES];

	for (const entry of entries) {
		if (!isToolModifier(entry)) continue;

		const name = entry.slice(1);
		const index = tools.indexOf(name);
		const isAdd = entry.startsWith("+");

		if (isAdd && index === -1 && name) {
			tools.push(name);
		} else if (!isAdd && index !== -1) {
			tools.splice(index, 1);
		}
	}

	return tools;
}

function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const merged = deepMergeObjects(
		base as Record<string, unknown>,
		overrides as Record<string, unknown>,
	) as Settings;
	const defaultTools = mergeDefaultTools(base.defaultTools, overrides.defaultTools);
	return defaultTools === undefined ? merged : { ...merged, defaultTools };
}

function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	if (timeoutMs !== undefined) return timeoutMs;
	if (value !== undefined) throw new Error(`Invalid setting: ${settingName}`);

	return undefined;
}

function toSettingsError(scope: SettingsScope, error: unknown, path?: string): SettingsError {
	return {
		scope,
		...(path ? { path } : {}),
		error: error instanceof Error ? error : new Error(String(error)),
	};
}

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string, agentDir: string) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		let lastError: unknown;

		for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code = getErrorCode(error);
				if (code !== "ELOCKED" || attempt === LOCK_ATTEMPTS) throw error;

				lastError = error;
				sleepSync(LOCK_RETRY_DELAY_MS);
			}
		}

		throw (lastError as Error) ?? new Error("Settings lock failed");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;

		if (existsSync(path)) {
			this.writeLocked(path, fn);
			return;
		}

		const next = fn(undefined);
		if (next === undefined) return;

		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: DIR_MODE });

		this.writeLocked(path, fn, next);
	}

	private writeLocked(
		path: string,
		fn: (current: string | undefined) => string | undefined,
		first?: string,
	): void {
		const release = this.acquireLockSyncWithRetry(path);

		try {
			const current = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
			const next = current === undefined && first !== undefined ? first : fn(current);
			if (next !== undefined) writeFileAtomicSync(path, next);
		} finally {
			release();
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next === undefined) return;

		if (scope === "global") {
			this.global = next;
		} else {
			this.project = next;
		}
	}
}

export class SettingsStore {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings: Settings;
	private runtimeOverrides: Partial<Settings> = {};
	private projectTrusted: boolean;
	private modifiedFields = new Set<keyof Settings>();
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>();
	private modifiedProjectFields = new Set<keyof Settings>();
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>();
	private globalSettingsLoadError: Error | null = null;
	private projectSettingsLoadError: Error | null = null;
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];
	private settingsPaths: SettingsPaths;

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = true,
		settingsPaths: SettingsPaths = {},
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.projectTrusted = projectTrusted;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.settingsPaths = settingsPaths;
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsStore {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		const storage = new FileSettingsStorage(resolvedCwd, resolvedAgentDir);
		return SettingsStore.fromStorageWithPaths(storage, options, {
			global: join(resolvedAgentDir, "settings.json"),
			project: join(resolvedCwd, CONFIG_DIR_NAME, "settings.json"),
		});
	}

	static fromStorage(
		storage: SettingsStorage,
		options: SettingsManagerCreateOptions = {},
	): SettingsStore {
		return SettingsStore.fromStorageWithPaths(storage, options);
	}

	private static fromStorageWithPaths(
		storage: SettingsStorage,
		options: SettingsManagerCreateOptions,
		settingsPaths: SettingsPaths = {},
	): SettingsStore {
		const projectTrusted = options.projectTrusted ?? true;
		const globalLoad = SettingsStore.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsStore.tryLoadFromStorage(storage, "project", projectTrusted);
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push(toSettingsError("global", globalLoad.error, settingsPaths.global));
		}
		if (projectLoad.error) {
			initialErrors.push(toSettingsError("project", projectLoad.error, settingsPaths.project));
		}

		return new SettingsStore(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
			settingsPaths,
		);
	}

	static inMemory(
		settings: Partial<Settings> = {},
		options: SettingsManagerCreateOptions = {},
	): SettingsStore {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsStore.migrateSettings(
			structuredClone(settings) as Record<string, unknown>,
		);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsStore.fromStorage(storage, options);
	}

	private static loadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): Settings {
		if (scope === "project" && !projectTrusted) {
			return {};
		}

		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings: unknown = JSON.parse(stripBom(content));
		if (!isMergeableObject(settings)) {
			throw new Error(`Invalid settings: ${scope}`);
		}
		return SettingsStore.migrateSettings(settings);
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; error: Error | null } {
		try {
			return {
				settings: SettingsStore.loadFromStorage(storage, scope, projectTrusted),
				error: null,
			};
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	private static migrateSettings(settings: Record<string, unknown>): Settings {
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		if ("skills" in settings && isMergeableObject(settings.skills)) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (
				skillsSettings.enableSkillCommands !== undefined &&
				settings.enableSkillCommands === undefined
			) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (
				Array.isArray(skillsSettings.customDirectories) &&
				skillsSettings.customDirectories.length > 0
			) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		if ("retry" in settings && isMergeableObject(settings.retry)) {
			const retrySettings = settings.retry;
			const providerSettings =
				typeof retrySettings.provider === "object" && retrySettings.provider !== null
					? (retrySettings.provider as Record<string, unknown>)
					: undefined;
			if (
				typeof retrySettings.maxDelayMs === "number" &&
				(providerSettings?.maxRetryDelayMs === undefined ||
					providerSettings?.maxRetryDelayMs === null)
			) {
				retrySettings.provider = {
					...(providerSettings ?? {}),
					maxRetryDelayMs: retrySettings.maxDelayMs,
				};
			}
			delete retrySettings.maxDelayMs;
		}

		return settings as Settings;
	}

	getSettings(): Settings {
		return structuredClone(this.settings);
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	isProjectTrusted(): boolean {
		return this.projectTrusted;
	}

	setProjectTrusted(trusted: boolean): void {
		if (this.projectTrusted === trusted) {
			return;
		}

		this.projectTrusted = trusted;
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		if (!trusted) {
			this.projectSettings = {};
			this.projectSettingsLoadError = null;
			this.settings = this.mergeScopedSettings();
			return;
		}

		const projectLoad = SettingsStore.tryLoadFromStorage(this.storage, "project", trusted);
		this.projectSettings = projectLoad.settings;
		this.projectSettingsLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.recordError("project", projectLoad.error);
		}
		this.settings = this.mergeScopedSettings();
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const globalLoad = SettingsStore.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsStore.tryLoadFromStorage(
			this.storage,
			"project",
			this.projectTrusted,
		);
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettings = {};
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		this.settings = this.mergeScopedSettings();
	}

	applyOverrides(overrides: Partial<Settings>): void {
		this.runtimeOverrides = deepMergeSettings(this.runtimeOverrides, overrides);
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.setGlobal("lastChangelogVersion", version);
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.setGlobal("defaultProvider", provider);
	}

	setDefaultModel(modelId: string): void {
		this.setGlobal("defaultModel", modelId);
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	clearDefaultModelAndProvider(): void {
		delete this.globalSettings.defaultProvider;
		delete this.globalSettings.defaultModel;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode === "one-at-a-time" ? "one-at-a-time" : "all";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.setGlobal("steeringMode", mode);
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode === "all" ? "all" : "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.setGlobal("followUpMode", mode);
	}

	getDefaultDeliveryMode(): "steer" | "followUp" {
		return this.settings.defaultDeliveryMode === "followUp" ? "followUp" : "steer";
	}

	setDefaultDeliveryMode(mode: "steer" | "followUp"): void {
		this.setGlobal("defaultDeliveryMode", mode);
	}

	getThemeSetting(): string | undefined {
		const value = this.settings.theme;
		if (typeof value === "string") return value;
		return undefined;
	}

	getTheme(): string | undefined {
		const theme = this.getThemeSetting();
		return theme?.includes("/") ? undefined : theme;
	}

	setTheme(theme: string): void {
		this.setGlobal("theme", theme);
	}

	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: ThinkingLevel): void {
		this.setGlobal("defaultThinkingLevel", level);
	}

	getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined {
		return this.settings.modelThinkingLevels?.[`${provider}/${modelId}`];
	}

	getAllModelThinkingLevels(): Record<string, ThinkingLevel> {
		return { ...(this.settings.modelThinkingLevels ?? {}) };
	}

	setModelThinkingLevel(provider: string, modelId: string, level: ThinkingLevel): void {
		this.globalSettings.modelThinkingLevels ??= {};
		this.globalSettings.modelThinkingLevels[`${provider}/${modelId}`] = level;
		this.markModified("modelThinkingLevels");
		this.save();
	}

	removeModelThinkingLevel(provider: string, modelId: string): void {
		if (!this.globalSettings.modelThinkingLevels) return;
		delete this.globalSettings.modelThinkingLevels[`${provider}/${modelId}`];
		if (Object.keys(this.globalSettings.modelThinkingLevels).length === 0) {
			delete this.globalSettings.modelThinkingLevels;
		}
		this.markModified("modelThinkingLevels");
		this.save();
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "auto";
	}

	setTransport(transport: TransportSetting): void {
		this.setGlobal("transport", transport);
	}

	getCacheWarmingMode(): CacheWarmingMode {
		const mode = this.globalSettings.cacheWarming;
		return mode !== undefined && CACHE_WARMING_MODES.includes(mode) ? mode : "streaming";
	}

	setCacheWarmingMode(mode: CacheWarmingMode): void {
		this.setGlobal("cacheWarming", mode);
	}

	getCacheTtlMs(): number {
		const seconds = this.settings.cacheTtlSeconds;
		if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
			return DEFAULT_ASSUMED_CACHE_TTL_SECONDS * MS_PER_SECOND;
		}

		return seconds * MS_PER_SECOND;
	}

	getCacheWarmSavingsRatio(): number {
		const ratio = this.settings.cacheWarmSavingsRatio;
		if (ratio === undefined || !Number.isFinite(ratio) || ratio <= 0) {
			return DEFAULT_CACHE_WARM_SAVINGS_RATIO;
		}
		return ratio;
	}

	getCacheRetention(): CacheRetention | undefined {
		const retention = this.settings.cacheRetention;
		return retention !== undefined && CACHE_RETENTIONS.includes(retention)
			? retention
			: undefined;
	}

	setCacheRetention(retention: CacheRetention): void {
		this.setGlobal("cacheRetention", retention);
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.globalSettings.compaction ??= {};
		this.globalSettings.compaction.enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	getCompactionReserveTokens(model?: Pick<Model<string>, "provider" | "id">): number {
		return this.getCompactionTokenSetting("reserveTokens", model);
	}

	getCompactionKeepRecentTokens(model?: Pick<Model<string>, "provider" | "id">): number {
		return this.getCompactionTokenSetting("keepRecentTokens", model);
	}

	getCompactionSettings(model?: Pick<Model<string>, "provider" | "id">): {
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
	} {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(model),
			keepRecentTokens: this.getCompactionKeepRecentTokens(model),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: readNonNegativeInteger(
				this.settings.branchSummary?.reserveTokens,
				DEFAULT_COMPACTION_SETTINGS.reserveTokens,
			),
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		this.globalSettings.retry ??= {};
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	getRetrySettings(): {
		enabled: boolean;
		maxRetries: number;
		baseDelayMs: number;
		maxAgentDelayMs: number;
	} {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: readNonNegativeInteger(this.settings.retry?.maxRetries, DEFAULT_MAX_RETRIES),
			baseDelayMs: readNonNegativeInteger(
				this.settings.retry?.baseDelayMs,
				DEFAULT_RETRY_BASE_DELAY_MS,
			),
			maxAgentDelayMs: readNonNegativeInteger(
				this.settings.retry?.maxAgentDelayMs,
				DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
			),
		};
	}

	getHttpIdleTimeoutMs(): number {
		return (
			parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ??
			DEFAULT_HTTP_IDLE_TIMEOUT_MS
		);
	}

	setHttpIdleTimeoutMs(timeoutMs: number): void {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error("Invalid setting: httpIdleTimeoutMs");
		}

		this.setGlobal("httpIdleTimeoutMs", Math.floor(timeoutMs));
	}

	getProviderRetrySettings(): {
		timeoutMs?: number;
		maxRetries?: number;
		maxRetryDelayMs: number;
	} {
		return {
			timeoutMs: readOptionalNonNegativeInteger(this.settings.retry?.provider?.timeoutMs),
			maxRetries: readOptionalNonNegativeInteger(this.settings.retry?.provider?.maxRetries),
			maxRetryDelayMs: readNonNegativeInteger(
				this.settings.retry?.provider?.maxRetryDelayMs,
				DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
			),
		};
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return parseTimeoutSetting(
			this.settings.websocketConnectTimeoutMs,
			"websocketConnectTimeoutMs",
		);
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? true;
	}

	getExternalEditorCommand(): string {
		const configuredEditor = this.settings.externalEditor;
		if (typeof configuredEditor === "string" && configuredEditor.trim() !== "") {
			return configuredEditor;
		}

		const environmentEditor = process.env.VISUAL || process.env.EDITOR;
		if (environmentEditor) {
			return environmentEditor;
		}

		return process.platform === "win32" ? DEFAULT_EDITORS.windows : DEFAULT_EDITORS.unix;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.setGlobal("hideThinkingBlock", hide);
	}

	getPromptSummaries(): boolean {
		return this.settings.promptSummaries ?? false;
	}

	setPromptSummaries(enabled: boolean): void {
		this.setGlobal("promptSummaries", enabled);
	}

	getNotifyOnTurnEnd(): boolean {
		return this.settings.notifyOnTurnEnd ?? true;
	}

	setNotifyOnTurnEnd(enabled: boolean): void {
		this.setGlobal("notifyOnTurnEnd", enabled);
	}

	getShellPath(): string | undefined {
		const shellPath = this.settings.shellPath;
		return shellPath ? normalizePath(shellPath) : shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.setGlobal("shellPath", path);
	}

	getQuietStartup(): QuietStartup {
		const value = this.settings.quietStartup;
		return value === false || value === "header" ? value : true;
	}

	setQuietStartup(quiet: QuietStartup): void {
		this.setGlobal("quietStartup", quiet);
	}

	getDefaultProjectTrust(): DefaultProjectTrust {
		const value = this.globalSettings.defaultProjectTrust;
		return value === "always" || value === "never" ? value : "ask";
	}

	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void {
		this.setGlobal("defaultProjectTrust", defaultProjectTrust);
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.setGlobal("shellCommandPrefix", prefix);
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.setGlobal("npmCommand", command ? [...command] : undefined);
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? true;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.setGlobal("collapseChangelog", collapse);
	}

	getEnableInstallTelemetry(): boolean {
		return this.settings.enableInstallTelemetry ?? true;
	}

	setEnableInstallTelemetry(enabled: boolean): void {
		this.setGlobal("enableInstallTelemetry", enabled);
	}

	getOrCreateDeviceId(): string {
		if (this.globalSettings.deviceId) return this.globalSettings.deviceId;

		const deviceId = randomUUID();
		this.setGlobal("deviceId", deviceId);

		return deviceId;
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.setGlobal("packages", packages);
	}

	setProjectPackages(packages: PackageSource[]): void {
		this.updateProjectSettings("packages", (settings) => {
			settings.packages = packages;
		});
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.setGlobal("extensions", paths);
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.updateProjectSettings("extensions", (settings) => {
			settings.extensions = paths;
		});
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.setGlobal("skills", paths);
	}

	setProjectSkillPaths(paths: string[]): void {
		this.updateProjectSettings("skills", (settings) => {
			settings.skills = paths;
		});
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.setGlobal("prompts", paths);
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.updateProjectSettings("prompts", (settings) => {
			settings.prompts = paths;
		});
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.setGlobal("themes", paths);
	}

	setProjectThemePaths(paths: string[]): void {
		this.updateProjectSettings("themes", (settings) => {
			settings.themes = paths;
		});
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.setGlobal("enableSkillCommands", enabled);
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getTerminalCapabilityOverrides(): Partial<TerminalCapabilities> {
		const terminal = this.settings.terminal;
		const images = terminal?.images;
		const overrides: Partial<TerminalCapabilities> = {};

		if (images === "kitty" || images === "iterm2") {
			overrides.images = images;
		} else if (images === false) {
			overrides.images = null;
		}

		if (typeof terminal?.trueColor === "boolean") overrides.trueColor = terminal.trueColor;
		if (typeof terminal?.hyperlinks === "boolean") overrides.hyperlinks = terminal.hyperlinks;

		return overrides;
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		this.globalSettings.terminal ??= {};
		this.globalSettings.terminal.showImages = show;
		this.markModified("terminal", "showImages");
		this.save();
	}

	getImageWidthCells(): number {
		const width = this.settings.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return DEFAULT_IMAGE_WIDTH_CELLS;
		}

		return Math.max(MIN_IMAGE_WIDTH_CELLS, Math.floor(width));
	}

	setImageWidthCells(width: number): void {
		this.globalSettings.terminal ??= {};
		this.globalSettings.terminal.imageWidthCells = Math.max(
			MIN_IMAGE_WIDTH_CELLS,
			Math.floor(width),
		);
		this.markModified("terminal", "imageWidthCells");
		this.save();
	}

	getClearOnShrink(): boolean {
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.GAMA_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		this.globalSettings.terminal ??= {};
		this.globalSettings.terminal.clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? false;
	}

	setShowTerminalProgress(enabled: boolean): void {
		this.globalSettings.terminal ??= {};
		this.globalSettings.terminal.showTerminalProgress = enabled;
		this.markModified("terminal", "showTerminalProgress");
		this.save();
	}

	getTuiMode(): TuiMode {
		return this.settings.tuiMode === "regular" ? "regular" : "fullscreen";
	}

	setTuiMode(mode: TuiMode): void {
		this.setGlobal("tuiMode", mode);
	}

	getFullscreenExitOutput(): FullscreenExitOutput {
		return this.settings.fullscreenExitOutput === "resume-hint" ? "resume-hint" : "transcript";
	}

	setFullscreenExitOutput(output: FullscreenExitOutput): void {
		this.setGlobal("fullscreenExitOutput", output);
	}

	getFullscreenScrollbar(): ScrollViewScrollbar {
		const mode = this.settings.fullscreenScrollbar;
		return mode === "always" || mode === "hidden" ? mode : "auto";
	}

	setFullscreenScrollbar(mode: ScrollViewScrollbar): void {
		this.setGlobal("fullscreenScrollbar", mode);
	}

	getFullscreenCopyOnSelect(): boolean {
		return this.settings.fullscreenCopyOnSelect ?? true;
	}

	setFullscreenCopyOnSelect(enabled: boolean): void {
		this.setGlobal("fullscreenCopyOnSelect", enabled);
	}

	getFullscreenWheelScrollLines(): WheelScrollLines {
		const lines = this.settings.fullscreenWheelScrollLines;
		return typeof lines === "number" && Number.isFinite(lines)
			? clampWheelScrollLines(lines)
			: "auto";
	}

	setFullscreenWheelScrollLines(lines: WheelScrollLines): void {
		this.setGlobal(
			"fullscreenWheelScrollLines",
			lines === "auto" ? lines : clampWheelScrollLines(lines),
		);
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		this.globalSettings.images ??= {};
		this.globalSettings.images.autoResize = enabled;
		this.markModified("images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): void {
		this.globalSettings.images ??= {};
		this.globalSettings.images.blockImages = blocked;
		this.markModified("images", "blockImages");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	getDefaultTools(): string[] | undefined {
		const tools = this.settings.defaultTools;
		if (tools === undefined) return undefined;
		return resolveDefaultTools(
			Array.isArray(tools) ? tools.filter((tool) => typeof tool === "string") : [],
		);
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.setGlobal("enabledModels", patterns);
	}

	getDoubleEscapeAction(): "fork" | "none" {
		return this.settings.doubleEscapeAction === "fork" ? "fork" : "none";
	}

	setDoubleEscapeAction(action: "fork" | "none"): void {
		this.setGlobal("doubleEscapeAction", action);
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.GAMA_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.setGlobal("showHardwareCursor", enabled);
	}

	getEditorPaddingX(): number {
		const value = this.settings.editorPaddingX;
		if (typeof value !== "number" || !Number.isFinite(value)) {
			return MIN_EDITOR_PADDING_X;
		}

		return clampEditorPaddingX(value);
	}

	setEditorPaddingX(padding: number): void {
		this.setGlobal("editorPaddingX", clampEditorPaddingX(padding));
	}

	getOutputPad(): 0 | 1 {
		return this.settings.outputPad === 0 ? 0 : 1;
	}

	setOutputPad(padding: 0 | 1): void {
		this.setGlobal("outputPad", padding);
	}

	getAutocompleteMaxVisible(): number {
		const value = this.settings.autocompleteMaxVisible;
		if (typeof value !== "number" || !Number.isFinite(value)) {
			return DEFAULT_AUTOCOMPLETE_VISIBLE;
		}

		return clampAutocompleteVisible(value);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.setGlobal("autocompleteMaxVisible", clampAutocompleteVisible(maxVisible));
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? DEFAULT_CODE_BLOCK_INDENT;
	}

	getMermaidRenderingMode(): MermaidRenderingMode {
		const mode = this.settings.markdown?.mermaid;
		return mode === "off" || mode === "final" ? mode : "streaming";
	}

	setMermaidRenderingMode(mode: MermaidRenderingMode): void {
		this.globalSettings.markdown ??= {};
		this.globalSettings.markdown.mermaid = mode;
		this.markModified("markdown", "mermaid");
		this.save();
	}

	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): void {
		this.setGlobal("warnings", { ...warnings });
	}

	private getCompactionTokenSetting(
		field: keyof CompactionModelOverride,
		model?: Pick<Model<string>, "provider" | "id">,
	): number {
		const compaction = this.settings.compaction;
		const ordinary = readTokenSetting(compaction?.[field], `compaction.${field}`);

		const modelKey = model ? `${model.provider}/${model.id}` : undefined;
		const entry = modelKey !== undefined ? compaction?.modelOverrides?.[modelKey] : undefined;
		if (entry !== undefined && !isMergeableObject(entry)) {
			throw new Error(`Invalid setting: ${modelKey}`);
		}

		const override = readTokenSetting(
			entry?.[field],
			`compaction.modelOverrides["${modelKey}"].${field}`,
		);

		return override ?? ordinary ?? DEFAULT_COMPACTION_TOKEN_SETTINGS[field];
	}

	private mergeScopedSettings(): Settings {
		const merged = deepMergeSettings(this.globalSettings, this.projectSettings);
		return deepMergeSettings(merged, this.runtimeOverrides);
	}

	private setGlobal<K extends keyof Settings>(field: K, value: Settings[K]): void {
		this.globalSettings[field] = value;
		this.markModified(field);
		this.save();
	}

	private markModified(field: keyof Settings, nestedKey?: string): void {
		markField(this.modifiedFields, this.modifiedNestedFields, field, nestedKey);
	}

	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		markField(this.modifiedProjectFields, this.modifiedProjectNestedFields, field, nestedKey);
	}

	private assertProjectTrustedForWrite(): void {
		if (!this.projectTrusted) {
			throw new Error("Project not trusted");
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		this.errors.push(toSettingsError(scope, error, this.settingsPaths[scope]));
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(
		source: Map<keyof Settings, Set<string>>,
	): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? SettingsStore.migrateSettings(
						JSON.parse(stripBom(current)) as Record<string, unknown>,
					)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			const target = mergedSettings as Record<string, unknown>;

			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				const nestedKeys = modifiedNestedFields.get(field);

				if (nestedKeys && typeof value === "object" && value !== null) {
					target[field] = mergeNestedFields(currentFileSettings[field], value, nestedKeys);
					continue;
				}

				target[field] = value;
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private save(): void {
		this.settings = this.mergeScopedSettings();

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings(
				"global",
				snapshotGlobalSettings,
				modifiedFields,
				modifiedNestedFields,
			);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.assertProjectTrustedForWrite();
		this.projectSettings = structuredClone(settings);
		this.settings = this.mergeScopedSettings();

		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings(
				"project",
				snapshotProjectSettings,
				modifiedFields,
				modifiedNestedFields,
			);
		});
	}

	private updateProjectSettings(
		field: keyof Settings,
		update: (settings: Settings) => void,
	): void {
		this.assertProjectTrustedForWrite();
		const projectSettings = structuredClone(this.projectSettings);
		update(projectSettings);
		this.markProjectModified(field);
		this.saveProjectSettings(projectSettings);
	}
}
