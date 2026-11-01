import {
	getScrollbarGeometry,
	getScrollViewBox,
	getScrollViewsAt,
	type LayoutFrame,
	type ScrollbarGeometry,
} from "../layout.ts";
import type { ScrollView } from "../view/scroll-view.ts";

export interface ScrollbarDrag {
	scrollView: ScrollView;
	grabOffset: number;
}

export interface ScrollbarTarget {
	scrollView: ScrollView;
	geometry: ScrollbarGeometry;
}

export function getScrollbarTargetAt(
	frame: LayoutFrame,
	x: number,
	y: number,
	includeHiddenAuto = false,
): ScrollbarTarget | undefined {
	for (const scrollView of getScrollViewsAt(frame, x, y)) {
		const box = getScrollViewBox(frame, scrollView);
		const geometry = box ? getScrollbarGeometry(box, includeHiddenAuto) : undefined;
		if (!geometry) continue;
		const insideTrack = y >= geometry.trackTop && y < geometry.trackTop + geometry.trackHeight;
		if (x === geometry.column && insideTrack) return { scrollView, geometry };
	}
	return undefined;
}

export function getThumbGrab(
	geometry: ScrollbarGeometry,
	y: number,
): { onThumb: boolean; grabOffset: number } {
	const onThumb = y >= geometry.thumbTop && y < geometry.thumbTop + geometry.thumbHeight;
	const grabOffset = onThumb ? y - geometry.thumbTop : Math.floor(geometry.thumbHeight / 2);
	return { onThumb, grabOffset };
}

export function getScrollbarScrollTop(
	geometry: ScrollbarGeometry,
	pointerY: number,
	grabOffset: number,
): number {
	const maxThumbOffset = geometry.trackHeight - geometry.thumbHeight;
	if (maxThumbOffset === 0) return 0;
	const rawOffset = pointerY - geometry.trackTop - grabOffset;
	const thumbOffset = Math.max(0, Math.min(maxThumbOffset, rawOffset));
	return Math.round((thumbOffset / maxThumbOffset) * geometry.maxScrollTop);
}

export class ScrollbarController {
	private hover: ScrollView | undefined;
	private drag: ScrollbarDrag | undefined;

	get isDragging(): boolean {
		return this.drag !== undefined;
	}

	setHover(scrollView: ScrollView | undefined): void {
		if (scrollView === this.hover) return;
		this.hover?.setScrollbarActive(false);
		this.hover = scrollView;
		this.hover?.setScrollbarActive(true);
	}

	beginDrag(target: ScrollbarTarget, pointerY: number): void {
		this.setHover(target.scrollView);
		const grab = getThumbGrab(target.geometry, pointerY);
		if (!grab.onThumb) {
			target.scrollView.scrollTo(getScrollbarScrollTop(target.geometry, pointerY, grab.grabOffset));
		}
		this.drag = { scrollView: target.scrollView, grabOffset: grab.grabOffset };
	}

	dragTo(frame: LayoutFrame | undefined, pointerY: number): void {
		const drag = this.drag;
		if (!drag || !frame) return;
		const box = getScrollViewBox(frame, drag.scrollView);
		const geometry = box ? getScrollbarGeometry(box) : undefined;
		if (!geometry) return;
		drag.scrollView.scrollTo(getScrollbarScrollTop(geometry, pointerY, drag.grabOffset));
	}

	stopDrag(): void {
		this.drag = undefined;
	}

	reset(): void {
		this.stopDrag();
		this.setHover(undefined);
	}
}
