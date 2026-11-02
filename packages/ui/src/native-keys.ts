import { getNativePlatformHelper, type ModifierKey } from "./native-platform.ts";

export type { ModifierKey } from "./native-platform.ts";

// Probe modifier
export function isNativeModifierPressed(key: ModifierKey): boolean {
	const helper = getNativePlatformHelper();
	const probe = helper?.isModifierPressed;
	return probe ? pressed(probe, key) : false;
}

// Safe probe
function pressed(probe: (key: ModifierKey) => boolean, key: ModifierKey): boolean {
	try {
		return probe(key) === true;
	} catch {
		return false;
	}
}
