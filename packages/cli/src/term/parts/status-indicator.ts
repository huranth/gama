import { type Component, Loader, type TUI, truncateToWidth } from "@huranth/gama-tui";
import type { WorkingIndicatorOptions } from "../../core/ext/index.ts";
import { theme } from "../theme/theme.ts";

const BORDER_PADDING = 2;

export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary";

export type CompactionStatusReason = "manual" | "threshold" | "overflow";

export class StatusIndicator extends Loader {
	readonly kind: StatusIndicatorKind;

	constructor(
		kind: StatusIndicatorKind,
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
		indicator?: WorkingIndicatorOptions,
	) {
		super(ui, spinnerColorFn, messageColorFn, message, indicator);
		this.kind = kind;
	}

	renderInBorder(width: number): string {
		// Second row
		const line = super.render(width + BORDER_PADDING)[1] ?? "";

		// Trim padding
		const trimmed = line
			.replace(/^\s+/, "")
			.replace(/\s+(?=(?:\x1b\[[0-9;]*m|\s)*$)/g, "");

		return truncateToWidth(trimmed, width, "");
	}

	renderSpinnerInBorder(width: number): string {
		return truncateToWidth(this.getRenderedIndicator(), width, "");
	}

	dispose(): void {
		this.stop();
	}
}

export class WorkingStatusIndicator extends StatusIndicator {
	constructor(
		ui: TUI,
		message: string,
		indicator?: WorkingIndicatorOptions,
		colorFn?: (text: string) => string,
	) {
		super(
			"working",
			ui,
			colorFn ?? ((text) => theme.fg("accent", text)),
			colorFn ?? ((text) => theme.fg("muted", text)),
			message,
			indicator,
		);
	}
}

export class RetryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, attempt: number, maxAttempts: number) {
		super(
			"retry",
			ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => theme.fg("muted", text),
			`Retrying ${attempt}/${maxAttempts}`,
		);
	}
}

export class CompactionStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, reason: CompactionStatusReason) {
		let label = "Auto-compacting";
		if (reason === "manual") {
			label = "Compacting context";
		} else if (reason === "overflow") {
			label = "Context overflow, auto-compacting";
		}

		super(
			"compaction",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			label,
		);
	}
}

export class BranchSummaryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI) {
		super(
			"branchSummary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			"Summarizing branch",
		);
	}
}

export class IdleStatus implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);

		return [emptyLine, emptyLine];
	}
}
