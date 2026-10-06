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

const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

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

export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes =
		cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" &&
			value !== null &&
			"code" in value &&
			typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) {
		return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	}
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

export async function getLatestGamaVersion(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<string | undefined> {
	return (await getLatestGamaRelease(currentVersion, options))?.version;
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
			maxRetries: options.retry ? 2 : 0,
			timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
		},
	);
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
		url?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const version = data.version.trim();
	if (!valid(version) || prerelease(version)) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim()
			? data.packageName.trim()
			: undefined;
	if (packageName && packageName !== PACKAGE_NAME) {
		throw new Error(`Update service returned a different package: ${packageName}`);
	}
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	const url = typeof data.url === "string" && data.url.trim() ? data.url.trim() : undefined;
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
