export interface GamaServiceEndpoints {
	updateCheck: string;
	installPing: string;
	shareViewer: string;
	releasesPage: string;
}

declare const GAMA_SERVICE_ENDPOINTS: string | undefined; // build-injected

const DEFAULT_ENDPOINTS: GamaServiceEndpoints = {
	updateCheck: "https://gama-update.vercel.app/api/latest-version",
	installPing: "https://gama.dev/api/report-install",
	shareViewer: "https://gama.dev/session/",
	releasesPage: "https://github.com/huranth/gama/releases/latest",
};

const ENDPOINT_KEYS = Object.keys(DEFAULT_ENDPOINTS) as (keyof GamaServiceEndpoints)[];

let resolvedEndpoints: Readonly<GamaServiceEndpoints> | undefined;

function readUrl(value: unknown): string | undefined {
	const text = typeof value === "string" ? value.trim() : "";

	return /^https?:\/\//.test(text) ? text : undefined;
}

function injectedEndpoints(): Partial<GamaServiceEndpoints> {
	if (typeof GAMA_SERVICE_ENDPOINTS === "undefined") return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(GAMA_SERVICE_ENDPOINTS);
	} catch {
		return {};
	}

	if (typeof parsed !== "object" || parsed === null) return {};

	const source = parsed as Record<string, unknown>;
	const result: Partial<GamaServiceEndpoints> = {};

	for (const key of ENDPOINT_KEYS) {
		const url = readUrl(source[key]);
		if (url) result[key] = url;
	}

	return result;
}

export function getServiceEndpoints(): Readonly<GamaServiceEndpoints> {
	if (!resolvedEndpoints) {
		const merged = { ...DEFAULT_ENDPOINTS, ...injectedEndpoints() };
		resolvedEndpoints = Object.freeze(merged);
	}

	return resolvedEndpoints;
}

export function getUpdateCheckUrl(): string {
	const override = readUrl(process.env.GAMA_UPDATE_URL);
	return override ?? getServiceEndpoints().updateCheck;
}

export function getInstallPingUrl(version: string): string {
	const base = getServiceEndpoints().installPing.replace(/[?&]+$/, "");
	const separator = base.includes("?") ? "&" : "?";
	return `${base}${separator}version=${encodeURIComponent(version)}`;
}

export function getReleasesUrl(): string {
	return getServiceEndpoints().releasesPage;
}

export function getShareViewerBaseUrl(): string {
	const override = readUrl(process.env.GAMA_SHARE_VIEWER_URL);
	return override ?? getServiceEndpoints().shareViewer;
}
