import type * as ChildProcess from "node:child_process";
import { createHash } from "node:crypto";
import type * as Fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	downloadFile,
	ensureTool,
	getLatestVersion,
	resolveExpectedDigest,
	type ToolStatus,
	verifyAssetDigest,
} from "../src/utils/tools-manager.ts";

const originalOffline = process.env.GAMA_OFFLINE;

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		existsSync: vi.fn(() => false),
	};
});

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	return {
		...actual,
		spawnSync: vi.fn(() => ({ error: new Error("not found") })),
	};
});

afterEach(() => {
	if (originalOffline === undefined) delete process.env.GAMA_OFFLINE;
	else process.env.GAMA_OFFLINE = originalOffline;
	vi.unstubAllGlobals();
});

function redirectResponse(location: string): Response {
	return new Response(null, { status: 302, headers: { location } });
}

describe("getLatestVersion", () => {
	it("resolves the version from the release page redirect", async () => {
		const fetchMock = vi.fn(async () =>
			redirectResponse("https://github.com/sharkdp/fd/releases/tag/v10.4.2"),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestVersion("sharkdp/fd")).resolves.toBe("10.4.2");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://github.com/sharkdp/fd/releases/latest",
			expect.objectContaining({ redirect: "manual" }),
		);
	});

	it("keeps tags without a v prefix intact", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				redirectResponse("https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0"),
			),
		);

		await expect(getLatestVersion("BurntSushi/ripgrep")).resolves.toBe("15.2.0");
	});

	it("resolves relative redirect targets", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => redirectResponse("/sharkdp/fd/releases/tag/v10.4.2")),
		);

		await expect(getLatestVersion("sharkdp/fd")).resolves.toBe("10.4.2");
	});

	it("discards the redirect response body", async () => {
		const response = new Response("<html></html>", {
			status: 302,
			headers: { location: "https://github.com/sharkdp/fd/releases/tag/v10.4.2" },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response),
		);

		await expect(getLatestVersion("sharkdp/fd")).resolves.toBe("10.4.2");
		expect(response.bodyUsed).toBe(true);
	});

	it("fails clearly when the endpoint does not redirect", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not found", { status: 404 })),
		);

		await expect(getLatestVersion("sharkdp/fd")).rejects.toThrow(
			"Release lookup failed: sharkdp/fd",
		);
	});

	it("fails clearly when the redirect does not point at a release tag", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => redirectResponse("https://github.com/login")),
		);

		await expect(getLatestVersion("sharkdp/fd")).rejects.toThrow(
			"Release redirect failed: sharkdp/fd",
		);
	});
});

describe("ensureTool", () => {
	it("reports status through a callback without writing to the console", async () => {
		process.env.GAMA_OFFLINE = "1";
		const statuses: ToolStatus[] = [];
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

		const result = await ensureTool("fd", (status) => statuses.push(status));

		expect(result).toBeUndefined();
		expect(statuses).toEqual([
			{
				type: "warning",
				message: "fd not found. Offline mode enabled, skipping download.",
			},
		]);
		expect(consoleLog).not.toHaveBeenCalled();
		consoleLog.mockRestore();
	});

	it("surfaces the error cause chain when a download fails", async () => {
		delete process.env.GAMA_OFFLINE;
		const cause = new Error("connect ETIMEDOUT 140.82.113.3:443");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed", { cause });
			}),
		);
		const statuses: ToolStatus[] = [];

		const result = await ensureTool("fd", (status) => statuses.push(status));

		expect(result).toBeUndefined();
		expect(statuses).toEqual([
			{ type: "info", message: "Downloading: fd" },
			{
				type: "warning",
				message: expect.stringContaining("Download failed: fd"),
			},
		]);
	});
});

describe("download failures", () => {
	it("cancels the response body when a download fails", async () => {
		const response = new Response("missing", { status: 404 });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response),
		);

		await expect(
			downloadFile("https://example.test/fd.zip", join(tmpdir(), `fd-${Date.now()}.zip`)),
		).rejects.toThrow("Download failed: 404");
		expect(response.bodyUsed).toBe(true);
	});
});

describe("asset checksums", () => {
	it("uses a valid sidecar digest without calling the release API", async () => {
		const digest = "a".repeat(64);
		const fetchMock = vi.fn(
			async (_input: string | URL | Request) =>
				new Response(`${digest}  fd.zip\n`, { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			resolveExpectedDigest("https://example.test/fd.zip", "sharkdp/fd", "v10.4.2", "fd.zip"),
		).resolves.toBe(digest);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.test/fd.zip.sha256");
	});

	it("falls back to the release API when the sidecar is missing", async () => {
		const digest = "b".repeat(64);
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			if (String(input).endsWith(".sha256")) return new Response("missing", { status: 404 });
			return new Response(
				JSON.stringify({ assets: [{ name: "fd.zip", digest: `sha256:${digest}` }] }),
				{ status: 200 },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			resolveExpectedDigest("https://example.test/fd.zip", "sharkdp/fd", "v10.4.2", "fd.zip"),
		).resolves.toBe(digest);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("ignores a malformed sidecar", async () => {
		const digest = "c".repeat(64);
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			if (String(input).endsWith(".sha256"))
				return new Response("not-a-digest", { status: 200 });
			return new Response(
				JSON.stringify({ assets: [{ name: "fd.zip", digest: `sha256:${digest}` }] }),
				{ status: 200 },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			resolveExpectedDigest("https://example.test/fd.zip", "sharkdp/fd", "v10.4.2", "fd.zip"),
		).resolves.toBe(digest);
	});

	it("rejects a mismatch and accepts the matching digest", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gama-digest-"));
		try {
			const path = join(dir, "fd.zip");
			writeFileSync(path, "archive");
			const digest = createHash("sha256").update("archive").digest("hex");

			await expect(verifyAssetDigest(path, digest, "fd.zip")).resolves.toBeUndefined();
			await expect(verifyAssetDigest(path, "0".repeat(64), "fd.zip")).rejects.toThrow(
				"Checksum mismatch: fd.zip",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
