import type { ProviderEnv } from "./types.ts";
import { getProviderEnvValue } from "./utils/provider-env.ts";

type DynamicImport = (specifier: string) => Promise<unknown>;

export const ANTHROPIC_AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
export const ANTHROPIC_OAUTH_TOKEN_ENV = "ANTHROPIC_OAUTH_TOKEN";
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
export const ANTHROPIC_FEDERATION_RULE_ID_ENV = "ANTHROPIC_FEDERATION_RULE_ID";
export const ANTHROPIC_ORGANIZATION_ID_ENV = "ANTHROPIC_ORGANIZATION_ID";
export const ANTHROPIC_SERVICE_ACCOUNT_ID_ENV = "ANTHROPIC_SERVICE_ACCOUNT_ID";
export const ANTHROPIC_IDENTITY_TOKEN_FILE_ENV = "ANTHROPIC_IDENTITY_TOKEN_FILE";
export const ANTHROPIC_WORKSPACE_ID_ENV = "ANTHROPIC_WORKSPACE_ID";

const AUTHENTICATED = "<authenticated>";

const ANTHROPIC_ENV_VARS: readonly string[] = [
	ANTHROPIC_AUTH_TOKEN_ENV,
	ANTHROPIC_OAUTH_TOKEN_ENV,
	ANTHROPIC_API_KEY_ENV,
];

const dynamicImport: DynamicImport = (specifier) => import(specifier);

// Bundler escape.
const FS_MODULE = "node:" + "fs";
const OS_MODULE = "node:" + "os";
const PATH_MODULE = "node:" + "path";

let existsSync: typeof import("node:fs").existsSync | null = null;
let homedir: typeof import("node:os").homedir | null = null;
let joinPath: typeof import("node:path").join | null = null;

let cachedAdcExists: boolean | null = null;

if (isNodeRuntime()) {
	dynamicImport(FS_MODULE).then((mod) => {
		existsSync = (mod as typeof import("node:fs")).existsSync;
	});
	dynamicImport(OS_MODULE).then((mod) => {
		homedir = (mod as typeof import("node:os")).homedir;
	});
	dynamicImport(PATH_MODULE).then((mod) => {
		joinPath = (mod as typeof import("node:path")).join;
	});
}

export function findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined {
	if (provider !== "anthropic") return undefined;

	const found = ANTHROPIC_ENV_VARS.filter((name) => !!getProviderEnvValue(name, env));

	return found.length > 0 ? found : undefined;
}

export function getEnvApiKey(provider: string, env?: ProviderEnv): string | undefined {
	const envKeys = findEnvKeys(provider, env);
	const apiKeyEnv = pickApiKeyEnv(provider, envKeys);

	if (apiKeyEnv) return getProviderEnvValue(apiKeyEnv, env);

	if (provider === "google-vertex" && hasVertexConfig(env)) return AUTHENTICATED;

	if (provider === "amazon-bedrock" && hasAwsConfig(env)) return AUTHENTICATED;

	return undefined;
}

function isNodeRuntime(): boolean {
	if (typeof process === "undefined") return false;

	return Boolean(process.versions?.node || process.versions?.bun);
}

function pickApiKeyEnv(provider: string, envKeys?: readonly string[]): string | undefined {
	if (!envKeys || envKeys.length === 0) return undefined;

	if (provider === "anthropic") {
		return envKeys.find((key) => key !== ANTHROPIC_AUTH_TOKEN_ENV);
	}

	return envKeys[0];
}

function hasVertexConfig(env?: ProviderEnv): boolean {
	const hasCredentials = hasVertexAdcCredentials(env);
	const hasProject = Boolean(
		getProviderEnvValue("GOOGLE_CLOUD_PROJECT", env) ||
			getProviderEnvValue("GCLOUD_PROJECT", env),
	);
	const hasLocation = Boolean(getProviderEnvValue("GOOGLE_CLOUD_LOCATION", env));

	return hasCredentials && hasProject && hasLocation;
}

function hasAwsConfig(env?: ProviderEnv): boolean {
	const hasKeys =
		getProviderEnvValue("AWS_ACCESS_KEY_ID", env) &&
		getProviderEnvValue("AWS_SECRET_ACCESS_KEY", env);

	return Boolean(
		getProviderEnvValue("AWS_PROFILE", env) ||
			hasKeys ||
			getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", env) ||
			getProviderEnvValue("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", env) ||
			getProviderEnvValue("AWS_CONTAINER_CREDENTIALS_FULL_URI", env) ||
			getProviderEnvValue("AWS_WEB_IDENTITY_TOKEN_FILE", env),
	);
}

function hasVertexAdcCredentials(env?: ProviderEnv): boolean {
	const explicitPath = env?.GOOGLE_APPLICATION_CREDENTIALS;

	if (explicitPath) {
		return existsSync ? existsSync(explicitPath) : false;
	}

	if (cachedAdcExists !== null) return cachedAdcExists;

	if (!existsSync || !homedir || !joinPath) return false;

	const gacPath = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);

	cachedAdcExists = gacPath
		? existsSync(gacPath)
		: existsSync(
				joinPath(homedir(), ".config", "gcloud", "application_default_credentials.json"),
			);

	return cachedAdcExists;
}
