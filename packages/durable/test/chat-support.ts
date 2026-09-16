import type { Context } from "@huranth/chord";
import {
	createModels,
	type FauxProviderHandle,
	type FauxResponseStep,
	fauxProvider,
	type Message,
	type Models,
	type RegisterFauxProviderOptions,
} from "@huranth/gama-ai";
import {
	type Conversation,
	createRegistry,
	type EntryRecord,
	Harness,
	type HarnessOptions,
	type HarnessSettings,
	type Registry,
	type Storage,
	type ToolRegistration,
} from "@huranth/gama-durable";
import type { ExecutionEnv } from "../src/env/index.ts";
import { context } from "./session-support.ts";

export type ChatSetup = {
	readonly faux: FauxProviderHandle;
	readonly models: Models;
	readonly registry: Registry;
	readonly reports: unknown[];
	readonly settings: { -readonly [K in keyof HarnessSettings]: HarnessSettings[K] };
	now: () => number;
};

export function chatSetup(options: RegisterFauxProviderOptions = {}): ChatSetup {
	const faux = fauxProvider(options);
	const models = createModels();
	models.setProvider(faux.provider);
	return {
		faux,
		models,
		registry: createRegistry(),
		reports: [],
		settings: {},
		now: () => Date.now(),
	};
}

export async function openChat(
	storage: Storage,
	setup: ChatSetup,
	options: { readonly env?: ExecutionEnv | NonNullable<HarnessOptions["env"]> } = {},
): Promise<{ readonly harness: Harness; readonly root: Conversation }> {
	const harness = await Harness.open(
		storage,
		{
			models: setup.models,
			registry: setup.registry,
			settings: setup.settings,
			...(options.env === undefined
				? {}
				: {
						env:
							typeof options.env === "function"
								? options.env
								: () => options.env as ExecutionEnv,
					}),
			now: () => setup.now(),
			onReport: (error) => setup.reports.push(error),
		},
		context,
	);
	const root = await harness.root(context, {
		agent: { model: { provider: "faux", modelId: "faux-1" } },
	});
	return { harness, root };
}

export async function allEntries(
	conversation: Conversation,
	callContext: Context = context,
): Promise<EntryRecord[]> {
	const page = await conversation.entries({}, 1000, undefined, callContext);
	return [...page.items].reverse();
}

export function textOf(message: Message | undefined): string | undefined {
	if (message === undefined) return undefined;
	if (message.role === "system") return undefined;
	if (typeof message.content === "string") return message.content;
	const text = message.content.find((content) => content.type === "text");
	return text?.type === "text" ? text.text : undefined;
}

export async function waitFor(
	check: () => boolean | Promise<boolean>,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("Condition was not reached");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

export function unanswered(): { readonly step: FauxResponseStep; readonly reached: Promise<void> } {
	let reach!: () => void;
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	const step: FauxResponseStep = (_context, options) =>
		new Promise((_, reject) => {
			reach();
			const signal = options!.signal!;
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	return { step, reached };
}

export function toolsNamed(setup: ChatSetup, ...names: string[]): ToolRegistration[] {
	const installed = setup.registry.snapshot().tools();
	return names.map((name) => {
		const found = installed.find(({ tool }) => tool.name === name);
		if (found === undefined) throw new Error(`Tool ${name} is not installed`);
		return found.tool;
	});
}
