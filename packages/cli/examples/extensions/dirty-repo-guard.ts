import type { ExtensionAPI, ExtensionContext } from "@huranth/gama-harness";

async function checkDirtyRepo(
	gama: ExtensionAPI,
	ctx: ExtensionContext,
	action: string,
): Promise<{ cancel: boolean } | undefined> {
	const { stdout, code } = await gama.exec("git", ["status", "--porcelain"]);

	if (code !== 0) {
		return;
	}

	const hasChanges = stdout.trim().length > 0;
	if (!hasChanges) {
		return;
	}

	if (!ctx.hasUI) {
		return { cancel: true };
	}

	const changedFiles = stdout.trim().split("\n").filter(Boolean).length;

	const choice = await ctx.ui.select(
		`You have ${changedFiles} uncommitted file(s). ${action} anyway?`,
		["Yes, proceed anyway", "No, let me commit first"],
	);

	if (choice !== "Yes, proceed anyway") {
		ctx.ui.notify("Commit your changes first", "warning");
		return { cancel: true };
	}
}

export default function (gama: ExtensionAPI) {
	gama.on("session_before_switch", async (event, ctx) => {
		const action = event.reason === "new" ? "new session" : "switch session";
		return checkDirtyRepo(gama, ctx, action);
	});

	gama.on("session_before_fork", async (_event, ctx) => {
		return checkDirtyRepo(gama, ctx, "fork");
	});
}
