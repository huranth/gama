export { Marked, type Token, type Tokens } from "marked";

export {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "./autocomplete.ts";

export {
	backgroundAnsi,
	type Color,
	type ColorMixSpace,
	colorToHex,
	colorToOkhsl,
	colorToOklch,
	colorToRgb,
	foregroundAnsi,
	type IndexedColor,
	indexedColor,
	mixColors,
	type OkhslChannels,
	type OklchChannels,
	type OklchColorValue,
	okhslColor,
	oklchColor,
	parseColor,
	type RgbColorValue,
	rgbColor,
	styleText,
	styleTextWithAnsi,
	type TerminalColorMode,
	type TextAttributes,
	type TextStyle,
} from "./colors.ts";

export type { EditorComponent } from "./editor-component.ts";

export { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "./fuzzy.ts";

export {
	getKeybindings,
	type Keybinding,
	type KeybindingConflict,
	type KeybindingDefinition,
	type KeybindingDefinitions,
	type Keybindings,
	type KeybindingsConfig,
	Keymap,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "./keybindings.ts";

export {
	decodeKittyPrintable,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	Key,
	type KeyEventType,
	type KeyId,
	matchesKey,
	parseKey,
	setKittyProtocolActive,
} from "./keys.ts";

export { type RenderLatexOptions, renderLatex } from "./latex.ts";

export { getNativeClipboard, type NativeClipboard } from "./native-platform.ts";

export { oklabToOkhslLightness } from "./oklab.ts";

export { Box } from "./view/box.ts";

export { CancellableLoader } from "./view/cancellable-loader.ts";

export { Editor, type EditorOptions, type EditorTheme } from "./view/editor.ts";

export { HStack } from "./view/h-stack.ts";

export {
	Image,
	type ImageOptions,
	type ImageTheme,
	type ImageTranscoder,
	setImageTranscoder,
} from "./view/image.ts";

export { Input } from "./view/input.ts";

export { Loader, type LoaderIndicatorOptions } from "./view/loader.ts";

export {
	type DefaultTextStyle,
	Markdown,
	type MarkdownOptions,
	type MarkdownTheme,
} from "./view/markdown.ts";

export { MouseRegion, type MouseRegionHandler } from "./view/mouse-region.ts";

export {
	ScrollView,
	type ScrollViewOptions,
	type ScrollViewScrollbar,
	type ScrollViewScrollToOptions,
} from "./view/scroll-view.ts";

export {
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	type SelectListTruncatePrimaryContext,
} from "./view/select-list.ts";

export { type SettingItem, SettingsList, type SettingsListTheme } from "./view/settings-list.ts";

export { Spacer } from "./view/spacer.ts";

export { Text } from "./view/text.ts";

export { TruncatedText } from "./view/truncated-text.ts";

export {
	type StackChild,
	type StackEntry,
	type StackEntryOptions,
	type StackOptions,
	VStack,
} from "./view/v-stack.ts";

export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "./stdin-buffer.ts";

export { isAppleTerminalSession, ProcessTerminal, type Terminal } from "./terminal.ts";

export {
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
	type TerminalColors,
} from "./terminal-colors.ts";

export {
	allocateImageId,
	type CellDimensions,
	calculateImageRows,
	deleteAllKittyImages,
	deleteKittyImage,
	detectCapabilities,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getPngDimensions,
	getTerminalColorMode,
	getWebpDimensions,
	hyperlink,
	type ImageDimensions,
	type ImageProtocol,
	type ImageRenderOptions,
	imageFallback,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCapabilityOverrides,
	setCellDimensions,
	type TerminalCapabilities,
} from "./terminal-image.ts";

export {
	type Component,
	Container,
	CURSOR_MARKER,
	compositeTuiLine,
	type Focusable,
	isFocusable,
	isViewportTUI,
	type OverlayAnchor,
	type OverlayBounds,
	type OverlayHandle,
	type OverlayMargin,
	type OverlayOptions,
	type OverlayUnfocusOptions,
	type SizeValue,
	type TUI,
	type TuiInputListener,
	type TuiInputListenerResult,
	type TuiMode,
	type TuiMouseButton,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	type TuiMouseEventType,
	type TuiStopOptions,
	type ViewportTUI,
} from "./screen.ts";

export { AltScreen, type AltScreenOptions } from "./alt-screen.ts";

export { MainScreen, type MainScreenRenderState } from "./main-screen.ts";

export {
	closeBeforePadding,
	getOsc8LinkAtColumn,
	padLine,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "./utils.ts";

export type { WheelScrollLines } from "./wheel-scroll.ts";
