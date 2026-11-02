import type { CreateModelsOptions } from "../registry.ts";
import { createModels, type MutableModels, type Provider } from "../registry.ts";
import type { Api, Model } from "../types.ts";

export type BuiltinProvider = string;

export function builtinProviders(): Provider[] {
	return [];
}

export function builtinModels(options?: CreateModelsOptions): MutableModels {
	return createModels(options);
}

export function getBuiltinProviders(): BuiltinProvider[] {
	return [];
}

export function getBuiltinModels(_provider: string): Model<Api>[] {
	return [];
}

export function getBuiltinModel(_provider: string, _modelId: string): Model<Api> | undefined {
	return undefined;
}
