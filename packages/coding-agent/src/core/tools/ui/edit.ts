import { Box, Container, Spacer, Text } from "@huranth/gama-tui";
import { renderDiff } from "../../../modes/tui/parts/diff.ts";
import type { Theme } from "../../../modes/tui/theme/theme.ts";
import type { ToolDefinition } from "../../ext/types.ts";
import type { EditToolDetails } from "../edit.ts";
import {
	computeEditsDiff,
	type Edit,
	type EditDiffError,
	type EditDiffResult,
} from "../edit-diff.ts";
import { renderToolPath, str } from "../render-utils.ts";

type EditPreview = EditDiffResult | EditDiffError;

export type EditRenderState = {
	callComponent?: EditCallRenderComponent;
};

type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	edits?: Edit[];
	oldText?: string;
	newText?: string;
};

type EditToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};

type EditCallRenderComponent = Box & {
	preview?: EditPreview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
};

function createEditCallRenderComponent(): EditCallRenderComponent {
	const component = new Box(1, 1, (text: string) => text) as EditCallRenderComponent;
	component.previewPending = false;
	component.settledError = false;

	return component;
}

function getEditCallRenderComponent(
	state: EditRenderState,
	lastComponent: unknown,
): EditCallRenderComponent {
	if (lastComponent instanceof Box) {
		state.callComponent = lastComponent as EditCallRenderComponent;
		return state.callComponent;
	}

	state.callComponent ??= createEditCallRenderComponent();
	return state.callComponent;
}

function previewArgsKey(input: { path: string; edits: Edit[] } | null): string | undefined {
	if (!input) return undefined;

	return JSON.stringify({ path: input.path, edits: input.edits });
}

function getRenderablePreviewInput(
	args: RenderableEditArgs | undefined,
): { path: string; edits: Edit[] } | null {
	if (!args) return null;

	const namedPath = typeof args.path === "string" ? args.path : args.file_path;
	const path = typeof namedPath === "string" ? namedPath : undefined;
	if (!path) return null;

	const edits = args.edits;
	if (Array.isArray(edits) && edits.length > 0 && edits.every(isRenderableEdit)) {
		return { path, edits };
	}

	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}

	return null;
}

function isRenderableEdit(edit: Edit): boolean {
	return typeof edit?.oldText === "string" && typeof edit?.newText === "string";
}

function formatEditCall(args: RenderableEditArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);

	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}

function getResultText(result: EditToolResultLike): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text || "")
		.join("\n");
}

function formatEditResult(
	args: RenderableEditArgs | undefined,
	preview: EditPreview | undefined,
	result: EditToolResultLike,
	theme: Theme,
	isError: boolean,
): string | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;

	if (isError) {
		const errorText = getResultText(result);
		if (!errorText || errorText === previewError) return undefined;

		return theme.fg("error", errorText);
	}

	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) {
		return renderDiff(resultDiff, { filePath: rawPath ?? undefined });
	}

	return undefined;
}

function getEditHeaderBg(
	preview: EditPreview | undefined,
	settledError: boolean | undefined,
	theme: Theme,
): (text: string) => string {
	if (settledError) {
		return (text: string) => theme.bg("toolErrorBg", text);
	}

	if (!preview) {
		return (text: string) => theme.bg("toolPendingBg", text);
	}

	if ("error" in preview) {
		return (text: string) => theme.bg("toolErrorBg", text);
	}

	return (text: string) => theme.bg("toolSuccessBg", text);
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
): EditCallRenderComponent {
	component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(args, theme, cwd), 0, 0));

	if (!component.preview) {
		return component;
	}

	const preview = component.preview;
	const body = "error" in preview ? theme.fg("error", preview.error) : renderDiff(preview.diff);

	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));

	return component;
}

function previewChanged(current: EditPreview | undefined, next: EditPreview): boolean {
	if (current === undefined) {
		return true;
	}

	if ("error" in current && "error" in next) {
		return current.error !== next.error;
	}

	if ("error" in current || "error" in next) {
		return true;
	}

	return current.diff !== next.diff || current.firstChangedLine !== next.firstChangedLine;
}

function setEditPreview(
	component: EditCallRenderComponent,
	preview: EditPreview,
	argsKey: string | undefined,
): boolean {
	const changed = previewChanged(component.preview, preview);

	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;

	return changed;
}

export const editRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const component = getEditCallRenderComponent(context.state, context.lastComponent);
		const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
		const argsKey = previewArgsKey(previewInput);

		if (component.previewArgsKey !== argsKey) {
			component.preview = undefined;
			component.previewArgsKey = argsKey;
			component.previewPending = false;
			component.settledError = false;
		}

		if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
			component.previewPending = true;
			const requestKey = argsKey;
			void computeEditsDiff(previewInput.path, previewInput.edits, context.cwd).then(
				(preview) => {
					if (component.previewArgsKey === requestKey) {
						setEditPreview(component, preview, requestKey);
						context.invalidate();
					}
				},
			);
		}

		return buildEditCallComponent(
			component,
			args as RenderableEditArgs | undefined,
			theme,
			context.cwd,
		);
	},
	renderResult(result, _options, theme, context) {
		const callComponent = context.state.callComponent;
		const previewInput = getRenderablePreviewInput(
			context.args as RenderableEditArgs | undefined,
		);
		const argsKey = previewArgsKey(previewInput);
		const typedResult = result as EditToolResultLike;
		const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
		let changed = false;

		if (callComponent) {
			if (typeof resultDiff === "string") {
				changed =
					setEditPreview(
						callComponent,
						{ diff: resultDiff, firstChangedLine: typedResult.details?.firstChangedLine },
						argsKey,
					) || changed;
			}
			if (callComponent.settledError !== context.isError) {
				callComponent.settledError = context.isError;
				changed = true;
			}
			if (changed) {
				buildEditCallComponent(
					callComponent,
					context.args as RenderableEditArgs | undefined,
					theme,
					context.cwd,
				);
			}
		}

		const output = formatEditResult(
			context.args as RenderableEditArgs | undefined,
			callComponent?.preview,
			typedResult,
			theme,
			context.isError,
		);
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		if (!output) {
			return component;
		}
		component.addChild(new Spacer(1));
		component.addChild(new Text(output, 1, 0));
		return component;
	},
};
