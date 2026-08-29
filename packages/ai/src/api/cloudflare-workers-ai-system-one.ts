import type { ClassifierFunction, ClassifierOptions } from "../types.ts";
import { classifySystemOne, isRecord, type SystemOneTransport } from "./system-one-shared.ts";

const LABEL = "Cloudflare Workers AI";

export const classify: ClassifierFunction<ClassifierOptions> = (model, context, options) =>
	classifySystemOne(transport, model, context, options);

function errorMessage(errors: unknown): string {
	if (!Array.isArray(errors)) return `${LABEL} request failed`;

	const messages = errors
		.filter(isRecord)
		.map((error) => error.message)
		.filter((message): message is string => typeof message === "string");

	if (messages.length === 0) return `${LABEL} request failed`;

	return `${LABEL} error: ${messages.join("; ")}`;
}

function readResult(body: unknown): Record<string, unknown> {
	if (!isRecord(body)) throw new Error(`${LABEL} returned an unexpected response`);
	if (body.success === false) throw new Error(errorMessage(body.errors));

	const result = body.result;
	if (!isRecord(result)) throw new Error(`${LABEL} returned an unexpected response`);

	if ("answers" in result) return result;

	if (result.state !== "Completed") {
		throw new Error(`${LABEL} run did not complete (state: ${String(result.state)})`);
	}

	if (!isRecord(result.result)) throw new Error(`${LABEL} returned an unexpected response`);

	return result.result;
}

const transport: SystemOneTransport = {
	api: "cloudflare-workers-ai-system-one",
	label: LABEL,
	url: (model) => new URL("run", `${model.baseUrl.replace(/\/+$/u, "")}/`),
	payload: (model, request) => ({ model: model.id, input: request }),
	output: readResult,
};
