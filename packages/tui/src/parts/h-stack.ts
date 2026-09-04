import type { StackLayoutEntry } from "../layout-node.ts";
import { compositeTuiLine } from "../tui.ts";
import { visibleWidth } from "../utils.ts";
import {
	allocateStackSizes,
	Stack,
	type StackChild,
	type StackOptions,
	visibleStackEntries,
} from "./stack.ts";

export class HStack extends Stack {
	protected readonly layoutType = "hstack" as const;

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super(children, options);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const entries = this.visibleEntries(safeWidth);
		if (entries.length === 0) return [];

		const widths = this.measureWidths(entries, safeWidth);
		const rendered = this.renderChildren(entries, widths);
		const height = rendered.reduce((max, lines) => Math.max(max, lines.length), 0);
		const result = Array.from({ length: height }, () => "");

		let x = 0;

		for (let index = 0; index < rendered.length; index++) {
			const lines = rendered[index]!;
			const childWidth = widths[index]!;
			const offset = this.alignOffset(height, lines.length);

			for (let row = 0; row < lines.length; row++) {
				const target = row + offset;
				if (target < 0 || target >= result.length) continue;

				result[target] = compositeTuiLine(
					result[target]!,
					lines[row]!,
					x,
					childWidth,
					safeWidth,
				);
			}

			x += childWidth + this.gap;
		}

		return result;
	}

	private visibleEntries(width: number): StackLayoutEntry[] {
		const viewport = { width, height: Number.MAX_SAFE_INTEGER };
		return visibleStackEntries(this.entries, viewport);
	}

	private measureWidths(entries: StackLayoutEntry[], width: number): number[] {
		const intrinsicWidths = entries.map((entry) => {
			const lines = entry.component.render(width);
			return lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
		});

		return allocateStackSizes(entries, intrinsicWidths, width, this.gap);
	}

	private renderChildren(entries: StackLayoutEntry[], widths: number[]): string[][] {
		return entries.map((entry, index) => {
			const childWidth = widths[index]!;
			if (childWidth === 0) return [];
			return entry.component.render(childWidth);
		});
	}

	private alignOffset(height: number, childHeight: number): number {
		if (this.align === "center") return Math.floor((height - childHeight) / 2);
		if (this.align === "end") return height - childHeight;
		return 0;
	}
}
