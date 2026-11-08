import { type ExtensionAPI, keyHint } from "@huranth/gama-harness";
import { Box, Text } from "@huranth/gama-tui";

const ENTRY_TYPE = "debug-provider-events";
const STATUS_KEY = "debug-provider";

interface ProviderDebugEntry {
	provider: string;
	api: string;
	model: string;
	events: unknown[];
}

export default function (gama: ExtensionAPI) {
	let enabled = false;
	let activeEvents: unknown[] | undefined;
	let completedEntry: ProviderDebugEntry | undefined;

	gama.registerEntryRenderer<ProviderDebugEntry>(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return new Text(theme.fg("warning", "[provider debug] Missing event data"), 0, 0);

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const count = `${data.events.length} event${data.events.length === 1 ? "" : "s"}`;
		const expandHint = expanded ? "" : ` (${keyHint("app.tools.expand", "to view events")})`;
		const line =
			`${theme.fg("accent", "[provider debug]")} ` +
			`${data.provider}/${data.model} (${data.api}) · ${count}${expandHint}`;
		box.addChild(new Text(line, 0, 0));
		if (expanded) {
			box.addChild(new Text(JSON.stringify(data.events, null, 2), 0, 0));
		}
		return box;
	});

	gama.registerCommand("debug-provider", {
		description: "Toggle capture of raw provider stream events",
		handler: async (args, ctx) => {
			const requestedState = args.trim().toLowerCase();
			if (requestedState !== "" && requestedState !== "on" && requestedState !== "off") {
				ctx.ui.notify("Usage: /debug-provider [on|off]", "warning");
				return;
			}

			enabled = requestedState === "" ? !enabled : requestedState === "on";
			if (!enabled) {
				activeEvents = undefined;
				completedEntry = undefined;
			}
			ctx.ui.setStatus(STATUS_KEY, enabled ? "provider debug" : undefined);
			ctx.ui.notify(`Provider event capture ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});

	gama.on("turn_start", () => {
		activeEvents = enabled ? [] : undefined;
	});

	gama.on("provider_stream_event", (event) => {
		activeEvents?.push(structuredClone(event.data));
	});

	gama.on("message_end", (event) => {
		if (event.message.role !== "assistant" || !activeEvents) return;
		completedEntry = {
			provider: event.message.provider,
			api: event.message.api,
			model: event.message.model,
			events: activeEvents,
		};
		activeEvents = undefined;
	});

	gama.on("turn_end", () => {
		if (!completedEntry) return;
		gama.appendEntry<ProviderDebugEntry>(ENTRY_TYPE, completedEntry);
		completedEntry = undefined;
	});
}
