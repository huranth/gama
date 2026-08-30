import type { ProviderEnv } from "../types.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { ModelsError } from "../utils/models-error.ts";
import type {
	ApiKeyAuth,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Credential,
	CredentialStore,
	ProviderAuth,
} from "./types.ts";

export { ModelsError, type ModelsErrorCode } from "../utils/models-error.ts";

export interface AuthResolutionOverrides {
	apiKey?: string;
	env?: ProviderEnv;
	signal?: AbortSignal;
}

export function resolveProviderAuth(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides?: AuthResolutionOverrides,
): Promise<AuthResult | undefined> {
	const signal = operationSignal(overrides?.signal);

	const resolution = resolveProviderAuthWithSignal(
		provider,
		credentials,
		authContext,
		overrides,
		signal,
	);

	return raceWithAbortSignal(resolution, signal);
}

function overlayEnvAuthContext(base: AuthContext, env: ProviderEnv): AuthContext {
	return {
		env: async (name) => env[name] || (await base.env(name)),
		fileExists: (path) => base.fileExists(path),
	};
}

async function resolveApiKey(
	authContext: AuthContext,
	apiKey: ApiKeyAuth,
	providerId: string,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	try {
		return await apiKey.resolve({ ctx: authContext, credential, signal });
	} catch (error) {
		throw new ModelsError("auth", `API key auth failed for provider ${providerId}`, {
			cause: error,
		});
	}
}

async function readCredential(
	credentials: CredentialStore,
	providerId: string,
	signal: AbortSignal,
): Promise<Credential | undefined> {
	try {
		return await credentials.read(providerId, { signal });
	} catch (error) {
		throw new ModelsError("auth", `Credential store read failed for ${providerId}`, {
			cause: error,
		});
	}
}

async function resolveProviderAuthWithSignal(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides: AuthResolutionOverrides | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	signal.throwIfAborted();

	const requestAuthContext = overrides?.env
		? overlayEnvAuthContext(authContext, overrides.env)
		: authContext;
	const apiKey = provider.auth.apiKey;

	if (!apiKey) return undefined;

	if (overrides?.apiKey !== undefined) {
		const credential: ApiKeyCredential = {
			type: "api_key",
			key: overrides.apiKey,
			env: overrides.env,
		};

		return resolveApiKey(requestAuthContext, apiKey, provider.id, credential, signal);
	}

	const stored = await readCredential(credentials, provider.id, signal);

	if (!stored) {
		return resolveApiKey(requestAuthContext, apiKey, provider.id, undefined, signal);
	}

	const credential = overrides?.env
		? { ...stored, env: { ...stored.env, ...overrides.env } }
		: stored;

	return resolveApiKey(requestAuthContext, apiKey, provider.id, credential, signal);
}
