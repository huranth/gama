import type { ExecutionEnv } from "../system/index.ts";
import type { ToolExecutionApi } from "../engine/types.ts";

export function requireEnv(api: ToolExecutionApi): ExecutionEnv {
	if (api.env === undefined) throw new Error("Missing environment");
	return api.env;
}
