import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentState } from "@huranth/gama-agent-core";
import { APP_NAME, getExportTemplateDir } from "../../config.ts";
import { getResolvedThemeColors, getThemeExportColors } from "../../term/theme/theme.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { ToolDefinition } from "../ext/types.ts";
import type { SessionEntry } from "../sessions.ts";
import { SESSION_DIR_MODE, SESSION_FILE_MODE, SessionStore } from "../sessions.ts";

const TEMPLATE_RENDERED_TOOLS = new Set(["bash", "read", "write", "edit", "ls"]);

// WCAG luminance
const SRGB_THRESHOLD = 0.03928;

const SRGB_DIVISOR = 12.92;

const SRGB_OFFSET = 0.055;

const SRGB_SCALE = 1.055;

const SRGB_EXPONENT = 2.4;

const LIGHT_LUMINANCE = 0.5;

// Background steps
const LIGHT_PAGE_FACTOR = 0.96;

const DARK_PAGE_FACTOR = 0.7;

const DARK_CARD_FACTOR = 0.85;

const BYTE_MAX = 255;

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
	header: ReturnType<SessionStore["getHeader"]>;
	entries: ReturnType<SessionStore["getEntries"]>;
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
	const toLinear = (channel: number): number => {
		const scaled = channel / BYTE_MAX;
		if (scaled <= SRGB_THRESHOLD) return scaled / SRGB_DIVISOR;

		return ((scaled + SRGB_OFFSET) / SRGB_SCALE) ** SRGB_EXPONENT;
	};

	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function adjustBrightness(color: string, factor: number): string {
	const parsed = parseColor(color);
	if (!parsed) return color;

	const adjust = (channel: number): number =>
		Math.min(BYTE_MAX, Math.max(0, Math.round(channel * factor)));

	return `rgb(${adjust(parsed.r)}, ${adjust(parsed.g)}, ${adjust(parsed.b)})`;
}

function shiftColor(r: number, g: number, b: number, dr: number, dg: number, db: number): string {
	const clamp = (value: number): number => Math.max(0, Math.min(BYTE_MAX, value));

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
	if (luminance > LIGHT_LUMINANCE) {
		return {
			pageBg: adjustBrightness(baseColor, LIGHT_PAGE_FACTOR),
			cardBg: baseColor,
			infoBg: shiftColor(parsed.r, parsed.g, parsed.b, 10, 5, -20),
		};
	}

	return {
		pageBg: adjustBrightness(baseColor, DARK_PAGE_FACTOR),
		cardBg: adjustBrightness(baseColor, DARK_CARD_FACTOR),
		infoBg: shiftColor(parsed.r, parsed.g, parsed.b, 20, 15, 0),
	};
}

// Sanitize CSS
function safeCssValue(value: string | undefined, fallback: string): string {
	return value !== undefined && value !== "" && !/[<>"';{}\\]/.test(value) ? value : fallback;
}

function exportColorsOf(themeName?: string): ExportColors {
	const colors = getResolvedThemeColors(themeName);
	const themeExport = getThemeExportColors(themeName);
	const derived = deriveExportColors(colors.userMessageBg);

	return {
		pageBg: safeCssValue(themeExport.pageBg, derived.pageBg),
		cardBg: safeCssValue(themeExport.cardBg, derived.cardBg),
		infoBg: safeCssValue(themeExport.infoBg, derived.infoBg),
	};
}

function generateThemeVars(themeName: string | undefined, exportColors: ExportColors): string {
	const colors = getResolvedThemeColors(themeName);
	const lines: string[] = [];

	for (const [key, value] of Object.entries(colors)) {
		if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) continue;

		lines.push(`--${key}: ${safeCssValue(value, "inherit")};`);
	}

	lines.push(`--exportPageBg: ${exportColors.pageBg};`);
	lines.push(`--exportCardBg: ${exportColors.cardBg};`);
	lines.push(`--exportInfoBg: ${exportColors.infoBg};`);

	return lines.join("\n      ");
}

function generateHtml(sessionData: SessionData, themeName?: string): string {
	const templateDir = getExportTemplateDir();
	const template = readFileSync(join(templateDir, "template.html"), "utf-8");
	const templateCss = readFileSync(join(templateDir, "template.css"), "utf-8");
	const templateJs = readFileSync(join(templateDir, "template.js"), "utf-8");
	const markedJs = readFileSync(join(templateDir, "vendor", "marked.min.js"), "utf-8");
	const hljsJs = readFileSync(join(templateDir, "vendor", "highlight.min.js"), "utf-8");

	const exportColors = exportColorsOf(themeName);
	const themeVars = generateThemeVars(themeName, exportColors);
	const bodyBg = exportColors.pageBg;
	const containerBg = exportColors.cardBg;
	const infoBg = exportColors.infoBg;

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

		const message = entry.message;

		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type !== "toolCall" || TEMPLATE_RENDERED_TOOLS.has(block.name)) continue;

				const callHtml = toolRenderer.renderCall(block.id, block.name, block.arguments);
				if (callHtml) renderedTools[block.id] = { callHtml };
			}
		}

		if (message.role !== "toolResult" || !message.toolCallId) continue;

		const toolName = message.toolName ?? "";
		const existing = renderedTools[message.toolCallId];
		if (!existing && TEMPLATE_RENDERED_TOOLS.has(toolName)) continue;

		const rendered = toolRenderer.renderResult(
			message.toolCallId,
			toolName,
			message.content,
			message.details,
			message.isError || false,
		);
		if (!rendered) continue;

		renderedTools[message.toolCallId] = {
			...existing,
			resultHtmlCollapsed: rendered.collapsed,
			resultHtmlExpanded: rendered.expanded,
		};
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
	const resolvedSource = resolvePath(sourcePath);
	const path =
		outputPath !== undefined
			? normalizePath(outputPath)
			: join(dirname(sourcePath), `${APP_NAME}-session-${sourceStem(sourcePath)}.html`);
	const resolvedOutput = resolvePath(path);
	const samePath =
		process.platform === "win32"
			? resolvedOutput.toLowerCase() === resolvedSource.toLowerCase()
			: resolvedOutput === resolvedSource;
	if (samePath) {
		throw new Error("Refusing to overwrite the session file with an HTML export.");
	}

	mkdirSync(dirname(path), { recursive: true, mode: SESSION_DIR_MODE });
	writeFileSync(path, html, { encoding: "utf8", mode: SESSION_FILE_MODE });

	return path;
}

export async function exportSessionToHtml(
	sm: SessionStore,
	state?: AgentState,
	options?: ExportOptions | string,
): Promise<string> {
	const opts = toExportOptions(options);
	const sessionFile = sm.getSessionFile();
	if (!sessionFile) {
		throw new Error("Session unsaved");
	}

	if (!existsSync(sessionFile)) {
		throw new Error("Nothing to export");
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
		tools: state?.tools?.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
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

	const sm = SessionStore.open(resolvedInputPath);

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
