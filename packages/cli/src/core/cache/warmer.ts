import type {
	Api,
	CacheRetention,
	Context,
	Model,
	ModelsSimpleStreamOptions,
	SimpleStreamOptions,
	Usage,
} from "@huranth/gama-ai";
import { calculateCost } from "@huranth/gama-ai";
import { getProviderEnvValue } from "@huranth/gama-ai/utils/provider-env";
import type { ModelHub } from "../model-run.ts";
import type { SessionEntry, SessionStore, UsageEntry } from "../sessions.ts";
import { type CacheWarmingMode, DEFAULT_CACHE_WARM_SAVINGS_RATIO } from "../settings.ts";
import { promptTokens } from "./rate.ts";
import { cacheWindowOf, resolveCacheWindowMs } from "./session.ts";

const MINUTE_MS = 60_000;

const SECOND_MS = 1_000;

const MAX_STREAM_AGE_MS = 60 * MINUTE_MS;

const MAX_IDLE_AGE_MS = 30 * MINUTE_MS;

const DEFAULT_TTL_MS = 5 * MINUTE_MS;

// Idle guess
const IDLE_CONTINUATION = 0.15;

// TTL margin
const TTL_MARGIN_MS = 10_000;

const EARLY_FRACTION = 0.9;

// Stop reasons
const REASONS = {
	inactive: "Inactive",
	warmingOff: "Warming off",
	unsafeReplay: "Unsafe replay",
	cachingOff: "Caching off",
	noLifetime: "No lifetime",
	runSettled: "Run settled",
	contextChanged: "Context changed",
	cacheExpired: "Cache expired",
	noSavings: "No savings",
	noEconomics: "No economics",
	warmNotHitting: "Warm not hitting",
	idleLimit: "Idle limit",
	timeLimit: "Time limit",
	waiting: "Waiting",
} as const;

export interface CacheWarmerPolicy {
	assumedTtlMs?: number;
	savingsRatio?: number;
}

export type CacheWarmingAction = "warm" | "stop";

export interface CacheWarmingDecision {
	phase: "streaming" | "idle";
	warmCost: number;
	missCost: number;
	continuationProbability: number;
	expectedSavings: number;
	economicsAvailable: boolean;
	action: CacheWarmingAction;
}

export interface WarmVerification {
	hits: number;
	misses: number;
	suspect: boolean;
}

export interface CacheWarmingStatus {
	state: "inactive" | "scheduled" | "refreshing";
	reason?: string;
	nextWarmAt?: number;
	decision?: CacheWarmingDecision;
	verification?: WarmVerification;
}

type WarmMessage = Awaited<ReturnType<CacheWarmer["warm"]>>;

export interface CacheWarmRequest {
	model: Model<Api>;
	context: Context;
	options: ModelsSimpleStreamOptions;
}

interface ActiveRun extends CacheWarmRequest {
	isCurrent: () => boolean;
	ttlMs: number;
	delayMs: number;
	expiresAt: number;
	startedAt: number;
	phase: "streaming" | "idle";
	nextWarmAt: number;
	controller: AbortController;
	timer?: ReturnType<typeof setTimeout>;
}

function retentionOf(options: SimpleStreamOptions | undefined): CacheRetention {
	if (options?.cacheRetention) return options.cacheRetention;
	const long = getProviderEnvValue("GAMA_CACHE_RETENTION", options?.env) === "long";
	return long ? "long" : "short";
}

export function getPromptCacheTtlMs(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
): number | undefined {
	return cacheWindowOf(model, retentionOf(options));
}

export function getCacheWarmingDelayMs(ttlMs: number): number | undefined {
	if (ttlMs <= TTL_MARGIN_MS) return undefined;

	const early = Math.min(ttlMs * EARLY_FRACTION, ttlMs - TTL_MARGIN_MS);

	return Math.max(Math.ceil(ttlMs / 2), Math.floor(early));
}

export function isReplayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
	if (!options?.reasoning) return true;
	if (model.api !== "anthropic-messages") return true;
	return (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking === true;
}

function isFailed(message: WarmMessage): boolean {
	return message.stopReason === "error" || message.stopReason === "aborted";
}

function lastPromptTokens(entries: readonly SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;

		return promptTokens(entry.message.usage);
	}

	return 0;
}

export function formatCacheWarmingStatus(status: CacheWarmingStatus, now = Date.now()): string {
	if (!status.decision) return status.reason ?? REASONS.inactive;
	if (status.state === "inactive") return status.reason ?? "Stopped";
	if (status.state === "refreshing") return "Warming";

	const seconds = Math.max(0, Math.ceil(((status.nextWarmAt ?? now) - now) / SECOND_MS));
	const minutes = Math.floor(seconds / 60);

	return `Next in ${minutes}m${seconds % 60}s`;
}

function price(
	model: Model<Api>,
	tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>,
): number {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	};
	return calculateCost(model, usage).total;
}

export class CacheWarmer {
	private run?: ActiveRun;

	private inactive: CacheWarmingStatus = {
		state: "inactive",
		reason: REASONS.waiting,
	};

	private readonly models: Pick<ModelHub, "streamSimple">;
	private readonly sessionManager: Pick<SessionStore, "appendUsage" | "getBranch">;
	private readonly getMode: () => CacheWarmingMode;
	private readonly getPolicy: () => CacheWarmerPolicy;

	private warmHits = 0;
	private warmMisses = 0;
	private warmRoute?: string;

	onWarmed?: (entry: UsageEntry) => void;

	constructor(
		models: Pick<ModelHub, "streamSimple">,
		sessionManager: Pick<SessionStore, "appendUsage" | "getBranch">,
		getMode: () => CacheWarmingMode,
		getPolicy: () => CacheWarmerPolicy = () => ({}),
	) {
		this.models = models;
		this.sessionManager = sessionManager;
		this.getMode = getMode;
		this.getPolicy = getPolicy;
	}

	get status(): CacheWarmingStatus {
		const verification = this.verification;
		if (this.getMode() === "off") {
			return { state: "inactive", reason: REASONS.warmingOff, verification };
		}

		const run = this.run;
		if (!run) return { ...this.inactive, verification };
		if (!run.isCurrent()) {
			return { state: "inactive", reason: REASONS.contextChanged, verification };
		}

		const decision = this.evaluate(run);
		const refreshing = run.timer === undefined;
		if (!decision.economicsAvailable && !refreshing) {
			return { state: "inactive", reason: REASONS.noEconomics, verification };
		}
		return {
			state: refreshing ? "refreshing" : "scheduled",
			nextWarmAt: run.nextWarmAt,
			decision,
			verification,
		};
	}

	start(request: CacheWarmRequest, isCurrent: () => boolean): void {
		this.clearRun();

		const route = `${request.model.provider}/${request.model.id}`;
		if (this.warmRoute !== route) {
			this.warmRoute = route;
			this.warmHits = 0;
			this.warmMisses = 0;
		}

		if (this.getMode() === "off") {
			this.stop(REASONS.warmingOff);
			return;
		}

		if (!isReplayable(request.model, request.options)) {
			this.stop(REASONS.unsafeReplay);
			return;
		}

		const retention = retentionOf(request.options);
		const ttlMs = this.resolveTtl(request.model, retention);
		if (ttlMs === undefined) {
			const reason = retention === "none" ? REASONS.cachingOff : REASONS.noLifetime;
			this.stop(reason);
			return;
		}

		const delayMs = getCacheWarmingDelayMs(ttlMs);
		if (delayMs === undefined) {
			this.stop(REASONS.noLifetime);
			return;
		}

		const now = Date.now();
		this.run = {
			...request,
			isCurrent,
			ttlMs,
			delayMs,
			expiresAt: now + ttlMs,
			startedAt: now,
			phase: "streaming",
			nextWarmAt: 0,
			controller: new AbortController(),
		};
		this.schedule(this.run);
	}

	onAgentSettled(): void {
		const run = this.run;
		if (!run) return;
		if (this.getMode() === "streaming") {
			this.stop(REASONS.runSettled);
			return;
		}
		run.phase = "idle";
		const deadline = run.startedAt + MAX_IDLE_AGE_MS;
		if (run.nextWarmAt > deadline || Date.now() >= deadline) {
			this.stop(REASONS.idleLimit);
		}
	}

	onModeChanged(): void {
		const run = this.run;
		if (!run) return;
		const reason = this.modeStopReason(run);
		if (reason) this.stop(reason);
	}

	cancel(): void {
		this.stop(REASONS.inactive);
	}

	private get verification(): WarmVerification | undefined {
		if (this.warmHits === 0 && this.warmMisses === 0) return undefined;
		return {
			hits: this.warmHits,
			misses: this.warmMisses,
			suspect: this.warmHits === 0 && this.warmMisses > 0,
		};
	}

	private resolveTtl(model: Model<Api>, retention: CacheRetention): number | undefined {
		if (retention === "none") return undefined;
		const assumed = this.getPolicy().assumedTtlMs;
		const observed = resolveCacheWindowMs(model, {
			retention,
			entries: this.sessionManager.getBranch(),
			assumedMs: assumed,
		});
		if (observed !== undefined) return observed;
		return assumed ?? DEFAULT_TTL_MS;
	}

	private clearRun(): void {
		const run = this.run;
		if (!run) return;
		this.run = undefined;
		if (run.timer) clearTimeout(run.timer);
		run.controller.abort();
	}

	private stop(reason: string, decision?: CacheWarmingDecision): void {
		this.clearRun();
		this.inactive = { state: "inactive", reason, ...(decision ? { decision } : {}) };
	}

	private schedule(run: ActiveRun): void {
		const now = Date.now();
		run.nextWarmAt = now + run.delayMs;

		const budget = run.phase === "idle" ? MAX_IDLE_AGE_MS : MAX_STREAM_AGE_MS;
		if (run.nextWarmAt > run.startedAt + budget || now >= run.startedAt + budget) {
			this.stop(run.phase === "idle" ? REASONS.idleLimit : REASONS.timeLimit);
			return;
		}

		run.timer = setTimeout(() => void this.refresh(run), Math.max(0, run.nextWarmAt - now));
		run.timer.unref?.();
	}

	private async refresh(run: ActiveRun): Promise<void> {
		run.timer = undefined;
		if (!this.validateRun(run)) return;

		if (Date.now() >= run.expiresAt) {
			this.stop(REASONS.cacheExpired);
			return;
		}

		const decision = this.evaluate(run);
		if (decision.action === "stop") {
			const reason = decision.economicsAvailable ? REASONS.noSavings : REASONS.noEconomics;
			this.stop(reason, decision);
			return;
		}

		try {
			const message = await this.warm(run);
			this.recordUsage(message);
			if (!this.validateRun(run)) return;

			this.recordWarmOutcome(message);
			if (this.warmHits === 0 && this.warmMisses >= 2) {
				this.stop(REASONS.warmNotHitting);
				return;
			}

			run.expiresAt = Date.now() + run.ttlMs;
		} catch {
			// Keep warming
		}

		if (this.run === run) this.schedule(run);
	}

	private warm(run: ActiveRun) {
		return this.models
			.streamSimple(run.model, run.context, {
				...run.options,
				maxTokens: 1,
				maxRetries: 0,
				signal: run.controller.signal,
			})
			.result();
	}

	private recordUsage(message: WarmMessage): void {
		if (isFailed(message)) return;

		const entry = this.sessionManager.appendUsage(
			"cache_warm",
			message.provider,
			message.responseModel ?? message.model,
			message.usage,
		);
		this.onWarmed?.(entry);
	}

	private recordWarmOutcome(message: WarmMessage): void {
		if (isFailed(message)) return;

		const prompt = promptTokens(message.usage);
		if (prompt > 0) {
			if (message.usage.cacheRead > 0) this.warmHits += 1;
			else this.warmMisses += 1;
		}
	}

	private validateRun(run: ActiveRun): boolean {
		if (this.run !== run) return false;
		const changed = !run.isCurrent() ? REASONS.contextChanged : undefined;
		const reason = this.modeStopReason(run) ?? changed;
		if (!reason) return true;
		this.stop(reason);
		return false;
	}

	private modeStopReason(run: ActiveRun): string | undefined {
		const mode = this.getMode();
		if (mode === "off") return REASONS.warmingOff;
		if (mode === "streaming" && run.phase === "idle") return REASONS.runSettled;
		return undefined;
	}

	private evaluate(run: ActiveRun): CacheWarmingDecision {
		const model = run.model;
		const prompt = lastPromptTokens(this.sessionManager.getBranch());

		const warmCost = price(model, { cacheRead: prompt, output: 1 });
		const cachedRead = price(model, { cacheRead: prompt });
		const fullPrompt =
			model.cost.cacheWrite > 0
				? price(model, { cacheWrite: prompt })
				: price(model, { input: prompt });
		const missCost = Math.max(0, fullPrompt - cachedRead);

		const phase = run.phase;
		const continuationProbability = phase === "idle" ? IDLE_CONTINUATION : 1;
		const economicsAvailable = prompt > 0 && (cachedRead > 0 || fullPrompt > 0);
		const expectedSavings = continuationProbability * missCost - warmCost;

		const ratio = this.getPolicy().savingsRatio ?? DEFAULT_CACHE_WARM_SAVINGS_RATIO;
		const worthIt = economicsAvailable && expectedSavings >= warmCost * ratio;
		return {
			phase,
			warmCost,
			missCost,
			continuationProbability,
			expectedSavings,
			economicsAvailable,
			action: worthIt ? "warm" : "stop",
		};
	}
}
