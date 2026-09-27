import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Container, type EditorComponent, hyperlink, type TUI } from "@huranth/gama-tui";
import { getShareViewerUrl } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { exportSessionToJsonl } from "../../core/session-export.ts";
import { BorderedLoader } from "./parts/bordered-loader.ts";
import { theme } from "./theme/theme.ts";

interface SessionShareContext {
	session: AgentSession;
	ui: TUI;
	editorContainer: Container;
	editor: EditorComponent;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
}

interface GistResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

export function createShareTrailingEntries(
	session: AgentSession,
	parentId: string | null,
	timestamp: string,
): object[] {
	return [
		{
			type: "custom",
			customType: "gama.share",
			id: crypto.randomUUID().slice(0, 8),
			parentId,
			timestamp,
			data: {
				systemPrompt: session.state.systemPrompt,
				tools: session.state.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			},
		},
	];
}

export function exportSessionForShare(filePath: string, session: AgentSession): void {
	exportSessionToJsonl(session.sessionManager, filePath, (parentId, timestamp) =>
		createShareTrailingEntries(session, parentId, timestamp),
	);
}

function restoreEditor(loader: BorderedLoader, context: SessionShareContext): void {
	loader.dispose();
	context.editorContainer.clear();
	context.editorContainer.addChild(context.editor);
	context.ui.setFocus(context.editor);
}

export async function shareSession(context: SessionShareContext): Promise<void> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gama-share-"));
	const jsonlFile = path.join(tempDir, "session.jsonl");
	const htmlFile = path.join(tempDir, "session.html");

	try {
		try {
			exportSessionForShare(jsonlFile, context.session);
		} catch (_error) {
			context.showError("Export failed");
			return;
		}

		const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
		if (authResult.error) {
			context.showError("GitHub CLI missing");
			return;
		}
		if (authResult.status !== 0) {
			context.showError("GitHub CLI logged out");
			return;
		}

		try {
			await context.session.exportToHtml(htmlFile, { themeName: theme.name });
		} catch (_error) {
			context.showError("Export failed");
			return;
		}

		await shareViaGist(htmlFile, context);
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	}
}

async function shareViaGist(tmpFile: string, context: SessionShareContext): Promise<void> {
	const loader = new BorderedLoader(context.ui, theme, "Creating gist...");
	context.editorContainer.clear();
	context.editorContainer.addChild(loader);
	context.ui.setFocus(loader);
	context.ui.requestRender();

	let proc: ReturnType<typeof spawn> | null = null;

	loader.onAbort = () => {
		proc?.kill();
		restoreEditor(loader, context);
		context.showStatus("Share cancelled");
	};

	try {
		const created = createGist(tmpFile);
		proc = created.proc;
		const result = await created.result;

		if (loader.signal.aborted) return;
		restoreEditor(loader, context);

		if (result.code !== 0) {
			context.showError("Share failed");
			return;
		}
		const gistUrl = result.stdout?.trim();
		const gistId = gistUrl?.split("/").pop();

		if (!gistId) {
			context.showError("Failed to parse gist ID from gh output");
			return;
		}

		const previewUrl = getShareViewerUrl(gistId);
		context.showStatus(
			`Share URL: ${hyperlink(previewUrl, previewUrl)}\n` +
				`Gist: ${hyperlink(gistUrl, gistUrl)}`,
		);
	} catch (_error) {
		if (!loader.signal.aborted) {
			restoreEditor(loader, context);
			context.showError("Share failed");
		}
	}
}

function createGist(file: string): {
	proc: ReturnType<typeof spawn>;
	result: Promise<GistResult>;
} {
	const proc = spawn("gh", ["gist", "create", "--public=false", file]);
	const result = new Promise<GistResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;

		const finish = (value: GistResult) => {
			if (settled) return;

			settled = true;
			resolve(value);
		};

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("error", (error) => {
			finish({ stdout, stderr: stderr || error.message, code: null });
		});
		proc.on("close", (code) => finish({ stdout, stderr, code }));
	});

	return { proc, result };
}
