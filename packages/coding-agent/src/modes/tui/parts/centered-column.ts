import { Container, type TuiMouseEvent, visibleWidth } from "@huranth/gama-tui";

export class CenteredColumn extends Container {
	private readonly maxWidth: number;
	private lastColumnOffset = 0;
	private lastColumnWidth = 0;

	constructor(maxWidth: number) {
		super();
		this.maxWidth = maxWidth;
	}

	private columnWidth(width: number): number {
		return Math.min(width, this.maxWidth);
	}

	private columnOffset(width: number): number {
		return Math.floor(Math.max(0, width - this.columnWidth(width)) / 2);
	}

	override render(width: number): string[] {
		const columnWidth = this.columnWidth(width);
		const offset = this.columnOffset(width);

		this.lastColumnOffset = offset;
		this.lastColumnWidth = columnWidth;

		const pad = " ".repeat(offset);
		const lines: string[] = [];

		for (const child of this.children) {
			for (const line of child.render(columnWidth)) {
				if (line.length === 0 || visibleWidth(line) === 0) {
					lines.push("");
					continue;
				}

				lines.push(`${pad}${line}`);
			}
		}

		return lines;
	}

	getTextSelectionLeft(): number {
		return this.lastColumnOffset;
	}

	resolveTextSelectionTarget(
		x: number,
		y: number,
	): ReturnType<Container["resolveTextSelectionTarget"]> {
		const left = this.lastColumnOffset;
		const right = left + this.lastColumnWidth - 1;
		const clampedX = Math.max(left, Math.min(right, x));

		return super.resolveTextSelectionTarget(clampedX - left, y, this.lastColumnWidth);
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		const left = this.lastColumnOffset;
		const right = left + this.lastColumnWidth;

		if (event.x < left || event.x >= right) {
			return undefined;
		}

		if (event.y < 0 || event.y >= event.height) {
			return undefined;
		}

		return super.handleMouse({
			...event,
			x: event.x - left,
			width: this.lastColumnWidth,
		});
	}
}
