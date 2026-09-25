import type { CacheColdReason, CacheSnapshot } from "./session.ts";

export type HitTone = "success" | "warning" | "error";

export type Paint = (text: string, tone: HitTone) => string;

const LEVELS = ["▁", "▃", "▅", "▆", "▇"];

const RAIL_WIDTH = 8;

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
	if (amount < 0.001) return `${sign}<$0.001`;
	if (amount < 0.01) return `${sign}$${amount.toFixed(4)}`;
	if (amount < 10) return `${sign}$${amount.toFixed(3)}`;
	if (amount < 1000) return `${sign}$${amount.toFixed(2)}`;
	return `${sign}$${Math.round(amount)}`;
}

export function hitTone(rate: number): HitTone {
	if (rate >= 0.9) return "success";
	if (rate >= 0.5) return "warning";
	return "error";
}

function levelOf(rate: number): number {
	if (rate >= 0.97) return 4;
	if (rate >= 0.9) return 3;
	if (rate >= 0.75) return 2;
	if (rate >= 0.5) return 1;
	return 0;
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
		["window", `${Math.round(snapshot.windowMs / 60_000)}m`],
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
		["hit rate", snapshot.rates.length === 0 ? "—" : formatPercent(snapshot.latest)],
	];
	if (snapshot.latestReason !== undefined && snapshot.latest < 1) {
		rows.push(["why", coldReasonLabel(snapshot.latestReason)]);
	}
	const turns = snapshot.warmTurns + snapshot.coldTurns;
	if (turns > 0) {
		const warm = `${snapshot.warmTurns} warm`;
		const cold = `${snapshot.coldTurns} cold`;
		const ratio = formatPercent(snapshot.warmRatio);
		rows.push(["turns", `${warm} · ${cold} · warm ${ratio}`]);
	}
	if (snapshot.unreported > 0) {
		rows.push(["no usage", `${snapshot.unreported} reported`]);
	}
	if (snapshot.lookbackPositions !== undefined && snapshot.lookbackPositions >= 18) {
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

export function hitRail(rates: readonly number[], paint: Paint): string {
	const recent = rates.slice(-RAIL_WIDTH);
	const marks = recent.map((rate) => {
		const level = LEVELS[levelOf(rate)] ?? "▁";
		return paint(level, hitTone(rate));
	});

	return marks.join("");
}
