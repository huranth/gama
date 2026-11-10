import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type BundleFacetsResult, bundleFacets } from "./bundle.ts";
import { isReservedEntryName } from "./manifest.ts";
import { isMissingPath, isRecord } from "./value.ts";

export interface BundleFacetPackageOptions {
	readonly packagePath: string;
	readonly outdir: string;
	readonly defaultFacets?: Readonly<Record<string, string>>;
}

export interface BundleFacetPackageResult extends BundleFacetsResult {
	readonly packageDirectory: string;
	readonly packageJsonPath: string;
}

interface FacetPackageMetadata {
	readonly packageDirectory: string;
	readonly packageJsonPath: string;
	readonly name: string;
	readonly version: string;
	readonly peerDependencies: readonly string[];
	readonly configuredFacets: Readonly<Record<string, string | false>>;
	readonly external: readonly string[];
	readonly sourceMap: boolean;
}

export async function bundleFacetPackage(
	options: BundleFacetPackageOptions,
): Promise<BundleFacetPackageResult> {
	const metadata = await readFacetPackageMetadata(options.packagePath);
	const entries = await resolveFacetEntries(metadata, options.defaultFacets ?? {});
	const peerExternal = metadata.peerDependencies;
	const extraExternal = metadata.external;
	const external = [...peerExternal, ...extraExternal].flatMap((specifier) => [
		specifier,
		`${specifier}/*`,
	]);

	const result = await bundleFacets({
		plugin: { id: metadata.name, version: metadata.version },
		entries,
		outdir: options.outdir,
		workingDirectory: metadata.packageDirectory,
		external,
		sourceMap: metadata.sourceMap,
	});

	return Object.freeze({
		...result,
		packageDirectory: metadata.packageDirectory,
		packageJsonPath: metadata.packageJsonPath,
	});
}

function validateFacetMapping(name: string, source: string, _kind: string): void {
	if (name.length === 0) throw new Error("Empty entry name");
	if (isReservedEntryName(name)) throw new Error(`Reserved entry: ${name}`);
	if (source.length === 0) throw new Error(`Missing source: ${name}`);
}

function validateCanonicalPackageEntry(packageDirectory: string, path: string, name: string): void {
	const relativePath = relative(packageDirectory, path);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error(`Outside package: ${name}`);
	}
}

function parsePeerDependencies(value: unknown, packageJsonPath: string): readonly string[] {
	if (value === undefined) return [];
	if (
		!isRecord(value) ||
		Object.entries(value).some(
			([name, version]) => name.length === 0 || typeof version !== "string",
		)
	) {
		throw new Error(`Invalid peerDependencies: ${packageJsonPath}`);
	}
	return Object.freeze(Object.keys(value).sort());
}

function resolvePackageEntry(packageDirectory: string, source: string, name: string): string {
	if (isAbsolute(source)) throw new Error(`Absolute entry: ${name}`);
	const path = resolve(packageDirectory, source);
	const relativePath = relative(packageDirectory, path);
	if (
		relativePath.length === 0 ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		throw new Error(`Escaping entry: ${name}`);
	}
	return path;
}

async function resolveFacetEntries(
	metadata: FacetPackageMetadata,
	defaultFacets: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, string>>> {
	const entries: Record<string, string> = Object.create(null);
	for (const [name, source] of Object.entries(defaultFacets)) {
		validateFacetMapping(name, source, "default");
		const path = resolvePackageEntry(metadata.packageDirectory, source, name);
		try {
			const entryStats = await stat(path);
			if (!entryStats.isFile()) throw new Error(`Invalid entry: ${name}`);
			const canonicalPath = await realpath(path);
			validateCanonicalPackageEntry(metadata.packageDirectory, canonicalPath, name);
			entries[name] = canonicalPath;
		} catch (error) {
			if (isMissingPath(error)) continue;
			throw error;
		}
	}

	for (const [name, source] of Object.entries(metadata.configuredFacets)) {
		if (source === false) {
			delete entries[name];
			continue;
		}
		validateFacetMapping(name, source, "configured");
		const path = resolvePackageEntry(metadata.packageDirectory, source, name);
		let entryStats: Awaited<ReturnType<typeof stat>>;
		try {
			entryStats = await stat(path);
		} catch (error) {
			throw new Error(`Unreadable entry: ${name}`, {
				cause: error,
			});
		}
		if (!entryStats.isFile()) throw new Error(`Invalid entry: ${name}`);
		const canonicalPath = await realpath(path);
		validateCanonicalPackageEntry(metadata.packageDirectory, canonicalPath, name);
		entries[name] = canonicalPath;
	}
	if (Object.keys(entries).length === 0) {
		throw new Error(`Missing entries: ${metadata.name}`);
	}

	return Object.freeze(entries);
}

async function readFacetPackageMetadata(packagePath: string): Promise<FacetPackageMetadata> {
	if (packagePath.length === 0) throw new TypeError("Facet package path must not be empty");
	const candidate = resolve(packagePath);
	let packageDirectory: string;
	let packageJsonPath: string;
	let candidateStats: Awaited<ReturnType<typeof stat>>;
	try {
		candidateStats = await stat(candidate);
	} catch (error) {
		throw new Error(`Unreadable package: ${candidate}`, { cause: error });
	}
	if (candidateStats.isDirectory()) {
		packageDirectory = await realpath(candidate);
		packageJsonPath = join(packageDirectory, "package.json");
	} else if (candidateStats.isFile() && basename(candidate) === "package.json") {
		packageJsonPath = await realpath(candidate);
		packageDirectory = dirname(packageJsonPath);
	} else {
		throw new Error(`Invalid path: ${candidate}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
	} catch (error) {
		throw new Error(`Unreadable metadata: ${packageJsonPath}`, { cause: error });
	}
	if (!isRecord(parsed)) throw new Error(`Invalid metadata: ${packageJsonPath}`);

	if (typeof parsed.name !== "string" || parsed.name.length === 0) {
		throw new Error("Missing package name");
	}
	if (typeof parsed.version !== "string" || parsed.version.length === 0) {
		throw new Error("Missing package version");
	}
	const peerDependencies = parsePeerDependencies(parsed.peerDependencies, packageJsonPath);
	const chord = parseChordConfiguration(parsed.chord, packageJsonPath);

	return {
		packageDirectory,
		packageJsonPath,
		name: parsed.name,
		version: parsed.version,
		peerDependencies,
		configuredFacets: chord.facets,
		external: chord.external,
		sourceMap: chord.sourceMap,
	};
}

function parseChordConfiguration(
	value: unknown,
	packageJsonPath: string,
): {
	readonly facets: Readonly<Record<string, string | false>>;
	readonly external: readonly string[];
	readonly sourceMap: boolean;
} {
	if (value === undefined)
		return { facets: Object.freeze({}), external: Object.freeze([]), sourceMap: true };
	if (!isRecord(value)) throw new Error(`Invalid config: ${packageJsonPath}`);
	if (
		Object.keys(value).some(
			(key) => key !== "facets" && key !== "external" && key !== "sourceMap",
		)
	) {
		throw new Error("Unknown config field");
	}
	const facets: Record<string, string | false> = Object.create(null);
	if (value.facets !== undefined) {
		if (!isRecord(value.facets)) {
			throw new Error(`Invalid facets: ${packageJsonPath}`);
		}
		for (const [name, source] of Object.entries(value.facets)) {
			if (
				name.length === 0 ||
				isReservedEntryName(name) ||
				(typeof source !== "string" && source !== false) ||
				source === ""
			) {
				throw new Error("Invalid facet entry");
			}
			facets[name] = source;
		}
	}

	let external: readonly string[] = [];
	if (value.external !== undefined) {
		if (
			!Array.isArray(value.external) ||
			value.external.some((specifier) => typeof specifier !== "string" || specifier.length === 0)
		) {
			throw new Error(`Invalid externals: ${packageJsonPath}`);
		}
		external = Object.freeze([...new Set(value.external as readonly string[])].sort());
	}

	if (value.sourceMap !== undefined && typeof value.sourceMap !== "boolean") {
		throw new Error(`Invalid sourceMap: ${packageJsonPath}`);
	}

	return {
		facets: Object.freeze(facets),
		external,
		sourceMap: value.sourceMap ?? true,
	};
}
