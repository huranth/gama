import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@huranth/gama-harness";

export default function (gama: ExtensionAPI) {
	gama.on("before_provider_request", (event, ctx) => {
		const logFile = join(ctx.cwd, CONFIG_DIR_NAME, "provider-payload.log");
		mkdirSync(dirname(logFile), { recursive: true });
		appendFileSync(logFile, `${JSON.stringify(event.payload, null, 2)}\n\n`, "utf8");
	});

	gama.on("after_provider_response", (event, ctx) => {
		const logFile = join(ctx.cwd, CONFIG_DIR_NAME, "provider-payload.log");
		mkdirSync(dirname(logFile), { recursive: true });
		appendFileSync(logFile, `[${event.status}] ${JSON.stringify(event.headers)}\n\n`, "utf8");
	});
}
