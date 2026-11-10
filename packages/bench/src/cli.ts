import { createHash, randomUUID } from "node:crypto";
import { globSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
	buildImages,
	CONTAINER_EVALS_PREFIX,
	createDockerContext,
	discoverCases,
	requireEvalAuthFile,
	runTask,
} from "./container.ts";
import {
	type EvalObservation,
	erroredObservation,
	formatEvalComparisonReport,
	readTaskObservation,
	summarizeEvalObservations,
} from "./output.ts";
import {
	createTaskPlan,
	type DiscoveredEvalCase,
	DOCUMENTATION_VARIANTS,
	parseDiscoveredCases,
} from "./plan.ts";

type EvalCliOptions = {
	provider?: string;
	model?: string;
	runsPerVariant: number;
	requestedFiles: string[];
	discoveryArgs: string[];
};

const RUNNER_OPTIONS = new Set(["--provider", "--model", "--runs-per-variant"]);

const FILTER_OPTIONS = new Set(["-t", "--testNamePattern"]);

function parseEvalCli(
	args: readonly string[],
	environment: NodeJS.ProcessEnv = process.env,
): EvalCliOptions {
	let provider: string | undefined;
	let model: string | undefined;
	let runsText: string | undefined;
	let cliSelectedModel = false;
	const requestedFiles: string[] = [];
	const discoveryArgs: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];

		if (FILTER_OPTIONS.has(argument)) {
			const value = args[index + 1];
			if (!value) {
				throw new Error(`Missing value: ${argument}`);
			}

			discoveryArgs.push(argument, value);
			index += 1;
			continue;
		}

		if (argument.startsWith("--testNamePattern=")) {
			const empty = argument.length === "--testNamePattern=".length;
			if (empty) {
				throw new Error("Missing test pattern");
			}

			discoveryArgs.push(argument);
			continue;
		}

		const equals = argument.indexOf("=");
		const name = equals === -1 ? argument : argument.slice(0, equals);

		if (RUNNER_OPTIONS.has(name)) {
			const value = equals === -1 ? args[index + 1] : argument.slice(equals + 1);

			if (!value || (equals === -1 && value.startsWith("-"))) {
				throw new Error(`Missing value: ${name}`);
			}

			if (name === "--provider") {
				provider = value;
			} else if (name === "--model") {
				model = value;
			} else {
				runsText = value;
			}

			if (name !== "--runs-per-variant") cliSelectedModel = true;
			if (equals === -1) index += 1;
			continue;
		}

		if (!argument.startsWith("-") && argument.endsWith(".docs.eval.ts")) {
			requestedFiles.push(argument);
			continue;
		}

		throw new Error(`Unsupported eval argument: ${argument}`);
	}

	provider = provider?.trim() || undefined;
	model = model?.trim() || undefined;

	if (cliSelectedModel) {
		if (!provider || !model) {
			throw new Error("Model flags required");
		}
	} else {
		provider = environment.GAMA_PROVIDER?.trim() || undefined;
		model = environment.GAMA_MODEL?.trim() || undefined;

		if (Boolean(provider) !== Boolean(model)) {
			throw new Error("Incomplete model env");
		}
	}

	const configuredRuns = (runsText ?? environment.GAMA_EVAL_RUNS_PER_VARIANT)?.trim();
	const runsPerVariant = configuredRuns ? Number(configuredRuns) : 1;

	if (!Number.isSafeInteger(runsPerVariant) || runsPerVariant < 1) {
		throw new Error("Invalid run count");
	}

	return { provider, model, runsPerVariant, requestedFiles, discoveryArgs };
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const evalRoot = resolve(packageRoot, "evals");

function artifactRunId(): string {
	return `${new Date().toISOString().replaceAll(":", "-")}_${randomUUID()}`;
}

function containerPath(path: string): string {
	const absolute = resolve(packageRoot, path);
	const evalPrefix = `${evalRoot}${sep}`;
	if (absolute !== evalRoot && !absolute.startsWith(evalPrefix)) {
		throw new Error(`Bad eval path: ${path}`);
	}

	return relative(packageRoot, absolute).replaceAll("\\", "/");
}

function normalizeDiscoveredFile(path: string): string {
	const prefix = CONTAINER_EVALS_PREFIX;

	if (!path.startsWith(prefix)) {
		throw new Error(`Path outside package: ${path}`);
	}

	return containerPath(path.slice(prefix.length));
}

function compareDiscovery(
	left: readonly DiscoveredEvalCase[],
	right: readonly DiscoveredEvalCase[],
): void {
	const identities = (cases: readonly DiscoveredEvalCase[]) =>
		cases
			.map(({ fullName, file }) => JSON.stringify([fullName, normalizeDiscoveredFile(file)]))
			.sort();
	if (JSON.stringify(identities(left)) !== JSON.stringify(identities(right))) {
		throw new Error("Variant case mismatch");
	}
}

const cli = parseEvalCli(process.argv.slice(2));
if (!cli.provider || !cli.model) throw new Error("Missing model choice");

const selectedModel = { provider: cli.provider, model: cli.model };

const modelIdentity = `${selectedModel.provider}/${selectedModel.model}`;

const files = (
	cli.requestedFiles.length > 0
		? cli.requestedFiles
		: globSync("evals/**/*.docs.eval.ts", { cwd: packageRoot })
)
	.map(containerPath)
	.sort();
if (files.length === 0) throw new Error("No eval files");
for (const file of files) {
	if (!file.endsWith(".docs.eval.ts")) throw new Error(`Bad eval type: ${file}`);
}

const artifactDirectory = resolve(packageRoot, ".eval", artifactRunId());

const authPath = requireEvalAuthFile(selectedModel.provider);
await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });

const images = buildImages();
if (images.with_docs.id === images.without_docs.id) throw new Error("Duplicate variant image");

const docker = createDockerContext(
	images,
	artifactDirectory,
	authPath,
	selectedModel.provider,
	selectedModel.model,
	cli.runsPerVariant,
);

const discoveries = [];
for (const variant of DOCUMENTATION_VARIANTS) {
	const path = discoverCases(docker, variant, files, cli.discoveryArgs);
	discoveries.push(parseDiscoveredCases(JSON.parse(await readFile(path, "utf8"))));
}
compareDiscovery(discoveries[0], discoveries[1]);

const cases = discoveries[0].map((evalCase) => ({
	...evalCase,
	file: normalizeDiscoveredFile(evalCase.file),
}));
if (cases.length === 0) throw new Error("No eval cases");

const tasks = createTaskPlan(cases, modelIdentity, cli.runsPerVariant);

const protocol = {
	schemaVersion: 1,
	model: modelIdentity,
	runsPerVariant: cli.runsPerVariant,
	images,
	files,
	cases: cases.map(({ evalSet, caseId, file }) => ({ evalSet, caseId, file })),
	tasks,
};

const protocolText = JSON.stringify(protocol);

const protocolDigest = createHash("sha256").update(protocolText).digest("hex");
await writeFile(
	resolve(artifactDirectory, "protocol.json"),
	`${JSON.stringify({ ...protocol, protocolDigest }, null, 2)}\n`,
);
await writeFile(
	resolve(artifactDirectory, "expected-runs.json"),
	`${JSON.stringify(tasks, null, 2)}\n`,
);

const observations: EvalObservation[] = [];
for (const [index, task] of tasks.entries()) {
	const progress =
		`\n[${index + 1}/${tasks.length}] ${task.evalSet} > ${task.caseId}` +
		` | ${task.variant} | ${task.model} | run ${task.runNumber}`;

	console.log(progress);
	const reportPath = runTask(docker, task);
	const observation: EvalObservation = reportPath
		? await readTaskObservation(task, reportPath, artifactDirectory)
		: erroredObservation(task);
	observations.push(observation);
	await writeFile(
		resolve(artifactDirectory, "observations.jsonl"),
		`${observations.map((item) => JSON.stringify(item)).join("\n")}\n`,
	);
}

const report = summarizeEvalObservations(protocolDigest, tasks, observations);

const reportText = formatEvalComparisonReport(report);
await writeFile(resolve(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
const plainReportText = stripVTControlCharacters(reportText);
await writeFile(resolve(artifactDirectory, "report.txt"), `${plainReportText}\n`);
console.log(`\n${reportText}`);
console.log(`\nArtifacts: ${artifactDirectory}`);
if (report.blockedPairs.length > 0) process.exitCode = 1;
