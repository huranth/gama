import type { ModelsRefreshResult } from "@huranth/gama-ai";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";

type ModelCatalogRuntime = Pick<ModelRuntime, "refresh">;

interface ActiveModelCatalogRefresh {
	controller: AbortController;
	promise: Promise<ModelsRefreshResult>;
	waiters: number;
}

export function refreshModelCatalogs(
	modelRuntime: ModelCatalogRuntime,
	signal: AbortSignal,
): Promise<ModelsRefreshResult> {
	return modelCatalogRefreshCoordinator.refresh(modelRuntime, signal);
}

class ModelCatalogRefreshCoordinator {
	private readonly activeByRuntime = new WeakMap<ModelCatalogRuntime, ActiveModelCatalogRefresh>();

	refresh(modelRuntime: ModelCatalogRuntime, signal: AbortSignal): Promise<ModelsRefreshResult> {
		signal.throwIfAborted();
		let active = this.activeByRuntime.get(modelRuntime);

		if (!active) {
			const controller = new AbortController();
			const operation = modelRuntime.refresh({ signal: controller.signal });
			const promise = raceWithAbortSignal(operation, controller.signal).finally(() => {
				const current = this.activeByRuntime.get(modelRuntime);
				if (current?.controller === controller) {
					this.activeByRuntime.delete(modelRuntime);
				}
			});

			active = { controller, promise, waiters: 0 };
			this.activeByRuntime.set(modelRuntime, active);
		}

		active.waiters++;

		return raceWithAbortSignal(active.promise, signal).finally(() => {
			active.waiters--;
			if (active.waiters === 0 && this.activeByRuntime.get(modelRuntime) === active) {
				active.controller.abort();
			}
		});
	}
}

const modelCatalogRefreshCoordinator = new ModelCatalogRefreshCoordinator();
