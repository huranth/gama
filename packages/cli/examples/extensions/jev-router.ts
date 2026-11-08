import type { Message } from "@huranth/gama-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@huranth/gama-harness";

const PROVIDER = "openai-codex";
const SOL = "gpt-5.6-sol";
const TERRA = "gpt-5.6-terra";
const LUNA = "gpt-5.6-luna";

const EDIT_TOOLS = new Set(["edit", "write"]);

interface JevState {
	phase: "planning" | "implementation";
	model: string;
}

type JevRequest = ModelRouteRequest<JevState>;

function routeTo(
	request: JevRequest,
	ctx: ExtensionContext,
	id: string,
	state?: JevState,
): ModelRoute<JevState> {
	const model = ctx.modelRegistry.find(PROVIDER, id);
	if (!model) throw new Error(`Model ${PROVIDER}/${id} is not in the catalog`);
	return { model, thinkingLevel: request.thinkingLevel, state };
}

function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function editedThisTurn(messages: readonly Message[]): boolean {
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	return messages
		.slice(lastUser + 1)
		.some(
			(message) =>
				message.role === "toolResult" && EDIT_TOOLS.has(message.toolName) && !message.isError,
		);
}

async function choosePlanningModel(request: JevRequest, ctx: ExtensionContext): Promise<string> {
	const previous = request.previous?.model;
	if (previous?.provider === PROVIDER && (previous.id === SOL || previous.id === TERRA))
		return previous.id;

	const jev = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
	if (!jev) return TERRA;
	const result = await ctx.modelRegistry.classify(
		jev,
		{
			state: { prompt: lastUserText(request.messages).slice(0, 16_000) },
			questions: {
				complexity: {
					type: "choice",
					instructions:
						"How demanding is the software engineering work requested in `prompt`?",
					criteria: {
						standard: "Ordinary features, fixes, reviews, or questions",
						complex: "Subtle design, cross-cutting changes, or hard debugging",
					},
				},
			},
		},
		{ signal: request.signal },
	);
	const answer = result.stopReason === "stop" ? result.answers.complexity : undefined;
	return answer?.type === "choice" && (answer.probabilities.complex ?? 0) >= 0.5 ? SOL : TERRA;
}

export default function (gama: ExtensionAPI) {
	gama.registerVirtualModel<JevState>({
		provider: "jev",
		id: "auto",
		name: "Auto (Jev)",
		thinkingLevels: ["low", "medium", "high", "xhigh"],
		contextWindow: 272_000,
		maxTokens: 128_000,
		async route(request, ctx) {
			if (request.reason === "direct") return routeTo(request, ctx, LUNA);
			const state = request.state;
			if (!state) {
				const model = await choosePlanningModel(request, ctx);
				return routeTo(request, ctx, model, { phase: "planning", model });
			}
			if (state.phase === "planning" && editedThisTurn(request.messages)) {
				return routeTo(request, ctx, LUNA, { phase: "implementation", model: LUNA });
			}
			return routeTo(request, ctx, state.model);
		},
	});
}
