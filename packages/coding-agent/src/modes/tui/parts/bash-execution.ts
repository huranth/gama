import { Container, Loader, Spacer, Text, type TUI } from "@huranth/gama-tui";
import { exitCodeLabel } from "../../../core/exit-code.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

const PREVIEW_LINES = 20;

export class BashExecutionComponent extends Container {
	private command: string;

	private readonly colorKey: "dim" | "bashMode";

	private outputLines: string[] = [];

	private status: "running" | "complete" | "cancelled" | "error" = "running";

	private exitCode: number | undefined = undefined;

	private loader: Loader;

	private truncationResult?: TruncationResult;

	private fullOutputPath?: string;

	private expanded = false;

	private contentContainer: Container;

	constructor(command: string, ui: TUI, excludeFromContext = false) {
		super();
		this.command = command;
		this.colorKey = excludeFromContext ? "dim" : "bashMode";

		const colorKey = this.colorKey;
		const borderColor = (str: string) => theme.fg(colorKey, str);

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(borderColor));

		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		const header = new Text(theme.fg(colorKey, theme.bold(`$ ${command}`)), 1, 0);
		this.contentContainer.addChild(header);

		this.loader = new Loader(
			ui,
			(spinner) => theme.fg(colorKey, spinner),
			(text) => theme.fg("muted", text),
			"",
		);
		this.loader.stop();

		this.addChild(new DynamicBorder(borderColor));
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	appendOutput(chunk: string): void {
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			this.outputLines.push(...newLines.slice(1));
		} else {
			this.outputLines.push(...newLines);
		}

		this.updateDisplay();
	}

	setFailed(): void {
		this.exitCode = undefined;
		this.status = "error";
		this.loader.stop();
		this.updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;

		this.loader.stop();

		this.updateDisplay();
	}

	private updateDisplay(): void {
		const fullOutput = this.outputLines.join("\n");
		const contextTruncation = truncateTail(fullOutput, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});
		const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];

		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;

		this.contentContainer.clear();

		const header = new Text(theme.fg(this.colorKey, theme.bold(`$ ${this.command}`)), 1, 0);
		this.contentContainer.addChild(header);

		if (availableLines.length > 0) {
			if (this.expanded) {
				const displayText = availableLines.map((line) => theme.fg("muted", line)).join("\n");
				this.contentContainer.addChild(new Text(`\n${displayText}`, 1, 0));
			} else {
				const styledOutput = previewLogicalLines
					.map((line) => theme.fg("muted", line))
					.join("\n");
				const styledInput = `\n${styledOutput}`;
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;
				this.contentContainer.addChild({
					render: (width: number) => {
						if (cachedLines === undefined || cachedWidth !== width) {
							const result = truncateToVisualLines(styledInput, PREVIEW_LINES, width, 1);
							cachedLines = result.visualLines;
							cachedWidth = width;
						}
						return cachedLines ?? [];
					},
					invalidate: () => {
						cachedWidth = undefined;
						cachedLines = undefined;
					},
				});
			}
		}

		// Settled status.
		if (this.status !== "running") {
			const statusParts: string[] = [];

			// Expand hint.
			if (hiddenLineCount > 0) {
				if (this.expanded) {
					statusParts.push(theme.fg("muted", "collapse"));
				} else {
					statusParts.push(theme.fg("muted", "expand"));
				}
			}

			if (this.status === "cancelled") {
				statusParts.push(theme.fg("warning", "Cancelled"));
			} else if (this.status === "error") {
				const label = this.exitCode === undefined ? "Failed" : exitCodeLabel(this.exitCode);
				statusParts.push(theme.fg("error", `${label[0]!.toUpperCase()}${label.slice(1)}`));
			}

			const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
			if (wasTruncated && this.fullOutputPath) {
				statusParts.push(
					theme.fg("warning", `Output truncated, full output at ${this.fullOutputPath}`),
				);
			}

			if (statusParts.length > 0) {
				this.contentContainer.addChild(new Text(`\n${statusParts.join("\n")}`, 1, 0));
			}
		}
	}

	getOutput(): string {
		return this.outputLines.join("\n");
	}

	getCommand(): string {
		return this.command;
	}
}
