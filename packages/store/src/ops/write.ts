import { type Static, Type } from "typebox";
import { defineTool } from "../engine/define.ts";
import type { ToolRegistration } from "../engine/types.ts";
import { getOrThrow } from "../system/index.ts";
import { requireEnv } from "./env.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToolPath } from "./path-utils.ts";

export type WriteToolInput = Static<typeof writeSchema>;

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export function createWriteTool(): ToolRegistration<typeof writeSchema> {
	return defineTool({
		name: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it " +
			"does. Automatically creates parent directories.",
		parameters: writeSchema,
		async execute(args, api, context) {
			const { path, content } = args;
			const env = requireEnv(api);
			const absolutePath = await resolveToolPath(env, path, context);

			return withFileMutationQueue(
				env,
				absolutePath,
				async () => {
					if (context.abortSignal?.aborted) {
						throw new Error("Operation aborted");
					}

					getOrThrow(await env.writeFile(absolutePath, content, context));

					return { content: [{ type: "text", text: `Successfully wrote to ${path}` }] };
				},
				context,
			);
		},
	});
}
