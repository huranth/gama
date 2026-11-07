import { compare, prerelease, valid } from "semver";
import { PACKAGE_NAME } from "../config.ts";
import { getUpdateCheckUrl } from "../core/endpoints.ts";
import { getGamaUserAgent } from "./gama-user-agent.ts";
import { fetchWithRetry } from "./management-http.ts";

export interface LatestGamaRelease {
	version: string;
	packageName?: string;
	note?: string;
	url?: string;
}

const defaultTimeoutMs = 10000;

const retryMaxAttempts = 2;

const noRetries = 0;

async function cancelBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// Already closed
	}
}

function trimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;

	const trimmed = value.trim();
	return trimmed || undefined;
}

export function comparePackageVersions(
	leftVersion: string,
	rightVersion: string,
): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}

	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}

	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestGamaVersion(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<string | undefined> {
	const release = await getLatestGamaRelease(currentVersion, options);
	return release?.version;
}

export async function getLatestGamaRelease(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<LatestGamaRelease | undefined> {
	if (process.env.GAMA_OFFLINE) return undefined;

	const response = await fetchWithRetry(
		getUpdateCheckUrl(),
		{
			headers: {
				"User-Agent": getGamaUserAgent(currentVersion),
				accept: "application/json",
			},
		},
		{
			maxRetries: options.retry ? retryMaxAttempts : noRetries,
			timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
		},
	);
	if (!response.ok) {
		await cancelBody(response);
		return undefined;
	}

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
		url?: unknown;
	};

	const version = trimmedString(data.version);
	if (!version || !valid(version) || prerelease(version)) {
		return undefined;
	}

	const packageName = trimmedString(data.packageName);
	if (packageName && packageName !== PACKAGE_NAME) {
		throw new Error(`Update package mismatch: ${packageName}`);
	}

	const note = trimmedString(data.note);
	const url = trimmedString(data.url);

	return {
		version,
		packageName,
		...(note ? { note } : {}),
		...(url ? { url } : {}),
	};
}

export async function checkForNewGamaVersion(
	currentVersion: string,
): Promise<LatestGamaRelease | undefined> {
	if (process.env.GAMA_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestGamaRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}

		return undefined;
	} catch {
		return undefined;
	}
}

function errorCode(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("code" in value)) return undefined;
	if (typeof value.code !== "string") return undefined;

	return value.code;
}

function collectCauses(error: unknown): unknown[] {
	const cause = error instanceof Error ? error.cause : undefined;
	if (cause === undefined) return [];
	if (cause instanceof AggregateError) return [...cause.errors];

	return [cause];
}

export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const causes = collectCauses(error);

	const codes = causes.map(errorCode).filter((code): code is string => code !== undefined);
	if (codes.length > 0) {
		return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	}

	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;

	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}
