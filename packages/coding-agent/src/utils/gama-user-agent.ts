export function getGamaUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `gama/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
