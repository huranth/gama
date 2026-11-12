import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@huranth/gama-agent-core";
import type { AssistantMessage, ImageContent, Message, Model } from "@huranth/gama-ai/compat";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	EditorComponent,
	KeyId,
	MainScreenRenderState,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	SlashCommand,
} from "@huranth/gama-tui";
import * as TuiLayouts from "@huranth/gama-tui";
import {
	AltScreen,
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	MainScreen,
	Markdown,
	MouseRegion,
	matchesKey,
	Spacer,
	setCapabilityOverrides,
	setKeybindings,
	type Terminal,
	Text,
	type TUI,
	visibleWidth,
} from "@huranth/gama-tui";
import { spawn } from "child_process";
import { spawn as crossSpawn } from "cross-spawn";
import {
	APP_NAME,
	APP_TITLE,
	getAgentDir,
	getAuthPath,
	getDebugLogPath,
	getModelsPath,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	PACKAGE_NAME,
	VERSION,
} from "../config.ts";
import { formatNoModelsAvailableMessage } from "../core/auth-guidance.ts";
import { findExtensionStackMatches, recordCrash, takeUnnotifiedCrash } from "../core/crash-log.ts";
import {
	CUSTOM_PROVIDER_API,
	deleteCustomProvider,
	deriveProviderId,
	fetchEndpointModels,
	fetchModelsDevCatalog,
	NO_PRICE,
	normalizeBaseUrl,
	rememberCustomProviderModel,
	resolveModels,
	saveCustomProviderModels,
	saveModelOverride,
	saveProviderBaseUrl,
	uniqueProviderId,
} from "../core/custom-provider.ts";
import { REASONING_LEVELS } from "../core/defaults.ts";
import { getInstallPingUrl } from "../core/endpoints.ts";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	MarkdownTransformer,
	PluginHost,
	ProjectTrustContext,
	UserBashEventResult,
	WorkingIndicatorOptions,
} from "../core/ext/index.ts";
import {
	FooterDataProvider,
	type ReadonlyFooterDataProvider,
} from "../core/footer-data-provider.ts";
import type { HandSnapshot } from "../core/hands.ts";
import { Keymap } from "../core/hotkeys.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";
import { formatNotice } from "../core/notices.ts";
import type { SourceInfo } from "../core/origin.ts";
import { DefaultPackageManager } from "../core/package-manager.ts";
import { findExactModelReferenceMatch } from "../core/pick.ts";
import { isInstallTelemetryEnabled } from "../core/ping.ts";
import type { ResourceDiagnostic } from "../core/resource-loader.ts";
import type { SessionRuntime } from "../core/session/runtime.ts";
import type { AgentSessionRuntimeDiagnostic } from "../core/session/services.ts";
import type { RunSession, SessionEvent } from "../core/session/session.ts";
import { formatMissingSessionCwdPrompt, type MissingSessionCwdError } from "../core/session-cwd.ts";
import { type SessionEntry, SessionStore } from "../core/sessions.ts";
import type { FullscreenExitOutput, TuiMode } from "../core/settings.ts";
import { BUILTIN_SLASH_COMMANDS } from "../core/slash-commands.ts";
import type { TruncationResult } from "../core/tools/truncate.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../core/trust-manager.ts";
import { AuthStorage } from "../core/vault.ts";
import { stripAnsi } from "../utils/ansi.ts";
import {
	compareVersions,
	fetchChangelogForVersion,
	findChangelogEntry,
	getChangelogPath,
	getNewEntries,
	normalizeChangelogLinks,
	parseChangelog,
} from "../utils/changelog.ts";
import { copyToClipboard, readClipboardFilePaths, readClipboardText } from "../utils/clipboard.ts";
import { extensionForImageMimeType, readClipboardImage } from "../utils/clipboard-image.ts";
import { getGamaUserAgent } from "../utils/gama-user-agent.ts";
import { parseGitUrl } from "../utils/git.ts";
import { ensurePngTranscoder } from "../utils/image-convert.ts";
import { getCwdRelativePath } from "../utils/paths.ts";
import { loadAllHighlightLanguages } from "../utils/syntax-highlight.ts";
import { pruneTempFiles } from "../utils/temp-cleanup.ts";
import { ensureTool } from "../utils/tools-manager.ts";
import { checkForNewGamaVersion, type LatestGamaRelease } from "../utils/version-check.ts";
import {
	handleResumeSession,
	rebindCurrentSession,
	rebuildChatFromMessages,
	renderCurrentSessionState,
	subscribeToAgent,
} from "./bind.ts";
import { refreshModelCatalogs } from "./catalog.ts";
import {
	addChatChild,
	addCompactionCostNotice,
	addCustomEntryToChat,
	addMessageToChat,
	addToolLine,
	type CompactionCostNotice,
	configurePromptSummary,
	dropChatChild,
	ExpandableText,
	ensureCurrentActivity,
	getMarkdownThemeWithSettings,
	getMarkdownTransformers,
	getUserMessageText,
	isExpandable,
	isSilentTool,
	maybeShowThinkingDropNotice,
	type RenderSessionItem,
	renderInitialMessages,
	renderProjectTrustWarningIfNeeded,
	renderSessionEntries,
	renderSessionItems,
	resetActivity,
	settleCurrentActivity,
	settleRunningActivities,
	showError,
	showStatus,
	showWarning,
	trackActivity,
	updateActivity,
} from "./chat.ts";
import {
	applyReasoningLevel,
	cycleModel,
	cycleThinkingLevel,
	handleDequeue,
	handleFollowUp,
	handleReasonCommand,
	parseContextWindowInput,
	parseDeliveryPrefix,
	setToolsExpanded,
	showCachePanel,
	showContextPanel,
	showStatsPanel,
	toggleThinkingBlockVisibility,
	toggleToolOutputExpansion,
	updateThinkingBlockVisibility,
} from "./commands.ts";
import { editInExternalEditor } from "./editor.ts";
import {
	type AgentEventOf,
	estimateStreamingOutputTokens,
	handleAgentEnd,
	handleAgentSettled,
	handleAgentStart,
	handleAutoRetryEnd,
	handleAutoRetryStart,
	handleCompactionEnd,
	handleCompactionStart,
	handleEntryAppended,
	handleEvent,
	handleMessageEnd,
	handleMessageStart,
	handleMessageUpdate,
	handleQueueUpdate,
	handleSessionInfoChanged,
	handleSummarizationRetryAttemptStart,
	handleSummarizationRetryFinished,
	handleSummarizationRetryScheduled,
	handleThinkingLevelChanged,
	handleToolExecutionEnd,
	handleToolExecutionStart,
	handleToolExecutionUpdate,
	handleTurnStart,
	maybeWarnAboutCacheCold,
} from "./events.ts";
import {
	closeHand,
	handleHandsFinished,
	handleHandsStarted,
	handleHandsUpdated,
	openHand,
} from "./hands.ts";
import { getModelSearchText } from "./model-search.ts";
import type {
	ActivityLineComponent,
	ActivityRecord,
	ActivityTickerComponent,
} from "./parts/activity.ts";
import { AssistantMessageComponent } from "./parts/assistant-message.ts";
import { BashExecutionComponent } from "./parts/bash-execution.ts";
import { BorderedLoader } from "./parts/bordered-loader.ts";
import { CenteredColumn } from "./parts/centered-column.ts";
import {
	ConnectProviderDialogComponent,
	type ConnectProviderInput,
} from "./parts/connect-provider-dialog.ts";
import { CustomEditor } from "./parts/custom-editor.ts";
import { DynamicBorder } from "./parts/dynamic-border.ts";
import { ExtensionEditorComponent } from "./parts/extension-editor.ts";
import { ExtensionInputComponent } from "./parts/extension-input.ts";
import { ExtensionSelectorComponent } from "./parts/extension-selector.ts";
import { FooterComponent, formatTokens } from "./parts/footer.ts";
import { GamaAsciiLogo } from "./parts/gama-ascii-logo.ts";
import type { HandCardComponent } from "./parts/hand-card.ts";
import type { HandGridComponent } from "./parts/hand-grid.ts";
import type { HandViewComponent } from "./parts/hand-view.ts";
import { formatKeyText, keyText } from "./parts/keybinding-hints.ts";
import { createMermaidMarkdownTransformer } from "./parts/mermaid.ts";
import { ModelSelectorComponent } from "./parts/model-selector.ts";
import { type ProviderChoice, ProviderSelectorComponent } from "./parts/provider-selector.ts";
import { QueuedMessagesComponent } from "./parts/queued-messages.ts";
import { SessionSelectorComponent } from "./parts/session-selector.ts";
import { IdleStatus, type StatusIndicator } from "./parts/status-indicator.ts";
import { ThemedText } from "./parts/themed-text.ts";
import { UserMessageComponent } from "./parts/user-message.ts";
import { UserMessageSelectorComponent } from "./parts/user-message-selector.ts";
import { createInteractiveTui, createInteractiveTuiReference } from "./screen.ts";
import {
	type CompactionQueuedMessage,
	checkShutdownRequested,
	emergencyTerminalExit,
	flushCompactionQueue,
	flushPendingBashComponents,
	formatCrashExtensionHint,
	handleCtrlC,
	handleCtrlD,
	handleCtrlZ,
	isExtensionCommand,
	queueCompactionMessage,
	quoteIfNeeded,
	registerSignalHandlers,
	shutdown,
	uncaughtCrash,
	unregisterSignalHandlers,
} from "./shutdown.ts";
import {
	getAvailableThemesWithPaths,
	getEditorTheme,
	getThemeByName,
	onThemeChange,
	setRegisteredThemes,
	stopThemeWatcher,
	Theme,
	type ThemeColor,
	theme,
} from "./theme/theme.ts";
import { InteractiveThemeController } from "./theme/theme-controller.ts";
import { createChatViewport } from "./viewport.ts";

export { type DeliveryMode, parseDeliveryPrefix } from "./commands.ts";
export { createInteractiveTui, createInteractiveTuiReference } from "./screen.ts";
export { formatCrashExtensionHint, formatResumeCommand } from "./shutdown.ts";

interface ActiveEditor extends EditorComponent {
	getCursor?(): { line: number; col: number };
}

interface WorkingStatusEditor extends EditorComponent {
	readonly embedWorkingStatus: boolean;
	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void;
}

const TMUX_LOOKUP_TIMEOUT_MS = 2000;
const CATALOG_TIMEOUT_MS = 15_000;

const INSTALL_PING_TIMEOUT_MS = 5000;

const EDITOR_COLUMN_MAX_WIDTH = 100;

export interface InteractiveModeOptions {
	migratedProviders?: string[];
	startupDiagnostics?: AgentSessionRuntimeDiagnostic[];
	modelFallbackMessage?: string;
	autoTrustOnReloadCwd?: string;
	initialMessage?: string;
	initialImages?: ImageContent[];
	initialMessages?: string[];
	verbose?: boolean;
	tuiMode?: TuiMode;
	initialThemeSetting?: string;
	terminal?: Terminal;
}

function isWorkingStatusEditor(editor: EditorComponent): editor is WorkingStatusEditor {
	return (
		"embedWorkingStatus" in editor &&
		editor.embedWorkingStatus === true &&
		"setWorkingStatusIndicator" in editor &&
		typeof editor.setWorkingStatusIndicator === "function"
	);
}

function hasUsableModel(model: Model<any> | undefined): boolean {
	return model !== undefined && model.api !== "unknown";
}

const ANTHROPIC_USAGE_URL = "https://claude.ai/settings/usage";

const ANTHROPIC_SUBSCRIPTION_KEY = "sk-ant-oat";

const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra " +
	"usage and is billed per token, not your Claude plan limits. Manage extra usage at " +
	`${ANTHROPIC_USAGE_URL}. Disable this warning in /settings`;

function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith(ANTHROPIC_SUBSCRIPTION_KEY);
}

function createFuzzyAutocompleteItems<T>(
	items: T[],
	prefix: string,
	getSearchText: (item: T) => string,
	toAutocompleteItem: (item: T) => AutocompleteItem,
): AutocompleteItem[] | null {
	const filtered = fuzzyFilter(items, prefix, getSearchText);
	if (filtered.length === 0) return null;
	return filtered.map(toAutocompleteItem);
}

function chip(content: string): string {
	const bgAnsi = theme.getBgAnsi("userMessageBg");
	return theme.bg("userMessageBg", ` ${content.replace(/\x1b\[0m/g, `\x1b[0m${bgAnsi}`)} `);
}

export class TermApp {
	private static readonly MAX_WIDGET_LINES = 10;

	runtimeHost: SessionRuntime;
	renderer: MainScreen | AltScreen;
	ui: TUI;
	private mainScreenRenderState: MainScreenRenderState | undefined;
	loadedResourcesContainer: Container;
	chatContainer: Container;
	handCards = new Map<string, HandCardComponent>();
	handGrid: HandGridComponent | undefined;
	handSnapshots = new Map<string, HandSnapshot>();
	handViewContainer: Container | undefined;
	handViewComponent: HandViewComponent | undefined;
	handViewId: string | undefined;
	handViewInputUnsubscribe: (() => void) | undefined;
	handEditorText: string | undefined;
	documentContainer: Container;
	transcriptScrollView: TuiLayouts.ScrollView | undefined;
	private fullscreenLayoutRoot: Component | undefined;
	pendingMessagesContainer: Container;
	private queuedMessagesComponent: QueuedMessagesComponent | undefined;
	private statusContainer: Container;

	defaultEditor: CustomEditor;
	editor: ActiveEditor;
	private editorComponentFactory: EditorFactory | undefined;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	private fdPath: string | undefined;
	editorContainer: Container;
	dockEditorColumn: CenteredColumn | undefined;
	private transcriptColumn: CenteredColumn | undefined;
	private dockPendingColumn: CenteredColumn | undefined;
	private dockStatusColumn: CenteredColumn | undefined;
	private dockWidgetsAboveColumn: CenteredColumn | undefined;
	private dockWidgetsBelowColumn: CenteredColumn | undefined;
	private activeSelectorToken?: object;
	private activeSelectorDispose?: () => void;

	footer: FooterComponent;
	private footerContainer: Container;
	private footerDataProvider: FooterDataProvider;
	private keybindings: Keymap;
	isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private pendingUserInputs: string[] = [];
	activeStatusIndicator: StatusIndicator | undefined;
	private activeWorkingIndicatorEmbedded = false;
	private readonly idleStatus = new IdleStatus();
	workingVisible = true;
	private readonly defaultWorkingMessage = "Working";
	private readonly defaultHiddenThinkingLabel = "Thinking";
	hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	lastSigintTime = 0;
	agentRunStartedAt: number | undefined;
	agentRunAborted = false;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined;
	private availableRelease: LatestGamaRelease | undefined;
	private updateNoticeVersion: string | undefined;
	private updateNoticeCard: ThemedText | undefined;
	private updateInProgress = false;
	private welcomeLogo: GamaAsciiLogo | undefined;
	private startupNoticesShown = false;
	private anthropicSubscriptionWarningShown = false;
	cacheColdWarningShown = false;

	lastStatusSpacer: Spacer | undefined;
	lastStatusText: ThemedText | undefined;
	lastStatusMessage = "";
	lastStatusTone: "dim" | "success" | "warning" | "error" = "dim";

	streamingComponent: AssistantMessageComponent | undefined;
	readonly entriesRenderedByBoundaryCompaction = new Set<string>();
	streamingMessage: AssistantMessage | undefined;
	streamingSpacer: Spacer | null = null;

	promptSummaries = new Map<string, string>();
	promptSummarySessionId: string | undefined;

	pendingToolCalls = new Set<string>();
	currentActivity?: ActivityTickerComponent;
	activityByToolId = new Map<
		string,
		{ record: ActivityRecord; ticker: ActivityTickerComponent; line?: ActivityLineComponent }
	>();
	toolOutputExpanded = false;

	hideThinkingBlock = false;
	outputPad = 1;
	readonly mermaidMarkdownTransformer: MarkdownTransformer = createMermaidMarkdownTransformer({
		getMode: () => this.settingsManager.getMermaidRenderingMode(),
		theme,
	});

	private skillCommands = new Map<string, string>();

	unsubscribe?: () => void;
	signalCleanupHandlers: Array<() => void> = [];

	private isBashMode = false;

	private bashComponent: BashExecutionComponent | undefined;

	pendingBashComponents: BashExecutionComponent[] = [];

	autoCompactionEscapeHandler?: () => void;

	retryEscapeHandler?: () => void;

	compactionQueuedMessages: CompactionQueuedMessage[] = [];

	shutdownRequested = false;

	private extensionSelector: ExtensionSelectorComponent | undefined;
	private extensionInput: ExtensionInputComponent | undefined;
	private extensionEditor: ExtensionEditorComponent | undefined;
	private extensionTerminalInputSubscriptions = new Set<{
		handler: (data: string) => { consume?: boolean; data?: string } | undefined;
		unsubscribe: () => void;
	}>();

	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	private customFooter: (Component & { dispose?(): void }) | undefined;

	private headerContainer: Container;

	builtInHeader: Component | undefined;

	customHeader: (Component & { dispose?(): void }) | undefined;

	private options: InteractiveModeOptions;
	private readonly onRightClickPaste = (): void => {
		void this.handleRightClickPaste();
	};
	private autoTrustOnReloadCwd: string | undefined;
	themeController: InteractiveThemeController;

	get session(): RunSession {
		return this.runtimeHost.session;
	}
	get sessionManager() {
		return this.session.sessionManager;
	}
	get settingsManager() {
		return this.session.settingsManager;
	}

	constructor(runtimeHost: SessionRuntime, options: InteractiveModeOptions = {}) {
		this.runtimeHost = runtimeHost;
		setCapabilityOverrides(this.settingsManager.getTerminalCapabilityOverrides());
		const tuiMode = options.tuiMode ?? this.settingsManager.getTuiMode();
		this.options = { ...options, tuiMode };
		this.autoTrustOnReloadCwd = options.autoTrustOnReloadCwd;
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			this.resetExtensionUI();
		});
		this.runtimeHost.setRebindSession(async () => {
			await this.rebindCurrentSession({ renderBeforeBind: true });
			this.themeController.applyFromSettings();
		});

		this.renderer = createInteractiveTui({
			tuiMode,
			showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
			logDirectory: getAgentDir(),
			terminal: options.terminal,
			onRightClickPaste: this.onRightClickPaste,
			fullscreenCopyOnSelect: this.settingsManager.getFullscreenCopyOnSelect(),
			fullscreenWheelScrollLines: this.settingsManager.getFullscreenWheelScrollLines(),
		});
		this.ui = createInteractiveTuiReference(() => this.renderer);
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());

		this.headerContainer = new Container();
		this.loadedResourcesContainer = new Container();
		this.chatContainer = new Container();
		this.documentContainer = new Container();
		this.documentContainer.addChild(this.headerContainer);
		this.documentContainer.addChild(this.loadedResourcesContainer);
		this.documentContainer.addChild(this.chatContainer);
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();

		this.keybindings = Keymap.create();
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
			embedWorkingStatus: false,
		});
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);

		// Centered column
		this.transcriptColumn = new CenteredColumn(EDITOR_COLUMN_MAX_WIDTH);
		this.transcriptColumn.addChild(this.documentContainer);
		this.dockPendingColumn = new CenteredColumn(EDITOR_COLUMN_MAX_WIDTH);
		this.dockPendingColumn.addChild(this.pendingMessagesContainer);
		this.dockStatusColumn = new CenteredColumn(EDITOR_COLUMN_MAX_WIDTH);
		this.dockStatusColumn.addChild(this.statusContainer);
		this.dockWidgetsAboveColumn = new CenteredColumn(EDITOR_COLUMN_MAX_WIDTH);
		this.dockWidgetsAboveColumn.addChild(this.widgetContainerAbove);
		this.dockWidgetsBelowColumn = new CenteredColumn(EDITOR_COLUMN_MAX_WIDTH);
		this.dockWidgetsBelowColumn.addChild(this.widgetContainerBelow);
		this.dockEditorColumn = new CenteredColumn(EDITOR_COLUMN_MAX_WIDTH);
		this.dockEditorColumn.addChild(this.editorContainer);

		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		this.footer = new FooterComponent(this.session, this.footerDataProvider);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footerContainer = new Container();
		this.footerContainer.addChild(this.footer);

		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.outputPad = this.settingsManager.getOutputPad();

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.themeController = new InteractiveThemeController(this.ui, {
			getSettingsManager: () => this.settingsManager,
			showError: (message) => this.showError(message),
			onChanged: () => this.updateEditorBorderColor(),
			initialThemeSetting: options.initialThemeSetting,
		});
	}

	private getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
		if (!sourceInfo || sourceInfo.source === "builtin") {
			return undefined;
		}

		const scopePrefix =
			({ user: "u", project: "p", temporary: "t" } as Record<string, string>)[
				sourceInfo.scope ?? ""
			] ?? "t";
		const source = sourceInfo.source.trim();

		if (source === "auto" || source === "local" || source === "cli") {
			return scopePrefix;
		}

		if (source.startsWith("npm:")) {
			return `${scopePrefix}:${source}`;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			const ref = gitSource.ref ? `@${gitSource.ref}` : "";
			return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
		}

		return scopePrefix;
	}

	private prefixAutocompleteDescription(
		description: string | undefined,
		sourceInfo?: SourceInfo,
	): string | undefined {
		const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
		if (!sourceTag) {
			return description;
		}
		return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
	}

	// Keep skill menu rows short
	private shortenSkillDescription(description: string | undefined): string | undefined {
		if (!description) return undefined;
		const firstSentence = description.split(/(?<=[.!?])\s|\n|;/)[0]?.trim() || description;
		const shortened = firstSentence.split(/\s+—\s+|\s+-\s+|\s+\(/)[0]?.trim() || firstSentence;
		const maxSkillDescriptionLength = 60;
		if (shortened.length <= maxSkillDescriptionLength) {
			return shortened.replace(/[.]$/, "");
		}
		const cut = shortened.slice(0, maxSkillDescriptionLength + 1);
		const lastSpace = cut.lastIndexOf(" ");
		const capped = (
			lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, maxSkillDescriptionLength)
		).trimEnd();
		return `${capped}...`;
	}

	private getBuiltInCommandConflictDiagnostics(extensionRunner: PluginHost): ResourceDiagnostic[] {
		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		return extensionRunner
			.getRegisteredCommands()
			.filter((command) => builtinNames.has(command.name))
			.map((command) => {
				const clash = "conflicts with built-in interactive command.";
				const conflict = `Extension command '/${command.name}' ${clash}`;
				const message =
					command.invocationName === command.name
						? `${conflict} Skipping in autocomplete.`
						: `${conflict} Available as '/${command.invocationName}'.`;
				return {
					type: "warning" as const,
					message,
					path: command.sourceInfo.path,
				};
			});
	}

	private createBaseAutocompleteProvider(): AutocompleteProvider {
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				const models =
					this.session.scopedModels.length > 0
						? this.session.scopedModels.map((s) => s.model)
						: this.session.modelRuntime.getAvailableSnapshot();

				if (models.length === 0) return null;

				const items = models.map((m) => ({
					id: m.id,
					provider: m.provider,
					name: m.name,
					label: `${m.provider}/${m.id}`,
				}));

				return createFuzzyAutocompleteItems(items, prefix, getModelSearchText, (item) => ({
					value: item.label,
					label: item.id,
					description: item.provider,
				}));
			};
		}

		const reasonCommand = slashCommands.find((command) => command.name === "reason");

		if (reasonCommand) {
			reasonCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				const items = REASONING_LEVELS.map((preset) => ({
					value: preset.name,
					label: preset.name,
					description: preset.hint,
				}));
				const filtered = prefix
					? items.filter((item) => item.value.startsWith(prefix.toLowerCase()))
					: items;

				return filtered.length > 0 ? filtered : null;
			};
		}

		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
			name: cmd.name,
			description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
		}));

		const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
		const extensionCommands: SlashCommand[] = this.session.extensionRunner
			.getRegisteredCommands()
			.filter((cmd) => !builtinCommandNames.has(cmd.name))
			.map((cmd) => ({
				name: cmd.invocationName,
				description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
				getArgumentCompletions: cmd.getArgumentCompletions,
			}));

		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({
					name: commandName,
					description: this.shortenSkillDescription(skill.description),
				});
			}
		}

		return new CombinedAutocompleteProvider(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			this.sessionManager.getCwd(),
			this.fdPath,
		);
	}

	private setupAutocompleteProvider(): void {
		let provider = this.createBaseAutocompleteProvider();
		const triggerCharacters: string[] = [];
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			provider = wrapProvider(provider);
			triggerCharacters.push(...(provider.triggerCharacters ?? []));
		}
		if (triggerCharacters.length > 0) {
			provider.triggerCharacters = [...new Set(triggerCharacters)];
		}

		this.autocompleteProvider = provider;
		this.defaultEditor.setAutocompleteProvider(provider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(provider);
		}
	}

	private showStartupNoticesIfNeeded(): void {
		if (this.startupNoticesShown) {
			return;
		}
		this.startupNoticesShown = true;

		this.showWelcome();

		if (!this.changelogMarkdown || this.settingsManager.getCollapseChangelog()) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new ThemedText(() => theme.fg("accent", "What's New"), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
		);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
	}

	private showWelcome(): void {
		// Top spacing
		const sky = Math.min(3, Math.max(1, Math.floor(this.ui.terminal.rows / 16)));
		this.chatContainer.addChild(new Spacer(sky));
		this.welcomeLogo = new GamaAsciiLogo(this.ui);
		this.chatContainer.addChild(this.welcomeLogo);
		this.chatContainer.addChild(new Spacer(1));
	}

	// Dismiss logo
	private dismissWelcomeLogo(): void {
		const logo = this.welcomeLogo;
		if (!logo) return;
		this.welcomeLogo = undefined;
		logo.beginDismiss(() => {
			logo.dispose();
			this.chatContainer.removeChild(logo);
			this.ui.requestRender();
		});
	}

	private mountInteractiveTui(
		tui: MainScreen | AltScreen,
		components: readonly Component[],
	): void {
		for (const component of components) {
			tui.addChild(component);
		}
		if (TuiLayouts.isViewportTUI(tui)) {
			if (!this.fullscreenLayoutRoot) throw new Error("Layout not ready");
			tui.setLayoutRoot(this.fullscreenLayoutRoot);
		}
	}

	private stopInteractiveTui(fullscreenExitOutput: FullscreenExitOutput): void {
		if (this.renderer.mode === "fullscreen" && fullscreenExitOutput === "transcript") {
			while (this.renderer.hasOverlayEntries) {
				this.renderer.hideOverlay();
			}
			this.switchTuiMode("regular", false, false);
			this.renderer.renderNow();
		}
		// Inline stop
		this.ui.stop({ preserveScreen: this.renderer.mode === "fullscreen" });
	}

	private switchTuiMode(mode: TuiMode, restoreProgress = true, startRenderer = true): boolean {
		const previousUi = this.renderer;
		if (mode === previousUi.mode) return true;
		if (previousUi.hasOverlayEntries) return false;

		const components = [...previousUi.children];
		const focus = previousUi.getFocusedComponent();
		const terminal = previousUi.terminal;
		const showHardwareCursor = previousUi.getShowHardwareCursor();
		const clearOnShrink = previousUi.getClearOnShrink();
		const onDebug = previousUi.onDebug;
		if (previousUi instanceof MainScreen) {
			this.mainScreenRenderState = previousUi.captureRenderState();
		}

		previousUi.stop({ preserveScreen: true });
		previousUi.setFocus(null);
		previousUi.clear();
		if (TuiLayouts.isViewportTUI(previousUi)) previousUi.setLayoutRoot(undefined);

		const nextUi = createInteractiveTui({
			tuiMode: mode,
			showHardwareCursor,
			logDirectory: getAgentDir(),
			terminal,
			onRightClickPaste: this.onRightClickPaste,
			fullscreenCopyOnSelect: this.settingsManager.getFullscreenCopyOnSelect(),
			fullscreenWheelScrollLines: this.settingsManager.getFullscreenWheelScrollLines(),
		});
		nextUi.setClearOnShrink(clearOnShrink);
		nextUi.onDebug = onDebug;
		if (nextUi instanceof MainScreen && this.mainScreenRenderState) {
			nextUi.restoreRenderState(this.mainScreenRenderState);
		}
		this.renderer = nextUi;
		this.options.tuiMode = mode;
		this.mountInteractiveTui(nextUi, components);
		nextUi.invalidate();
		nextUi.setFocus(focus);
		if (!startRenderer) return true;
		nextUi.start();
		this.themeController.rebindTui();
		this.rebindExtensionTerminalInputListeners();
		if (
			restoreProgress &&
			this.settingsManager.getShowTerminalProgress() &&
			(this.session.isStreaming || this.session.isCompacting)
		) {
			terminal.setProgress(true);
		}
		return true;
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.registerSignalHandlers();

		this.changelogMarkdown = this.getChangelogForDisplay();

		if (this.session.scopedModels.length > 0 && this.shouldShowStartupDetails()) {
			const modelList = this.session.scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			const cycleKeys = this.keybindings.getKeys("app.model.cycleForward");
			const cycleHint =
				cycleKeys.length > 0
					? theme.fg(
							"muted",
							` (${formatKeyText(cycleKeys.join("/"), { capitalize: true })} to cycle)`,
						)
					: "";
			console.log(theme.fg("dim", `Model scope: ${modelList}${cycleHint}`));
		}

		this.renderWidgets();
		const viewport = createChatViewport({
			document: this.transcriptColumn!,
			pendingMessages: this.dockPendingColumn!,
			status: this.dockStatusColumn!,
			widgetsAbove: this.dockWidgetsAboveColumn!,
			editor: this.dockEditorColumn!,
			widgetsBelow: this.dockWidgetsBelowColumn!,
			footer: this.footerContainer,
			scrollbar: this.settingsManager.getFullscreenScrollbar(),
			scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
			scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
		});
		this.transcriptScrollView = viewport.transcript;
		this.fullscreenLayoutRoot = viewport.root;
		this.mountInteractiveTui(this.renderer, [
			this.transcriptColumn!,
			this.dockPendingColumn!,
			this.dockStatusColumn!,
			this.dockWidgetsAboveColumn!,
			this.dockEditorColumn!,
			this.dockWidgetsBelowColumn!,
			this.footerContainer,
		]);
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onSubmit = (text) => this.handleStartupSubmit(text);
		this.ui.setFocus(this.editor);

		this.ui.start();
		this.isInitialized = true;
		this.ensurePngTranscoder();

		this.themeController.applyFromSettings();
		await this.themeController.waitForTerminalColors();

		// Title slot
		this.builtInHeader = new Text("", 0, 0);
		this.headerContainer.addChild(this.builtInHeader);
		if (this.shouldShowStartupHeader()) {
			this.addSessionCard();
		}
		this.ui.requestRender();

		const [fdPath] = await Promise.all([ensureTool("fd"), ensureTool("rg")]);
		this.fdPath = fdPath;

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();
		this.ui.requestRender();

		await this.rebindCurrentSession();

		this.renderInitialMessages();

		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		await this.updateAvailableProviderCount();

		this.ui.renderNow();
		void loadAllHighlightLanguages().then(() => {
			if (!this.isInitialized) return;
			this.ui.invalidate();
			this.ui.requestRender();
		});
	}

	updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
		}
	}

	async run(): Promise<void> {
		await this.init();

		if (!process.env.GAMA_OFFLINE) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
			void refreshModelCatalogs(this.session.modelRuntime, controller.signal)
				.then(() => this.updateAvailableProviderCount())
				.catch(() => {})
				.finally(() => clearTimeout(timeout));
		}

		// Update check
		this.checkForGamaUpdate();

		this.checkForPackageUpdates()
			.then((updates) => {
				if (updates.length > 0) {
					this.showPackageUpdateNotification(updates);
				}
			})
			.finally(() => {
				if (process.platform === "win32" && this.isInitialized) {
					this.updateTerminalTitle();
				}
			});

		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		const {
			migratedProviders,
			startupDiagnostics,
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages,
		} = this.options;

		for (const diagnostic of startupDiagnostics ?? []) {
			if (diagnostic.type === "error") {
				this.showError(diagnostic.message);
			} else if (diagnostic.type === "warning") {
				this.showWarning(diagnostic.message);
			} else {
				this.showStatus(diagnostic.message);
			}
		}

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning("Credentials migrated");
		}

		const modelsJsonError = this.session.modelRuntime.getError();
		if (modelsJsonError) {
			this.showError(`Models failed: ${modelsJsonError}`);
		}

		if (modelFallbackMessage && hasUsableModel(this.session.model)) {
			this.showWarning(modelFallbackMessage);
		}

		const crash = takeUnnotifiedCrash();
		if (crash) {
			this.showWarning(`Crash saved: ${crash.message}`);
		}

		void this.maybeWarnAboutAnthropicSubscriptionAuth();

		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error";
				this.showError(errorMessage);
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error";
					this.showError(errorMessage);
				}
			}
		}

		while (true) {
			const userInput = await this.getUserInput();
			try {
				await this.session.prompt(userInput);
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error";
				this.showError(errorMessage);
			}
		}
	}

	private checkForGamaUpdate(): void {
		if (process.env.GAMA_OFFLINE || process.env.GAMA_SKIP_VERSION_CHECK) return;
		void checkForNewGamaVersion(VERSION)
			.then((release) => {
				if (!release) return;
				this.availableRelease = release;
				this.showNewVersionNotification(release);
			})
			.catch(() => {});
	}

	private async checkForPackageUpdates(): Promise<string[]> {
		if (process.env.GAMA_OFFLINE) {
			return [];
		}

		try {
			const packageManager = new DefaultPackageManager({
				cwd: this.sessionManager.getCwd(),
				agentDir: getAgentDir(),
				settingsManager: this.settingsManager,
			});
			const updates = await packageManager.checkForAvailableUpdates();
			return updates.map((update) => update.displayName);
		} catch {
			return [];
		}
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, TMUX_LOOKUP_TIMEOUT_MS);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		if (extendedKeys === undefined) return undefined;

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return [
				"tmux extended-keys is off. Modified Enter keys may not work",
				"Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux",
			].join(" ");
		}

		if (extendedKeysFormat === "xterm") {
			return [
				"tmux extended-keys-format is xterm. Gama works best with csi-u",
				"Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux",
			].join(" ");
		}

		return undefined;
	}

	private getChangelogForDisplay(): string | undefined {
		if (this.session.state.messages.length > 0) {
			return undefined;
		}

		const lastVersion = this.settingsManager.getLastChangelogVersion();
		const changelogPath = getChangelogPath();
		const entries = parseChangelog(changelogPath);

		if (!lastVersion) {
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return undefined;
		}

		const [major, minor, patch] = VERSION.split("-")[0].split(".").map(Number);
		const currentEntry = { major: major || 0, minor: minor || 0, patch: patch || 0, content: "" };
		const newEntries = getNewEntries(entries, lastVersion).filter(
			(entry) => compareVersions(entry, currentEntry) <= 0,
		);
		if (newEntries.length > 0) {
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return newEntries
				.map((entry) => normalizeChangelogLinks(entry.content, entry))
				.join("\n\n");
		}

		return undefined;
	}

	// Install ping
	private reportInstallTelemetry(version: string): void {
		if (process.env.GAMA_OFFLINE) return;
		if (!isInstallTelemetryEnabled(this.settingsManager)) return;

		void fetch(getInstallPingUrl(version), {
			headers: { "User-Agent": getGamaUserAgent(version) },
			signal: AbortSignal.timeout(INSTALL_PING_TIMEOUT_MS),
		})
			.then(() => undefined)
			.catch(() => undefined);
	}

	getMarkdownThemeWithSettings(): MarkdownTheme {
		return getMarkdownThemeWithSettings(this);
	}

	configurePromptSummary(component: UserMessageComponent, text: string): void {
		configurePromptSummary(this, component, text);
	}

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Then a sibling like /home/smart2 doesn't collapse into ~2
		if (result === home || result.startsWith(`${home}/`) || result.startsWith(`${home}\\`)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	private formatExtensionDisplayPath(path: string): string {
		let result = this.formatDisplayPath(path);
		result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
		return result;
	}

	private formatContextPath(target: string): string {
		const cwd = path.resolve(this.sessionManager.getCwd());
		const absolutePath = path.isAbsolute(target)
			? path.resolve(target)
			: path.resolve(cwd, target);
		const relativePath = getCwdRelativePath(absolutePath, cwd);
		if (relativePath !== undefined) {
			return relativePath;
		}

		return this.formatDisplayPath(absolutePath);
	}

	private getStartupExpansionState(): boolean {
		return this.options.verbose || this.toolOutputExpanded;
	}

	private shouldShowStartupHeader(): boolean {
		return this.options.verbose === true || this.settingsManager.getQuietStartup() !== true;
	}

	// Session card
	private addSessionCard(): void {
		// Needs branch
		const branch = this.footerDataProvider.getGitBranch();
		if (!branch) return;
		this.chatContainer.addChild(new ThemedText(() => theme.fg("dim", `Branch: ${branch}`), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
	}

	private shouldShowStartupDetails(): boolean {
		return this.options.verbose === true || this.settingsManager.getQuietStartup() === false;
	}

	private getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
		const normalizedFullPath = fullPath.replace(/\\/g, "/");
		const baseDir = sourceInfo?.baseDir;
		if (baseDir && this.isPackageSource(sourceInfo)) {
			const normalizedBaseDir = baseDir.replace(/\\/g, "/");
			const npmRootMatch = normalizedBaseDir.match(
				/^(.*\/node_modules)\/(@?[^/]+(?:\/[^/]+)?)$/,
			);
			if (npmRootMatch?.[1] && normalizedFullPath.startsWith(`${npmRootMatch[1]}/`)) {
				return path.posix.relative(normalizedBaseDir, normalizedFullPath);
			}

			const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
			if (
				relativePath &&
				relativePath !== "." &&
				!relativePath.startsWith("..") &&
				!relativePath.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relativePath)
			) {
				return relativePath.replace(/\\/g, "/");
			}
		}

		const source = sourceInfo?.source ?? "";
		const npmMatch = normalizedFullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		const gitMatch = normalizedFullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		return this.formatDisplayPath(fullPath);
	}

	private getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		const shortPath = this.getShortPath(resourcePath, sourceInfo);
		const normalizedPath = shortPath.replace(/\\/g, "/");
		const segments = normalizedPath
			.split("/")
			.filter((segment) => segment.length > 0 && segment !== "~");
		if (segments.length > 0) {
			return segments[segments.length - 1]!;
		}
		return shortPath;
	}

	private getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
		const source = sourceInfo?.source ?? "";
		if (source.startsWith("npm:")) {
			return source.slice("npm:".length) || source;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			return gitSource.path || source;
		}

		return source;
	}

	private getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		if (!this.isPackageSource(sourceInfo)) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const sourceLabel = this.getCompactPackageSourceLabel(sourceInfo);
		if (!sourceLabel) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const shortPath = this.getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
		const packagePath = shortPath.startsWith("extensions/")
			? shortPath.slice("extensions/".length)
			: shortPath;
		const parsedPath = path.posix.parse(packagePath);

		if (parsedPath.name === "index") {
			return !parsedPath.dir || parsedPath.dir === "."
				? sourceLabel
				: `${sourceLabel}:${parsedPath.dir}`;
		}

		return `${sourceLabel}:${packagePath}`;
	}

	private getCompactDisplayPathSegments(resourcePath: string): string[] {
		return this.formatDisplayPath(resourcePath)
			.replace(/\\/g, "/")
			.split("/")
			.filter((segment) => segment.length > 0 && segment !== "~");
	}

	private getCompactNonPackageExtensionLabel(
		resourcePath: string,
		index: number,
		allPaths: Array<{ path: string; segments: string[] }>,
	): string {
		const segments = allPaths[index]?.segments;
		if (!segments || segments.length === 0) {
			return this.getCompactPathLabel(resourcePath);
		}

		for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
			const candidate = segments.slice(-segmentCount).join("/");
			const isUnique = allPaths.every((item, itemIndex) => {
				if (itemIndex === index) {
					return true;
				}
				return item.segments.slice(-segmentCount).join("/") !== candidate;
			});

			if (isUnique) {
				return candidate;
			}
		}

		return segments.join("/");
	}

	private getCompactExtensionLabels(
		extensions: Array<{ path: string; sourceInfo?: SourceInfo }>,
	): string[] {
		const nonPackageExtensions = extensions
			.map((extension) => {
				const segments = this.getCompactDisplayPathSegments(extension.path);
				const lastSegment = segments[segments.length - 1];
				if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
					segments.pop();
				}
				return {
					path: extension.path,
					sourceInfo: extension.sourceInfo,
					segments,
				};
			})
			.filter((extension) => !this.isPackageSource(extension.sourceInfo));

		return extensions.map((extension) => {
			if (this.isPackageSource(extension.sourceInfo)) {
				return this.getCompactExtensionLabel(extension.path, extension.sourceInfo);
			}

			const nonPackageIndex = nonPackageExtensions.findIndex(
				(item) => item.path === extension.path,
			);
			if (nonPackageIndex === -1) {
				return this.getCompactPathLabel(extension.path, extension.sourceInfo);
			}

			return this.getCompactNonPackageExtensionLabel(
				extension.path,
				nonPackageIndex,
				nonPackageExtensions,
			);
		});
	}

	private getDisplaySourceInfo(sourceInfo?: SourceInfo): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	} {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return {
				label: "path",
				scopeLabel: scope === "temporary" ? "temp" : undefined,
				color: "muted",
			};
		}

		const scopeLabel = (
			{ user: "user", project: "project", temporary: "temp" } as Record<string, string>
		)[scope ?? ""];
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(sourceInfo?: SourceInfo): boolean {
		const source = sourceInfo?.source ?? "";
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
	}> {
		const groups: Record<
			"user" | "project" | "path",
			{
				scope: "user" | "project" | "path";
				paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
				packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
			}
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const item of items) {
			const groupKey = this.getScopeGroup(item.sourceInfo);
			const group = groups[groupKey];
			const source = item.sourceInfo?.source ?? "local";

			if (this.isPackageSource(item.sourceInfo)) {
				const list = group.packages.get(source) ?? [];
				list.push(item);
				group.packages.set(source, list);
			} else {
				group.paths.push(item);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
		}>,
		options: {
			formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
			formatPackagePath: (
				item: { path: string; sourceInfo?: SourceInfo },
				source: string,
			) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) =>
				a.localeCompare(b),
			);
			for (const [source, items] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
				for (const item of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	private findSourceInfoForPath(
		target: string,
		sourceInfos: Map<string, SourceInfo>,
	): SourceInfo | undefined {
		const exact = sourceInfos.get(target);
		if (exact) return exact;

		let current = target;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = sourceInfos.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	private formatPathWithSource(target: string, sourceInfo?: SourceInfo): string {
		if (sourceInfo) {
			const shortPath = this.getShortPath(target, sourceInfo);
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(target);
	}

	private formatDiagnostics(
		diagnostics: readonly ResourceDiagnostic[],
		sourceInfos: Map<string, SourceInfo>,
	): string {
		const lines: string[] = [];

		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			const winnerSource = this.findSourceInfoForPath(first.winnerPath, sourceInfos);
			const winner = this.formatPathWithSource(first.winnerPath, winnerSource);
			lines.push(theme.fg("dim", `    ${winner} (kept)`));
			for (const d of collisionList) {
				if (!d.collision) continue;
				const loserPath = d.collision.loserPath;
				const loserSource = this.findSourceInfoForPath(loserPath, sourceInfos);
				const loser = this.formatPathWithSource(loserPath, loserSource);
				lines.push(theme.fg("dim", `    ${loser} (skipped)`));
			}
		}

		for (const d of otherDiagnostics) {
			if (d.path) {
				const formattedPath = this.formatPathWithSource(
					d.path,
					this.findSourceInfoForPath(d.path, sourceInfos),
				);
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

	private showLoadedResources(options?: {
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		this.loadedResourcesContainer.clear();

		const showListing = options?.force || this.shouldShowStartupDetails();
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") =>
			theme.fg(color, `[${name}]`);
		const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
			const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
			if (options?.sort !== false) {
				labels.sort((a, b) => a.localeCompare(b));
			}
			return theme.fg("dim", `  ${labels.join(", ")}`);
		};
		const addLoadedSection = (
			name: string,
			collapsedBody: () => string,
			expandedBody = collapsedBody,
			color: ThemeColor = "mdHeading",
		): void => {
			const section = new ExpandableText(
				() => `${sectionHeader(name, color)}\n${collapsedBody()}`,
				() => `${sectionHeader(name, color)}\n${expandedBody()}`,
				this.getStartupExpansionState(),
				0,
				0,
			);
			this.loadedResourcesContainer.addChild(section);
			this.loadedResourcesContainer.addChild(new Spacer(1));
		};

		const skillsResult = this.session.resourceLoader.getSkills();
		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();
		const extensions =
			options?.extensions ??
			this.session.resourceLoader
				.getExtensions()
				.extensions.filter((extension) => !extension.hidden)
				.map((extension) => ({
					path: extension.path,
					sourceInfo: extension.sourceInfo,
				}));
		const sourceInfos = new Map<string, SourceInfo>();
		for (const extension of extensions) {
			if (extension.sourceInfo) {
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		for (const skill of skillsResult.skills) {
			if (skill.sourceInfo) {
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		for (const prompt of promptsResult.prompts) {
			if (prompt.sourceInfo) {
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		for (const loadedTheme of themesResult.themes) {
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		if (showListing) {
			const systemPromptSource = this.session.resourceLoader.getSystemPromptSource();
			const contextFiles = [
				...(systemPromptSource ? [systemPromptSource] : []),
				...this.session.resourceLoader.getAppendSystemPromptSources(),
				...this.session.resourceLoader.getAgentsFiles().agentsFiles,
			];
			if (contextFiles.length > 0) {
				this.loadedResourcesContainer.addChild(new Spacer(1));
				const contextList = () =>
					contextFiles
						.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`))
						.join("\n");
				const contextCompactList = () =>
					formatCompactList(
						contextFiles.map((contextFile) => this.formatContextPath(contextFile.path)),
						{ sort: false },
					);
				addLoadedSection("Context", contextCompactList, contextList);
			}

			const skills = skillsResult.skills;
			if (skills.length > 0) {
				const groups = this.buildScopeGroups(
					skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
				);
				const skillList = () =>
					this.formatScopeGroups(groups, {
						formatPath: (item) => this.formatDisplayPath(item.path),
						formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
					});
				const skillCompactList = () => formatCompactList(skills.map((skill) => skill.name));
				addLoadedSection("Skills", skillCompactList, skillList);
			}

			const templates = this.session.promptTemplates;
			if (templates.length > 0) {
				const groups = this.buildScopeGroups(
					templates.map((template) => ({
						path: template.filePath,
						sourceInfo: template.sourceInfo,
					})),
				);
				const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
				const templateList = () =>
					this.formatScopeGroups(groups, {
						formatPath: (item) => {
							const template = templateByPath.get(item.path);
							return template ? `/${template.name}` : this.formatDisplayPath(item.path);
						},
						formatPackagePath: (item) => {
							const template = templateByPath.get(item.path);
							return template ? `/${template.name}` : this.formatDisplayPath(item.path);
						},
					});
				const promptCompactList = () =>
					formatCompactList(templates.map((template) => `/${template.name}`));
				addLoadedSection("Prompts", promptCompactList, templateList);
			}

			if (extensions.length > 0) {
				const groups = this.buildScopeGroups(extensions);
				const extList = () =>
					this.formatScopeGroups(groups, {
						formatPath: (item) => this.formatExtensionDisplayPath(item.path),
						formatPackagePath: (item) =>
							this.formatExtensionDisplayPath(this.getShortPath(item.path, item.sourceInfo)),
					});
				const extensionLabels = this.getCompactExtensionLabels(extensions);
				const extensionCompactList = () => formatCompactList(extensionLabels);
				addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = () => this.formatDiagnostics(skillDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new ThemedText(
						() => `${theme.fg("warning", "[Skill conflicts]")}\n${warningLines()}`,
						0,
						0,
					),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = () => this.formatDiagnostics(promptDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new ThemedText(
						() => `${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines()}`,
						0,
						0,
					),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionsResult = this.session.resourceLoader.getExtensions();
			for (const error of extensionsResult.errors) {
				extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
			}
			for (const warning of extensionsResult.warnings ?? []) {
				extensionDiagnostics.push({
					type: "warning",
					message: warning.warning,
					path: warning.path,
				});
			}

			const commandDiagnostics = this.session.extensionRunner.getCommandDiagnostics();
			extensionDiagnostics.push(...commandDiagnostics);
			extensionDiagnostics.push(
				...this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner),
			);

			const shortcutDiagnostics = this.session.extensionRunner.getShortcutDiagnostics();
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				const warningLines = () => this.formatDiagnostics(extensionDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new ThemedText(
						() => `${theme.fg("warning", "[Extension issues]")}\n${warningLines()}`,
						0,
						0,
					),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = () => this.formatDiagnostics(themeDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new ThemedText(
						() => `${theme.fg("warning", "[Theme conflicts]")}\n${warningLines()}`,
						0,
						0,
					),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}
		}
	}

	async bindCurrentSessionExtensions(): Promise<void> {
		const uiContext = this.createExtensionUIContext();
		await this.session.bindExtensions({
			uiContext,
			mode: "tui",
			abortHandler: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			commandContextActions: {
				waitForIdle: () => this.session.waitForIdle(),
				newSession: async (options) => {
					this.clearStatusIndicator();
					try {
						return await this.runtimeHost.newSession(options);
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Create failed", error);
					}
				},
				fork: async (entryId, options) => {
					try {
						const result = await this.runtimeHost.fork(entryId, options);
						if (!result.cancelled) {
							this.editor.setText(result.selectedText ?? "");
							this.showStatus("Forked session");
						}
						return { cancelled: result.cancelled };
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Fork failed", error);
					}
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}

					this.resetActivity();
					this.chatContainer.clear();
					this.renderInitialMessages();
					if (result.editorText && !this.editor.getText().trim()) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("Point selected");
					void this.flushCompactionQueue({ willRetry: false });
					return { cancelled: false };
				},
				switchSession: async (sessionPath, options) => {
					return this.handleResumeSession(sessionPath, options);
				},
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (this.session.isIdle) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error);
			},
		});

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocompleteProvider();

		const extensionRunner = this.session.extensionRunner;
		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
		this.showStartupNoticesIfNeeded();
	}

	private applyFullscreenScrollbarSetting(): void {
		this.transcriptScrollView?.setScrollbar(this.settingsManager.getFullscreenScrollbar());
	}

	private ensurePngTranscoder(): void {
		ensurePngTranscoder(() => {
			this.ui.invalidate();
			this.ui.requestRender();
		});
	}

	applyRuntimeSettings(): void {
		setCapabilityOverrides(this.settingsManager.getTerminalCapabilityOverrides());
		this.ensurePngTranscoder();
		configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
		this.applyFullscreenScrollbarSetting();
		if (this.renderer instanceof AltScreen) {
			this.renderer.setCopyOnSelect(this.settingsManager.getFullscreenCopyOnSelect());
			this.renderer.setWheelScrollLines(this.settingsManager.getFullscreenWheelScrollLines());
		}
		this.footer.setSession(this.session);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footerDataProvider.setCwd(this.sessionManager.getCwd());
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.outputPad = this.settingsManager.getOutputPad();
		this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		const clearOnShrink = this.settingsManager.getClearOnShrink();
		this.ui.setClearOnShrink(clearOnShrink);
		if (!clearOnShrink && !this.activeStatusIndicator) {
			this.statusContainer.clear();
		}
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		if (this.editor !== this.defaultEditor) {
			this.editor.setPaddingX?.(editorPaddingX);
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
	}

	private async rebindCurrentSession(options: { renderBeforeBind?: boolean } = {}): Promise<void> {
		return rebindCurrentSession(this, options);
	}

	async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`${prefix}: ${message}`);
		const extensionHint = this.getCrashExtensionHint(error);
		if (extensionHint) {
			this.chatContainer.addChild(
				new ThemedText(() => theme.fg("warning", extensionHint), this.outputPad, 0),
			);
		}
		this.recordCrash("fatal_error", error);
		stopThemeWatcher();
		this.stop("transcript");
		process.exit(1);
	}

	getCrashExtensionHint(error: unknown): string | undefined {
		try {
			return formatCrashExtensionHint(
				findExtensionStackMatches(
					error instanceof Error ? error.stack : undefined,
					this.session.resourceLoader.getExtensions().extensions,
				),
			);
		} catch {
			return undefined;
		}
	}

	recordCrash(kind: "uncaught_exception" | "fatal_error", error: unknown): boolean {
		try {
			return (
				recordCrash({
					kind,
					error,
					sessionFile: this.session.sessionFile,
					cwd: this.session.sessionManager.getCwd(),
				}) !== undefined
			);
		} catch {
			return false;
		}
	}

	renderCurrentSessionState(): void {
		renderCurrentSessionState(this);
	}

	getMarkdownTransformers(): MarkdownTransformer[] {
		return getMarkdownTransformers(this);
	}

	private setupExtensionShortcuts(extensionRunner: PluginHost): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			mode: "tui",
			hasUI: true,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: extensionRunner.getModelRegistry(),
			model: this.session.model,
			scopedModels: this.session.scopedModels,
			thinkingLevel: this.session.thinkingLevel,
			isIdle: () => this.session.isIdle,
			isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
			signal: this.session.agent.signal,
			abort: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.session.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				if (matchesKey(data, shortcutStr as KeyId)) {
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(
							`Shortcut failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					});
					return true;
				}
			}
			return false;
		};
	}

	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	private setEditorWorkingStatusIndicator(indicator: StatusIndicator | undefined): boolean {
		this.defaultEditor.setWorkingStatusIndicator(undefined);
		if (!isWorkingStatusEditor(this.editor)) return false;
		this.editor.setWorkingStatusIndicator(indicator);
		return true;
	}

	showStatusIndicator(indicator: StatusIndicator): void {
		this.activeStatusIndicator?.dispose();
		this.activeStatusIndicator = indicator;
		this.activeWorkingIndicatorEmbedded = false;
		this.statusContainer.clear();
		this.setEditorWorkingStatusIndicator(undefined);
		if (this.setEditorWorkingStatusIndicator(indicator)) {
			this.activeWorkingIndicatorEmbedded = true;
			return;
		}
		this.statusContainer.addChild(indicator);
	}

	clearStatusIndicator(kind?: StatusIndicator["kind"]): void {
		if (kind && this.activeStatusIndicator?.kind !== kind) {
			return;
		}
		const clearedIndicator = this.activeStatusIndicator;
		const clearedIndicatorWasEmbedded = this.activeWorkingIndicatorEmbedded;
		clearedIndicator?.dispose();
		this.activeStatusIndicator = undefined;
		this.activeWorkingIndicatorEmbedded = false;
		this.statusContainer.clear();
		this.setEditorWorkingStatusIndicator(undefined);
		if (
			clearedIndicator &&
			!clearedIndicatorWasEmbedded &&
			this.options.tuiMode === "regular" &&
			this.ui.getClearOnShrink()
		) {
			this.statusContainer.addChild(this.idleStatus);
		}
	}

	showWorkingStatusIndicator(): void {
		// No-op
		return;
	}

	private setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
		if (!visible) {
			this.clearStatusIndicator("working");
			this.ui.requestRender();
			return;
		}
		if (this.session.isStreaming && this.activeStatusIndicator?.kind !== "working") {
			this.showWorkingStatusIndicator();
		}
		this.ui.requestRender();
	}

	private setWorkingIndicator(options?: WorkingIndicatorOptions): void {
		if (this.activeStatusIndicator?.kind === "working") {
			this.activeStatusIndicator.setIndicator(options);
		}
		this.ui.requestRender();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		if (this.streamingComponent) {
			this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		this.handViewComponent?.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		this.ui.requestRender();
	}

	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			const container = new Container();
			for (const line of content.slice(0, TermApp.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > TermApp.MAX_WIDGET_LINES) {
				container.addChild(
					new ThemedText(() => theme.fg("muted", "... (widget truncated)"), 1, 0),
				);
			}
			component = container;
		} else {
			component = content(this.ui, theme);
		}

		const targetMap =
			placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.autocompleteProviderWrappers = [];
		this.setCustomEditorComponent(undefined);
		this.setupAutocompleteProvider();
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		this.workingVisible = true;
		this.setWorkingIndicator();
		if (this.activeStatusIndicator?.kind === "working") {
			this.activeStatusIndicator.setMessage(
				`${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`,
			);
		}
		this.setHiddenThinkingLabel();
	}

	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(
			this.widgetContainerBelow,
			this.extensionWidgetsBelow,
			false,
			false,
		);
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	private setExtensionFooter(
		factory:
			| ((
					tui: TUI,
					thm: Theme,
					footerData: ReadonlyFooterDataProvider,
			  ) => Component & { dispose?(): void })
			| undefined,
	): void {
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		this.footerContainer.clear();
		if (factory) {
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.footerContainer.addChild(this.customFooter);
		} else {
			this.customFooter = undefined;
			this.footerContainer.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	private setExtensionHeader(
		factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
	): void {
		if (!this.builtInHeader) {
			return;
		}

		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		const currentHeader = this.customHeader ?? this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);
		const nextHeader = factory ? factory(this.ui, theme) : this.builtInHeader;

		this.customHeader = factory ? nextHeader : undefined;
		if (isExpandable(nextHeader)) {
			nextHeader.setExpanded(this.toolOutputExpanded);
		}

		if (index !== -1) {
			this.headerContainer.children[index] = nextHeader;
		} else if (factory) {
			this.headerContainer.children.unshift(nextHeader);
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const subscription = { handler, unsubscribe: this.ui.addInputListener(handler) };
		this.extensionTerminalInputSubscriptions.add(subscription);
		return () => {
			subscription.unsubscribe();
			this.extensionTerminalInputSubscriptions.delete(subscription);
		};
	}

	private rebindExtensionTerminalInputListeners(): void {
		for (const subscription of this.extensionTerminalInputSubscriptions) {
			subscription.unsubscribe();
			subscription.unsubscribe = this.ui.addInputListener(subscription.handler);
		}
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const subscription of this.extensionTerminalInputSubscriptions) {
			subscription.unsubscribe();
		}
		this.extensionTerminalInputSubscriptions.clear();
	}

	createProjectTrustContext(cwd: string): ProjectTrustContext {
		const ui = this.createExtensionUIContext();
		return {
			cwd,
			mode: "tui",
			hasUI: true,
			ui: {
				select: ui.select,
				confirm: ui.confirm,
				input: ui.input,
				notify: ui.notify,
			},
		};
	}

	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				if (this.activeStatusIndicator?.kind === "working") {
					this.activeStatusIndicator.setMessage(message ?? this.defaultWorkingMessage);
				}
			},
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviderWrappers.push(factory);
				this.setupAutocompleteProvider();
			},
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					return this.themeController.setThemeInstance(themeOrName);
				}
				const result = this.themeController.setThemeName(themeOrName);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{
					tui: this.ui,
					timeout: opts?.timeout,
					onToggleToolsExpanded: () => this.toggleToolOutputExpansion(),
				},
			);

			this.disposeActiveSelector();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();
		});
	}

	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.disposeActiveSelector();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();
		});
	}

	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
				undefined,
				this.settingsManager.getExternalEditorCommand(),
			);

			this.disposeActiveSelector();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();
		});
	}

	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;

		const currentText = this.editor.getText();

		this.disposeActiveSelector();
		this.editorContainer.clear();

		if (factory) {
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			newEditor.setText(currentText);

			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}
			if (newEditor.setAutocompleteMaxVisible !== undefined) {
				newEditor.setAutocompleteMaxVisible(this.defaultEditor.getAutocompleteMaxVisible());
			}

			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) =>
						this.defaultEditor.onExtensionShortcut?.(data);
				}
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor as Component);
		if (this.activeStatusIndicator) {
			this.statusContainer.clear();
			this.activeWorkingIndicatorEmbedded = this.setEditorWorkingStatusIndicator(
				this.activeStatusIndicator,
			);
			if (!this.activeWorkingIndicatorEmbedded) {
				this.statusContainer.addChild(this.activeStatusIndicator);
			}
		}
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: Keymap,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				resolve(result);
				try {
					component?.dispose?.();
				} catch {}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							const componentWidth = (component as { width?: number }).width;
							return componentWidth ? { width: componentWidth } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						options?.onHandle?.(handle);
					} else {
						this.disposeActiveSelector();
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	private showExtensionError(extensionPath: string, error: string): void {
		const msg = `Extension error: ${extensionPath}: ${formatNotice(error)}`;

		const text = new ThemedText(() => theme.fg("error", msg), 1, 0);

		this.chatContainer.addChild(text);
		this.ui.requestRender();
	}

	private setupKeyHandlers(): void {
		this.defaultEditor.onEscape = () => {
			if (this.session.isStreaming) {
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.session.isBashRunning) {
				this.session.abortBash();
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						this.showUserMessageSelector();
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("app.thinking.cycle", () => this.cycleThinkingLevel());
		this.defaultEditor.onAction("app.model.cycleForward", () => this.cycleModel("forward"));
		this.defaultEditor.onAction("app.model.cycleBackward", () => this.cycleModel("backward"));

		this.ui.onDebug = () => this.handleDebugCommand();
		this.defaultEditor.onAction("app.model.select", () => this.showModelSelector());
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("app.thinking.toggle", () =>
			this.toggleThinkingBlockVisibility(),
		);
		this.defaultEditor.onAction(
			"app.editor.external",
			() => void this.handleOpenExternalEditor(),
		);
		this.defaultEditor.onAction(
			"app.message.copy",
			() => void this.handleCopyCommand({ flashConfirmation: true, preferSelection: true }),
		);
		this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());
		this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
		this.defaultEditor.onAction("app.session.fork", () => this.showUserMessageSelector());
		this.defaultEditor.onAction("app.session.resume", () => this.showSessionSelector());

		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};

		this.defaultEditor.onPasteImage = () => {
			void this.handleClipboardPaste();
		};
	}

	private async handleRightClickPaste(): Promise<void> {
		const target = this.renderer.getFocusedComponent();
		const handleInput = target?.handleInput;
		if (!target || !handleInput) return;
		try {
			const text = await readClipboardText();
			if (!text || this.renderer.getFocusedComponent() !== target) return;
			handleInput.call(target, `\x1b[200~${text}\x1b[201~`);
			this.ui.requestRender();
		} catch {}
	}

	private async handleClipboardPaste(): Promise<void> {
		try {
			const filePaths = await readClipboardFilePaths();
			if (filePaths) {
				if (filePaths.some((filePath) => /\p{Cc}/u.test(filePath))) {
					throw new Error("Invalid clipboard path");
				}
				const paths = this.isBashMode
					? filePaths.map(quoteIfNeeded).join(" ")
					: filePaths.join("\n");
				const cursor = this.editor.getCursor?.();
				const currentLine = cursor
					? (this.editor.getText().split("\n")[cursor.line] ?? "")
					: "";
				const characterBeforeCursor =
					cursor && cursor.col > 0 ? currentLine[cursor.col - 1] : "";
				const characterAfterCursor = cursor ? currentLine[cursor.col] : "";
				const leadingSpace =
					characterBeforeCursor && !/\s/.test(characterBeforeCursor) ? " " : "";
				const trailingSpace =
					characterAfterCursor && !/\s/.test(characterAfterCursor) ? " " : "";
				this.editor.insertTextAtCursor?.(`${leadingSpace}${paths}${trailingSpace}`);
				this.ui.requestRender();
				return;
			}

			const image = await readClipboardImage();
			if (image) {
				pruneTempFiles({
					prefix: "gama-clipboard-",
					maxAgeMs: 24 * 60 * 60 * 1000,
					isTarget: (name) => /\.(png|jpe?g|webp|gif)$/i.test(name),
				});
				const tmpDir = os.tmpdir();
				const ext = extensionForImageMimeType(image.mimeType) ?? "png";
				const fileName = `gama-clipboard-${crypto.randomUUID()}.${ext}`;
				const filePath = path.join(tmpDir, fileName);
				fs.writeFileSync(filePath, Buffer.from(image.bytes), { mode: 0o600 });

				this.editor.insertTextAtCursor?.(filePath);
				this.ui.requestRender();
				return;
			}

			const text = await readClipboardText();
			if (text) {
				this.editor.insertTextAtCursor?.(text);
				this.ui.requestRender();
			}
		} catch (error) {
			this.showError(`Paste failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private handleStartupSubmit(text: string): void {
		this.editor.setText(text);
		this.showStatus("Startup in progress");
	}

	async routeBuiltinInput(text: string): Promise<boolean> {
		if (text === "/model" || text.startsWith("/model ")) {
			const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
			this.editor.setText("");
			await this.handleModelCommand(searchTerm);
			return true;
		}
		if (text === "/history" || text.startsWith("/history ")) {
			this.editor.setText("");
			this.showSessionSelector();
			return true;
		}
		if (text === "/provider" || text.startsWith("/provider ")) {
			const argument = text.startsWith("/provider ") ? text.slice(10).trim() : undefined;
			this.editor.setText("");
			await this.handleProviderCommand(argument || undefined);
			return true;
		}

		if (text === "/context" || text.startsWith("/context ")) {
			const argument = text.startsWith("/context ") ? text.slice(9).trim() : undefined;
			this.editor.setText("");
			await this.handleContextCommand(argument || undefined);
			return true;
		}

		if (text === "/stats") {
			this.editor.setText("");
			this.showStatsPanel();
			return true;
		}

		if (text === "/cache") {
			this.editor.setText("");
			this.showCachePanel();
			return true;
		}

		if (text === "/changelog") {
			this.editor.setText("");
			await this.handleChangelogCommand();
			return true;
		}

		if (text === "/update") {
			this.editor.setText("");
			this.handleUpdateCommand();
			return true;
		}

		if (text === "/summaries" || text.startsWith("/summaries ")) {
			const argument = text.startsWith("/summaries ") ? text.slice(11).trim().toLowerCase() : "";
			this.editor.setText("");
			if (argument !== "" && argument !== "on" && argument !== "off") {
				this.showStatus("Usage summaries");
				return true;
			}
			const enabled =
				argument === "" ? !this.settingsManager.getPromptSummaries() : argument === "on";
			this.settingsManager.setPromptSummaries(enabled);
			this.showStatus(`Summaries ${enabled ? "on" : "off"}`);
			return true;
		}

		if (text === "/bell" || text.startsWith("/bell ")) {
			const argument = text.slice(5).trim().toLowerCase();
			this.editor.setText("");
			if (argument !== "" && argument !== "on" && argument !== "off") {
				this.showStatus("Usage: /bell [on|off]");
				return true;
			}
			const enabled =
				argument === "" ? !this.settingsManager.getNotifyOnTurnEnd() : argument === "on";
			this.settingsManager.setNotifyOnTurnEnd(enabled);
			this.showStatus(`Turn bell ${enabled ? "on" : "off"}`);
			return true;
		}

		if (text === "/compact" || text.startsWith("/compact ")) {
			const instructions = text.slice(8).trim();
			this.editor.setText("");
			if (this.session.isStreaming || this.session.isPreparingPrompt) {
				this.showWarning("Response in progress");
				return true;
			}
			if (this.session.isCompacting) {
				this.showWarning("Compaction in progress");
				return true;
			}
			try {
				await this.session.compact(instructions || undefined);
			} catch {
				// Rendered
			}
			return true;
		}

		if (text === "/reason" || text.startsWith("/reason ")) {
			const argument = text.startsWith("/reason ") ? text.slice(8).trim() : undefined;
			this.editor.setText("");
			this.handleReasonCommand(argument || undefined);
			return true;
		}

		if (text.startsWith("!")) {
			const isExcluded = text.startsWith("!!");
			const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
			if (command) {
				if (this.session.isBashRunning) {
					this.showWarning("A bash command is already running. Press Esc to cancel it first");
					this.editor.setText(text);
					return true;
				}
				this.editor.setText("");
				this.editor.addToHistory?.(text);
				await this.handleBashCommand(command, isExcluded);
				this.isBashMode = false;
				this.updateEditorBorderColor();
				return true;
			}
		}
		return false;
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			text = text.trim();
			if (!text) return;
			this.dismissWelcomeLogo();

			const parsed = parseDeliveryPrefix(text);
			if (parsed.setDefault) {
				this.settingsManager.setDefaultDeliveryMode(parsed.setDefault);
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				this.showStatus(parsed.setDefault === "steer" ? "Default: steering" : "Default: queue");
				this.ui.requestRender();
				return;
			}
			text = parsed.text;
			if (!text) return;

			if (await this.routeBuiltinInput(text)) return;

			if (!hasUsableModel(this.session.model) && !text.startsWith("/")) {
				this.showPromptWithoutModel(text);
				return;
			}

			if (this.session.isCompacting) {
				if (this.isExtensionCommand(text)) {
					this.editor.addToHistory?.(text);
					this.editor.setText("");
					try {
						await this.session.prompt(text);
					} catch (error) {
						this.reportPromptFailure(text, error);
					}
				} else {
					this.queueCompactionMessage(
						text,
						parsed.delivery ?? this.settingsManager.getDefaultDeliveryMode(),
					);
				}
				return;
			}

			if (this.session.isStreaming) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				try {
					await this.session.prompt(text, {
						streamingBehavior:
							parsed.delivery ?? this.settingsManager.getDefaultDeliveryMode(),
					});
				} catch (error) {
					this.reportPromptFailure(text, error);
					return;
				}
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				return;
			}

			this.flushPendingBashComponents();

			if (this.onInputCallback) {
				this.onInputCallback(text);
			} else {
				this.pendingUserInputs.push(text);
			}
			this.editor.addToHistory?.(text);
		};
	}

	subscribeToAgent(): void {
		subscribeToAgent(this);
	}

	async handleEvent(event: SessionEvent): Promise<void> {
		return handleEvent(this, event);
	}

	handleAgentStart(): void {
		handleAgentStart(this);
	}

	handleTurnStart(): void {
		handleTurnStart(this);
	}

	handleQueueUpdate(): void {
		handleQueueUpdate(this);
	}

	handleEntryAppended(event: AgentEventOf<"entry_appended">): void {
		handleEntryAppended(this, event);
	}

	handleSessionInfoChanged(): void {
		handleSessionInfoChanged(this);
	}

	handleThinkingLevelChanged(): void {
		handleThinkingLevelChanged(this);
	}

	estimateStreamingOutputTokens(message: AssistantMessage): number {
		return estimateStreamingOutputTokens(message);
	}

	handleMessageStart(event: AgentEventOf<"message_start">): void {
		handleMessageStart(this, event);
	}

	handleMessageUpdate(event: AgentEventOf<"message_update">): void {
		handleMessageUpdate(this, event);
	}

	handleMessageEnd(event: AgentEventOf<"message_end">): void {
		handleMessageEnd(this, event);
	}

	maybeWarnAboutCacheCold(isAssistant: boolean): void {
		maybeWarnAboutCacheCold(this, isAssistant);
	}

	handleHandsStarted(event: AgentEventOf<"hands_started">): void {
		handleHandsStarted(this, event);
	}

	handleHandsUpdated(event: AgentEventOf<"hands_updated">): void {
		handleHandsUpdated(this, event);
	}

	handleHandsFinished(event: AgentEventOf<"hands_finished">): void {
		handleHandsFinished(this, event);
	}

	openHand(handId: string): void {
		openHand(this, handId);
	}

	closeHand(): void {
		closeHand(this);
	}

	handleToolExecutionStart(event: AgentEventOf<"tool_execution_start">): void {
		handleToolExecutionStart(this, event);
	}

	handleToolExecutionUpdate(event: AgentEventOf<"tool_execution_update">): void {
		handleToolExecutionUpdate(this, event);
	}

	handleToolExecutionEnd(event: AgentEventOf<"tool_execution_end">): void {
		handleToolExecutionEnd(this, event);
	}

	handleAgentEnd(event: AgentEventOf<"agent_end">): void {
		handleAgentEnd(this, event);
	}

	async handleAgentSettled(): Promise<void> {
		return handleAgentSettled(this);
	}

	handleCompactionStart(event: AgentEventOf<"compaction_start">): void {
		handleCompactionStart(this, event);
	}

	handleCompactionEnd(event: AgentEventOf<"compaction_end">): void {
		handleCompactionEnd(this, event);
	}

	handleAutoRetryStart(event: AgentEventOf<"auto_retry_start">): void {
		handleAutoRetryStart(this, event);
	}

	handleAutoRetryEnd(event: AgentEventOf<"auto_retry_end">): void {
		handleAutoRetryEnd(this, event);
	}

	handleSummarizationRetryScheduled(event: AgentEventOf<"summarization_retry_scheduled">): void {
		handleSummarizationRetryScheduled(this, event);
	}

	handleSummarizationRetryAttemptStart(
		event: AgentEventOf<"summarization_retry_attempt_start">,
	): void {
		handleSummarizationRetryAttemptStart(this, event);
	}

	handleSummarizationRetryFinished(): void {
		handleSummarizationRetryFinished(this);
	}

	getUserMessageText(message: Message): string {
		return getUserMessageText(message);
	}

	showStatus(message: string, tone: "dim" | "success" | "warning" | "error" = "dim"): void {
		showStatus(this, message, tone);
	}

	addCustomEntryToChat(entry: Extract<SessionEntry, { type: "custom" }>): void {
		addCustomEntryToChat(this, entry);
	}

	isSilentTool(toolName: string): boolean {
		return isSilentTool(toolName);
	}

	resetActivity(): void {
		resetActivity(this);
	}

	trackActivity(toolCallId: string, name: string, args: unknown, timestamp = Date.now()): void {
		trackActivity(this, toolCallId, name, args, timestamp);
	}

	addChatChild(component: Component): Spacer | null {
		return addChatChild(this, component);
	}

	dropChatChild(component: Component, spacer: Spacer | null): void {
		dropChatChild(this, component, spacer);
	}

	addToolLine(line: ActivityLineComponent): void {
		addToolLine(this, line);
	}

	ensureCurrentActivity(): void {
		ensureCurrentActivity(this);
	}

	settleRunningActivities(message: string): void {
		settleRunningActivities(this, message);
	}

	settleCurrentActivity(): void {
		settleCurrentActivity(this);
	}

	updateActivity(toolCallId: string, update: Partial<ActivityRecord>): void {
		updateActivity(this, toolCallId, update);
	}

	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		addMessageToChat(this, message, options);
	}

	renderSessionItems(
		items: readonly RenderSessionItem[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		renderSessionItems(this, items, options);
	}

	renderSessionEntries(
		entries: SessionEntry[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		renderSessionEntries(this, entries, options);
	}

	addCompactionCostNotice(notice: CompactionCostNotice): void {
		addCompactionCostNotice(this, notice);
	}

	maybeShowThinkingDropNotice(message: AssistantMessage): void {
		maybeShowThinkingDropNotice(this, message);
	}

	renderInitialMessages(): void {
		renderInitialMessages(this);
	}

	renderProjectTrustWarningIfNeeded(): void {
		renderProjectTrustWarningIfNeeded(this);
	}

	async getUserInput(): Promise<string> {
		const queuedInput = this.pendingUserInputs.shift();
		if (queuedInput !== undefined) {
			return queuedInput;
		}

		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	private rebuildChatFromMessages(): void {
		rebuildChatFromMessages(this);
	}

	handleCtrlC(): void {
		handleCtrlC(this);
	}

	private handleCtrlD(): void {
		handleCtrlD(this);
	}

	isShuttingDown = false;

	async shutdown(options?: { fromSignal?: boolean; signal?: NodeJS.Signals }): Promise<void> {
		return shutdown(this, options);
	}

	emergencyTerminalExit(): never {
		return emergencyTerminalExit(this);
	}

	uncaughtCrash(error: Error): never {
		return uncaughtCrash(this, error);
	}

	async checkShutdownRequested(): Promise<void> {
		return checkShutdownRequested(this);
	}

	private registerSignalHandlers(): void {
		registerSignalHandlers(this);
	}

	unregisterSignalHandlers(): void {
		unregisterSignalHandlers(this);
	}

	private handleCtrlZ(): void {
		handleCtrlZ(this);
	}

	async handleFollowUp(): Promise<void> {
		return handleFollowUp(this);
	}

	private handleDequeue(): void {
		handleDequeue(this);
	}

	updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = this.session.thinkingLevel || "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.activeStatusIndicator?.invalidate();
		this.ui.requestRender();
	}

	// Model indicators
	refreshModelIndicators(): void {
		this.footer.invalidate();
		this.updateEditorBorderColor();
	}

	private handleReasonCommand(argument: string | undefined): void {
		handleReasonCommand(this, argument);
	}

	applyReasoningLevel(level: ThinkingLevel): void {
		applyReasoningLevel(this, level);
	}

	private cycleThinkingLevel(): void {
		cycleThinkingLevel(this);
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		return cycleModel(this, direction);
	}

	private toggleToolOutputExpansion(): void {
		toggleToolOutputExpansion(this);
	}

	setToolsExpanded(expanded: boolean): void {
		setToolsExpanded(this, expanded);
	}

	updateThinkingBlockVisibility(): void {
		updateThinkingBlockVisibility(this);
	}

	toggleThinkingBlockVisibility(): void {
		toggleThinkingBlockVisibility(this);
	}

	private async handleOpenExternalEditor(): Promise<void> {
		const editorCmd = this.settingsManager.getExternalEditorCommand();
		const content = this.editor.getExpandedText?.() ?? this.editor.getText();
		this.ui.stop();
		try {
			const result = await editInExternalEditor({
				command: editorCmd,
				content,
			});
			if (result.status === "complete") {
				this.editor.setText(result.content);
			} else if (result.reason === "timeout") {
				this.showStatus("Editor timed out");
			}
		} finally {
			this.ui.start();
			this.ui.requestRender(true);
		}
	}

	clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	private showPromptWithoutModel(text: string): void {
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		const component = new UserMessageComponent(
			text,
			this.getMarkdownThemeWithSettings(),
			this.outputPad,
			this.getMarkdownTransformers(),
		);
		this.addChatChild(component);
		this.showError(formatNoModelsAvailableMessage());
	}

	showError(errorMessage: string): void {
		showError(this, errorMessage);
	}

	showWarning(warningMessage: string): void {
		showWarning(this, warningMessage);
	}

	showNewVersionNotification(release: LatestGamaRelease): void {
		const isInstalled = () => this.updateNoticeVersion === release.version;

		const title = () =>
			isInstalled()
				? theme.bold(theme.fg("success", "Update Installed"))
				: theme.bold(theme.fg("warning", "Update Available"));
		const updateInstruction = () =>
			isInstalled()
				? theme.fg("success", `Updated to ${release.version}. Restart ${APP_NAME}`)
				: theme.fg("muted", `New version ${release.version} is available. Run `) +
					theme.fg("accent", `${APP_NAME} update`);
		const changelogLine = () =>
			theme.fg("muted", "Run ") +
			theme.fg("accent", "/changelog") +
			theme.fg("muted", " to see what changed.");
		const note = release.note?.trim();

		const card = new ThemedText(() => `${title()}\n${updateInstruction()}`, 1, 0);
		this.updateNoticeCard = card;

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new DynamicBorder((line) => theme.fg(isInstalled() ? "success" : "warning", line)),
		);
		this.chatContainer.addChild(
			new MouseRegion(card, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				void this.installRelease(release);
				return { handled: true };
			}),
		);
		if (note) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(note, 1, 0, this.getMarkdownThemeWithSettings(), {
					color: (text) => theme.fg("muted", text),
				}),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new ThemedText(changelogLine, 1, 0));
		this.chatContainer.addChild(
			new DynamicBorder((line) => theme.fg(isInstalled() ? "success" : "warning", line)),
		);
		this.ui.requestRender();
	}

	private handleUpdateCommand(): void {
		const release = this.availableRelease;
		if (!release) {
			this.showStatus("No update available");
			return;
		}
		void this.installRelease(release);
	}

	private async installRelease(release: LatestGamaRelease): Promise<boolean> {
		if (this.updateInProgress) return false;

		const command = getSelfUpdateCommand(PACKAGE_NAME, undefined, {
			packageName: PACKAGE_NAME,
			installSpec: `${PACKAGE_NAME}@${release.version}`,
		});
		if (!command) {
			this.showWarning(getSelfUpdateUnavailableInstruction(PACKAGE_NAME));
			return false;
		}

		this.updateInProgress = true;
		const output: string[] = [];
		const panel = new ThemedText(() => output.join("\n"), 1, 0);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(panel);

		const write = (line: string) => {
			output.push(line);
			panel.invalidate();
			this.ui.requestRender();
		};

		try {
			write(theme.bold(`Updating ${APP_NAME} ${VERSION} -> ${release.version}`));
			write(theme.fg("dim", command.display));

			let buffer = "";
			const read = (chunk: string) => {
				buffer += stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (line.trim()) write(theme.fg("muted", line));
				}
			};

			for (const step of command.steps ?? [command]) {
				const exitCode = await new Promise<number>((resolve) => {
					const child = crossSpawn(step.command, step.args, {
						stdio: ["ignore", "pipe", "pipe"],
					});
					child.stdout?.on("data", (chunk) => read(chunk.toString()));
					child.stderr?.on("data", (chunk) => read(chunk.toString()));
					child.on("error", () => resolve(1));
					child.on("close", (code) => resolve(code ?? 1));
				});

				if (buffer.trim()) {
					write(theme.fg("muted", buffer.trim()));
					buffer = "";
				}
				if (exitCode !== 0) {
					write(theme.fg("error", `Update failed: ${exitCode}`));
					return false;
				}
			}

			this.availableRelease = undefined;
			this.updateNoticeVersion = release.version;
			this.updateNoticeCard?.invalidate();
			this.ui.requestRender();
			return true;
		} catch (error) {
			const message = error instanceof Error && error.message ? error.message : String(error);
			write(theme.fg("error", `Update failed: ${message}`));
			return false;
		} finally {
			this.updateInProgress = false;
		}
	}

	private async handleChangelogCommand(): Promise<void> {
		const release = this.availableRelease;
		const version = release?.version;

		const entries = parseChangelog(getChangelogPath());
		let markdown = release?.note?.trim();
		if (!markdown && version) {
			const localEntry = findChangelogEntry(entries, version);
			if (localEntry) markdown = normalizeChangelogLinks(localEntry.content, localEntry);
		}
		if (!markdown && version) {
			markdown = await fetchChangelogForVersion(PACKAGE_NAME, version);
		}
		if (!markdown && !version) {
			const currentEntry = findChangelogEntry(entries, VERSION);
			if (currentEntry) markdown = normalizeChangelogLinks(currentEntry.content, currentEntry);
		}

		if (!markdown) {
			this.showWarning(version ? `No changelog: ${version}` : "No changelog");
			return;
		}

		this.showChangelogPanel(version, markdown);
	}

	private showChangelogPanel(version: string | undefined, markdown: string): void {
		const body = markdown.replace(/^##\s+\[?\d+\.\d+\.\d+\]?[^\n]*\n?/, "").trim();
		const label = version ?? VERSION;
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(
			new ThemedText(
				() => `${theme.fg("accent", "Changelog")}  ${chip(theme.fg("accent", label))}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(body, 1, 0, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	showPackageUpdateNotification(packages: string[]): void {
		const updateInstruction = () =>
			theme.fg("muted", "Package updates are available. Run ") +
			theme.fg("accent", `${APP_NAME} update --extensions`);
		const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new ThemedText(
				() => {
					const title = theme.bold(theme.fg("warning", "Package Updates Available"));
					const packagesLabel = theme.fg("muted", "Packages:");
					return `${title}\n${updateInstruction()}\n${packagesLabel}\n${packageLines}`;
				},
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return {
			steering: [
				...this.session.getSteeringMessages(),
				...this.compactionQueuedMessages
					.filter((msg) => msg.mode === "steer")
					.map((msg) => msg.text),
			],
			followUp: [
				...this.session.getFollowUpMessages(),
				...this.compactionQueuedMessages
					.filter((msg) => msg.mode === "followUp")
					.map((msg) => msg.text),
			],
		};
	}

	private clearAllQueues(): { steering: string[]; followUp: string[] } {
		const { steering, followUp } = this.session.clearQueue();
		const compactionSteering = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "steer")
			.map((msg) => msg.text);
		const compactionFollowUp = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "followUp")
			.map((msg) => msg.text);
		this.compactionQueuedMessages = [];
		return {
			steering: [...steering, ...compactionSteering],
			followUp: [...followUp, ...compactionFollowUp],
		};
	}

	// Docked prompts
	updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		// Skip docked prompts while a hand view is open
		if (this.handViewId !== undefined) return;
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.addChild(component);
		}

		const { steering, followUp } = this.getAllQueuedMessages();
		const addSpacer = () => {
			const children = this.pendingMessagesContainer.children;
			if (children.length === 0 || !(children[children.length - 1] instanceof Spacer)) {
				this.pendingMessagesContainer.addChild(new Spacer(1));
			}
		};

		for (const message of steering) {
			addSpacer();
			this.pendingMessagesContainer.addChild(
				new UserMessageComponent(
					message,
					this.getMarkdownThemeWithSettings(),
					this.outputPad,
					this.getMarkdownTransformers(),
				),
			);
		}

		if (followUp.length === 0) return;
		addSpacer();
		this.pendingMessagesContainer.addChild(this.getQueuedMessagesComponent(followUp));
	}

	private getQueuedMessagesComponent(messages: string[]): QueuedMessagesComponent {
		if (!this.queuedMessagesComponent) {
			this.queuedMessagesComponent = new QueuedMessagesComponent(() => this.ui.requestRender());
		}

		this.queuedMessagesComponent.setMessages(messages);
		return this.queuedMessagesComponent;
	}

	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.clearAllQueues();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				void this.session.abort();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.editor.getText();
		const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			void this.session.abort();
		}
		return allQueued.length;
	}

	// Prompt failure
	reportPromptFailure(text: string, error: unknown): void {
		this.showError(error instanceof Error ? error.message : "Unknown error");
		const current = this.editor.getText().trim();
		this.editor.setText(current ? `${text}\n\n${current}` : text);
		this.ui.requestRender();
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		queueCompactionMessage(this, text, mode);
	}

	isExtensionCommand(text: string): boolean {
		return isExtensionCommand(this, text);
	}

	async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		return flushCompactionQueue(this, options);
	}

	private flushPendingBashComponents(): void {
		flushPendingBashComponents(this);
	}

	private setModalMouse(active: boolean): void {
		if (this.renderer instanceof MainScreen) this.renderer.setMouseTracking(active);
	}

	private disposeActiveSelector(): void {
		const dispose = this.activeSelectorDispose;
		this.activeSelectorToken = undefined;
		this.activeSelectorDispose = undefined;
		dispose?.();
	}

	showSelector(
		create: (done: () => void) => {
			component: Component;
			focus: Component;
			dispose?: () => void;
		},
	): void {
		const token = {};
		let dispose: (() => void) | undefined;
		const done = () => {
			dispose?.();
			if (this.activeSelectorToken !== token) return;
			this.activeSelectorToken = undefined;
			this.activeSelectorDispose = undefined;
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.setModalMouse(false);
		};
		const created = create(done);
		dispose = created.dispose;
		this.disposeActiveSelector();
		this.activeSelectorToken = token;
		this.activeSelectorDispose = dispose;
		this.editorContainer.clear();
		this.editorContainer.addChild(created.component);
		this.ui.setFocus(created.focus);
		this.setModalMouse(true);
		this.ui.requestRender();
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (searchTerm === "connect" || searchTerm === "add") {
			this.showConnectProviderDialog();
			return;
		}
		if (!searchTerm) {
			if (this.session.modelRuntime.getAvailableSnapshot().length > 0) {
				await this.fetchModelCatalogsWithLoader();
				this.showModelSelector(undefined, undefined, { skipInitialRefresh: true });
			} else this.showConnectProviderDialog();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				await this.session.setModel(model, { persist: false });
				this.refreshModelIndicators();
				this.showStatus(`Model: ${model.id}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showModelSelector(searchTerm, undefined, { skipInitialRefresh: true });
	}

	showContextPanel(rows: ReadonlyArray<[string, string]>): void {
		showContextPanel(this, rows);
	}

	private showCachePanel(): void {
		showCachePanel(this);
	}

	private showStatsPanel(): void {
		showStatsPanel(this);
	}

	private parseContextWindowInput(raw: string): number | undefined {
		return parseContextWindowInput(raw);
	}

	private async handleContextCommand(argument?: string): Promise<void> {
		const model = this.session.model;
		if (!model) {
			this.showWarning("No model selected");
			return;
		}

		const modelsPath = getModelsPath();

		if (argument) {
			const tokens = this.parseContextWindowInput(argument);
			if (tokens === undefined) {
				this.showWarning(
					`Invalid context window "${argument}". Use a token count like 200000 or 1m.`,
				);
				return;
			}
			try {
				await saveModelOverride(modelsPath, model.provider, model.id, {
					contextWindow: tokens,
				});
				await this.session.modelRuntime.refresh({ allowNetwork: false });
				const updated = this.session.modelRuntime
					.getAvailableSnapshot()
					.find(
						(candidate) => candidate.provider === model.provider && candidate.id === model.id,
					);
				if (updated) {
					await this.session.setModel(updated, { persist: false });
				}
				this.footer.invalidate();
				this.showContextPanel([
					["model", `${model.provider}/${model.id}`],
					["context window", `${formatTokens(tokens)} tokens`],
					["change with", "/context <tokens>"],
					["stored in", modelsPath],
				]);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		const currentWindow = model.contextWindow ?? 0;
		const windowLabel = currentWindow > 0 ? `${formatTokens(currentWindow)} tokens` : "unknown";
		this.showContextPanel([
			["model", `${model.provider}/${model.id}`],
			["context window", windowLabel],
			[
				"max output",
				model.maxTokens > 0 ? `${formatTokens(model.maxTokens)} tokens` : "unknown",
			],
			["change with", "/context <tokens>  e.g. /context 1m"],
			["stored in", modelsPath],
		]);
	}

	// Fetch catalogs
	private async fetchModelCatalogsWithLoader(): Promise<void> {
		const loader = new BorderedLoader(this.ui, theme, "Fetching models...", {
			cancellable: false,
		});
		const controller = new AbortController();
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, CATALOG_TIMEOUT_MS);
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.requestRender();
		try {
			await refreshModelCatalogs(this.session.modelRuntime, controller.signal);
		} catch (error) {
			const failure = error instanceof Error ? error.message : String(error);
			const message = timedOut ? "Refresh timed out" : `Refresh failed: ${failure}`;
			this.showWarning(message);
		} finally {
			clearTimeout(timeout);
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		}
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		await this.fetchModelCatalogsWithLoader();
		const models =
			this.session.scopedModels.length > 0
				? this.session.scopedModels.map((scoped) => scoped.model)
				: [...this.session.modelRuntime.getAvailableSnapshot()];
		return findExactModelReferenceMatch(searchTerm, models);
	}

	updateAvailableProviderCount(): void {
		const models =
			this.session.scopedModels.length > 0
				? this.session.scopedModels.map((scoped) => scoped.model)
				: this.session.modelRuntime.getAvailableSnapshot();
		const uniqueProviders = new Set(models.map((model) => model.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	async maybeWarnAboutAnthropicSubscriptionAuth(
		model: Model<any> | undefined = this.session.model,
	): Promise<void> {
		if (this.settingsManager.getWarnings().anthropicExtraUsage === false) {
			return;
		}
		if (this.anthropicSubscriptionWarningShown) {
			return;
		}
		if (!model || model.provider !== "anthropic") {
			return;
		}

		try {
			const apiKey = (await this.session.modelRuntime.getAuth(model.provider))?.auth.apiKey;
			if (!isAnthropicSubscriptionAuthKey(apiKey)) {
				return;
			}
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
		} catch {}
	}

	private maybeSaveImplicitProjectTrustAfterReload(): boolean {
		const cwd = this.sessionManager.getCwd();
		if (this.autoTrustOnReloadCwd !== cwd) {
			return false;
		}
		if (!this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(cwd)) {
			return false;
		}

		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		try {
			if (trustStore.get(cwd) !== null) {
				this.autoTrustOnReloadCwd = undefined;
				return false;
			}
			trustStore.set(cwd, true);
			this.autoTrustOnReloadCwd = undefined;
			return true;
		} catch {
			this.showWarning("Trust not saved");
			return false;
		}
	}

	private showConnectProviderDialog(prefill?: ConnectProviderInput): void {
		this.showSelector((done) => {
			const dialog = new ConnectProviderDialogComponent({
				onContinue: (input) => {
					done();
					void this.connectProvider(input);
				},
				onCancel: () => {
					done();
					this.ui.requestRender();
				},
				initialBaseUrl: prefill?.baseUrl,
				initialApiKey: prefill?.apiKey,
			});
			return { component: dialog, focus: dialog };
		});
	}

	private async connectProvider(input: ConnectProviderInput): Promise<void> {
		const controller = new AbortController();
		let closeLoader: (() => void) | undefined;
		const loader = new BorderedLoader(this.ui, theme, "Fetching models...", {
			showCancelHint: false,
		});
		this.showSelector((done) => {
			closeLoader = done;
			loader.onAbort = () => {
				controller.abort();
				done();
				this.ui.requestRender();
			};
			return { component: loader, focus: loader, dispose: () => loader.dispose() };
		});

		try {
			const endpointModels = await fetchEndpointModels(input.baseUrl, input.apiKey, {
				signal: controller.signal,
			});
			if (controller.signal.aborted) return;
			if (endpointModels.length === 0) throw new Error("No models found");

			const builtinModels = [...this.session.modelRuntime.getModels()];

			// Catalog data
			const catalog =
				process.env.GAMA_OFFLINE === undefined
					? await fetchModelsDevCatalog({ signal: controller.signal }).catch(() => undefined)
					: undefined;
			if (controller.signal.aborted) return;

			const baseUrl = normalizeBaseUrl(input.baseUrl);
			const existingProviderIds = new Set([
				...builtinModels.map((model) => model.provider),
				...this.session.modelRuntime.getAvailableSnapshot().map((model) => model.provider),
			]);
			const catalogProviderId = deriveProviderId(baseUrl);
			const resolved = resolveModels(endpointModels, builtinModels, catalog, catalogProviderId);
			const providerId = uniqueProviderId(catalogProviderId, existingProviderIds);
			const modelDefinitions = resolved.map((model) => ({
				id: model.id,
				name: model.name,
				input: model.input,
				cost: model.cost ?? NO_PRICE,
				reasoning: model.reasoning,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				...(model.cacheControlFormat
					? { compat: { cacheControlFormat: model.cacheControlFormat } }
					: {}),
			}));

			this.session.modelRuntime.registerProvider(providerId, {
				name: providerId,
				baseUrl,
				apiKey: input.apiKey,
				api: CUSTOM_PROVIDER_API,
				models: modelDefinitions,
			});
			await this.session.modelRuntime.refresh({ providers: [providerId] });
			if (controller.signal.aborted) return;

			let persistError: string | undefined;
			try {
				await saveCustomProviderModels(getModelsPath(), providerId, {
					name: providerId,
					baseUrl,
					api: CUSTOM_PROVIDER_API,
					models: modelDefinitions,
				});
				const authStorage = AuthStorage.create(getAuthPath());
				await authStorage.modify(providerId, async () => ({
					type: "api_key",
					key: input.apiKey,
				}));
			} catch (error) {
				persistError = error instanceof Error ? error.message : String(error);
			}

			closeLoader?.();
			this.updateAvailableProviderCount();
			this.footer.invalidate();
			this.showStatus(`Connected ${providerId}`);
			if (persistError) {
				this.showWarning("Provider not saved");
			}
			this.showModelSelector(undefined, providerId);
		} catch (error) {
			if (controller.signal.aborted) return;
			closeLoader?.();
			this.showError(error instanceof Error ? error.message : String(error));
			this.showConnectProviderDialog(input);
		}
	}

	// Configured providers
	private configuredProviders(): ProviderChoice[] {
		const runtime = this.session.modelRuntime;
		return runtime
			.getProviders()
			.map((provider) => ({
				id: provider.id,
				baseUrl: provider.baseUrl,
				status: runtime.getProviderAuthStatus(provider.id),
			}))
			.filter((entry) => entry.status.configured)
			.map((entry) => ({
				id: entry.id,
				baseUrl: entry.baseUrl,
				authLabel: entry.status.label ?? entry.status.source,
			}))
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	private async handleProviderCommand(argument?: string): Promise<void> {
		const providers = this.configuredProviders();
		if (providers.length === 0) {
			this.showWarning("No providers configured");
			return;
		}
		if (argument) {
			const needle = argument.toLowerCase();
			const exact = providers.find((provider) => provider.id.toLowerCase() === needle);
			const partial = providers.filter((provider) => provider.id.toLowerCase().includes(needle));
			const match = exact ?? (partial.length === 1 ? partial[0] : undefined);
			if (match) {
				this.showEditProviderDialog(match.id);
				return;
			}
			this.showWarning("No provider match");
			return;
		}
		this.showProviderSelector(providers);
	}

	private showProviderSelector(providers: readonly ProviderChoice[]): void {
		this.showSelector((done) => {
			const selector = new ProviderSelectorComponent({
				providers,
				onSelect: (providerId) => {
					done();
					this.showEditProviderDialog(providerId);
				},
				onDelete: (providerId) => {
					done();
					void this.deleteProvider(providerId);
				},
				onCancel: () => {
					done();
					this.ui.requestRender();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	private showEditProviderDialog(providerId: string): void {
		const provider = this.session.modelRuntime.getProvider(providerId);
		this.showSelector((done) => {
			const dialog = new ConnectProviderDialogComponent({
				title: `Edit provider ${providerId}`,
				submitLabel: "Save",
				apiKeyPlaceholder: "unchanged",
				baseUrlOptional: true,
				onContinue: (input) => {
					done();
					// Keeps current
					const baseUrl =
						input.baseUrl.trim() !== "" ? input.baseUrl : (provider?.baseUrl ?? "");
					void this.saveProviderEndpoint(providerId, { ...input, baseUrl });
				},
				onCancel: () => {
					done();
					this.ui.requestRender();
				},
			});
			return { component: dialog, focus: dialog };
		});
	}

	// Save endpoint
	private async deleteProvider(providerId: string): Promise<void> {
		try {
			await deleteCustomProvider(getModelsPath(), providerId);
			await AuthStorage.create(getAuthPath()).delete(providerId);
			this.session.modelRuntime.unregisterProvider(providerId);
			await this.session.modelRuntime.refresh({ allowNetwork: false });
			if (this.session.model?.provider === providerId) {
				const fallback = this.session.modelRuntime.getAvailableSnapshot()[0];
				if (fallback) {
					await this.session.setModel(fallback, { persist: true });
				} else {
					this.session.clearModel();
				}
			}
			this.updateAvailableProviderCount();
			this.refreshModelIndicators();
			this.footer.invalidate();
			this.showStatus(`Deleted provider ${providerId}`, "success");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async saveProviderEndpoint(
		providerId: string,
		input: ConnectProviderInput,
	): Promise<void> {
		const baseUrl = normalizeBaseUrl(input.baseUrl);
		if (!baseUrl) {
			this.showError("Base URL required");
			this.showEditProviderDialog(providerId);
			return;
		}
		const apiKey = input.apiKey.trim();
		try {
			await saveProviderBaseUrl(getModelsPath(), providerId, baseUrl);
			if (apiKey !== "") {
				const authStorage = AuthStorage.create(getAuthPath());
				await authStorage.modify(providerId, async () => ({ type: "api_key", key: apiKey }));
			}
			await this.session.modelRuntime.refresh({ allowNetwork: false, providers: [providerId] });
			this.updateAvailableProviderCount();
			this.refreshModelIndicators();
			this.footer.invalidate();
			this.showStatus(`Updated ${providerId}`, "success");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			this.showEditProviderDialog(providerId);
		}
	}

	private showModelSelector(
		initialSearchInput?: string,
		providerFilter?: string,
		options?: { skipInitialRefresh?: boolean },
	): void {
		this.showSelector((done) => {
			const selectModel = async (model: Model<any>) => {
				try {
					await this.session.setModel(model, { persist: true });
					try {
						await rememberCustomProviderModel(getModelsPath(), model);
					} catch (_error) {
						this.showWarning("Model not saved");
					}
					this.updateAvailableProviderCount();
					this.refreshModelIndicators();
					done();
					void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
				} catch (error) {
					done();
					this.showError(error instanceof Error ? error.message : String(error));
				}
			};
			const defaultProvider = this.settingsManager.getDefaultProvider();
			const defaultModel = this.settingsManager.getDefaultModel();
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.session.modelRuntime,
				this.session.scopedModels,
				(model) => selectModel(model),
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
				(model) => selectModel(model),
				defaultProvider && defaultModel
					? { provider: defaultProvider, id: defaultModel }
					: undefined,
				providerFilter,
				() => this.showConnectProviderDialog(),
				options?.skipInitialRefresh ?? false,
			);
			return { component: selector, focus: selector, dispose: () => selector.dispose() };
		});
	}

	private showUserMessageSelector(): void {
		const userMessages = this.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			this.showStatus("No messages found");
			return;
		}

		const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					done();
					try {
						const result = await this.runtimeHost.fork(entryId);
						if (result.cancelled) {
							this.ui.requestRender();
							return;
						}

						this.editor.setText(result.selectedText ?? "");
						this.showStatus("Forked session");
					} catch (error: unknown) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSelectedId,
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private showSessionSelector(): void {
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress, signal) =>
					SessionStore.list(
						this.sessionManager.getCwd(),
						this.sessionManager.getSessionDir(),
						onProgress,
						signal,
					),
				(onProgress, signal) =>
					this.sessionManager.usesDefaultSessionDir()
						? SessionStore.listAll(onProgress, signal)
						: SessionStore.listAll(this.sessionManager.getSessionDir(), onProgress, signal),
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.ui.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const mgr = SessionStore.open(sessionFilePath);
						mgr.appendSessionInfo(next);
					},
					keybindings: this.keybindings,
				},

				this.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector, dispose: () => selector.dispose() };
		});
	}

	private async handleResumeSession(
		sessionPath: string,
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean }> {
		return handleResumeSession(this, sessionPath, options);
	}

	private async handleReloadCommand(): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Response in progress");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Compaction in progress");
			return;
		}

		this.resetExtensionUI();

		const reloadBox = new Container();
		const borderColor = (s: string) => theme.fg("border", s);
		reloadBox.addChild(new DynamicBorder(borderColor));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new ThemedText(() => theme.fg("muted", "Reloading config..."), 1, 0));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new DynamicBorder(borderColor));

		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(reloadBox);
		this.ui.setFocus(reloadBox);
		this.ui.requestRender(true);
		await new Promise((resolve) => process.nextTick(resolve));

		const dismissReloadBox = (editor: Component) => {
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.ui.requestRender();
		};

		let chatRestoredBeforeSessionStart = false;
		let reloadBoxDismissed = false;
		const restoreChatBeforeSessionStart = () => {
			if (chatRestoredBeforeSessionStart) {
				return;
			}
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			this.outputPad = this.settingsManager.getOutputPad();
			this.rebuildChatFromMessages();
			chatRestoredBeforeSessionStart = true;
		};

		try {
			await this.session.reload({ beforeSessionStart: restoreChatBeforeSessionStart });
			restoreChatBeforeSessionStart();
			this.keybindings.reload();
			const activeHeader = this.customHeader ?? this.builtInHeader;
			if (isExpandable(activeHeader)) {
				activeHeader.setExpanded(this.toolOutputExpanded);
			}
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			this.applyRuntimeSettings();
			this.themeController.applyFromSettings();
			this.setupAutocompleteProvider();
			const runner = this.session.extensionRunner;
			this.setupExtensionShortcuts(runner);
			this.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const savedImplicitProjectTrust = this.maybeSaveImplicitProjectTrustAfterReload();
			const modelsJsonError = this.session.modelRuntime.getError();
			if (modelsJsonError) {
				this.showError(`Models failed: ${modelsJsonError}`);
			}
			const reloaded = "Reloaded config";
			this.showStatus(savedImplicitProjectTrust ? `${reloaded}; saved project trust` : reloaded);
			dismissReloadBox(this.editor as Component);
			reloadBoxDismissed = true;
		} catch (error) {
			if (!reloadBoxDismissed) {
				dismissReloadBox(previousEditor as Component);
			}
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleCopyCommand(
		options: { flashConfirmation?: boolean; preferSelection?: boolean } = {},
	): Promise<void> {
		if (
			options.preferSelection &&
			this.ui instanceof AltScreen &&
			!this.ui.getCopyOnSelect() &&
			this.ui.hasActiveSelection()
		) {
			await this.ui.copyActiveSelectionToClipboard();
			return;
		}

		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("No messages");
			return;
		}

		try {
			await copyToClipboard(text);
			if (options.flashConfirmation && this.ui instanceof AltScreen) {
				this.ui.flash("Copied!");
			} else {
				this.showStatus("Message copied");
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handleClearCommand(): Promise<void> {
		this.clearStatusIndicator();
		try {
			const result = await this.runtimeHost.newSession();
			if (result.cancelled) {
				return;
			}
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new ThemedText(() => theme.fg("accent", "New session started"), 1, 1),
			);
			this.ui.requestRender();
		} catch (error: unknown) {
			await this.handleFatalRuntimeError("Create failed", error);
		}
	}

	private handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);

		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const lineWidth = visibleWidth(line);
				const escaped = JSON.stringify(line);

				return `[${idx}] (w=${lineWidth}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true, mode: 0o700 });
		fs.writeFileSync(debugLogPath, debugData, { mode: 0o600 });

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new ThemedText(
				() => `${theme.fg("accent", "Debug log written")}\n${theme.fg("muted", debugLogPath)}`,
				1,
				1,
			),
		);
		this.ui.requestRender();
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		let eventResult: UserBashEventResult | undefined;
		try {
			eventResult = await extensionRunner.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext,
				cwd: this.sessionManager.getCwd(),
			});
		} catch {
			return;
		}

		if (eventResult?.result) {
			const result = eventResult.result;

			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated
					? ({ truncated: true, content: result.output } as TruncationResult)
					: undefined,
				result.fullOutputPath,
			);

			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);

		if (isDeferred) {
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			this.chatContainer.addChild(this.bashComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.ui.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated
						? ({ truncated: true, content: result.output } as TruncationResult)
						: undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setFailed();
			}
			this.showError(`Bash failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	stop(fullscreenExitOutput = this.settingsManager.getFullscreenExitOutput()): void {
		this.disposeActiveSelector();
		if (this.settingsManager.getShowTerminalProgress()) {
			this.ui.terminal.setProgress(false);
		}
		this.clearStatusIndicator();
		this.themeController.disableAutoSync();
		this.clearExtensionTerminalInputListeners();
		this.welcomeLogo?.dispose();
		this.welcomeLogo = undefined;
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.isInitialized) {
			this.stopInteractiveTui(fullscreenExitOutput);
			this.isInitialized = false;
		}
		this.unregisterSignalHandlers();
	}
}
