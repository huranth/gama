import * as os from "node:os";
import { sep } from "node:path";
import { pathToFileURL } from "node:url";
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@huranth/gama-tui";
import type { Theme } from "../../term/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { formatPathRelativeToCwdOrAbsolute, resolvePath } from "../../utils/paths.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

type RenderBlock = { type: string; text?: string; data?: string; mimeType?: string };

const ellipsis = "...";

const tabPad = "   ";

const unknownMime = "image/unknown";

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, tabPad);
}

export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";

	const home = os.homedir();
	if (path === home) return "~";
	if (path.startsWith(`${home}${sep}`)) return `~${path.slice(home.length)}`;

	return path;
}

export function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;

	const absolutePath = resolvePath(rawPath, cwd);

	return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

export function toolMoreLines(theme: Theme, remaining: number, total?: number): string {
	const totalSuffix = total !== undefined ? `, ${total} total` : "";

	return theme.fg("muted", `... (${remaining} more lines${totalSuffix})`);
}

export function renderToolPath(
	rawPath: string | null,
	theme: Theme,
	cwd: string,
	options?: { emptyFallback?: string },
): string {
	if (rawPath === null) return invalidArgText(theme);

	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", ellipsis);

	const display = formatPathRelativeToCwdOrAbsolute(value, cwd);

	return linkPath(theme.fg("accent", display), value, cwd);
}

export function getTextOutput(
	result: { content: RenderBlock[] } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const text = result.content
		.filter((block) => block.type === "text")
		.map((block) => normalizeDisplayText(sanitizeBinaryOutput(stripAnsi(block.text || ""))))
		.join("\n");

	const images = result.content.filter((block) => block.type === "image");

	const caps = getCapabilities();
	const imagesHidden = images.length > 0 && !(caps.images && showImages);

	if (!imagesHidden) return text;

	const imageText = images.map(imageIndicator).join("\n");

	return text ? `${text}\n${imageText}` : imageText;
}

function imageIndicator(image: RenderBlock): string {
	const mimeType = image.mimeType ?? unknownMime;

	const dims =
		image.data && image.mimeType
			? (getImageDimensions(image.data, image.mimeType) ?? undefined)
			: undefined;

	return imageFallback(mimeType, dims);
}
