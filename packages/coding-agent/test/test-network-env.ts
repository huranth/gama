import { vi } from "vitest";

export function allowNetwork(): void {
	vi.stubEnv("GAMA_OFFLINE", undefined);
}
