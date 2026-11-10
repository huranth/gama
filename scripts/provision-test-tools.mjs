import { ensureTool } from "../packages/cli/src/utils/tools-manager.ts";

let failed = false;

for (const tool of ["rg", "fd"]) {
	const statuses = [];
	const path = await ensureTool(tool, (status) => statuses.push(status));
	for (const status of statuses) console.warn(`${status.type}: ${status.message}`);
	if (!path) {
		console.error(`test provisioning failed: ${tool}`);
		failed = true;
	}
}

process.exitCode = failed ? 1 : 0;
