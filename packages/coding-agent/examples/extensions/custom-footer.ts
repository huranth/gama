import type { AssistantMessage } from "@huranth/gama-ai";
import type { ExtensionAPI } from "@huranth/gama-harness";
import { truncateToWidth, visibleWidth } from "@huranth/gama-tui";

export default function (gama: ExtensionAPI) {
	let enabled = false;

	gama.registerCommand("footer", {
		description: "Toggle custom footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;

			if (enabled) {
				ctx.ui.setFooter((tui, theme, footerData) => {
					const unsub = footerData.onBranchChange(() => tui.requestRender());

					return {
						dispose: unsub,
						invalidate() {},
						render(width: number): string[] {
							let input = 0,
								output = 0,
								cost = 0;
							for (const e of ctx.sessionManager.getBranch()) {
								if (e.type === "message" && e.message.role === "assistant") {
									const m = e.message as AssistantMessage;
									input += m.usage.input;
									output += m.usage.output;
									cost += m.usage.cost.total;
								}
							}

							const branch = footerData.getGitBranch();
							const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

							const left = theme.fg(
								"dim",
								`↑${fmt(input)} ↓${fmt(output)} $${cost.toFixed(3)}`,
							);
							const branchStr = branch ? ` (${branch})` : "";
							const right = theme.fg("dim", `${ctx.model?.id || "no-model"}${branchStr}`);

							const pad = " ".repeat(
								Math.max(1, width - visibleWidth(left) - visibleWidth(right)),
							);
							return [truncateToWidth(left + pad + right, width)];
						},
					};
				});
				ctx.ui.notify("Custom footer enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});
}
