import type { ExtensionCommandContext } from "../core/ext/index.ts";
import { MissingSessionCwdError } from "../core/session-cwd.ts";
import type { TermApp } from "./app.ts";

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function subscribeToAgent(mode: TermApp): void {
	let queue: Promise<void> = Promise.resolve();

	mode.unsubscribe = mode.session.subscribe((event) => {
		queue = queue
			.then(() => mode.handleEvent(event))
			.catch((error: unknown) => {
				mode.showError(`Event failed: ${messageOf(error)}`);
			});
	});
}

export function renderCurrentSessionState(mode: TermApp): void {
	mode.closeHand();
	mode.handCards.clear();
	mode.handGrid = undefined;
	mode.handSnapshots.clear();
	mode.loadedResourcesContainer.clear();
	mode.resetActivity();
	mode.chatContainer.clear();
	mode.pendingMessagesContainer.clear();
	mode.compactionQueuedMessages = [];
	mode.streamingComponent = undefined;
	mode.streamingMessage = undefined;
	mode.pendingToolCalls.clear();
	mode.renderInitialMessages();
}

export function rebuildChatFromMessages(mode: TermApp): void {
	mode.resetActivity();
	mode.chatContainer.clear();
	mode.renderSessionEntries(mode.sessionManager.buildContextEntries());
}

export async function rebindCurrentSession(
	mode: TermApp,
	options: { renderBeforeBind?: boolean } = {},
): Promise<void> {
	const session = mode.session;
	mode.cacheColdWarningShown = false;

	mode.unsubscribe?.();
	mode.unsubscribe = undefined;
	mode.applyRuntimeSettings();

	if (options.renderBeforeBind) {
		mode.renderCurrentSessionState();
		mode.subscribeToAgent();
	}

	await mode.bindCurrentSessionExtensions();

	if (mode.session !== session) {
		return;
	}

	if (!options.renderBeforeBind) {
		mode.subscribeToAgent();
	}

	await mode.updateAvailableProviderCount();
	mode.updateEditorBorderColor();
	mode.updateTerminalTitle();
}

export async function handleResumeSession(
	mode: TermApp,
	sessionPath: string,
	options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
): Promise<{ cancelled: boolean }> {
	mode.clearStatusIndicator();
	try {
		const result = await mode.runtimeHost.switchSession(sessionPath, {
			withSession: options?.withSession,
			projectTrustContextFactory: (cwd) => mode.createProjectTrustContext(cwd),
		});
		if (result.cancelled) {
			return result;
		}
		mode.showStatus("Resumed session");
		return result;
	} catch (error: unknown) {
		if (error instanceof MissingSessionCwdError) {
			const selectedCwd = await mode.promptForMissingSessionCwd(error);
			if (!selectedCwd) {
				mode.showStatus("Resume cancelled");
				return { cancelled: true };
			}
			const result = await mode.runtimeHost.switchSession(sessionPath, {
				cwdOverride: selectedCwd,
				withSession: options?.withSession,
				projectTrustContextFactory: (cwd) => mode.createProjectTrustContext(cwd),
			});
			if (result.cancelled) {
				return result;
			}
			mode.showStatus("Resumed in cwd");
			return result;
		}
		return mode.handleFatalRuntimeError("Resume failed", error);
	}
}
