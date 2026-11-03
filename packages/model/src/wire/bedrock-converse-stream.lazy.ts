import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

let bedrockModuleOverride: ProviderStreams | undefined;

export function setBedrockProviderModule(module: ProviderStreams): void {
	bedrockModuleOverride = module;
}

const importNodeOnlyApi = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js")
		? specifier.replace(/\.ts$/, ".js")
		: specifier;
	return import(runtimeSpecifier);
};

export const bedrockConverseStreamApi = (): ProviderStreams =>
	lazyApi(
		async () =>
			bedrockModuleOverride ??
			((await importNodeOnlyApi("./bedrock-converse-stream.ts")) as ProviderStreams),
	);
