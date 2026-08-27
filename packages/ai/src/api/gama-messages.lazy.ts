import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const gamaMessagesApi = (): ProviderStreams => lazyApi(loadGamaMessages);

function loadGamaMessages() {
	return import("./gama-messages.ts");
}
