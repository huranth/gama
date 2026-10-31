import type { Context } from "@huranth/gama-bus";
import { NodeExecutionEnv } from "../../system/node.ts";
import { JsonlStorage, type JsonlStorageOptions } from "./storage.ts";

export { JsonlStorage, type JsonlStorageOptions } from "./storage.ts";

export async function openNodeJsonlStorage(
	directory: string,
	context: Context,
	options: JsonlStorageOptions = {},
): Promise<JsonlStorage> {
	return JsonlStorage.open(
		directory,
		new NodeExecutionEnv({ cwd: process.cwd() }),
		context,
		options,
	);
}
