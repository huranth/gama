const DEFAULT_PACKAGE_NAME = "@huranth/gama-harness";

const REGISTRY_TIMEOUT_MS = 5000;

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export const config = { runtime: "edge" };

function getPackageName(): string {
	const override = process.env.GAMA_PACKAGE_NAME?.trim();
	return override || DEFAULT_PACKAGE_NAME;
}

function registryUnavailable(): Response {
	return Response.json(
		{ error: "registry unavailable" },
		{ status: 503, headers: { "cache-control": "no-store" } },
	);
}

export default async function latestVersion(request: Request): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return Response.json({ error: "method not allowed" }, { status: 405 });
	}

	const packageName = getPackageName();
	const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;

	let registry: Response;
	try {
		registry = await fetch(registryUrl, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
		});
	} catch {
		return registryUnavailable();
	}

	if (!registry.ok) {
		return registryUnavailable();
	}

	let data: { version?: unknown };
	try {
		data = (await registry.json()) as { version?: unknown };
	} catch {
		return registryUnavailable();
	}

	const version = typeof data.version === "string" ? data.version.trim() : "";
	if (!VERSION_PATTERN.test(version)) {
		return registryUnavailable();
	}

	const body = {
		version,
		packageName,
		url: `https://www.npmjs.com/package/${packageName}`,
	};

	if (request.method === "HEAD") {
		return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
	}

	return Response.json(body, {
		headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=300" },
	});
}
