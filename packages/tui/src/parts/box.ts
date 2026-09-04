import {
	type Component,
	dispatchMouseEvent,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
} from "../tui.ts";
import { visibleWidth } from "../utils.ts";

type RenderCache = {
	childLines: string[];
	width: number;
	bgSample: string | undefined;
	lines: string[];
};

export class Box implements Component {
	children: Component[] = [];
	private paddingX: number;
	private paddingY: number;
	private bgFn?: (text: string) => string;

	private cache?: RenderCache;
	private mouseLayout?: {
		width: number;
		children: Array<{ component: Component; height: number }>;
	};

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index === -1) return;
		this.children.splice(index, 1);
		this.invalidateCache();
	}

	clear(): void {
		this.children = [];
		this.invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.bgFn = bgFn;
		this.invalidateCache();
	}

	invalidate(): void {
		this.invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		const contentWidth = Math.max(1, event.width - this.paddingX * 2);
		const contentX = event.x - this.paddingX;
		const contentY = event.y - this.paddingY;

		if (contentY < 0 || contentX < 0 || contentX >= contentWidth) {
			return undefined;
		}

		let childY = 0;
		for (const child of this.getMouseChildren(contentWidth)) {
			if (contentY >= childY && contentY < childY + child.height) {
				return dispatchMouseEvent(child.component, {
					...event,
					x: contentX,
					y: contentY - childY,
					width: contentWidth,
					height: child.height,
				});
			}
			childY += child.height;
		}

		return undefined;
	}

	render(width: number): string[] {
		if (this.children.length === 0) {
			this.mouseLayout = undefined;
			return [];
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const { childLines, mouseChildren } = this.renderChildren(contentWidth);

		this.mouseLayout = { width: contentWidth, children: mouseChildren };

		if (childLines.length === 0) {
			return [];
		}

		const bgSample = this.bgFn ? this.bgFn("test") : undefined;

		if (this.matchCache(width, childLines, bgSample)) {
			return this.cache!.lines;
		}

		const leftPad = " ".repeat(this.paddingX);
		const result = [...this.emptyLines(width)];

		for (const line of childLines) {
			result.push(this.applyBg(leftPad + line, width));
		}

		result.push(...this.emptyLines(width));

		this.cache = { childLines, width, bgSample, lines: result };

		return result;
	}

	private getMouseChildren(contentWidth: number): Array<{ component: Component; height: number }> {
		if (this.mouseLayout?.width === contentWidth) {
			return this.mouseLayout.children;
		}

		return this.children.map((component) => ({
			component,
			height: component.render(contentWidth).length,
		}));
	}

	private renderChildren(contentWidth: number): {
		childLines: string[];
		mouseChildren: Array<{ component: Component; height: number }>;
	} {
		const childLines: string[] = [];
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		for (const child of this.children) {
			const lines = child.render(contentWidth);
			mouseChildren.push({ component: child, height: lines.length });
			for (const line of lines) {
				childLines.push(line);
			}
		}
		return { childLines, mouseChildren };
	}

	private emptyLines(width: number): string[] {
		return Array.from({ length: this.paddingY }, () => this.applyBg("", width));
	}

	private matchCache(width: number, childLines: string[], bgSample: string | undefined): boolean {
		const cache = this.cache;
		const sameWidth = cache?.width === width;
		const sameBg = cache?.bgSample === bgSample;
		if (!cache || !sameWidth || !sameBg) return false;
		if (cache.childLines.length !== childLines.length) return false;
		return cache.childLines.every((line, index) => line === childLines[index]);
	}

	private invalidateCache(): void {
		this.cache = undefined;
		this.mouseLayout = undefined;
	}

	private applyBg(line: string, width: number): string {
		const padNeeded = Math.max(0, width - visibleWidth(line));
		const padded = line + " ".repeat(padNeeded);
		return this.bgFn ? this.bgFn(padded) : padded;
	}
}
