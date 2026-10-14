import type { Api, Model } from "@huranth/gama-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/tui/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

const findExactModelMatch = Reflect.get(InteractiveMode.prototype, "findExactModelMatch") as (
	this: object,
	searchTerm: string,
) => Promise<Model<Api> | undefined>;

describe("issue #7443 /model cached match", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	it("refreshes catalogs on every lookup, even when the model is cached", async () => {
		harness = await createHarness({ models: [{ id: "cached", name: "Cached" }] });
		const refresh = vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map(),
		});
		const context = {
			session: harness.session,
			fetchModelCatalogsWithLoader: vi.fn(async () => {
				await refresh({ signal: new AbortController().signal });
			}),
			showWarning: vi.fn(),
		};

		const model = await findExactModelMatch.call(context, harness.models[0].id);

		expect(model?.id).toBe("cached");
		expect(context.fetchModelCatalogsWithLoader).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("uses a caller-owned deadline and still returns undefined on a cache miss", async () => {
		harness = await createHarness({ models: [{ id: "cached", name: "Cached" }] });
		const refresh = vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: true,
			errors: new Map(),
		});
		const context = {
			session: harness.session,
			fetchModelCatalogsWithLoader: vi.fn(async () => {
				await refresh({ signal: new AbortController().signal });
			}),
			showWarning: vi.fn(),
		};

		await expect(findExactModelMatch.call(context, "not-cached")).resolves.toBeUndefined();

		expect(context.fetchModelCatalogsWithLoader).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledOnce();
	});
});
