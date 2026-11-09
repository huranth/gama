import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("Provider removal", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("clears the selected model and its persisted default", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		const model = harness.getModel("faux-2")!;

		await harness.session.setModel(model, { persist: true });
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.settingsManager.getDefaultModel()).toBe("faux-2");

		harness.session.clearModel();

		expect(harness.session.model).toBeUndefined();
		expect(harness.settingsManager.getDefaultModel()).toBeUndefined();
		expect(harness.settingsManager.getDefaultProvider()).toBeUndefined();
	});
});
