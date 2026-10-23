import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const durableOutputPath = join(tmpdir(), "gama-durable-browser-smoke.js");
const agentTreeshakeOutputPath = join(tmpdir(), "gama-agent-treeshake-smoke.js");
const errorLogPath = join(tmpdir(), "gama-browser-smoke-errors.log");

function normalizePath(path) {
	return path.replaceAll("\\", "/");
}

function findInput(inputs, suffix) {
	return Object.keys(inputs).find((input) => {
		const normalized = normalizePath(input);
		return normalized === suffix || normalized.endsWith(`/${suffix}`);
	});
}

function includesNodePackage(inputs, packageName) {
	const marker = `node_modules/${packageName}/`;
	return Object.keys(inputs).some((input) => normalizePath(input).includes(marker));
}

try {
	const durableBuild = await build({
		entryPoints: ["scripts/durable-browser-smoke-entry.ts"],
		bundle: true,
		platform: "browser",
		format: "esm",
		logLevel: "silent",
		metafile: true,
		outfile: durableOutputPath,
		write: false,
	});
	const durableInputs = durableBuild.metafile.inputs;
	for (const expectedInput of [
		"packages/durable/src/index.ts",
		"packages/durable/src/env/index.ts",
		"packages/durable/src/storage/jsonl/index.ts",
		"packages/durable/src/storage/jsonl/storage.ts",
		"packages/durable/src/storage/memory.ts",
		"packages/durable/src/storage/sqlite/index.ts",
		"packages/durable/src/storage/sqlite/storage.ts",
	]) {
		if (!findInput(durableInputs, expectedInput)) {
			throw new Error(`Durable browser bundle does not include ${expectedInput}`);
		}
	}
	for (const forbiddenInput of [
		"packages/durable/src/env/node.ts",
		"packages/durable/src/storage/jsonl/node.ts",
		"packages/durable/src/storage/sqlite/node.ts",
	]) {
		const nodeAdapter = findInput(durableInputs, forbiddenInput);
		if (nodeAdapter) throw new Error(`Durable browser bundle unexpectedly includes ${nodeAdapter}`);
	}

	const agentTreeshakeBuild = await build({
		entryPoints: ["scripts/agent-treeshake-smoke-entry.ts"],
		bundle: true,
		platform: "browser",
		format: "esm",
		logLevel: "silent",
		metafile: true,
		outfile: agentTreeshakeOutputPath,
		write: false,
	});
	const inputs = agentTreeshakeBuild.metafile.inputs;
	for (const forbiddenInput of [
		"packages/ai/src/compat.ts",
		"packages/ai/src/providers/all.ts",
	]) {
		const includedInput = findInput(inputs, forbiddenInput);
		if (includedInput) {
			throw new Error(`Agent bring-your-own-provider bundle unexpectedly includes ${includedInput}`);
		}
	}

	const contributingInputs = new Set(
		Object.values(agentTreeshakeBuild.metafile.outputs).flatMap((output) =>
			Object.entries(output.inputs)
				.filter(([, contribution]) => contribution.bytesInOutput > 0)
				.map(([input]) => input),
		),
	);
	const catalogInputs = Array.from(contributingInputs).filter((input) =>
		normalizePath(input).includes("packages/ai/src/providers/"),
	);
	if (catalogInputs.length !== 0) {
		const message =
			"Agent bring-your-own-provider bundle unexpectedly includes provider " +
			"catalog files:";
		throw new Error(`${message} ${catalogInputs.join(", ")}`);
	}

	const aiSdkPackages = ["@anthropic-ai/sdk", "@aws-sdk/client-bedrock-runtime", "@google/genai"];
	const includedAiSdkPackages = aiSdkPackages.filter((packageName) =>
		includesNodePackage(inputs, packageName),
	);
	if (includedAiSdkPackages.length !== 0) {
		const message = "Agent bring-your-own-provider bundle unexpectedly bundles vendor SDKs:";
		throw new Error(`${message} ${includedAiSdkPackages.join(", ")}`);
	}
	if (!includesNodePackage(inputs, "openai")) {
		throw new Error(
			"Agent bring-your-own-provider bundle does not include the openai SDK for its API",
		);
	}

	process.exit(0);
} catch (error) {
	let detailedErrors = "";
	if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
		detailedErrors = error.errors
			.map((entry) => {
				const location = entry.location
					? `${entry.location.file}:${entry.location.line}:${entry.location.column}`
					: "";
				return [location, entry.text].filter(Boolean).join(" ");
			})
			.join("\n");
	}

	const baseError = error instanceof Error ? (error.stack ?? error.message) : String(error);
	writeFileSync(errorLogPath, [detailedErrors, baseError].filter(Boolean).join("\n\n"), "utf-8");
	console.error(`Browser smoke check failed. See ${errorLogPath}`);
	process.exit(1);
}
