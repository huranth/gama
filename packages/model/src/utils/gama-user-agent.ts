import type * as NodeOs from "node:os";

type ProcessWithOsBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:os") => typeof NodeOs;
};

function loadNodeOs(): typeof NodeOs | null {
	if (typeof process === "undefined") return null;

	const isNodeLike = process.versions?.node || process.versions?.bun;
	if (!isNodeLike) return null;

	const nodeProcess = process as ProcessWithOsBuiltinModule;
	const osModule = nodeProcess.getBuiltinModule?.("node:os");
	return osModule ?? null;
}

const nodeOs = loadNodeOs();

export function getGamaUserAgent(): string {
	return nodeOs
		? `gama (${nodeOs.platform()} ${nodeOs.release()}; ${nodeOs.arch()})`
		: "gama (browser)";
}
