import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolCallOutcome, AgentToolResult } from "@huranth/gama-agent-core";
import type {
	AnyModel,
	ClassifierContext,
	ImageContent,
	ImagesContext,
	ModelType,
	ModelTypeMap,
	TextContent,
	Usage,
} from "@huranth/gama-ai";
import {
	type CodemodeResult,
	CodemodeSandbox,
	type CodemodeTool,
	loadQuickJSWasm,
	parseCodemodeSource,
	renderToolSample,
	toCodemodeIdentifier,
} from "@huranth/gama-codemode";
import { getCodemodeWorkerSpecifier, getQuickJSWasmPath } from "../../config.ts";
import type { ExtensionToolContext, ToolNamespace } from "../../core/ext/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { combineUsage } from "../../core/usage-totals.ts";
import { Bm25Ranker, createToolSearchDocument, DEFAULT_TOOL_SEARCH_LIMIT } from "../search/tool.ts";
import {
	CODEMODE_STORE_ENTRY_TYPE,
	type CodemodeModelRuntime,
	type CodemodeNestedCall,
	type CodemodeStoreEntryData,
	type CodemodeToolDetails,
	type CodemodeToolInput,
	type CodemodeToolOptions,
	getCodemodeCallableTools,
	toCodemodeDeclaration,
} from "./tool.ts";

interface ModelCallResult {
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;
	usage?: Usage;
}

const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;
const MAX_CONCURRENT_MODEL_CALLS = 4;
const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const MODEL_TYPES: ReadonlySet<string> = new Set<ModelType>(["chat", "image", "classifier"]);

function truncateText(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

function previewArgs(args: unknown): string {
	if (args === undefined) return "";
	try {
		return truncateText(JSON.stringify(args) ?? "", ARGS_PREVIEW_CHARS);
	} catch {
		return "";
	}
}

function textOf(result: AgentToolResult<unknown>): string {
	return (result.content ?? [])
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function toModelType(value: unknown): ModelType {
	if (typeof value === "string" && MODEL_TYPES.has(value)) return value as ModelType;
	throw new Error(
		`Unknown model type ${JSON.stringify(value)}. Use "chat", "image", or "classifier".`,
	);
}

function toProvider(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error("provider must be a string");
	return value;
}

function toModelInfo(model: AnyModel): Record<string, unknown> {
	const info: Record<string, unknown> = { ...model };
	delete info.headers;
	return info;
}

function withArticle(word: string): string {
	return `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
	if (value === undefined || value === null) return String(value);
	if (Array.isArray(value)) return value.length === 0 ? "an empty array" : "an array";
	if (typeof value === "object") {
		const keys = Object.keys(value);
		if (keys.length === 0) return "{}";
		return `{ ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", ..." : ""} }`;
	}
	return typeof value === "string" ? "a string" : `a ${typeof value}`;
}

const CLASSIFIER_CONTEXT_SHAPE = [
	'{ state: { ... }, questions: { <id>: { type: "choice", instructions, ',
	'criteria: { <label>: <meaning> } } | { type: "score", instructions, ',
	'criteria: [<lowest level>, ..., <highest level>] } | { type: "bool", ',
	"instructions, criteria: { true: <meaning>, false: <meaning> } } } }",
].join("");

function checkClassifierContext(context: unknown): ClassifierContext {
	const fail = (problem: string) =>
		new Error(`models.classify() ${problem}. Expected context: ${CLASSIFIER_CONTEXT_SHAPE}.`);
	if (!isRecord(context)) {
		const got = describeValue(context);
		throw fail(`expects a context object as its second argument, got ${got}`);
	}

	if (!isRecord(context.state)) {
		const got = describeValue(context.state);
		throw fail(`context.state must be an object, got ${got}`);
	}

	const { questions } = context;
	if (!isRecord(questions) || Object.keys(questions).length === 0) {
		throw fail(
			`context.questions must map question IDs to questions, got ${describeValue(questions)}`,
		);
	}
	const isStrings = (values: unknown[]) =>
		values.length > 0 && values.every((value) => typeof value === "string");

	for (const [id, question] of Object.entries(questions)) {
		const at = `context.questions.${id}`;
		if (!isRecord(question))
			throw fail(`${at} must be a question object, got ${describeValue(question)}`);
		if (typeof question.instructions !== "string")
			throw fail(`${at}.instructions must be a string`);
		const { criteria } = question;
		if (question.type === "choice") {
			if (!isRecord(criteria) || !isStrings(Object.values(criteria))) {
				throw fail(
					`${at} is a "choice" question, so criteria must map each label to its meaning`,
				);
			}
		} else if (question.type === "score") {
			if (!Array.isArray(criteria) || !isStrings(criteria)) {
				throw fail(
					`${at} is a "score" question, so criteria must list the levels as strings, lowest first`,
				);
			}
		} else if (question.type === "bool") {
			if (
				!isRecord(criteria) ||
				typeof criteria.true !== "string" ||
				typeof criteria.false !== "string"
			) {
				throw fail(
					`${at} is a "bool" question, so criteria must be { true: string, false: string }`,
				);
			}
		} else {
			throw fail(
				`${at}.type must be "choice", "score", or "bool", got ${JSON.stringify(question.type)}`,
			);
		}
	}
	return context as unknown as ClassifierContext;
}

function checkImagesContext(context: unknown): ImagesContext {
	const fail = (problem: string) =>
		new Error(
			[
				`models.generateImages() ${problem}. Expected context: { input: [{ type: "text", `,
				'text: <prompt> }, ...optional { type: "image", data: <base64>, mimeType } ',
				"references] }.",
			].join(""),
		);
	if (!isRecord(context)) {
		const got = describeValue(context);
		throw fail(`expects a context object as its second argument, got ${got}`);
	}
	const { input } = context;
	if (!Array.isArray(input) || input.length === 0) {
		throw fail(`context.input must be a non-empty array of blocks, got ${describeValue(input)}`);
	}
	input.forEach((block: unknown, index) => {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") return;
		if (
			isRecord(block) &&
			block.type === "image" &&
			typeof block.data === "string" &&
			typeof block.mimeType === "string"
		) {
			return;
		}
		throw fail(
			`context.input[${index}] must be a text or image block, got ${describeValue(block)}`,
		);
	});
	return context as unknown as ImagesContext;
}

function createLimiter(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async (run) => {
		while (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
		active++;
		try {
			return await run();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

function isStoreEntryData(data: unknown): data is CodemodeStoreEntryData {
	if (typeof data !== "object" || data === null) return false;
	const { set, delete: deleted } = data as Partial<CodemodeStoreEntryData>;
	return (
		typeof set === "object" &&
		set !== null &&
		Array.isArray(deleted) &&
		deleted.every((key: unknown) => typeof key === "string")
	);
}

export function readCodemodeStore(branch: readonly SessionEntry[]): Record<string, unknown> {
	const store = new Map<string, unknown>();
	for (const entry of branch) {
		if (
			entry.type !== "custom" ||
			entry.customType !== CODEMODE_STORE_ENTRY_TYPE ||
			!isStoreEntryData(entry.data)
		) {
			continue;
		}
		for (const key of entry.data.delete) {
			store.delete(key);
		}
		for (const [key, value] of Object.entries(entry.data.set)) {
			store.set(key, value);
		}
	}
	return Object.fromEntries(store);
}

const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;

const CHARS_PER_TOKEN = 4;

function valueText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value) ?? String(value);
}

function formatCallSummary(calls: readonly CodemodeNestedCall[]): string {
	if (calls.length === 0) return "No tool calls were made.";
	const listed = calls.map((call) => `${call.name} (${call.status})`).join(", ");
	return `Tool calls made before the failure (they are not undone): ${listed}`;
}

function formatError(
	result: Extract<CodemodeResult, { ok: false }>,
	calls: readonly CodemodeNestedCall[],
): string {
	const { error } = result;
	const head =
		error.kind === "script"
			? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
			: error.kind === "timeout"
				? `Script timed out: ${error.message}`
				: error.kind === "aborted"
					? `Script aborted: ${error.message}`
					: `Script sandbox failed: ${error.message}`;
	return `${head}\n\n${formatCallSummary(calls)}`;
}

async function spillOutput(text: string): Promise<{ path: string } | { error: string }> {
	const path = join(tmpdir(), `gama-codemode-${randomBytes(8).toString("hex")}.txt`);
	try {
		await writeFile(path, text);
		return { path };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

async function truncateOutput(
	items: (TextContent | ImageContent)[],
	maxTokens: number,
): Promise<{ items: (TextContent | ImageContent)[]; fullOutputPath?: string }> {
	const texts = items
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text);
	const combined = texts.join("\n");
	const budget = maxTokens * CHARS_PER_TOKEN;
	if (texts.length === 0 || combined.length <= budget) return { items };
	const headChars = Math.floor(budget / 2);
	const tailChars = budget - headChars;
	let headEnd = headChars;

	// Surrogate safe
	const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
	const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
	if (
		headEnd > 0 &&
		headEnd < combined.length &&
		isHigh(combined.charCodeAt(headEnd - 1)) &&
		isLow(combined.charCodeAt(headEnd))
	) {
		headEnd--;
	}

	let tailStart = combined.length - tailChars;
	if (
		tailChars > 0 &&
		tailStart > 0 &&
		tailStart < combined.length &&
		isLow(combined.charCodeAt(tailStart)) &&
		isHigh(combined.charCodeAt(tailStart - 1))
	) {
		tailStart++;
	}

	const head = combined.slice(0, headEnd);
	const tail = tailStart < combined.length ? combined.slice(tailStart) : "";
	const removed = combined.length - head.length - tail.length;
	const tokenCount = Math.ceil(combined.length / CHARS_PER_TOKEN);
	const lineCount = combined.split("\n").length;
	const dropped = Math.ceil(removed / CHARS_PER_TOKEN);
	let text =
		`Warning: truncated output (original token count: ${tokenCount})\n` +
		`Total output lines: ${lineCount}\n\n${head}…${dropped} tokens truncated…${tail}`;
	const spilled = await spillOutput(combined);
	text +=
		"path" in spilled
			? `\n\n[Full output: ${spilled.path} (read with offset/limit)]`
			: `\n\n[Could not save the full output: ${spilled.error}]`;
	return {
		items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
		...("path" in spilled ? { fullOutputPath: spilled.path } : {}),
	};
}

function toScriptValue(tool: AgentTool<any>, outcome: AgentToolCallOutcome): unknown {
	const { result } = outcome;
	// Structured first
	if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
	const text = textOf(result);
	if (outcome.isError) throw new Error(text || `${tool.name} failed`);
	return text;
}

export async function executeCodemode(
	toolCallId: string,
	input: CodemodeToolInput,
	signal: AbortSignal | undefined,
	onUpdate: ((result: AgentToolResult<CodemodeToolDetails>) => void) | undefined,
	ctx: ExtensionToolContext | undefined,
	options: CodemodeToolOptions = {},
): Promise<AgentToolResult<CodemodeToolDetails>> {
	const startedAt = performance.now();
	const { code, options: sourceOptions } = parseCodemodeSource(input.code);
	const calls: CodemodeNestedCall[] = [];
	let modelUsage: Usage | undefined;
	let generatedImages = 0;
	const addGeneratedImages = (count: number) => {
		generatedImages += count;
	};
	const addModelUsage = (usage: Usage) => {
		modelUsage = modelUsage ? combineUsage(modelUsage, usage) : usage;
	};

	const snapshot = (): CodemodeToolDetails => ({ calls: calls.map((call) => ({ ...call })) });
	const publish = () => onUpdate?.({ content: [], details: snapshot() });

	const callable = ctx ? getCodemodeCallableTools(ctx.tools) : [];
	const samples = new Map(
		callable.map((tool) => [tool.name, renderToolSample(toCodemodeDeclaration(tool))]),
	);
	const sandboxTools: CodemodeTool[] = callable.map((tool) => ({
		name: tool.name,
		description: samples.get(tool.name),
		execute: async (args, { signal: callSignal }) => {
			const record: CodemodeNestedCall = {
				id: `${toolCallId}/?`,
				name: tool.name,
				args: previewArgs(args),
				status: "running",
			};
			calls.push(record);
			publish();
			const callStartedAt = performance.now();
			if (!ctx) throw new Error("Tool calls need a session");
			let outcome: AgentToolCallOutcome;
			try {
				outcome = await ctx.executeTool(tool.name, args, { signal: callSignal });
			} catch (error) {
				record.durationMs = performance.now() - callStartedAt;
				record.status = callSignal.aborted ? "cancelled" : "error";
				record.error = truncateText(
					error instanceof Error ? error.message : String(error),
					ERROR_PREVIEW_CHARS,
				);
				publish();
				throw error;
			}
			record.id = outcome.toolCall.id;
			record.durationMs = performance.now() - callStartedAt;
			if (outcome.isError) {
				record.status = callSignal.aborted ? "cancelled" : "error";
				record.error = truncateText(
					textOf(outcome.result) || `${tool.name} failed`,
					ERROR_PREVIEW_CHARS,
				);
			} else {
				record.status = "ok";
			}
			publish();
			return toScriptValue(tool, outcome);
		},
	}));

	const sandbox = new CodemodeSandbox({
		tools: sandboxTools,
		globals: [
			...createDiscoveryGlobals(callable, samples, options),
			...(options.models && ctx
				? createModelGlobals(
						ctx.modelRegistry,
						toolCallId,
						calls,
						publish,
						addModelUsage,
						addGeneratedImages,
					)
				: []),
		],
		timeoutMs: sourceOptions.timeoutMs ?? Number.POSITIVE_INFINITY,
		memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
		wasm: loadQuickJSWasm(getQuickJSWasmPath()),
		workerUrl: getCodemodeWorkerSpecifier(),
	});

	let result: CodemodeResult;
	try {
		const store = ctx ? readCodemodeStore(ctx.sessionManager.getBranch()) : {};
		result = await sandbox.execute(code, { signal, store });
	} finally {
		await sandbox.close();
	}
	for (const call of calls) {
		if (call.status === "running") call.status = "cancelled";
	}

	const items: (TextContent | ImageContent)[] = result.output.map((item) =>
		item.type === "text" ? { type: "text", text: item.text } : item,
	);
	if (result.ok) {
		const { set, delete: deleted } = result.storeWrites;
		if (Object.keys(set).length > 0 || deleted.length > 0) {
			options.appendEntry?.(CODEMODE_STORE_ENTRY_TYPE, { set, delete: deleted });
		}
		if (result.value !== undefined) items.push({ type: "text", text: valueText(result.value) });
	} else {
		items.push({ type: "text", text: `Script error:\n${formatError(result, calls)}` });
	}
	if (generatedImages > 0 && !items.some((item) => item.type === "image")) {
		items.push({
			type: "text",
			text: [
				`Note: models.generateImages() returned ${generatedImages} `,
				`image${generatedImages === 1 ? "" : "s"} that the script did not show. `,
				"Show each image block of result.output with image(block).",
			].join(""),
		});
	}

	const truncated = await truncateOutput(
		items,
		sourceOptions.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
	);
	const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1);
	const status = result.ok ? "Script completed" : "Script failed";
	const header = `${status}\nWall time ${wallTime} seconds\nOutput:\n`;
	const details = snapshot();
	if (truncated.fullOutputPath) details.fullOutputPath = truncated.fullOutputPath;
	return {
		content: [{ type: "text", text: header }, ...truncated.items],
		details,
		...(modelUsage ? { usage: modelUsage } : {}),
		...(result.ok ? {} : { isError: true }),
	};
}

function isNamespaceName(namespace: string, query: string): boolean {
	const id = toCodemodeIdentifier(namespace);
	const queryId = toCodemodeIdentifier(query);
	const suffix = (name: string) =>
		name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : undefined;
	return (
		namespace === query || id === queryId || suffix(namespace) === query || suffix(id) === queryId
	);
}

function createDiscoveryGlobals(
	tools: readonly AgentTool<any>[],
	samples: ReadonlyMap<string, string>,
	options: CodemodeToolOptions,
): CodemodeTool[] {
	const ranker = new Bm25Ranker();
	const entry = (name: string) => ({
		name: toCodemodeIdentifier(name),
		description: samples.get(name) ?? "",
	});
	return [
		{
			name: "searchTools",
			spread: true,
			execute: (args) => {
				const [query, searchOptions] = args as [
					unknown,
					{ limit?: unknown; namespace?: unknown } | undefined,
				];
				if (typeof query !== "string") throw new Error("searchTools() expects a query string");
				const limit = searchOptions?.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
					throw new Error("searchTools() limit must be a positive integer");
				}
				const namespace = searchOptions?.namespace;
				if (namespace !== undefined && namespace !== null && typeof namespace !== "string") {
					throw new Error("searchTools() namespace must be a string");
				}
				const documents = tools.flatMap((tool) => {
					const toolNamespace = options.getToolNamespace?.(tool.name);
					if (namespace && (!toolNamespace || !isNamespaceName(toolNamespace.name, namespace)))
						return [];
					return [createToolSearchDocument(tool, toolNamespace)];
				});
				return ranker.rank(query, documents, limit).map((match) => entry(match.name));
			},
		},
		{
			name: "describeTool",
			spread: true,
			execute: (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
				const tool = tools.find(
					(candidate) =>
						candidate.name === name || toCodemodeIdentifier(candidate.name) === name,
				);
				return tool ? samples.get(tool.name) : undefined;
			},
		},
		{
			name: "describeNamespace",
			spread: true,
			execute: (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string")
					throw new Error("describeNamespace() expects a namespace name");
				let namespace: ToolNamespace | undefined;
				const names: string[] = [];
				for (const tool of tools) {
					const toolNamespace = options.getToolNamespace?.(tool.name);
					if (!toolNamespace || !isNamespaceName(toolNamespace.name, name)) continue;
					namespace ??= toolNamespace;
					names.push(toCodemodeIdentifier(tool.name));
				}
				if (!namespace) return undefined;
				return {
					name: namespace.name,
					...(namespace.description ? { description: namespace.description } : {}),
					...(namespace.instructions ? { instructions: namespace.instructions } : {}),
					tools: names,
				};
			},
		},
	];
}

function createModelGlobals(
	models: CodemodeModelRuntime,
	toolCallId: string,
	calls: CodemodeNestedCall[],
	publish: () => void,
	addUsage: (usage: Usage) => void,
	addGeneratedImages: (count: number) => void,
): CodemodeTool[] {
	const limit = createLimiter(MAX_CONCURRENT_MODEL_CALLS);
	let callCount = 0;

	const runModelCall = async <
		TType extends "classifier" | "image",
		TContext,
		TResult extends ModelCallResult,
	>(
		name: string,
		type: TType,
		[model, context]: unknown[],
		checkContext: (context: unknown) => TContext,
		run: (resolved: ModelTypeMap[TType], context: TContext) => Promise<TResult>,
	): Promise<TResult> => {
		const listHint = `List the ${type} models you can use with models.getAvailableOfType("${type}").`;
		if (!isRecord(model) || typeof model.provider !== "string" || typeof model.id !== "string") {
			const undefinedHint =
				model === undefined || model === null
					? " models.getModelOfType() returns undefined for an unknown provider or id."
					: "";
			throw new Error(
				[
					`${name}() expects ${withArticle(type)} model as its first argument, `,
					`got ${describeValue(model)}.${undefinedHint} ${listHint}`,
				].join(""),
			);
		}
		const { provider, id } = model;
		const ref = `${provider}/${id}`;
		const resolved = models.getModelOfType(type, provider, id);
		if (!resolved) {
			const actualType = [...MODEL_TYPES].find(
				(other) =>
					other !== type &&
					models.getModelOfType(other as ModelType, provider, id) !== undefined,
			);
			throw new Error(
				actualType
					? `"${ref}" is ${withArticle(actualType)} model, not ${withArticle(type)} model. ${listHint}`
					: `Unknown ${type} model "${ref}". ${listHint}`,
			);
		}
		const checked = checkContext(context);

		const record: CodemodeNestedCall = {
			id: `${toolCallId}/${name}/${++callCount}`,
			name,
			args: `${resolved.provider}/${resolved.id}`,
			status: "running",
		};
		calls.push(record);
		publish();
		const startedAt = performance.now();
		let result: TResult;
		try {
			result = await limit(() => run(resolved, checked));
		} catch (error) {
			record.durationMs = performance.now() - startedAt;
			record.status = "error";
			record.error = truncateText(
				error instanceof Error ? error.message : String(error),
				ERROR_PREVIEW_CHARS,
			);
			publish();
			throw error;
		}
		record.durationMs = performance.now() - startedAt;
		record.status =
			result.stopReason === "stop"
				? "ok"
				: result.stopReason === "aborted"
					? "cancelled"
					: "error";
		if (result.errorMessage)
			record.error = truncateText(result.errorMessage, ERROR_PREVIEW_CHARS);
		if (result.usage) {
			record.cost = result.usage.cost.total;
			addUsage(result.usage);
		}
		publish();
		return result;
	};
	const implementations: Record<string, CodemodeTool["execute"]> = {
		"models.getModelsOfType": (args) => {
			const [type, provider] = args as unknown[];
			return models.getModelsOfType(toModelType(type), toProvider(provider)).map(toModelInfo);
		},
		"models.getAvailableOfType": async (args, { signal }) => {
			const [type, provider] = args as unknown[];
			const available = await models.getAvailableOfType(
				toModelType(type),
				toProvider(provider),
				{ signal },
			);
			return available.map(toModelInfo);
		},
		"models.getModelOfType": (args) => {
			const [type, provider, id] = args as unknown[];
			if (typeof provider !== "string" || typeof id !== "string") {
				const got = (args as unknown[]).map(describeValue).join(", ");
				const example = 'models.getModelOfType("classifier", "typesafe", "jev-latest")';
				throw new Error(
					`models.getModelOfType(type, provider, id) expects three strings, got (${got}). ` +
						`The provider and the id are separate arguments, for example ${example}.`,
				);
			}
			const model = models.getModelOfType(toModelType(type), provider, id);
			return model === undefined ? undefined : toModelInfo(model);
		},
		"models.classify": (args, { signal }) =>
			runModelCall(
				"models.classify",
				"classifier",
				args as unknown[],
				checkClassifierContext,
				(resolved, context) => models.classify(resolved, context, { signal }),
			),
		"models.generateImages": (args, { signal }) =>
			runModelCall(
				"models.generateImages",
				"image",
				args as unknown[],
				checkImagesContext,
				async (resolved, context) => {
					const result = await models.generateImages(resolved, context, { signal });
					addGeneratedImages(result.output.filter((block) => block.type === "image").length);
					return result;
				},
			),
	};
	return Object.entries(implementations).map(([name, execute]) => ({
		name,
		spread: true,
		execute,
	}));
}
