import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionAPI } from "@huranth/gama-harness";

interface ConflictBlock {
	file: string;
	startLine: number;
	separatorLine: number;
	endLine: number;
}

async function findConflicts(gama: ExtensionAPI, cwd: string): Promise<ConflictBlock[]> {
	const { stdout, code } = await gama.exec("git", ["diff", "--name-only", "--diff-filter=U"]);
	if (code !== 0 || !stdout.trim()) return [];

	const blocks: ConflictBlock[] = [];
	for (const file of stdout.trim().split("\n")) {
		try {
			const rl = createInterface({ input: createReadStream(join(cwd, file), "utf-8") });
			let lineNo = 0;
			let blockStart: number | undefined;
			let separatorLine: number | undefined;
			for await (const line of rl) {
				lineNo++;
				if (line.startsWith("<<<<<<<")) {
					blockStart = lineNo;
					separatorLine = undefined;
				} else if (line.startsWith("=======") && blockStart !== undefined) {
					separatorLine = lineNo;
				} else if (
					line.startsWith(">>>>>>>") &&
					blockStart !== undefined &&
					separatorLine !== undefined
				) {
					blocks.push({ file, startLine: blockStart, separatorLine, endLine: lineNo });
					blockStart = undefined;
					separatorLine = undefined;
				}
			}
		} catch {}
	}
	return blocks;
}

function formatRange(start: number, end: number): string {
	if (start > end) return "empty";
	if (start === end) return `${start}`;
	return `${start}-${end}`;
}

function formatConflicts(ref: string, blocks: ConflictBlock[]): string {
	const lines = [`Merged ${ref} with conflicts:`, ""];
	for (const b of blocks) {
		const ours = formatRange(b.startLine + 1, b.separatorLine - 1);
		const theirs = formatRange(b.separatorLine + 1, b.endLine - 1);
		lines.push(`  ${b.file}:${b.startLine}-${b.endLine} (ours ${ours}, theirs ${theirs})`);
	}
	lines.push("", "Resolve these conflicts.");
	return lines.join("\n");
}

export default function (gama: ExtensionAPI) {
	gama.on("agent_end", async (_event, ctx) => {
		const { code: revParseCode } = await gama.exec("git", ["rev-parse", "--git-dir"]);
		if (revParseCode !== 0) return;

		let ref = "MERGE_HEAD";

		const { code: mergeHeadCode } = await gama.exec("git", ["rev-parse", "MERGE_HEAD"]);
		if (mergeHeadCode !== 0) {
			const { stdout: status } = await gama.exec("git", ["status", "--porcelain"]);
			if (status.trim()) return;

			const { stdout: upstream, code: upstreamCode } = await gama.exec("git", [
				"rev-parse",
				"--abbrev-ref",
				"--symbolic-full-name",
				"@{u}",
			]);
			if (upstreamCode !== 0) return;

			ref = upstream.trim();
			const remote = ref.split("/")[0];
			ctx.ui.notify(`git-merge-and-resolve: fetching ${remote}, merging ${ref}`, "info");

			const { code: fetchCode, stderr: fetchErr } = await gama.exec("git", ["fetch", remote]);
			if (fetchCode !== 0) {
				ctx.ui.notify(`git-merge-and-resolve: fetch failed: ${fetchErr.trim()}`, "warning");
				return;
			}

			const { code: mergeCode } = await gama.exec("git", ["merge", "--no-ff", ref]);
			if (mergeCode === 0) return;
		}

		const conflicts = await findConflicts(gama, ctx.cwd);
		if (conflicts.length === 0) return;

		gama.sendUserMessage(formatConflicts(ref, conflicts), { deliverAs: "followUp" });
	});
}
