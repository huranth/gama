import {
	AltScreenSearchComponent,
	AltScreenSearchIndex,
	getAltScreenSearchMatchKey,
} from "./alt-screen-search.ts";
import { KittyImageCache } from "./fullscreen/images.ts";
import {
	createMouseEvent,
	decodeMouseButton,
	isMouseSequence,
	parseSgrMouseEvent,
	parseWheelEvent,
	resolveWheelDelta,
	type SgrMouseEvent,
	type WheelEvent,
} from "./fullscreen/mouse.ts";
import {
	getScrollbarTargetAt,
	ScrollbarController,
	type ScrollbarTarget,
} from "./fullscreen/scrollbar.ts";
import {
	type ActiveSearch,
	applySearchTextHighlight,
	getSearchHighlightRanges,
	pickSearchSelection,
} from "./fullscreen/search.ts";
import { TextSelection, type SelectionHost } from "./fullscreen/selection.ts";
import { getKeybindings } from "./keybindings.ts";
import { isKeyRelease } from "./keys.ts";
import {
	getLayoutBoxesAt,
	getScrollbarGeometry,
	getScrollViewBox,
	getScrollViewsAt,
	type LayoutFrame,
	renderLayoutFrame,
} from "./layout.ts";
import { getLayoutNode } from "./layout-node.ts";
import { AltScreenFlashContainer } from "./view/alt-screen-flash.ts";
import { ScrollView } from "./view/scroll-view.ts";
import type { Terminal } from "./terminal.ts";
import {
	deleteAllKittyImages,
	deleteAllKittyPlacements,
	getCapabilities,
	getKittyImagePlacementRows,
	type ImageProtocol,
	isImageLine,
	setCapabilities,
	type TerminalCapabilities,
} from "./terminal-image.ts";
import {
	type Component,
	Container,
	CURSOR_MARKER,
	compositeTuiLine,
	dispatchMouseEvent,
	retargetMouseEvent,
	TuiBase,
	type TuiMouseDispatchResult,
	type TuiMouseDispatchTarget,
	type TuiMouseEvent,
	type TuiStopOptions,
	VIEWPORT_TUI,
	type ViewportTUI,
} from "./screen.ts";
import { sliceByColumn, truncateToWidth, visibleWidth } from "./utils.ts";
import { WheelScrollAccelerator, type WheelScrollLines } from "./wheel-scroll.ts";

export type { CachedKittyImage } from "./fullscreen/images.ts";
export type { SgrMouseEvent, WheelEvent } from "./fullscreen/mouse.ts";
export type { ScrollbarDrag, ScrollbarTarget } from "./fullscreen/scrollbar.ts";
export type {
	ActiveSearch,
	SearchHighlightRange,
	SearchSelectionMode,
} from "./fullscreen/search.ts";
export type {
	ClickTarget,
	SelectionGranularity,
	SelectionPoint,
	SelectionRange,
} from "./fullscreen/selection.ts";

interface ScrollToEndIndicatorRect {
	row: number;
	column: number;
	width: number;
}

export interface AltScreenOptions {
	wheelScrollLines?: WheelScrollLines;
	mouse?: boolean;
	searchMatchStyle?: (text: string) => string;
	searchCurrentMatchStyle?: (text: string) => string;
	searchNavigationButtonStyle?: (text: string, hovered: boolean) => string;
	scrollToEndIndicator?: () => string;
	openUrl?: (url: string) => void;
	onRightClickPaste?: () => void;
	copyOnSelect?: boolean;
	copySelection?: (text: string) => Promise<boolean | string>;
}

const ENTER_ALT_SCREEN = "\x1b[?1049h";

const EXIT_ALT_SCREEN = "\x1b[?1049l";

const DISABLE_AUTOWRAP = "\x1b[?7l";

const ENABLE_AUTOWRAP = "\x1b[?7h";

const ENABLE_BUTTON_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";

const ENABLE_ALL_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";

const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

const FOCUS_IN = "\x1b[I";

const FOCUS_OUT = "\x1b[O";

const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";

const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";

const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;

const pageScrollOverlap = 4;

const doubleClickIntervalMs = 500;

const copyErrorFlashMs = 5000;

export class AltScreen extends TuiBase implements ViewportTUI {
	readonly mode = "fullscreen" as const;
	readonly [VIEWPORT_TUI] = true as const;
	private previousScreen: string[] = [];
	private lastDocument: string[] = [];
	private previousScreenWidth = 0;
	private previousScreenHeight = 0;
	private layoutRoot: Component | undefined;
	private currentLayout: LayoutFrame | undefined;
	private readonly implicitDocument: Component;
	private readonly implicitScrollView: ScrollView;
	private readonly flashes: AltScreenFlashContainer;
	private altScreenActive = false;
	private imageProtocol: ImageProtocol = null;
	private savedCapabilities?: TerminalCapabilities;
	private readonly kittyImages = new KittyImageCache();
	private readonly selection: TextSelection;
	private readonly scrollbars = new ScrollbarController();
	private scrollToEndIndicatorRect?: ScrollToEndIndicatorRect;
	private activeSearch?: ActiveSearch;
	private mouseCapture?: TuiMouseDispatchTarget;
	private mouseHover?: { target: TuiMouseDispatchTarget; event: TuiMouseEvent };
	private pointerCell?: { x: number; y: number };
	private mouseDownCell?: { x: number; y: number };
	private mousePressTarget?: TuiMouseDispatchTarget;
	private mousePressPoint?: { x: number; y: number };
	private mousePressMoved = false;
	private lastComponentClick?: {
		timestamp: number;
		count: number;
		component: Component;
		x: number;
		y: number;
	};
	private readonly wheelScroll: WheelScrollAccelerator;
	private readonly mouseEnabled: boolean;
	private mouseStartSequence = "";
	private readonly searchMatchStyle: (text: string) => string;
	private readonly searchCurrentMatchStyle: (text: string) => string;
	private readonly searchNavigationButtonStyle: (text: string, hovered: boolean) => string;
	private readonly scrollToEndIndicator?: () => string;
	private readonly openUrl?: (url: string) => void;
	private readonly onRightClickPaste?: () => void;
	private copyOnSelect: boolean;
	private readonly copySelection?: (text: string) => Promise<boolean | string>;

	constructor(
		terminal: Terminal,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		options: AltScreenOptions = {},
	) {
		super(terminal, showHardwareCursor, logDirectory);
		this.implicitDocument = {
			render: (width) => super.render(width),
			handleMouse: (event) => super.handleMouse(event),
			invalidate: () => {
				for (const child of this.children) {
					child.invalidate();
				}
			},
		};
		this.implicitScrollView = new ScrollView(this.implicitDocument, {
			follow: "end",
			primary: true,
		});
		this.flashes = new AltScreenFlashContainer(() => this.requestRender());
		this.wheelScroll = new WheelScrollAccelerator(options.wheelScrollLines ?? 1);
		this.mouseEnabled = options.mouse ?? true;
		this.searchMatchStyle = options.searchMatchStyle ?? ((text) => `\x1b[4m${text}\x1b[24m`);
		this.searchCurrentMatchStyle =
			options.searchCurrentMatchStyle ?? ((text) => `\x1b[1;7m${text}\x1b[22;27m`);
		this.searchNavigationButtonStyle = options.searchNavigationButtonStyle ?? ((text) => text);
		this.scrollToEndIndicator = options.scrollToEndIndicator;
		this.openUrl = options.openUrl;
		this.onRightClickPaste = options.onRightClickPaste;
		this.copyOnSelect = options.copyOnSelect ?? true;
		this.copySelection = options.copySelection;
		this.selection = new TextSelection(this.createSelectionHost());
		this.addInputListener((data) => this.handleViewportInput(data));
	}

	private createSelectionHost(): SelectionHost {
		return {
			getLayout: () => this.currentLayout,
			getScreenLines: () => this.previousScreen,
			getRows: () => this.terminal.rows,
			getColumns: () => this.terminal.columns,
			hasOverlay: () => this.hasOverlay(),
			isOverlayRow: (row) =>
				this.getRenderedOverlayLayouts().some(
					(layout) => row >= layout.row && row < layout.row + layout.height,
				),
			requestRender: () => this.requestRender(),
			dispatchClick: (button, x, y, clickCount) =>
				this.dispatchSelectionClick(button, x, y, clickCount),
			copySelection: () => {
				if (this.copyOnSelect) void this.copySelectionToClipboard();
			},
			openUrl: this.openUrl ? (url) => this.openSelectionUrl(url) : undefined,
		};
	}

	private openSelectionUrl(url: string): void {
		if (!this.openUrl) return;
		try {
			this.openUrl(url);
		} catch {}
	}

	get viewportTop(): number {
		return this.getPrimaryScrollView().scrollTop;
	}

	get isFollowingOutput(): boolean {
		return this.getPrimaryScrollView().isFollowingEnd;
	}

	setWheelScrollLines(lines: WheelScrollLines): void {
		this.wheelScroll.setLines(lines);
	}

	getCopyOnSelect(): boolean {
		return this.copyOnSelect;
	}

	setCopyOnSelect(enabled: boolean): void {
		this.copyOnSelect = enabled;
	}

	hasActiveSelection(): boolean {
		return this.selection.getActiveText() !== undefined;
	}

	async copyActiveSelectionToClipboard(): Promise<boolean> {
		const text = this.selection.getActiveText();
		if (!text) return false;
		return this.copyTextToClipboard(text);
	}

	isTextSelectionActive(): boolean {
		return this.selection.hasSelection();
	}

	clearActiveSelection(): void {
		if (!this.selection.hasSelection()) return;
		this.selection.clear();
		this.requestRender();
	}

	getScreenLines(): string[] {
		return [...this.previousScreen];
	}

	setLayoutRoot(component: Component | undefined): void {
		if (this.layoutRoot === component) return;
		this.layoutRoot = component;
		this.currentLayout = undefined;
		this.requestRender();
	}

	override render(width: number): string[] {
		return this.layoutRoot?.render(width) ?? super.render(width);
	}

	protected override getMountedRoots(): readonly Component[] {
		return this.layoutRoot ? [this.layoutRoot] : this.children;
	}

	private getPrimaryScrollView(): ScrollView {
		return this.currentLayout?.primaryScrollView ?? this.implicitScrollView;
	}

	protected override beforeTerminalStart(): void {
		this.selection.resetGesture();
		this.scrollbars.reset();
		this.flashes.dispose();
		this.altScreenActive = true;
		const capabilities = getCapabilities();
		this.imageProtocol = capabilities.images;
		this.kittyImages.clear();
		if (capabilities.images === "iterm2") {
			this.savedCapabilities = capabilities;
			setCapabilities({ ...capabilities, images: null });
			this.invalidate();
		}
		this.lastDocument = [];
		this.selection.clear();
		this.selection.lastClick = undefined;
		this.clearComponentMouseGesture();
		this.mouseHover = undefined;
		this.lastComponentClick = undefined;
		this.resetRenderState();
		const term = process.env.TERM?.toLowerCase() ?? "";
		const mouseSequence =
			process.env.TMUX !== undefined ||
			process.env.ZELLIJ !== undefined ||
			process.env.STY !== undefined ||
			term.startsWith("tmux") ||
			term.startsWith("screen")
				? ENABLE_BUTTON_MOTION_MOUSE
				: ENABLE_ALL_MOTION_MOUSE;
		const mouse = this.mouseEnabled ? mouseSequence : "";
		this.mouseStartSequence = mouse;
		this.terminal.write(`${ENTER_ALT_SCREEN}${DISABLE_AUTOWRAP}${mouse}\x1b[2J\x1b[H\x1b[?25l`);
	}

	protected override afterTerminalStart(): void {
		if (this.mouseStartSequence) this.terminal.write(this.mouseStartSequence);
	}

	protected override beforeTerminalStop(_options: TuiStopOptions): void {
		this.closeSearch();
		this.selection.stopAutoScroll();
		this.selection.pressActive = false;
		this.scrollbars.reset();
		this.clearComponentMouseGesture();
		this.mouseHover = undefined;
		this.flashes.dispose();
		if (!this.altScreenActive) return;
		this.mouseStartSequence = "";
		const mouse = this.mouseEnabled ? DISABLE_MOUSE : "";
		const body = `${this.deleteKittyImages()}${mouse}${ENABLE_AUTOWRAP}`;
		this.terminal.write(`${BEGIN_SYNCHRONIZED_OUTPUT}${body}${END_SYNCHRONIZED_OUTPUT}`);
		this.kittyImages.clear();
	}

	protected override afterTerminalStop(options: TuiStopOptions): void {
		if (!this.altScreenActive) return;
		let exitedAltScreen = false;
		try {
			if (options.preserveScreen) {
				this.terminal.write(
					`${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`,
				);
				exitedAltScreen = true;
			} else {
				const width = Math.max(1, this.terminal.columns);
				const documentLines = this.render(width).map((line) =>
					line.replace(OSC133_ZONE_PREFIX, ""),
				);
				this.lastDocument = this.applyLineResets(
					documentLines.map((line) => line.replaceAll(CURSOR_MARKER, "")),
				).map((line) =>
					isImageLine(line) || visibleWidth(line) <= width
						? line
						: sliceByColumn(line, 0, width, true),
				);
				let buffer = `${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}${DISABLE_AUTOWRAP}`;
				for (let row = 0; row < this.lastDocument.length; row++) {
					if (row > 0) buffer += "\r\n";
					buffer += `\r\x1b[2K${this.lastDocument[row] ?? ""}`;
				}
				buffer += `\x1b[0m${ENABLE_AUTOWRAP}\r\n\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`;
				this.terminal.write(buffer);
				exitedAltScreen = true;
			}
		} finally {
			if (!exitedAltScreen) {
				this.terminal.write(
					`${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`,
				);
			}
			this.altScreenActive = false;
			if (this.savedCapabilities) {
				setCapabilities(this.savedCapabilities);
				this.savedCapabilities = undefined;
			}
		}
	}

	private deleteKittyImages(): string {
		return this.imageProtocol === "kitty" ? deleteAllKittyImages() : "";
	}

	protected override resetRenderState(): void {
		this.previousScreen = [];
		this.previousScreenWidth = 0;
		this.previousScreenHeight = 0;
		this.currentLayout = undefined;
	}

	scrollBy(lines: number): void {
		this.getPrimaryScrollView().scrollBy(lines);
		this.clearMouseHover();
		this.requestRender();
	}

	scrollToTop(): void {
		this.getPrimaryScrollView().scrollToStart();
		this.clearMouseHover();
		this.requestRender();
	}

	scrollToBottom(): void {
		this.getPrimaryScrollView().scrollToEnd();
		this.clearMouseHover();
		this.requestRender();
	}

	// Keyboard owns
	private clearMouseHover(): void {
		const previous = this.mouseHover;
		if (!previous) return;
		this.mouseHover = undefined;
		const cell = this.pointerCell ?? { x: 0, y: 0 };
		const event = this.createMouseEvent("leave", 0, cell.x, cell.y);
		const result = this.dispatchMouseToTarget(event, previous.target);
		if (result && result.render !== false) this.requestRender();
	}

	// Scroll hover
	private refreshMouseHover(): void {
		const cell = this.pointerCell;
		if (!cell || !this.mouseHover) return;
		const event = this.createMouseEvent("move", 0, cell.x, cell.y);
		const result = this.dispatchMouseToLayout(event);
		this.updateMouseHover(event, result?.target);
	}

	private scrollToPrompt(direction: -1 | 1): void {
		if (!this.currentLayout) return;
		const scrollView = this.getPrimaryScrollView();
		const lines = getScrollViewBox(this.currentLayout, scrollView)?.scrollContentLines;
		if (!lines) return;

		for (
			let row = scrollView.scrollTop + direction;
			row >= 0 && row < lines.length;
			row += direction
		) {
			if (!OSC133_PROMPT_START.test(lines[row] ?? "")) continue;
			scrollView.scrollTo(row);
			this.requestRender();
			return;
		}
	}

	private toggleSearch(): void {
		if (this.activeSearch) {
			this.closeSearch();
			return;
		}
		const component = new AltScreenSearchComponent(
			(query) => this.updateSearchQuery(query),
			this.searchNavigationButtonStyle,
		);
		const search: ActiveSearch = {
			component,
			index: new AltScreenSearchIndex(),
			query: "",
			matches: [],
			selectedIndex: -1,
			anchorRow: this.getPrimaryScrollView().scrollTop,
			selectionMode: "query",
		};
		this.activeSearch = search;
		search.overlay = this.showOverlay(component, {
			anchor: "top-right",
			width: "40%",
			minWidth: 32,
			margin: 1,
		});
	}

	private closeSearch(): void {
		const search = this.activeSearch;
		if (!search) return;
		this.activeSearch = undefined;
		search.overlay?.hide();
		this.requestRender();
	}

	private updateSearchQuery(query: string): void {
		const search = this.activeSearch;
		if (!search || query === search.query) return;
		const selected = search.matches[search.selectedIndex];
		search.anchorRow = selected?.segments[0]?.row ?? this.getPrimaryScrollView().scrollTop;
		search.query = query;
		search.selectionMode = "query";
		search.component.setResult(-1, 0);
		this.requestRender();
	}

	private navigateSearch(direction: -1 | 1): void {
		const search = this.activeSearch;
		if (!search?.query) return;
		search.selectionMode = direction < 0 ? "previous" : "next";
		this.requestRender();
	}

	private getSearchNavigationDirectionAt(x: number, y: number): -1 | 1 | undefined {
		const search = this.activeSearch;
		const bounds = search?.overlay?.getBounds();
		if (!search || !bounds) return undefined;
		if (
			x < bounds.col ||
			x >= bounds.col + bounds.width ||
			y < bounds.row ||
			y >= bounds.row + bounds.height
		) {
			return undefined;
		}
		return search.component.getNavigationDirectionAt(y - bounds.row, x - bounds.col);
	}

	private handleSearchMouseEvent(event: SgrMouseEvent): boolean {
		const search = this.activeSearch;
		if (!search) return false;
		const direction = this.getSearchNavigationDirectionAt(event.x, event.y);
		if (search.component.setHoveredNavigationDirection(direction)) this.requestRender();
		if (
			direction === undefined ||
			event.release ||
			(event.button & 32) !== 0 ||
			(event.button & 3) !== 0
		) {
			return false;
		}
		this.navigateSearch(direction);
		return true;
	}

	private refreshSearch(layout: LayoutFrame): boolean {
		const search = this.activeSearch;
		if (!search) return false;
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		const box = getScrollViewBox(layout, scrollView);
		const lines = box?.scrollContentLines;
		if (!lines || !search.query.trim()) {
			search.matches = [];
			search.selectedIndex = -1;
			search.selectedKey = undefined;
			search.selectionMode = "retain";
			search.component.setResult(-1, 0);
			return false;
		}

		const shouldRevealSelection = search.selectionMode !== "retain";
		const result = search.index.search(lines, search.query);
		const matches = result.matches;
		search.matches = matches;
		if (!result.changed && search.selectionMode === "retain") return false;

		const selectedIndex = pickSearchSelection(
			matches,
			search.selectionMode,
			search.anchorRow,
			search.selectedIndex,
			search.selectedKey,
			result.changed,
		);
		search.selectedIndex = selectedIndex;
		search.selectedKey =
			selectedIndex >= 0 ? getAltScreenSearchMatchKey(matches[selectedIndex]!) : undefined;
		search.selectionMode = "retain";
		search.component.setResult(selectedIndex, matches.length);
		if (!shouldRevealSelection) return false;

		const selected = matches[selectedIndex];
		const firstSegment = selected?.segments[0];
		const lastSegment = selected?.segments[selected.segments.length - 1];
		if (!box || !firstSegment || !lastSegment || scrollView.viewportHeight <= 0) return false;
		const before = scrollView.scrollTop;
		const visibleBottom = before + scrollView.viewportHeight - 1;
		let target = before;
		if (firstSegment.row < before || lastSegment.row > visibleBottom) {
			target = firstSegment.row - Math.floor(scrollView.viewportHeight / 3);
		}
		scrollView.scrollTo(target, { disableFollow: true });
		return scrollView.scrollTop !== before;
	}

	flash(message: string, durationMs?: number): void {
		this.flashes.flash(message, durationMs);
	}

	private shouldDeferViewportInputToOverlay(): boolean {
		return this.isOverlayFocused() && this.activeSearch?.overlay?.isFocused() !== true;
	}

	private clearComponentMouseGesture(): void {
		this.mouseCapture = undefined;
		this.mousePressTarget = undefined;
		this.mousePressPoint = undefined;
		this.mousePressMoved = false;
	}

	private updateMouseHover(event: TuiMouseEvent, target?: TuiMouseDispatchTarget): void {
		const previous = this.mouseHover;
		this.mouseHover = target ? { target, event } : undefined;
		if (!previous || previous.target.component === target?.component) return;
		const result = this.dispatchMouseToTarget(
			{ ...event, type: "leave", button: "none" },
			previous.target,
		);
		if (result && result.render !== false) this.requestRender();
	}

	private handleViewportInput(data: string): { consume?: boolean } | undefined {
		if (data === FOCUS_OUT) {
			if (
				this.mouseCapture ||
				this.mousePressTarget ||
				this.scrollbars.isDragging ||
				this.selection.pressActive
			) {
				this.mouseHover = undefined;
			} else if (this.mouseHover) {
				this.updateMouseHover(this.mouseHover.event);
			}
			const hadActiveSelection = this.selection.pressActive;
			const hadNonEmptyActiveSelection = hadActiveSelection && this.selection.hasSelection();
			this.selection.resetGesture();
			this.scrollbars.setHover(undefined);
			if (this.activeSearch?.component.setHoveredNavigationDirection(undefined))
				this.requestRender();
			this.scrollbars.stopDrag();
			this.clearComponentMouseGesture();
			this.lastComponentClick = undefined;
			if (hadActiveSelection) {
				this.selection.clear();
				if (hadNonEmptyActiveSelection) this.requestRender();
			}
			this.selection.lastClick = undefined;
			return { consume: true };
		}
		if (data === FOCUS_IN) return { consume: true };

		const wheelEvent = parseWheelEvent(data);
		if (wheelEvent) {
			this.pointerCell = { x: wheelEvent.x, y: wheelEvent.y };
			const lines = this.wheelScroll.next(wheelEvent.direction, performance.now());
			const wheelDelta = resolveWheelDelta(wheelEvent, lines);
			const event = this.createMouseEvent(
				"wheel",
				wheelEvent.button,
				wheelEvent.x,
				wheelEvent.y,
				{ wheelDelta },
			);
			const overlay = this.dispatchMouseToOverlay(event);
			const result =
				overlay.result ?? (overlay.hit ? undefined : this.dispatchMouseToLayout(event));
			if (result) {
				if (this.applyMouseDispatchResult(event, result)) this.requestRender();
				return { consume: true };
			}
			if (this.shouldDeferViewportInputToOverlay()) return undefined;
			this.routeWheel(wheelEvent, wheelDelta);
			return { consume: true };
		}
		const mouseEvent = parseSgrMouseEvent(data);
		if (mouseEvent) {
			this.handleMouseEvent(mouseEvent);
			return { consume: true };
		}
		if (isMouseSequence(data)) return { consume: true };
		if (
			!isKeyRelease(data) &&
			!this.isOverlayFocused() &&
			this.selection.handleDeleteKey(data)
		)
			return { consume: true };

		const keybindings = getKeybindings();
		const isRelease = isKeyRelease(data);
		if (keybindings.matches(data, "tui.altScreen.search")) {
			if (!isRelease) this.toggleSearch();
			return { consume: true };
		}
		if (this.activeSearch) {
			if (this.activeSearch.overlay?.isFocused()) {
				if (keybindings.matches(data, "tui.altScreen.searchNext")) {
					if (!isRelease) this.navigateSearch(1);
					return { consume: true };
				}
				if (keybindings.matches(data, "tui.altScreen.searchPrevious")) {
					if (!isRelease) this.navigateSearch(-1);
					return { consume: true };
				}
			}
			if (keybindings.matches(data, "tui.altScreen.searchClose")) {
				if (!isRelease) this.closeSearch();
				return { consume: true };
			}
		}
		if (this.shouldDeferViewportInputToOverlay()) return undefined;
		if (keybindings.matches(data, "tui.altScreen.pageUp")) {
			if (!isRelease) {
				this.scrollBy(
					-Math.max(1, this.getPrimaryScrollView().viewportHeight - pageScrollOverlap),
				);
			}
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.pageDown")) {
			if (!isRelease) {
				this.scrollBy(
					Math.max(1, this.getPrimaryScrollView().viewportHeight - pageScrollOverlap),
				);
			}
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.halfPageUp")) {
			if (!isRelease)
				this.scrollBy(-Math.max(1, Math.floor(this.getPrimaryScrollView().viewportHeight / 2)));
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.halfPageDown")) {
			if (!isRelease)
				this.scrollBy(Math.max(1, Math.floor(this.getPrimaryScrollView().viewportHeight / 2)));
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.lineUp")) {
			if (!isRelease) this.scrollBy(-1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.lineDown")) {
			if (!isRelease) this.scrollBy(1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.previousPrompt")) {
			if (!isRelease) this.scrollToPrompt(-1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.nextPrompt")) {
			if (!isRelease) this.scrollToPrompt(1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.top")) {
			if (!isRelease) this.scrollToTop();
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.bottom")) {
			if (!isRelease) this.scrollToBottom();
			return { consume: true };
		}
		return undefined;
	}

	private createMouseEvent(
		type: TuiMouseEvent["type"],
		button: number,
		x: number,
		y: number,
		extra: Partial<Pick<TuiMouseEvent, "wheelDelta" | "clickCount">> = {},
	): TuiMouseEvent {
		return createMouseEvent(
			type,
			button,
			x,
			y,
			this.terminal.columns,
			this.terminal.rows,
			extra,
		);
	}

	private dispatchMouseToLayout(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (!this.currentLayout) return undefined;
		const visited = new Set<Component>();
		const boxes = getLayoutBoxesAt(this.currentLayout, event.screenX, event.screenY);
		for (const box of boxes) {
			if (visited.has(box.component)) continue;
			// Own rectangle
			if (
				event.screenX < box.rect.x ||
				event.screenX >= box.rect.x + box.rect.width ||
				event.screenY < box.rect.y ||
				event.screenY >= box.rect.y + box.rect.height
			)
				continue;
			if (
				getLayoutNode(box.component) &&
				box.component.handleMouse === Container.prototype.handleMouse
			)
				continue;
			visited.add(box.component);
			const result = dispatchMouseEvent(box.component, {
				...event,
				x: event.screenX - box.rect.x,
				y: event.screenY - box.rect.y,
				width: box.rect.width,
				height: box.rect.height,
			});
			if (result) return result;
		}
		return undefined;
	}

	private applyMouseDispatchResult(event: TuiMouseEvent, result: TuiMouseDispatchResult): boolean {
		const focusTarget = this.resolveMouseFocusTarget(
			result.focusTarget ?? result.target.component,
		);
		const focusChanged = result.focus === true && this.getFocusedComponent() !== focusTarget;
		if (result.focus) this.setFocus(focusTarget);
		if (result.capture) this.mouseCapture = result.target;
		return (
			result.render ??
			(focusChanged ||
				event.type === "press" ||
				event.type === "click" ||
				event.type === "drag" ||
				event.type === "wheel")
		);
	}

	private dispatchMouseToTarget(
		event: TuiMouseEvent,
		target: TuiMouseDispatchTarget,
	): TuiMouseDispatchResult | undefined {
		return dispatchMouseEvent(target.component, retargetMouseEvent(event, target));
	}

	private getComponentClickCount(target: TuiMouseDispatchTarget, x: number, y: number): number {
		const now = Date.now();
		const previous = this.lastComponentClick;
		const count =
			previous &&
			now - previous.timestamp <= doubleClickIntervalMs &&
			previous.component === target.component &&
			previous.x === x &&
			previous.y === y
				? (previous.count % 3) + 1
				: 1;
		this.lastComponentClick = { timestamp: now, count, component: target.component, x, y };
		return count;
	}

	private dispatchSelectionClick(
		button: number,
		x: number,
		y: number,
		clickCount: number,
	): void {
		const event = this.createMouseEvent("click", button, x, y, { clickCount });
		const overlay = this.dispatchMouseToOverlay(event);
		const result =
			overlay.result ?? (overlay.hit ? undefined : this.dispatchMouseToLayout(event));
		if (result) this.applyMouseDispatchResult(event, result);
	}

	private handleMouseEvent(raw: SgrMouseEvent): void {
		const isMotion = (raw.button & 32) !== 0;
		const type: TuiMouseEvent["type"] = raw.release
			? "release"
			: isMotion
				? decodeMouseButton(raw.button) === "none"
					? "move"
					: "drag"
				: "press";
		const event = this.createMouseEvent(type, raw.button, raw.x, raw.y);
		this.pointerCell = { x: raw.x, y: raw.y };
		if (type === "press") this.mouseDownCell = { x: raw.x, y: raw.y };

		if (this.mouseCapture || this.mousePressTarget) {
			const target = this.mouseCapture ?? this.mousePressTarget!;
			if (
				this.mousePressPoint &&
				(raw.x !== this.mousePressPoint.x || raw.y !== this.mousePressPoint.y)
			) {
				this.mousePressMoved = true;
				this.lastComponentClick = undefined;
			}
			let render = false;
			const targetResult = this.dispatchMouseToTarget(event, target);
			if (targetResult) render = this.applyMouseDispatchResult(event, targetResult);
			if (raw.release) {
				if (
					!this.mousePressMoved &&
					this.mousePressPoint?.x === raw.x &&
					this.mousePressPoint.y === raw.y
				) {
					const clickEvent = this.createMouseEvent("click", raw.button, raw.x, raw.y, {
						clickCount: this.getComponentClickCount(target, raw.x, raw.y),
					});
					const clickResult = this.dispatchMouseToTarget(clickEvent, target);
					if (clickResult)
						render = this.applyMouseDispatchResult(clickEvent, clickResult) || render;
				}
				this.clearComponentMouseGesture();
			}
			if (render) this.requestRender();
			return;
		}

		this.clickUnpressedCell(raw);

		if (this.handleSearchMouseEvent(raw)) return;

		const overlay = this.dispatchMouseToOverlay(event);
		if (!overlay.hit) {
			if (this.handleScrollToEndIndicatorMouseEvent(raw)) return;
			const scrollbarHandled = this.handleScrollbarMouseEvent(raw);
			if (!this.scrollbars.isDragging) this.updateScrollbarHover(raw.x, raw.y);
			if (scrollbarHandled) return;
		} else {
			this.scrollbars.setHover(undefined);
		}

		const indicator = this.scrollToEndIndicatorRect;
		const overIndicator =
			indicator &&
			raw.y === indicator.row &&
			raw.x >= indicator.column &&
			raw.x < indicator.column + indicator.width;
		const blocksLayoutMotion =
			type === "move" &&
			(overIndicator || this.findScrollbar(raw.x, raw.y, true) !== undefined);
		const result =
			overlay.result ??
			(overlay.hit || blocksLayoutMotion ? undefined : this.dispatchMouseToLayout(event));
		if (type === "move" && !this.selection.pressActive)
			this.updateMouseHover(event, result?.target);
		if (result) {
			const render = this.applyMouseDispatchResult(event, result);
			if (type === "press") {
				this.selection.clear();
				this.mousePressTarget = result.target;
				this.mousePressPoint = { x: raw.x, y: raw.y };
				this.mousePressMoved = false;
			}
			if (render) this.requestRender();
			return;
		}

		if (this.handleRightClickPaste(raw)) return;
		this.selection.handleMouseEvent(raw);
	}

	private clickUnpressedCell(raw: SgrMouseEvent): void {
		const down = this.mouseDownCell;
		this.mouseDownCell = undefined;
		if (!raw.release || !down) return;
		if (down.x !== raw.x || down.y !== raw.y) return;

		const event = this.createMouseEvent("click", raw.button, raw.x, raw.y, { clickCount: 1 });
		const overlay = this.dispatchMouseToOverlay(event);
		const result =
			overlay.result ?? (overlay.hit ? undefined : this.dispatchMouseToLayout(event));
		if (!result) return;

		this.applyMouseDispatchResult(event, result);
		this.clearComponentMouseGesture();
		this.requestRender();
	}

	private routeWheel(event: WheelEvent, delta: number): void {
		let remaining = delta;
		const seen = new Set<ScrollView>();
		let canChain = true;
		for (const scrollView of this.currentLayout
			? getScrollViewsAt(this.currentLayout, event.x, event.y)
			: []) {
			seen.add(scrollView);
			remaining = scrollView.scrollBy(remaining);
			if (remaining === 0) break;
			if (scrollView.overscroll === "contain") {
				canChain = false;
				break;
			}
		}
		const primary = this.getPrimaryScrollView();
		if (canChain && remaining !== 0 && !seen.has(primary)) primary.scrollBy(remaining);
		this.updateScrollbarHover(event.x, event.y);
		this.refreshMouseHover();
		this.requestRender();
	}

	private handleRightClickPaste(event: SgrMouseEvent): boolean {
		if (
			!this.onRightClickPaste ||
			process.platform !== "win32" ||
			process.env.TERM_PROGRAM?.toLowerCase() === "vscode" ||
			event.release ||
			event.button !== 2
		) {
			return false;
		}
		try {
			this.onRightClickPaste();
		} catch {}
		return true;
	}

	private handleScrollToEndIndicatorMouseEvent(event: SgrMouseEvent): boolean {
		const rect = this.scrollToEndIndicatorRect;
		if (!rect || event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0)
			return false;
		if (event.y !== rect.row || event.x < rect.column || event.x >= rect.column + rect.width)
			return false;
		this.scrollToBottom();
		return true;
	}

	private findScrollbar(
		x: number,
		y: number,
		includeHiddenAuto = false,
	): ScrollbarTarget | undefined {
		if (this.hasOverlay() || !this.currentLayout) return undefined;
		return getScrollbarTargetAt(this.currentLayout, x, y, includeHiddenAuto);
	}

	private updateScrollbarHover(x: number, y: number): void {
		this.scrollbars.setHover(this.findScrollbar(x, y, true)?.scrollView);
	}

	private handleScrollbarMouseEvent(event: SgrMouseEvent): boolean {
		if (this.scrollbars.isDragging) {
			if (event.release) {
				this.scrollbars.stopDrag();
				return true;
			}
			this.scrollbars.dragTo(this.currentLayout, event.y);
			return true;
		}

		if (event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
		const target = this.findScrollbar(event.x, event.y);
		if (!target) return false;
		this.selection.clear();
		this.selection.lastClick = undefined;
		this.scrollbars.beginDrag(target, event.y);
		return true;
	}

	private async copySelectionToClipboard(): Promise<boolean> {
		const text = this.selection.getActiveText();
		if (!text) return false;
		return this.copyTextToClipboard(text);
	}

	private async copyTextToClipboard(text: string): Promise<boolean> {
		if (this.copySelection) {
			try {
				const result = await this.copySelection(text);
				const ok = result === true;
				let message = "Copy failed";
				if (ok) message = "Copied!";
				else if (typeof result === "string") message = result;
				this.flash(message, ok ? undefined : copyErrorFlashMs);
				return ok;
			} catch {
				this.flash("Copy failed", copyErrorFlashMs);
				return false;
			}
		}
		this.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		this.flash("Copied!");
		return true;
	}

	private applySearchHighlights(screen: string[], layout: LayoutFrame): string[] {
		const search = this.activeSearch;
		if (!search || search.selectedIndex < 0 || search.matches.length === 0) return screen;
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		const box = getScrollViewBox(layout, scrollView);
		if (!box) return screen;

		const rangesByRow = getSearchHighlightRanges(
			screen.length,
			this.terminal.columns,
			box,
			scrollView,
			search.matches,
			search.selectedIndex,
		);
		const result = [...screen];
		for (const [row, ranges] of rangesByRow) {
			let line = result[row] ?? "";
			if (isImageLine(line)) continue;
			const lineWidth = visibleWidth(line);
			for (const range of ranges.sort((a, b) => b.startCol - a.startCol)) {
				const startCol = Math.min(range.startCol, lineWidth);
				const endCol = Math.min(range.endCol, lineWidth);
				if (endCol <= startCol) continue;
				const before = sliceByColumn(line, 0, startCol, true);
				const highlighted = sliceByColumn(line, startCol, endCol - startCol, true);
				const after = sliceByColumn(line, endCol, Math.max(0, lineWidth - endCol), true);
				const style = range.current ? this.searchCurrentMatchStyle : this.searchMatchStyle;
				line = `${before}${applySearchTextHighlight(highlighted, style)}${after}`;
			}
			result[row] = line;
		}
		return result;
	}

	private compositeScrollToEndIndicator(
		screen: string[],
		layout: LayoutFrame,
		width: number,
	): string[] {
		this.scrollToEndIndicatorRect = undefined;
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		if (!this.scrollToEndIndicator || !scrollView.followEnd || scrollView.isFollowingEnd)
			return screen;
		const box = getScrollViewBox(layout, scrollView);
		const clip = box?.clip;
		if (!clip || clip.width <= 0 || clip.height <= 0) return screen;
		const row = clip.y + clip.height - 1;
		if (row >= screen.length || isImageLine(screen[row] ?? "")) return screen;
		const scrollbarColumn = box ? getScrollbarGeometry(box)?.column : undefined;
		const label = truncateToWidth(this.scrollToEndIndicator(), clip.width, "");
		const labelWidth = visibleWidth(label);
		const column = clip.x + Math.floor((clip.width - labelWidth) / 2);
		const rightEdge = scrollbarColumn ?? clip.x + clip.width;
		const availableWidth = Math.max(0, rightEdge - column);
		const text = truncateToWidth(label, availableWidth, "");
		const textWidth = visibleWidth(text);
		if (textWidth === 0) return screen;
		const result = [...screen];
		result[row] = compositeTuiLine(result[row] ?? "", text, column, textWidth, width);
		this.scrollToEndIndicatorRect = { row, column, width: textWidth };
		return result;
	}

	private compositeFlashes(screen: string[], width: number, height: number): string[] {
		const flashLines = this.flashes.render(width).slice(-height);
		if (flashLines.length === 0) return screen;
		const result = [...screen];
		while (result.length < height) {
			result.push("");
		}
		for (let row = 0; row < flashLines.length; row++) {
			const line = flashLines[row]!;
			const flashWidth = visibleWidth(line);
			if (flashWidth === 0) continue;
			result[row] = compositeTuiLine(
				result[row] ?? "",
				line,
				width - flashWidth,
				flashWidth,
				width,
			);
		}
		return result;
	}

	protected override doRender(): void {
		if (this.stopped || !this.altScreenActive) return;
		const width = Math.max(1, this.terminal.columns);
		const height = Math.max(1, this.terminal.rows);
		if (
			this.previousScreen.length > 0 &&
			(this.previousScreenWidth !== width || this.previousScreenHeight !== height)
		) {
			this.selection.clear();
		}
		const root = this.layoutRoot ?? this.implicitScrollView;
		let nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender());
		if (this.refreshSearch(nextLayout)) {
			nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender());
		}
		let screen = nextLayout.lines.map((line) => line.replace(OSC133_ZONE_PREFIX, ""));
		screen = this.applySearchHighlights(screen, nextLayout);
		screen = this.compositeScrollToEndIndicator(screen, nextLayout, width);
		screen = this.compositeOverlays(screen, width, height);
		if (screen.length > height) screen = screen.slice(screen.length - height);
		screen = this.selection.apply(screen, nextLayout);
		screen = this.compositeFlashes(screen, width, height);

		const cursorPos = this.extractCursorPosition(screen, height);
		screen = this.applyLineResets(screen).map((line) => {
			if (isImageLine(line) || visibleWidth(line) <= width) return line;
			return sliceByColumn(line, 0, width, true);
		});

		const fullRedraw =
			this.previousScreen.length === 0 ||
			this.previousScreenWidth !== width ||
			this.previousScreenHeight !== height;
		const changedRows = screen.map((line, row) => line !== this.previousScreen[row]);
		const imageAnchorsNeedRedraw = screen.some(
			(line, row) =>
				changedRows[row] && (isImageLine(line) || isImageLine(this.previousScreen[row] ?? "")),
		);
		const isWezTerm =
			Boolean(process.env.WEZTERM_PANE) || process.env.TERM_PROGRAM?.toLowerCase() === "wezterm";
		const imageCellsNeedRedraw =
			!imageAnchorsNeedRedraw &&
			isWezTerm &&
			this.imageProtocol === "kitty" &&
			changedRows.some(Boolean) &&
			screen.some((line, row) => {
				const placementRows = getKittyImagePlacementRows(line);
				if (placementRows === undefined) return false;
				for (let coveredRow = row; coveredRow < row + placementRows; coveredRow++) {
					if (changedRows[coveredRow]) return true;
				}
				return false;
			});
		const imagesNeedRedraw = imageAnchorsNeedRedraw || imageCellsNeedRedraw;
		const redrawImages = fullRedraw || imagesNeedRedraw;
		const hadUploadedKittyImages = this.kittyImages.size > 0;
		const preparedKittyScreen =
			redrawImages && this.imageProtocol === "kitty"
				? this.kittyImages.prepare(screen)
				: { lines: screen, evictedImageDeletion: "" };

		let buffer = BEGIN_SYNCHRONIZED_OUTPUT;
		if (fullRedraw) {
			this.fullRedrawCount += 1;
			const clearImages =
				this.imageProtocol === "kitty" && hadUploadedKittyImages
					? deleteAllKittyPlacements()
					: this.deleteKittyImages();
			buffer += `${clearImages}\x1b[2J`;
		} else if (imagesNeedRedraw) {
			if (this.imageProtocol === "iterm2") buffer += "\x1b[2J";
			else if (this.imageProtocol === "kitty") buffer += deleteAllKittyPlacements();
		}
		buffer += preparedKittyScreen.evictedImageDeletion;

		const drawKittyImagesLast =
			redrawImages && this.imageProtocol === "kitty" && screen.some(isImageLine) && isWezTerm;
		if (drawKittyImagesLast) {
			for (let row = 0; row < height; row++) {
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row])
					continue;
				buffer += `\x1b[${row + 1};1H\x1b[2K`;
			}
			for (let row = 0; row < height; row++) {
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row])
					continue;
				if (isImageLine(preparedKittyScreen.lines[row] ?? "")) continue;
				buffer += `\x1b[${row + 1};1H${preparedKittyScreen.lines[row] ?? ""}`;
			}
			for (let row = 0; row < height; row++) {
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row])
					continue;
				if (!isImageLine(preparedKittyScreen.lines[row] ?? "")) continue;
				buffer += `\x1b[${row + 1};1H${preparedKittyScreen.lines[row] ?? ""}`;
			}
		} else {
			for (let row = 0; row < height; row++) {
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row])
					continue;
				buffer += `\x1b[${row + 1};1H\x1b[2K${preparedKittyScreen.lines[row] ?? ""}`;
			}
		}

		if (cursorPos) {
			buffer += `\x1b[${cursorPos.row + 1};${Math.min(width, cursorPos.col) + 1}H`;
			buffer += this.getShowHardwareCursor() ? "\x1b[?25h" : "\x1b[?25l";
		} else {
			buffer += "\x1b[?25l";
		}
		buffer += END_SYNCHRONIZED_OUTPUT;
		this.terminal.write(buffer);

		this.previousScreen = screen;
		this.previousScreenWidth = width;
		this.previousScreenHeight = height;
		this.currentLayout = nextLayout;
	}
}
