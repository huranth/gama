import type { TUI } from "@huranth/gama-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	GAMA_ASCII_HEIGHT,
	GAMA_ASCII_ROWS,
	GAMA_ASCII_TOTAL_ROWS,
	GAMA_ASCII_WIDTH,
	GAMA_BAND_HEX,
	GamaAsciiLogo,
	gamaAsciiBandOffset,
	gamaAsciiBandOfRow,
} from "../src/modes/tui/parts/gama-ascii-logo.ts";
import { initTheme } from "../src/modes/tui/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function tui(): { ui: TUI; requestRender: ReturnType<typeof vi.fn> } {
	const requestRender = vi.fn();
	return { ui: { requestRender } as unknown as TUI, requestRender };
}

describe("gama ASCII logo", () => {
	beforeAll(() => {
		initTheme("dark");
		vi.useFakeTimers();
	});

	it("holds the gamma grid: fused bar, left hook, kicking tail", () => {
		expect(GAMA_ASCII_ROWS).toHaveLength(12);
		expect(GAMA_ASCII_HEIGHT).toBe(12);
		expect(GAMA_ASCII_WIDTH).toBe(14);
		for (const row of GAMA_ASCII_ROWS) {
			expect([...row].length).toBeLessThanOrEqual(GAMA_ASCII_WIDTH);
			for (const cell of row) {
				expect([" ", "▀", "▄", "█"]).toContain(cell);
			}
		}
		expect(GAMA_ASCII_ROWS[0]).toBe(" ▄███████████");
		expect(GAMA_ASCII_ROWS[1]).toBe("██████████████");
		expect(GAMA_ASCII_ROWS[11]).toBe("  ▀██▀");
	});

	it("stacks six 2-row courses, base course first, each its own color", () => {
		expect(GAMA_BAND_HEX).toHaveLength(6);
		expect(new Set(GAMA_BAND_HEX).size).toBe(6);
		expect(gamaAsciiBandOfRow(11)).toBe(0);
		expect(gamaAsciiBandOfRow(10)).toBe(0);
		expect(gamaAsciiBandOfRow(0)).toBe(5);
		expect(gamaAsciiBandOfRow(1)).toBe(5);
	});

	it("lands the base course first, relaying upward", () => {
		expect(gamaAsciiBandOffset(0, 0)).toBeLessThan(0);
		expect(gamaAsciiBandOffset(5, 0)).toBeLessThan(0);
		expect(gamaAsciiBandOffset(0, 10)).toBe(0);
		expect(gamaAsciiBandOffset(1, 10)).toBeLessThan(0);
		expect(gamaAsciiBandOffset(5, 60)).toBe(0);
	});

	it("assembles bottom-up through the sky, never changing row count", () => {
		const { ui } = tui();
		const logo = new GamaAsciiLogo(ui);
		try {
			const blank = logo.render(100).map(stripAnsi).join("\n");
			expect(blank.trim()).toBe("");
			vi.advanceTimersByTime(60 * 12);
			const partial = logo.render(100).map(stripAnsi);
			expect(partial).toHaveLength(GAMA_ASCII_TOTAL_ROWS);
			expect(partial.join("\n").trim().length).toBeGreaterThan(0);
			expect(partial.join("\n")).not.toBe(blank);
			vi.advanceTimersByTime(60 * 200);
			const landed = logo.render(100).map(stripAnsi);
			expect(landed).toHaveLength(GAMA_ASCII_TOTAL_ROWS);
			expect(landed.join("\n")).toContain("████");
		} finally {
			logo.stop();
		}
	});

	it("paints each course its own ember color", () => {
		const { ui } = tui();
		const logo = new GamaAsciiLogo(ui);
		try {
			vi.advanceTimersByTime(60 * 200);
			const raw = logo.render(100).join("\n");
			const colors = new Set(
				[...raw.matchAll(/38;(2;\d+;\d+;\d+|5;\d+)/g)].map((match) => match[1]),
			);
			expect(colors.size).toBeGreaterThanOrEqual(6);
		} finally {
			logo.stop();
		}
	});

	it("paints courses in one flat color each with zero background, ever", () => {
		const { ui } = tui();
		const logo = new GamaAsciiLogo(ui);
		try {
			for (const at of [0, 360, 1500, 4000]) {
				vi.advanceTimersByTime(at);
				for (const line of logo.render(100)) {
					expect(line).not.toMatch(/\x1b\[48[;:]/);
					if (line !== "") {
						expect(line.startsWith("\x1b[49m")).toBe(true);
					}
				}
			}
		} finally {
			logo.stop();
		}
	});

	it("lifts off top-first on dismiss, then hands back for removal", () => {
		const { ui } = tui();
		const logo = new GamaAsciiLogo(ui);
		try {
			vi.advanceTimersByTime(60 * 200);
			expect(logo.isSettled).toBe(true);
			const resting = logo.render(100).map(stripAnsi).join("\n");
			const done = vi.fn();
			logo.beginDismiss(done);
			expect(logo.render(100).map(stripAnsi).join("\n")).toBe(resting);
			vi.advanceTimersByTime(60 * 3);
			const lifting = logo.render(100).map(stripAnsi).join("\n");
			expect(lifting).not.toBe(resting);
			expect(lifting).toContain("████");
			expect(done).not.toHaveBeenCalled();
			vi.advanceTimersByTime(60 * 200);
			expect(logo.isDismissed).toBe(true);
			expect(done).toHaveBeenCalledTimes(1);
			expect(logo.render(100).map(stripAnsi).join("\n").trim()).toBe("");
			logo.beginDismiss(done);
			vi.advanceTimersByTime(60 * 200);
			expect(done).toHaveBeenCalledTimes(1);
		} finally {
			logo.stop();
		}
	});

	it("dismisses mid-drop from the exact current frame", () => {
		const { ui } = tui();
		const logo = new GamaAsciiLogo(ui);
		try {
			vi.advanceTimersByTime(60 * 15);
			const frame = logo.render(100).map(stripAnsi).join("\n");
			expect(frame.trim().length).toBeGreaterThan(0);
			const done = vi.fn();
			logo.beginDismiss(done);
			expect(logo.render(100).map(stripAnsi).join("\n")).toBe(frame);
			vi.advanceTimersByTime(60 * 200);
			expect(done).toHaveBeenCalledTimes(1);
			expect(logo.render(100).map(stripAnsi).join("\n").trim()).toBe("");
		} finally {
			logo.stop();
		}
	});

	it("sweeps light across the mark, then freezes and releases its timer", () => {
		const { ui, requestRender } = tui();
		const logo = new GamaAsciiLogo(ui);
		const callsAfterStart = requestRender.mock.calls.length;
		vi.advanceTimersByTime(60 * 200);
		expect(logo.isSettled).toBe(true);
		const frozen = logo.render(100).map(stripAnsi).join("\n");
		const callsAfterSettle = requestRender.mock.calls.length;
		expect(callsAfterSettle).toBeGreaterThan(callsAfterStart);
		vi.advanceTimersByTime(60 * 200);
		expect(requestRender.mock.calls.length).toBe(callsAfterSettle);
		expect(logo.render(100).map(stripAnsi).join("\n")).toBe(frozen);
		logo.stop();
	});
});
