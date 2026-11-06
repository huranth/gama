import { type Component, Container, Key, matchesKey } from "@huranth/gama-tui";
import type { SessionEvent } from "../core/session/session.ts";
import type { TermApp } from "./app.ts";
import { HandBackComponent } from "./parts/hand-back.ts";
import { HandCardComponent } from "./parts/hand-card.ts";
import { HandGridComponent } from "./parts/hand-grid.ts";
import { HandViewComponent } from "./parts/hand-view.ts";

export function handleHandsStarted(
	mode: TermApp,
	event: Extract<SessionEvent, { type: "hands_started" }>,
): void {
	// New grid.
	const grid = new HandGridComponent();
	mode.handGrid = grid;
	mode.addChatChild(grid);
	for (const hand of event.hands) {
		mode.handSnapshots.set(hand.id, hand);
		const card = new HandCardComponent(hand, () => mode.openHand(hand.id));
		mode.handCards.set(hand.id, card);
		grid.addCard(card);
	}
	mode.ui.invalidate();
	mode.ui.requestRender();
}

export function handleHandsUpdated(
	mode: TermApp,
	event: Extract<SessionEvent, { type: "hands_updated" }>,
): void {
	const hand = event.hand;
	mode.handSnapshots.set(hand.id, hand);
	mode.handCards.get(hand.id)?.setSnapshot(hand);
	if (mode.handViewId === hand.id) mode.handViewComponent?.setSnapshot(hand);
	mode.ui.requestRender();
}

export function handleHandsFinished(
	mode: TermApp,
	event: Extract<SessionEvent, { type: "hands_finished" }>,
): void {
	for (const hand of event.hands) {
		mode.handSnapshots.set(hand.id, hand);
		mode.handCards.get(hand.id)?.setSnapshot(hand);
		if (mode.handViewId === hand.id) mode.handViewComponent?.setSnapshot(hand);
	}
	mode.ui.requestRender();
}

export function openHand(mode: TermApp, handId: string): void {
	const hand = mode.handSnapshots.get(handId);
	if (!hand || mode.handViewId === handId) return;
	if (mode.handViewId) mode.closeHand();

	mode.handEditorText = mode.editor.getText();
	mode.handViewId = handId;
	mode.updatePendingMessagesDisplay();
	mode.handViewComponent = new HandViewComponent(
		hand,
		mode.getMarkdownThemeWithSettings(),
		mode.outputPad,
		mode.getMarkdownTransformers(),
		{
			cwd: () => mode.sessionManager.getCwd(),
			hideThinkingBlock: mode.hideThinkingBlock,
			hiddenThinkingLabel: mode.hiddenThinkingLabel,
			requestRender: () => mode.ui.requestRender(),
			onToggleThinking: () => mode.toggleThinkingBlockVisibility(),
			toolOutputExpanded: mode.toolOutputExpanded,
		},
	);
	mode.handViewContainer = new Container();
	mode.handViewContainer.addChild(mode.handViewComponent);
	mode.documentContainer.removeChild(mode.chatContainer);
	mode.documentContainer.addChild(mode.handViewContainer);
	mode.editorContainer.clear();
	mode.editorContainer.addChild(new HandBackComponent(() => mode.closeHand()));
	mode.dockEditorColumn?.setOffsetOverride(0);
	mode.ui.setFocus(null);
	mode.transcriptScrollView?.setAlign("end");
	mode.transcriptScrollView?.scrollToEnd();
	mode.handViewInputUnsubscribe = mode.ui.addInputListener((data) => {
		if (matchesKey(data, Key.escape)) {
			mode.closeHand();
			return { consume: true };
		}
		return undefined;
	});
	mode.ui.invalidate();
	mode.ui.requestRender();
}

export function closeHand(mode: TermApp): void {
	const view = mode.handViewContainer;
	if (!view) return;

	mode.handViewInputUnsubscribe?.();
	mode.handViewInputUnsubscribe = undefined;
	mode.documentContainer.removeChild(view);
	mode.documentContainer.addChild(mode.chatContainer);
	mode.handViewComponent?.dispose();
	mode.handViewContainer = undefined;
	mode.handViewComponent = undefined;
	mode.handViewId = undefined;
	mode.updatePendingMessagesDisplay();
	mode.editorContainer.clear();
	mode.editorContainer.addChild(mode.editor as Component);
	mode.dockEditorColumn?.setOffsetOverride(undefined);
	if (mode.handEditorText !== undefined) {
		mode.editor.setText(mode.handEditorText);
		mode.handEditorText = undefined;
	}
	mode.ui.setFocus(mode.editor);
	mode.transcriptScrollView?.setAlign("start");
	mode.transcriptScrollView?.scrollToEnd();
	mode.ui.invalidate();
	mode.ui.requestRender();
}
