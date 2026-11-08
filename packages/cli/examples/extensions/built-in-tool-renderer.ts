import type {
	BashToolDetails,
	EditToolDetails,
	ExtensionAPI,
	ReadToolDetails,
} from "@huranth/gama-harness";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@huranth/gama-harness";
import { Text } from "@huranth/gama-tui";

export default function (gama: ExtensionAPI) {
	const cwd = process.cwd();

	const originalRead = createReadToolDefinition(cwd);
	gama.registerTool({
		...originalRead,

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("read "));
			text += theme.fg("accent", args.path);
			if (args.offset || args.limit) {
				const parts: string[] = [];
				if (args.offset) parts.push(`offset=${args.offset}`);
				if (args.limit) parts.push(`limit=${args.limit}`);
				text += theme.fg("dim", ` (${parts.join(", ")})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);

			const details = result.details as ReadToolDetails | undefined;
			const content = result.content[0];

			if (content?.type === "image") {
				return new Text(theme.fg("success", "Image loaded"), 0, 0);
			}

			if (content?.type !== "text") {
				return new Text(theme.fg("error", "No content"), 0, 0);
			}

			const lineCount = content.text.split("\n").length;
			let text = theme.fg("success", `${lineCount} lines`);

			if (details?.truncation?.truncated) {
				text += theme.fg("warning", ` (truncated from ${details.truncation.totalLines})`);
			}

			if (expanded) {
				const lines = content.text.split("\n").slice(0, 15);
				for (const line of lines) {
					text += `\n${theme.fg("dim", line)}`;
				}
				if (lineCount > 15) {
					text += `\n${theme.fg("muted", `... ${lineCount - 15} more lines`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	const originalBash = createBashToolDefinition(cwd);
	gama.registerTool({
		...originalBash,

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("$ "));
			const cmd = args.command.length > 80 ? `${args.command.slice(0, 77)}...` : args.command;
			text += theme.fg("accent", cmd);
			if (args.timeout) {
				text += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text("", 0, 0);

			const details = result.details as BashToolDetails | undefined;
			const content = result.content[0];
			const output = content?.type === "text" ? content.text : "";

			const exitMatch = output.match(/exit code: (\d+)/);
			const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
			const lineCount = output.split("\n").filter((l) => l.trim()).length;

			let text = "";
			if (exitCode === 0 || exitCode === null) {
				text += theme.fg("success", "done");
			} else {
				text += theme.fg("error", `exit ${exitCode}`);
			}
			text += theme.fg("dim", ` (${lineCount} lines)`);

			if (details?.truncation?.truncated) {
				text += theme.fg("warning", " [truncated]");
			}

			if (expanded) {
				const lines = output.split("\n").slice(0, 20);
				for (const line of lines) {
					text += `\n${theme.fg("dim", line)}`;
				}
				if (output.split("\n").length > 20) {
					text += `\n${theme.fg("muted", "... more output")}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	const originalEdit = createEditToolDefinition(cwd);
	gama.registerTool({
		...originalEdit,

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("edit "));
			text += theme.fg("accent", args.path);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text("", 0, 0);

			const details = result.details as EditToolDetails | undefined;
			const content = result.content[0];

			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			}

			if (!details?.diff) {
				return new Text(theme.fg("success", "Applied"), 0, 0);
			}

			const diffLines = details.diff.split("\n");
			let additions = 0;
			let removals = 0;
			for (const line of diffLines) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) removals++;
			}

			let text = theme.fg("success", `+${additions}`);
			text += theme.fg("dim", " / ");
			text += theme.fg("error", `-${removals}`);

			if (expanded) {
				for (const line of diffLines.slice(0, 30)) {
					if (line.startsWith("+") && !line.startsWith("+++")) {
						text += `\n${theme.fg("success", line)}`;
					} else if (line.startsWith("-") && !line.startsWith("---")) {
						text += `\n${theme.fg("error", line)}`;
					} else {
						text += `\n${theme.fg("dim", line)}`;
					}
				}
				if (diffLines.length > 30) {
					text += `\n${theme.fg("muted", `... ${diffLines.length - 30} more diff lines`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	const originalWrite = createWriteToolDefinition(cwd);
	gama.registerTool({
		...originalWrite,

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("write "));
			text += theme.fg("accent", args.path);
			const lineCount = args.content.split("\n").length;
			text += theme.fg("dim", ` (${lineCount} lines)`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "Writing..."), 0, 0);

			const content = result.content[0];
			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			}

			return new Text(theme.fg("success", "Written"), 0, 0);
		},
	});
}
