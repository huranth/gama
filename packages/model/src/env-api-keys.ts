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

const ADC_PARTS = [".config", "gcloud", "application_default_credentials.json"];

const GOOGLE_PROJECT_ENV_VARS = ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"];

const GOOGLE_LOCATION_ENV = "GOOGLE_CLOUD_LOCATION";

const AWS_PROFILE_ENV = "AWS_PROFILE";

const AWS_ACCESS_KEY_ENV = "AWS_ACCESS_KEY_ID";

const AWS_SECRET_KEY_ENV = "AWS_SECRET_ACCESS_KEY";

const AWS_BEARER_ENV = "AWS_BEARER_TOKEN_BEDROCK";

const AWS_CONTAINER_RELATIVE_ENV = "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI";

const AWS_CONTAINER_FULL_ENV = "AWS_CONTAINER_CREDENTIALS_FULL_URI";

const AWS_WEB_IDENTITY_ENV = "AWS_WEB_IDENTITY_TOKEN_FILE";

const AWS_SINGLE_KEY_ENV_VARS = [
	AWS_PROFILE_ENV,
	AWS_BEARER_ENV,
	AWS_CONTAINER_RELATIVE_ENV,
	AWS_CONTAINER_FULL_ENV,
	AWS_WEB_IDENTITY_ENV,
];

const ANTHROPIC_ENV_VARS: readonly string[] = [
	ANTHROPIC_AUTH_TOKEN_ENV,
	ANTHROPIC_OAUTH_TOKEN_ENV,
	ANTHROPIC_API_KEY_ENV,
];

const dynamicImport: DynamicImport = (specifier) => import(specifier);

// Escape
const FS_MODULE = "node:" + "fs";

const OS_MODULE = "node:" + "os";

const PATH_MODULE = "node:" + "path";

let existsSync: typeof import("node:fs").existsSync | null = null;

let homedir: typeof import("node:os").homedir | null = null;

let joinPath: typeof import("node:path").join | null = null;

function isNodeRuntime(): boolean {
	if (typeof process === "undefined") return false;

	return Boolean(process.versions?.node || process.versions?.bun);
}

if (isNodeRuntime()) {
	dynamicImport(FS_MODULE)
		.then((mod) => {
			existsSync = (mod as typeof import("node:fs")).existsSync;
		})
		.catch(() => {});
	dynamicImport(OS_MODULE)
		.then((mod) => {
			homedir = (mod as typeof import("node:os")).homedir;
		})
		.catch(() => {});
	dynamicImport(PATH_MODULE)
		.then((mod) => {
			joinPath = (mod as typeof import("node:path")).join;
		})
		.catch(() => {});
}

function pickApiKeyEnv(provider: string, envKeys?: readonly string[]): string | undefined {
	if (!envKeys || envKeys.length === 0) return undefined;

	if (provider === "anthropic") {
		return envKeys.find((key) => key !== ANTHROPIC_AUTH_TOKEN_ENV);
	}

	return envKeys[0];
}

function hasVertexAdcCredentials(env?: ProviderEnv): boolean {
	if (env && Object.hasOwn(env, "GOOGLE_APPLICATION_CREDENTIALS")) {
		const explicitPath = env.GOOGLE_APPLICATION_CREDENTIALS;
		return explicitPath.length > 0 && existsSync ? existsSync(explicitPath) : false;
	}

	if (!existsSync || !homedir || !joinPath) return false;

	return existsSync(joinPath(homedir(), ...ADC_PARTS));
}

function hasVertexConfig(env?: ProviderEnv): boolean {
	const hasCredentials = hasVertexAdcCredentials(env);

	const hasProject = GOOGLE_PROJECT_ENV_VARS.some((name) =>
		Boolean(getProviderEnvValue(name, env)),
	);

	const hasLocation = Boolean(getProviderEnvValue(GOOGLE_LOCATION_ENV, env));

	return hasCredentials && hasProject && hasLocation;
}

function hasAwsConfig(env?: ProviderEnv): boolean {
	const hasKeys =
		getProviderEnvValue(AWS_ACCESS_KEY_ENV, env) && getProviderEnvValue(AWS_SECRET_KEY_ENV, env);

	if (hasKeys) return true;

	return AWS_SINGLE_KEY_ENV_VARS.some((name) => Boolean(getProviderEnvValue(name, env)));
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
