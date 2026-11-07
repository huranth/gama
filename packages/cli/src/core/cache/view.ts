import type { CacheColdReason, CacheSnapshot } from "./session.ts";

export type HitTone = "success" | "warning" | "error";

// Lookback warn
const LOOKBACK_WARN = 18;

const MINUTE_MS = 60_000;

const MONEY_DIGITS: Array<[limit: number, digits: number]> = [
	[0.01, 4],
	[10, 3],
	[1000, 2],
];

const COLD_REASON_LABELS: Record<CacheColdReason, string> = {
	"first-request": "First request",
	"model-switched": "Model switch",
	compacted: "After compaction",
	"cache-expired": "Cache expired",
	"prompt-changed": "Prompt changed",
	"new-tokens": "New tokens",
};

export function coldReasonLabel(reason: CacheColdReason): string {
	return COLD_REASON_LABELS[reason];
}

export function formatPercent(rate: number): string {
	return `${(rate * 100).toFixed(1)}%`;
}

export function formatMoney(value: number): string {
	if (!Number.isFinite(value) || value === 0) return "$0.00";

	const sign = value < 0 ? "-" : "";
	const amount = Math.abs(value);
	if (amount < 0.001) return value < 0 ? "-$0.001" : "<$0.001";

	const digits = MONEY_DIGITS.find(([limit]) => amount < limit)?.[1];
	if (digits === undefined) return `${sign}$${Math.round(amount)}`;

	return `${sign}$${amount.toFixed(digits)}`;
}

export function hitTone(rate: number): HitTone {
	if (rate >= 0.9) return "success";
	if (rate >= 0.5) return "warning";
	return "error";
}

function formatCountdown(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const minutes = Math.floor(total / 60);
	const rest = total % 60;
	return `${minutes}:${rest < 10 ? `0${rest}` : rest}`;
}

function modelRows(snapshot: CacheSnapshot): Array<[string, string]> {
	return snapshot.model ? [["model", snapshot.model]] : [];
}

function warmRows(snapshot: CacheSnapshot): Array<[string, string]> {
	if (snapshot.warmRequests === 0) return [];
	return [
		["warm spend", formatMoney(snapshot.warmSpent)],
		["warm requests", snapshot.warmRequests.toString()],
		["net saved", formatMoney(snapshot.totals.saved - snapshot.warmSpent)],
	];
}

function windowRows(snapshot: CacheSnapshot): Array<[string, string]> {
	if (snapshot.windowMs === undefined) return [];
	return [
		["window", `${Math.round(snapshot.windowMs / MINUTE_MS)}m`],
		["left", formatCountdown(snapshot.leftMs)],
	];
}

function forecastRows(snapshot: CacheSnapshot): Array<[string, string]> {
	if (snapshot.nextWarm === undefined || snapshot.nextCold === undefined) return [];
	return [
		["next warm", formatMoney(snapshot.nextWarm)],
		["next cold", formatMoney(snapshot.nextCold)],
	];
}

function usageRows(snapshot: CacheSnapshot): Array<[string, string]> {
	const { totals } = snapshot;
	const rows: Array<[string, string]> = [
		["scope", "main agent"],
		["hit rate", snapshot.rates.length === 0 ? "n/a" : formatPercent(snapshot.latest)],
	];
	if (snapshot.latestReason !== undefined && snapshot.latest < 1) {
		rows.push(["why", coldReasonLabel(snapshot.latestReason)]);
	}
	const turns = snapshot.warmTurns + snapshot.coldTurns;
	if (turns > 0) {
		const warm = `${snapshot.warmTurns} warm`;
		const cold = `${snapshot.coldTurns} cold`;
		const ratio = formatPercent(snapshot.warmRatio);
		rows.push(["turns", `${warm} warm, ${cold} cold, ${ratio} hit`]);
	}
	if (snapshot.unreported > 0) {
		rows.push(["no usage", `${snapshot.unreported} turns`]);
	}
	if (snapshot.lookbackPositions !== undefined && snapshot.lookbackPositions >= LOOKBACK_WARN) {
		rows.push(["lookback", `${snapshot.lookbackPositions} turns since write`]);
	}
	rows.push(["read", `${totals.cacheRead.toLocaleString()} tokens`]);
	rows.push(["write", `${totals.cacheWrite.toLocaleString()} tokens`]);
	rows.push(["spent", formatMoney(totals.spent)]);
	rows.push(["uncached", formatMoney(totals.uncached)]);
	rows.push(["saved", formatMoney(totals.saved)]);
	return rows;
}

export function cacheRows(snapshot: CacheSnapshot): Array<[string, string]> {
	return [
		...usageRows(snapshot),
		...warmRows(snapshot),
		...forecastRows(snapshot),
		...windowRows(snapshot),
		...modelRows(snapshot),
		["requests", snapshot.rates.length.toString()],
		["recent", snapshot.rates.map((rate) => formatPercent(rate)).join(" ")],
	];
}

