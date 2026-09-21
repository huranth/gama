import type { AgentTool } from "@huranth/gama-agent-core";
import { existsSync } from "fs";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../ext/types.ts";
import { assertNotAborted } from "./abort.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import type { FileReadTracker } from "./file-read-tracker.ts";
import { resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { writeRenderers } from "./ui/write.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteOperations {
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	mkdir: (dir: string) => Promise<void>;
}

export interface WriteToolDetails {
	created: boolean;
}

export interface WriteToolOptions {
	operations?: WriteOperations;
	tracker?: FileReadTracker;
}

export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: [
		"Use write only for new files or complete rewrites.",
		"Decide the target path before composing the content.",
		"Read an existing file before overwriting it; writes to files you have not read are rejected.",
	],
} as const;

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export function createWriteTool(
	cwd: string,
	options?: WriteToolOptions,
): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, WriteToolDetails> {
	const ops = options?.operations ?? defaultWriteOperations;
	const tracker = options?.tracker;
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, " +
			"overwrites if it does. Automatically creates parent directories.",
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		parameters: writeSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
			const dir = dirname(absolutePath);

			return withFileMutationQueue(absolutePath, async () => {
				assertNotAborted(signal);

				const created = !existsSync(absolutePath);
				if (!created) {
					tracker?.assertRead(absolutePath);
					tracker?.assertUnchanged(absolutePath);
				}

				try {
					await ops.mkdir(dir);
				} catch (error) {
					throw describeWriteError(path, error);
				}

				assertNotAborted(signal);

				try {
					await ops.writeFile(absolutePath, content);
				} catch (error) {
					throw describeWriteError(path, error);
				}

				tracker?.markWritten(absolutePath);

				return {
					content: [{ type: "text", text: created ? `Created ${path}` : `Wrote ${path}` }],
					details: { created },
				};
			});
		},
		...writeRenderers,
	};
}

function describeWriteError(path: string, error: unknown): Error {
	const code = error instanceof Error && "code" in error ? error.code : undefined;

	if (code === "EACCES" || code === "EPERM") {
		return new Error(`Could not write ${path}, permission denied`);
	}

	if (code === "EISDIR") {
		return new Error(`Could not write ${path}, it is a directory`);
	}

	if (code === "ENOTDIR" || code === "EEXIST") {
		return new Error(`Could not write ${path}, a parent path is not a directory`);
	}

	if (code === "ENOENT") {
		return new Error(`Could not write ${path}, a parent directory does not exist`);
	}

	if (code === "ENOSPC") {
		return new Error(`Could not write ${path}, the disk is full`);
	}

	if (code) {
		return new Error(`Could not write ${path}, the file failed with ${code}`);
	}

	const reason = error instanceof Error ? error.message : String(error);
	return new Error(`Could not write ${path}, ${reason}`);
}
