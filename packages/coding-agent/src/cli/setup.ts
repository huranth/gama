import { APP_NAME } from "../config.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";

export function setupCli(): void {
	process.title = APP_NAME;
	process.env.GAMA_CODING_AGENT = "true";
	process.env.AI_AGENT = APP_NAME;
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	configureHttpDispatcher();
}
