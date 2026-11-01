import {
	allocateStackSizes,
	Stack,
	type StackChild,
	type StackOptions,
	visibleStackEntries,
} from "./stack.ts";

export type { StackChild, StackEntry, StackEntryOptions, StackOptions } from "./stack.ts";

export class VStack extends Stack {
	protected readonly layoutType = "vstack" as const;

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super(children, options);
	}

	private gapLines(): string[] {
		return Array.from({ length: this.gap }, () => "");
	}

	private paddingLines(from: number, to: number): string[] {
		return Array.from({ length: Math.max(0, to - from) }, () => "");
	}

	render(width: number): string[] {
		const viewport = { width: Math.max(1, width), height: Number.MAX_SAFE_INTEGER };
		const entries = visibleStackEntries(this.entries, viewport);
		const rendered = entries.map((entry) => entry.component.render(viewport.width));
		const sizes = allocateStackSizes(
			entries,
			rendered.map((lines) => lines.length),
			undefined,
			this.gap,
		);
		const lines: string[] = [];

		for (let index = 0; index < entries.length; index++) {
			if (index > 0) {
				lines.push(...this.gapLines());
			}

			const childLines = rendered[index]!.slice(0, sizes[index]);
			lines.push(...childLines);
			lines.push(...this.paddingLines(childLines.length, sizes[index]!));
		}

		return lines;
	}
}
