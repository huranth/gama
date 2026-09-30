import { getKeybindings, type Keybinding, type KeyId } from "@huranth/gama-tui";
import { theme } from "../theme/theme.ts";

export interface KeyTextFormatOptions {
	capitalize?: boolean;
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	const groups = key.split("/");

	return groups
		.map((group) => {
			const parts = group.split("+");

			return parts.map((part) => formatKeyPart(part, options)).join("+");
		})
		.join("/");
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

export function keyHint(keybinding: Keybinding, description: string): string {
	const keys = theme.fg("dim", keyText(keybinding));

	return keys + theme.fg("muted", ` ${description}`);
}

export function rawKeyHint(key: string, description: string): string {
	const keys = theme.fg("dim", formatKeyText(key));

	return keys + theme.fg("muted", ` ${description}`);
}

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";

	return formatKeyText(keys.join("/"), options);
}

function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	const isMac = process.platform === "darwin";
	const displayPart = isMac && part.toLowerCase() === "alt" ? "option" : part;
	if (!options.capitalize) return displayPart;

	return displayPart.charAt(0).toUpperCase() + displayPart.slice(1);
}
