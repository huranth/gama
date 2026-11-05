import { fuzzyFilter } from "@huranth/gama-tui";
import chalk from "chalk";
import { formatNoModelsAvailableMessage } from "../core/auth-guidance.ts";
import type { ModelHub } from "../core/model-run.ts";
import { formatNotice } from "../core/notices.ts";

const COLUMNS = ["provider", "model", "context", "maxOut", "thinking", "images"] as const;

type Column = (typeof COLUMNS)[number];

type Row = Record<Column, string>;

function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		const millions = count / 1_000_000;
		return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
	}
	if (count >= 1_000) {
		const thousands = count / 1_000;
		return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
	}
	return count.toString();
}

function columnWidth(header: string, values: string[]): number {
	return Math.max(header.length, ...values.map((value) => value.length));
}

export async function listModels(
	modelRuntime: ModelHub,
	searchPattern?: string,
	signal?: AbortSignal,
): Promise<void> {
	const loadError = modelRuntime.getError();
	if (loadError) {
		console.error(
			chalk.yellow(`Warning: ${formatNotice(`Models failed: ${loadError}`)}`),
		);
	}

	const models = [...(await modelRuntime.getAvailable(undefined, { signal }))];

	if (models.length === 0) {
		console.log(formatNoModelsAvailableMessage());
		return;
	}

	let filteredModels = models;
	if (searchPattern) {
		filteredModels = fuzzyFilter(models, searchPattern, (m) => `${m.provider} ${m.id}`);
	}

	if (filteredModels.length === 0) {
		console.log(`No matches: ${searchPattern}`);
		return;
	}

	filteredModels.sort((a, b) => {
		const providerCmp = a.provider.localeCompare(b.provider);
		if (providerCmp !== 0) return providerCmp;
		return a.id.localeCompare(b.id);
	});

	const rows: Row[] = filteredModels.map((m) => ({
		provider: m.provider,
		model: m.id,
		context: formatTokenCount(m.contextWindow),
		maxOut: formatTokenCount(m.maxTokens),
		thinking: m.reasoning ? "yes" : "no",
		images: m.input.includes("image") ? "yes" : "no",
	}));

	const headers: Row = {
		provider: "provider",
		model: "model",
		context: "context",
		maxOut: "max-out",
		thinking: "thinking",
		images: "images",
	};

	const widths = {} as Record<Column, number>;

	for (const column of COLUMNS) {
		widths[column] = columnWidth(headers[column], rows.map((row) => row[column]));
	}

	const formatLine = (row: Row): string =>
		COLUMNS.map((column) => row[column].padEnd(widths[column])).join("  ");

	console.log(formatLine(headers));

	for (const row of rows) {
		console.log(formatLine(row));
	}
}
