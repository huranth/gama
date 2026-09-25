import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentState } from "@huranth/gama-agent-core";
import { APP_NAME, getExportTemplateDir } from "../../config.ts";
import { getResolvedThemeColors, getThemeExportColors } from "../../modes/tui/theme/theme.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { ToolDefinition } from "../ext/types.ts";
import type { SessionEntry } from "../session-manager.ts";
import { SessionManager } from "../session-manager.ts";

const DEFAULT_USER_MESSAGE_BG = "#343541";

const TEMPLATE_RENDERED_TOOLS = new Set(["bash", "read", "write", "edit", "ls"]);

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

interface RenderedToolHtml {
	callHtml?: string;
	resultHtmlCollapsed?: string;
	resultHtmlExpanded?: string;
}

interface ExportColors {
	pageBg: string;
	cardBg: string;
	infoBg: string;
}

export interface ExportOptions {
	outputPath?: string;
	themeName?: string;
	toolRenderer?: ToolHtmlRenderer;
}

interface SessionData {
	header: ReturnType<SessionManager["getHeader"]>;
	entries: ReturnType<SessionManager["getEntries"]>;
	leafId: string | null;
	systemPrompt?: string;
	tools?: Array<Pick<ToolDefinition, "name" | "description" | "parameters">>;
	renderedTools?: Record<string, RenderedToolHtml>;
}

function parseColor(color: string): { r: number; g: number; b: number } | undefined {
	const hexMatch = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (hexMatch) {
		return {
			r: Number.parseInt(hexMatch[1], 16),
			g: Number.parseInt(hexMatch[2], 16),
			b: Number.parseInt(hexMatch[3], 16),
		};
	}
	const rgbMatch = color.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
	if (rgbMatch) {
		return {
			r: Number.parseInt(rgbMatch[1], 10),
			g: Number.parseInt(rgbMatch[2], 10),
			b: Number.parseInt(rgbMatch[3], 10),
		};
	}
	return undefined;
}

function getLuminance(r: number, g: number, b: number): number {
	const toLinear = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function adjustBrightness(color: string, factor: number): string {
	const parsed = parseColor(color);
	if (!parsed) return color;

	const adjust = (channel: number) => Math.min(255, Math.max(0, Math.round(channel * factor)));

	return `rgb(${adjust(parsed.r)}, ${adjust(parsed.g)}, ${adjust(parsed.b)})`;
}

function shiftColor(r: number, g: number, b: number, dr: number, dg: number, db: number): string {
	const clamp = (value: number) => Math.max(0, Math.min(255, value));

	return `rgb(${clamp(r + dr)}, ${clamp(g + dg)}, ${clamp(b + db)})`;
}

function deriveExportColors(baseColor: string): ExportColors {
	const parsed = parseColor(baseColor);
	if (!parsed) {
		return {
			pageBg: "rgb(24, 24, 30)",
			cardBg: "rgb(30, 30, 36)",
			infoBg: "rgb(60, 55, 40)",
		};
	}

	const luminance = getLuminance(parsed.r, parsed.g, parsed.b);
	const isLight = luminance > 0.5;

	if (isLight) {
		return {
			pageBg: adjustBrightness(baseColor, 0.96),
			cardBg: baseColor,
			infoBg: shiftColor(parsed.r, parsed.g, parsed.b, 10, 5, -20),
		};
	}

	return {
		pageBg: adjustBrightness(baseColor, 0.7),
		cardBg: adjustBrightness(baseColor, 0.85),
		infoBg: shiftColor(parsed.r, parsed.g, parsed.b, 20, 15, 0),
	};
}

// Untrusted input
function safeCssValue(value: string | undefined, fallback: string): string {
	return value !== undefined && value !== "" && !/[<>"';{}\\]/.test(value) ? value : fallback;
}

function generateThemeVars(themeName?: string): string {
	const colors = getResolvedThemeColors(themeName);
	const lines: string[] = [];

	for (const [key, value] of Object.entries(colors)) {
		if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) continue;
		lines.push(`--${key}: ${safeCssValue(value, "inherit")};`);
	}

	const themeExport = getThemeExportColors(themeName);
	const userMessageBg = colors.userMessageBg || DEFAULT_USER_MESSAGE_BG;
	const derivedColors = deriveExportColors(userMessageBg);

	lines.push(`--exportPageBg: ${safeCssValue(themeExport.pageBg, derivedColors.pageBg)};`);
	lines.push(`--exportCardBg: ${safeCssValue(themeExport.cardBg, derivedColors.cardBg)};`);
	lines.push(`--exportInfoBg: ${safeCssValue(themeExport.infoBg, derivedColors.infoBg)};`);

	return lines.join("\n      ");
}

function generateHtml(sessionData: SessionData, themeName?: string): string {
	const templateDir = getExportTemplateDir();
	const template = readFileSync(join(templateDir, "template.html"), "utf-8");
	const templateCss = readFileSync(join(templateDir, "template.css"), "utf-8");
	const templateJs = readFileSync(join(templateDir, "template.js"), "utf-8");
	const markedJs = readFileSync(join(templateDir, "vendor", "marked.min.js"), "utf-8");
	const hljsJs = readFileSync(join(templateDir, "vendor", "highlight.min.js"), "utf-8");

	const themeVars = generateThemeVars(themeName);
	const colors = getResolvedThemeColors(themeName);
	const themeExport = getThemeExportColors(themeName);
	const derivedExportColors = deriveExportColors(colors.userMessageBg || DEFAULT_USER_MESSAGE_BG);
	const bodyBg = safeCssValue(themeExport.pageBg, derivedExportColors.pageBg);
	const containerBg = safeCssValue(themeExport.cardBg, derivedExportColors.cardBg);
	const infoBg = safeCssValue(themeExport.infoBg, derivedExportColors.infoBg);

	const sessionDataBase64 = Buffer.from(JSON.stringify(sessionData)).toString("base64");

	// Literal dollars
	const css = templateCss
		.replace("{{THEME_VARS}}", () => themeVars)
		.replace("{{BODY_BG}}", () => bodyBg)
		.replace("{{CONTAINER_BG}}", () => containerBg)
		.replace("{{INFO_BG}}", () => infoBg);

	return template
		.replace("{{CSS}}", () => css)
		.replace("{{JS}}", () => templateJs)
		.replace("{{SESSION_DATA}}", () => sessionDataBase64)
		.replace("{{MARKED_JS}}", () => markedJs)
		.replace("{{HIGHLIGHT_JS}}", () => hljsJs);
}

function preRenderCustomTools(
	entries: SessionEntry[],
	toolRenderer: ToolHtmlRenderer,
): Record<string, RenderedToolHtml> {
	const renderedTools: Record<string, RenderedToolHtml> = {};

	for (const entry of entries) {
		if (entry.type !== "message") continue;

		const msg = entry.message;

		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "toolCall" && !TEMPLATE_RENDERED_TOOLS.has(block.name)) {
					const callHtml = toolRenderer.renderCall(block.id, block.name, block.arguments);
					if (callHtml) {
						renderedTools[block.id] = { callHtml };
					}
				}
			}
		}

		if (msg.role === "toolResult" && msg.toolCallId) {
			const toolName = msg.toolName ?? "";
			const existing = renderedTools[msg.toolCallId];
			if (existing || !TEMPLATE_RENDERED_TOOLS.has(toolName)) {
				const rendered = toolRenderer.renderResult(
					msg.toolCallId,
					toolName,
					msg.content,
					msg.details,
					msg.isError || false,
				);
				if (rendered) {
					renderedTools[msg.toolCallId] = {
						...existing,
						resultHtmlCollapsed: rendered.collapsed,
						resultHtmlExpanded: rendered.expanded,
					};
				}
			}
		}
	}

	return renderedTools;
}

function toExportOptions(options?: ExportOptions | string): ExportOptions {
	if (typeof options === "string") return { outputPath: options };

	return options ?? {};
}

function sourceStem(sessionPath: string): string {
	return basename(sessionPath).replace(/\.(jsonl|gama)$/, "");
}

function writeExport(html: string, outputPath: string | undefined, sourcePath: string): string {
	const path =
		outputPath !== undefined
			? normalizePath(outputPath)
			: join(dirname(sourcePath), `${APP_NAME}-session-${sourceStem(sourcePath)}.html`);

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, html, "utf8");

	return path;
}

export async function exportSessionToHtml(
	sm: SessionManager,
	state?: AgentState,
	options?: ExportOptions | string,
): Promise<string> {
	const opts = toExportOptions(options);
	const sessionFile = sm.getSessionFile();
	if (!sessionFile) {
		throw new Error("Cannot export in-memory session to HTML");
	}

	if (!existsSync(sessionFile)) {
		throw new Error("Nothing to export yet - start a conversation first");
	}

	const entries = sm.getEntries();

	let renderedTools: Record<string, RenderedToolHtml> | undefined;
	if (opts.toolRenderer) {
		renderedTools = preRenderCustomTools(entries, opts.toolRenderer);
		if (Object.keys(renderedTools).length === 0) {
			renderedTools = undefined;
		}
	}

	const sessionData: SessionData = {
		header: sm.getHeader(),
		entries,
		leafId: sm.getLeafId(),
		systemPrompt: state?.systemPrompt,
		tools: state?.tools?.map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		})),
		renderedTools,
	};

	const html = generateHtml(sessionData, opts.themeName);

	return writeExport(html, opts.outputPath, sessionFile);
}

export async function exportFromFile(
	inputPath: string,
	options?: ExportOptions | string,
): Promise<string> {
	const opts = toExportOptions(options);
	const resolvedInputPath = resolvePath(inputPath);

	if (!existsSync(resolvedInputPath)) {
		throw new Error(`File not found: ${resolvedInputPath}`);
	}

	const sm = SessionManager.open(resolvedInputPath);

	const sessionData: SessionData = {
		header: sm.getHeader(),
		entries: sm.getEntries(),
		leafId: sm.getLeafId(),
		systemPrompt: undefined,
		tools: undefined,
	};

	const html = generateHtml(sessionData, opts.themeName);

	return writeExport(html, opts.outputPath, resolvedInputPath);
}
