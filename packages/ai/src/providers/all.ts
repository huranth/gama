import type { CreateModelsOptions } from "../models.ts";
import { createModels, type MutableModels, type Provider } from "../models.ts";
import type {
	AnyModel,
	Api,
	ClassifierApi,
	ClassifierModel,
	ImageApi,
	ImageModel,
	Model,
} from "../types.ts";

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

export function getBuiltinModelDataGeneratedAt(): undefined {
	return undefined;
}

export function getBuiltinModels(_provider: string): Model<Api>[] {
	return [];
}

export function getBuiltinModel(_provider: string, _modelId: string): Model<Api> | undefined {
	return undefined;
}

export function getBuiltinImageModels(_provider: string): ImageModel<ImageApi>[] {
	return [];
}

export function getBuiltinImageModel(
	_provider: string,
	_modelId: string,
): ImageModel<ImageApi> | undefined {
	return undefined;
}

export function getBuiltinClassifierModels(_provider: string): ClassifierModel<ClassifierApi>[] {
	return [];
}

export function getBuiltinClassifierModel(
	_provider: string,
	_modelId: string,
): ClassifierModel<ClassifierApi> | undefined {
	return undefined;
}

export function getAllBuiltinModels(_provider: string): AnyModel[] {
	return [];
}
