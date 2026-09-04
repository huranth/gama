import {
	LAYOUT_NODE,
	type LayoutViewport,
	type StackLayoutEntry,
	type StackLayoutNode,
} from "../layout-node.ts";
import { type Component, Container } from "../tui.ts";

export interface StackEntryOptions {
	basis?: number | "auto";
	grow?: number;
	shrink?: number;
	minSize?: number;
	maxSize?: number;
	visible?: (viewport: LayoutViewport) => boolean;
}

export interface StackEntry extends StackEntryOptions {
	component: Component;
}

export type StackChild = Component | StackEntry;

export interface StackOptions {
	gap?: number;
	align?: "stretch" | "start" | "center" | "end";
}

function isStackEntry(child: StackChild): child is StackEntry {
	return !("render" in child);
}

function normalizeSize(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(0, Math.floor(value));
}

function clampSize(size: number, entry: StackLayoutEntry): number {
	const min = Math.max(0, Math.floor(entry.minSize ?? 0));
	const max = Math.max(min, Math.floor(entry.maxSize ?? Number.MAX_SAFE_INTEGER));
	const floored = Math.max(0, Math.floor(size));
	return Math.max(min, Math.min(max, floored));
}

export function visibleStackEntries(
	entries: readonly StackLayoutEntry[],
	viewport: LayoutViewport,
): StackLayoutEntry[] {
	return entries.filter((entry) => entry.visible?.(viewport) ?? true);
}

export abstract class Stack extends Container {
	protected readonly entries: StackLayoutEntry[] = [];
	protected readonly gap: number;
	protected readonly align: "stretch" | "start" | "center" | "end";
	protected abstract readonly layoutType: "vstack" | "hstack";

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super();
		this.gap = normalizeSize(options.gap, 0);
		this.align = options.align ?? "stretch";
		for (const child of children) {
			if (isStackEntry(child)) {
				this.addChild(child.component, child);
			} else {
				this.addChild(child);
			}
		}
	}

	override addChild(component: Component, options: StackEntryOptions = {}): void {
		super.addChild(component);

		const entry: StackLayoutEntry = { component };

		if (options.basis !== undefined) entry.basis = options.basis;
		if (options.grow !== undefined) entry.grow = normalizeSize(options.grow, 0);
		if (options.shrink !== undefined) entry.shrink = normalizeSize(options.shrink, 1);
		if (options.minSize !== undefined) entry.minSize = normalizeSize(options.minSize, 0);

		if (options.maxSize !== undefined) {
			entry.maxSize = normalizeSize(options.maxSize, Number.MAX_SAFE_INTEGER);
		}

		if (options.visible !== undefined) entry.visible = options.visible;

		this.entries.push(entry);
	}

	override removeChild(component: Component): void {
		super.removeChild(component);
		const index = this.entries.findIndex((entry) => entry.component === component);
		if (index !== -1) this.entries.splice(index, 1);
	}

	override clear(): void {
		super.clear();
		this.entries.length = 0;
	}

	[LAYOUT_NODE](): StackLayoutNode {
		return {
			type: this.layoutType,
			entries: this.entries,
			gap: this.gap,
			align: this.align,
		};
	}
}

export function allocateStackSizes(
	entries: readonly StackLayoutEntry[],
	intrinsicSizes: readonly number[],
	availableSize: number | undefined,
	gap: number,
): number[] {
	const sizes = entries.map((entry, index) => {
		const basis = entry.basis;
		if (basis === undefined || basis === "auto") {
			return clampSize(intrinsicSizes[index] ?? 0, entry);
		}
		return clampSize(basis, entry);
	});
	if (availableSize === undefined) return sizes;

	const gaps = Math.max(0, entries.length - 1) * gap;
	const contentSize = Math.max(0, Math.floor(availableSize) - gaps);
	const total = sizes.reduce((sum, size) => sum + size, 0);
	if (total < contentSize) {
		distribute(sizes, entries, contentSize - total, "grow");
	} else if (total > contentSize) {
		distribute(sizes, entries, total - contentSize, "shrink");
	}
	return sizes;
}

function weightOf(
	entry: StackLayoutEntry,
	index: number,
	sizes: readonly number[],
	mode: "grow" | "shrink",
): number {
	if (mode === "grow") return entry.grow ?? 0;
	return (entry.shrink ?? 1) * Math.max(1, sizes[index]!);
}

function capacityOf(
	entry: StackLayoutEntry,
	index: number,
	sizes: readonly number[],
	mode: "grow" | "shrink",
): number {
	if (mode === "grow") {
		return (entry.maxSize ?? Number.MAX_SAFE_INTEGER) - sizes[index]!;
	}
	return sizes[index]! - (entry.minSize ?? 0);
}

function canResize(
	entry: StackLayoutEntry,
	index: number,
	sizes: readonly number[],
	mode: "grow" | "shrink",
): boolean {
	if (mode === "grow") {
		return (entry.grow ?? 0) > 0 && sizes[index]! < (entry.maxSize ?? Number.MAX_SAFE_INTEGER);
	}
	return (entry.shrink ?? 1) > 0 && sizes[index]! > (entry.minSize ?? 0);
}

function distribute(
	sizes: number[],
	entries: readonly StackLayoutEntry[],
	amount: number,
	mode: "grow" | "shrink",
): void {
	let remaining = amount;
	while (remaining > 0) {
		const candidates = entries
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry, index }) => canResize(entry, index, sizes, mode));
		if (candidates.length === 0) return;

		const totalWeight = candidates.reduce((sum, { entry, index }) => {
			return sum + weightOf(entry, index, sizes, mode);
		}, 0);
		const passAmount = remaining;
		let distributed = 0;
		for (const { entry, index } of candidates) {
			if (remaining <= 0) break;
			const weight = weightOf(entry, index, sizes, mode);
			const proposed = Math.max(1, Math.floor((passAmount * weight) / totalWeight));
			const capacity = capacityOf(entry, index, sizes, mode);
			const delta = Math.min(remaining, proposed, capacity);
			if (delta <= 0) continue;
			sizes[index] = sizes[index]! + (mode === "grow" ? delta : -delta);
			remaining -= delta;
			distributed += delta;
		}
		if (distributed === 0) return;
	}
}
