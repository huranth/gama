import type { ImageContent, TextContent } from "@huranth/gama-ai";
import type { Component } from "@huranth/gama-tui";
import type { Theme } from "../../modes/tui/theme/theme.ts";
import type { ToolRenderContext, ToolRenderers } from "../ext/types.ts";
import { ansiLinesToHtml } from "./ansi-to-html.ts";

export interface ToolHtmlRendererDeps {
	getToolRenderers: (name: string) => ToolRenderers | undefined;
	theme: Theme;
	cwd: string;
	width?: number;
}

export interface ToolHtmlRenderer {
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { collapsed?: string; expanded?: string } | undefined;
}

interface RenderContextOptions {
	lastComponent: Component | undefined;
	expanded: boolean;
	isPartial: boolean;
	isError: boolean;
}

const ANSI_ESCAPE_REGEX = /\x1b\[[\d;]*m/g;

function isBlankRenderedLine(line: string): boolean {
	return line.replace(ANSI_ESCAPE_REGEX, "").trim().length === 0;
}

function trimRenderedResultLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlankRenderedLine(lines[start])) {
		start++;
	}

	while (end > start && isBlankRenderedLine(lines[end - 1])) {
		end--;
	}

	return lines.slice(start, end);
}

export function createToolHtmlRenderer(deps: ToolHtmlRendererDeps): ToolHtmlRenderer {
	const { getToolRenderers, theme, cwd, width = 100 } = deps;

	const renderedCallComponents = new Map<string, Component>();
	const renderedResultComponents = new Map<string, Component>();
	const renderedStates = new Map<string, any>();
	const renderedArgs = new Map<string, unknown>();

	const getState = (toolCallId: string): any => {
		let state = renderedStates.get(toolCallId);
		if (!state) {
			state = {};
			renderedStates.set(toolCallId, state);
		}
		return state;
	};

	const createRenderContext = (
		toolCallId: string,
		options: RenderContextOptions,
	): ToolRenderContext => {
		return {
			args: renderedArgs.get(toolCallId),
			toolCallId,
			invalidate: () => {},
			lastComponent: options.lastComponent,
			state: getState(toolCallId),
			cwd,
			executionStarted: true,
			argsComplete: true,
			isPartial: options.isPartial,
			expanded: options.expanded,
			showImages: false,
			isError: options.isError,
		};
	};

	return {
		renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined {
			try {
				renderedArgs.set(toolCallId, args);
				const toolDef = getToolRenderers(toolName);
				if (!toolDef?.renderCall) {
					return undefined;
				}

				const component = toolDef.renderCall(
					args,
					theme,
					createRenderContext(toolCallId, {
						lastComponent: renderedCallComponents.get(toolCallId),
						expanded: false,
						isPartial: true,
						isError: false,
					}),
				);
				renderedCallComponents.set(toolCallId, component);
				const lines = component.render(width);
				return ansiLinesToHtml(lines);
			} catch {
				return undefined;
			}
		},

		renderResult(
			toolCallId: string,
			toolName: string,
			result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
			details: unknown,
			isError: boolean,
		): { collapsed?: string; expanded?: string } | undefined {
			try {
				const renderResult = getToolRenderers(toolName)?.renderResult;
				if (!renderResult) {
					return undefined;
				}

				const agentToolResult = {
					content: result as (TextContent | ImageContent)[],
					details,
					isError,
				};

				const renderAt = (expanded: boolean): string => {
					const component = renderResult(
						agentToolResult,
						{ expanded, isPartial: false },
						theme,
						createRenderContext(toolCallId, {
							lastComponent: renderedResultComponents.get(toolCallId),
							expanded,
							isPartial: false,
							isError,
						}),
					);
					renderedResultComponents.set(toolCallId, component);

					return ansiLinesToHtml(trimRenderedResultLines(component.render(width)));
				};

				const collapsed = renderAt(false);
				const expanded = renderAt(true);

				return {
					...(collapsed && collapsed !== expanded ? { collapsed } : {}),
					expanded,
				};
			} catch {
				return undefined;
			}
		},
	};
}
