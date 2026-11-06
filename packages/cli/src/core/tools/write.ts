import { statSync } from "node:fs";
import { mkdir as fsMkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@huranth/gama-agent-core";
import { type Static, Type } from "typebox";
import { writeFileAtomicSync } from "../../utils/atomic-write.ts";
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

// Error reasons
const WRITE_ERROR_REASON: Record<string, string> = {
	EACCES: "Write denied",
	EPERM: "Write denied",
	EISDIR: "Is directory",
	ENOTDIR: "Bad parent",
	EEXIST: "Bad parent",
	ENOENT: "No parent",
	ENOSPC: "Disk full",
};

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
	writeFile: async (path, content) => {
		writeFileAtomicSync(path, content);
	},
	mkdir: async (dir) => {
		await fsMkdir(dir, { recursive: true });
	},
};

function errorCode(error: unknown): string | undefined {
	if (!(error instanceof Error) || !("code" in error)) return undefined;
	if (typeof error.code !== "string") return undefined;

	return error.code;
}

function describeWriteError(error: unknown): Error {
	const code = errorCode(error);
	if (code && WRITE_ERROR_REASON[code]) return new Error(WRITE_ERROR_REASON[code]);

	return new Error("Write failed");
}

function directoryError(): Error {
	return new Error(WRITE_ERROR_REASON.EISDIR);
}

type PathState = { isNew: boolean; isDirectory: boolean };

function inspectPath(absolutePath: string): PathState {
	try {
		const stats = statSync(absolutePath);

		return { isNew: false, isDirectory: stats.isDirectory() };
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw describeWriteError(error);

		return { isNew: true, isDirectory: false };
	}
}

async function writeFile(
	absolutePath: string,
	content: string,
	ops: WriteOperations,
	tracker: FileReadTracker | undefined,
	signal: AbortSignal | undefined,
): Promise<WriteToolDetails> {
	assertNotAborted(signal);

	const state = inspectPath(absolutePath);

	if (state.isDirectory) throw directoryError();
	if (!state.isNew) tracker?.assertRead(absolutePath);

	try {
		await ops.mkdir(dirname(absolutePath));
	} catch (error) {
		throw describeWriteError(error);
	}

	assertNotAborted(signal);
	if (!state.isNew) tracker?.assertUnchanged(absolutePath);

	try {
		await ops.writeFile(absolutePath, content);
	} catch (error) {
		throw describeWriteError(error);
	}

	tracker?.markWritten(absolutePath);

	return { created: state.isNew };
}

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

			return withFileMutationQueue(absolutePath, async () => {
				const details = await writeFile(absolutePath, content, ops, tracker, signal);
				const text = details.created ? `Created ${path}` : `Wrote ${path}`;

				return { content: [{ type: "text" as const, text }], details };
			});
		},
		...writeRenderers,
	};
}
