import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import type { Facet, FacetLoader, LoadedFacets } from "../types.ts";
import {
	FACET_BUNDLE_ARTIFACT_FORMAT,
	FACET_BUNDLE_ARTIFACT_FORMAT_VERSION,
	FACET_BUNDLE_FORMAT,
	FACET_BUNDLE_FORMAT_VERSION,
	FACET_BUNDLE_MANIFEST_FILE,
	isReservedEntryName,
	type FacetBundleArtifact,
	type FacetBundleEntry,
	type FacetBundleManifest,
} from "./manifest.ts";
import { isRecord } from "./value.ts";

export type FacetBundleExternalResolver = (specifier: string) => string | URL | undefined;

export interface FacetBundleLoaderOptions {
	readonly manifestPath: string | URL;
	readonly entry: string;
	readonly verifyIntegrity?: boolean;
	readonly resolveExternal?: FacetBundleExternalResolver;
}

export interface FacetBundleArtifactLoaderOptions {
	readonly artifact: unknown;
	readonly resolveExternal?: FacetBundleExternalResolver;
	readonly temporaryDirectory?: string;
}

interface CommonJsModule {
	exports: unknown;
}

export async function readFacetBundleManifest(path: string | URL): Promise<FacetBundleManifest> {
	const manifestPath = toFilePath(path);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(manifestPath, "utf8"));
	} catch (error) {
		throw new Error(`Unreadable manifest: ${manifestPath}`, { cause: error });
	}
	return validateManifest(parsed, manifestPath);
}

export async function readFacetBundleArtifact(options: {
	readonly manifestPath: string | URL;
	readonly entry: string;
}): Promise<FacetBundleArtifact> {
	assertEntryName(options.entry);
	const manifestPath = toFilePath(options.manifestPath);
	const manifest = await readFacetBundleManifest(manifestPath);
	const entry = manifest.entries[options.entry];
	if (entry === undefined)
		throw new Error(`Missing entry: ${options.entry}`);
	const modulePath = await readBundleFile(manifestPath, entry.file, "entry");
	const source = await readFile(modulePath, "utf8");
	verifySource(source, entry);
	const sourceMapContents =
		entry.sourceMap === undefined
			? undefined
			: await readFile(
					await readBundleFile(manifestPath, entry.sourceMap, "source map"),
					"utf8",
				);
	return Object.freeze({
		format: FACET_BUNDLE_ARTIFACT_FORMAT,
		formatVersion: FACET_BUNDLE_ARTIFACT_FORMAT_VERSION,
		plugin: manifest.plugin,
		entryName: options.entry,
		entry,
		source,
		...(sourceMapContents === undefined ? {} : { sourceMapContents }),
	});
}

export function createFacetBundleArtifactLoader(
	options: FacetBundleArtifactLoaderOptions,
): FacetLoader {
	const artifact = validateArtifact(options.artifact);
	const temporaryParent = resolve(options.temporaryDirectory ?? tmpdir());
	return {
		async load(): Promise<LoadedFacets> {
			await mkdir(temporaryParent, { recursive: true });
			const directory = await mkdtemp(join(temporaryParent, "chord-facet-"));
			try {
				await materializeArtifact(directory, artifact);
				const loaded = await createFacetBundleLoader({
					manifestPath: join(directory, FACET_BUNDLE_MANIFEST_FILE),
					entry: artifact.entryName,
					resolveExternal: options.resolveExternal,
				}).load();
				let disposed = false;
				return {
					get facets() {
						return loaded.facets;
					},
					async dispose() {
						if (disposed) return;
						disposed = true;
						const errors: unknown[] = [];
						try {
							await loaded.dispose();
						} catch (error) {
							errors.push(error);
						}
						try {
							await rm(directory, { force: true, recursive: true });
						} catch (error) {
							errors.push(error);
						}
						if (errors.length === 1) throw errors[0];
						if (errors.length > 1)
							throw new AggregateError(errors, "Failed to dispose facet bundle artifact");
					},
				};
			} catch (error) {
				try {
					await rm(directory, { force: true, recursive: true });
				} catch (cleanupError) {
					throw new AggregateError(
						[error, cleanupError],
						"Facet bundle artifact loading and cleanup failed",
					);
				}
				throw error;
			}
		},
	};
}

export function createFacetBundleLoader(options: FacetBundleLoaderOptions): FacetLoader {
	assertEntryName(options.entry);
	const manifestPath = toFilePath(options.manifestPath);
	return {
		async load(): Promise<LoadedFacets> {
			const manifest = await readFacetBundleManifest(manifestPath);
			const entry = manifest.entries[options.entry];
			if (entry === undefined) {
				throw new Error(
					`Missing entry: ${options.entry}`,
				);
			}
			const modulePath = await readBundleFile(manifestPath, entry.file, "entry");
			try {
				const source = await readFile(modulePath, "utf8");
				if (options.verifyIntegrity !== false) verifySource(source, entry);
				const exported = executeCommonJsModule(
					source,
					modulePath,
					entry.externalImports,
					options.resolveExternal,
				);
				let facets = facetsFromModule(exported, manifest.plugin.id, options.entry);
				let disposed = false;
				return {
					get facets() {
						return facets;
					},
					async dispose() {
						if (disposed) return;
						disposed = true;
						facets = Object.freeze([]);
					},
				};
			} catch (error) {
				throw new Error(
					`Bundle failed: ${options.entry}`,
					{
						cause: error,
					},
				);
			}
		},
	};
}

function executeCommonJsModule(
	source: string,
	modulePath: string,
	externalImports: readonly string[],
	resolver?: FacetBundleExternalResolver,
): unknown {
	const requireFromModule = createRequire(modulePath);
	const externalTargets = new Map<string, string>();
	for (const specifier of externalImports) {
		if (!isBuiltin(specifier)) validatePackageSpecifier(specifier);
		externalTargets.set(
			specifier,
			toRequireSpecifier(resolveExternalTarget(specifier, resolver)),
		);
	}
	const targetFor = (specifier: string): string => {
		const target = externalTargets.get(specifier);
		if (target === undefined)
			throw new Error(`Undeclared import: ${specifier}`);
		return target;
	};
	const requireExternal = Object.assign(
		(specifier: string): unknown => requireFromModule(targetFor(specifier)),
		{
			resolve: (specifier: string): string => requireFromModule.resolve(targetFor(specifier)),
		},
	);
	const commonJsModule: CommonJsModule = { exports: Object.create(null) };
	const compiled = compileFunction(
		source,
		["exports", "require", "module", "__filename", "__dirname"],
		{
			filename: modulePath,
		},
	);
	Reflect.apply(compiled, commonJsModule.exports, [
		commonJsModule.exports,
		requireExternal,
		commonJsModule,
		modulePath,
		dirname(modulePath),
	]);
	return commonJsModule.exports;
}

function toRequireSpecifier(target: string): string {
	if (isAbsolute(target) || isBuiltin(target)) return target;
	let url: URL;
	try {
		url = new URL(target);
	} catch {
		return target;
	}
	if (url.protocol === "file:") return fileURLToPath(url);
	if (url.protocol === "node:") return url.href;
	throw new Error(
		`Invalid target: ${target}`,
	);
}

function toFilePath(path: string | URL): string {
	if (typeof path === "string") return resolve(path);
	if (path.protocol !== "file:")
		throw new TypeError(`Facet bundle manifest must be a file URL, not ${path.protocol}`);
	return fileURLToPath(path);
}

function assertEntryName(name: string): void {
	if (name.length === 0) throw new TypeError("Facet bundle entry name must not be empty");
	if (isReservedEntryName(name)) {
		throw new TypeError(`Facet bundle entry name ${name} is reserved`);
	}
}

function resolveBundleFile(manifestPath: string, file: string, label: string): string {
	if (
		file.length === 0 ||
		isAbsolute(file) ||
		basename(file) !== file ||
		file === "." ||
		file === ".."
	) {
		throw new Error(`Invalid filename: ${label}`);
	}
	return resolve(dirname(manifestPath), file);
}

async function readBundleFile(
	manifestPath: string,
	file: string,
	label: string,
): Promise<string> {
	const candidate = resolveBundleFile(manifestPath, file, label);
	const root = await realpath(dirname(manifestPath));
	let resolved: string;
	try {
		resolved = await realpath(candidate);
	} catch (error) {
		throw new Error(`Unreadable bundle: ${label}`, { cause: error });
	}
	const inside = relative(root, resolved);
	if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
		throw new Error(`Invalid path: ${label}`);
	}
	return resolved;
}

function verifySource(source: string, entry: FacetBundleEntry): void {
	const expected = parseIntegrity(entry.integrity);
	const actual = createHash("sha256").update(source, "utf8").digest("base64");
	if (actual !== expected)
		throw new Error(`Integrity failed: ${entry.file}`);
}

function parseIntegrity(integrity: string): string {
	const prefix = "sha256-";
	if (!integrity.startsWith(prefix) || integrity.length === prefix.length) {
		throw new Error("Invalid integrity");
	}
	return integrity.slice(prefix.length);
}

function facetsFromModule(
	imported: unknown,
	_pluginId: string,
	entryName: string,
): readonly Facet[] {
	if (!isRecord(imported))
		throw new Error(`Missing module: ${entryName}`);
	const exported = imported.default;
	const candidates: readonly unknown[] = Array.isArray(exported)
		? (exported as readonly unknown[])
		: [exported];
	if (candidates.length === 0) {
		throw new Error(`Missing facets: ${entryName}`);
	}
	const facets: Facet[] = [];
	for (const candidate of candidates) {
		if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.length === 0) {
			throw new Error(
				"Invalid facet ID",
			);
		}
		if (typeof candidate.setup !== "function") {
			throw new Error(
				`Missing setup: ${candidate.id}`,
			);
		}
		facets.push(candidate as unknown as Facet);
	}
	const ids = facets.map(({ id }) => id);
	if (new Set(ids).size !== ids.length) {
		throw new Error("Duplicate facet ID");
	}
	return Object.freeze(facets);
}

function validateArtifact(value: unknown): FacetBundleArtifact {
	if (
		!isRecord(value) ||
		value.format !== FACET_BUNDLE_ARTIFACT_FORMAT ||
		value.formatVersion !== FACET_BUNDLE_ARTIFACT_FORMAT_VERSION ||
		typeof value.entryName !== "string" ||
		value.entryName.length === 0 ||
		typeof value.source !== "string"
	) {
		throw new Error("Invalid artifact");
	}
	const manifest = validateManifest(
		{
			format: FACET_BUNDLE_FORMAT,
			formatVersion: FACET_BUNDLE_FORMAT_VERSION,
			plugin: value.plugin,
			entries: { [value.entryName]: value.entry },
		},
		"facet bundle artifact",
	);
	const entry = manifest.entries[value.entryName]!;
	if (entry.sourceMap === undefined) {
		if (value.sourceMapContents !== undefined) {
			throw new Error("Missing source map");
		}
	} else if (typeof value.sourceMapContents !== "string") {
		throw new Error("Missing source map");
	}
	verifySource(value.source, entry);
	return Object.freeze({
		format: FACET_BUNDLE_ARTIFACT_FORMAT,
		formatVersion: FACET_BUNDLE_ARTIFACT_FORMAT_VERSION,
		plugin: manifest.plugin,
		entryName: value.entryName,
		entry,
		source: value.source,
		...(value.sourceMapContents === undefined
			? {}
			: { sourceMapContents: value.sourceMapContents }),
	});
}

async function materializeArtifact(
	directory: string,
	artifact: FacetBundleArtifact,
): Promise<void> {
	const manifest: FacetBundleManifest = {
		format: FACET_BUNDLE_FORMAT,
		formatVersion: FACET_BUNDLE_FORMAT_VERSION,
		plugin: artifact.plugin,
		entries: { [artifact.entryName]: artifact.entry },
	};
	await Promise.all([
		writeFile(join(directory, artifact.entry.file), artifact.source, "utf8"),
		writeFile(
			join(directory, FACET_BUNDLE_MANIFEST_FILE),
			`${JSON.stringify(manifest, null, 2)}\n`,
			"utf8",
		),
		...(artifact.entry.sourceMap === undefined
			? []
			: [
					writeFile(
						join(directory, artifact.entry.sourceMap),
						artifact.sourceMapContents!,
						"utf8",
					),
				]),
	]);
}

function resolveExternalTarget(specifier: string, resolver?: FacetBundleExternalResolver): string {
	const resolved = resolver?.(specifier);
	if (resolved !== undefined) return typeof resolved === "string" ? resolved : resolved.href;
	const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
	if (specifier === "@huranth/gama-bus")
		return new URL(`../index.${extension}`, import.meta.url).href;
	if (specifier === "@huranth/gama-bus/context") {
		return new URL(`../scope/index.${extension}`, import.meta.url).href;
	}
	if (specifier === "@huranth/gama-bus/node")
		return new URL(`../host.${extension}`, import.meta.url).href;
	return import.meta.resolve(specifier);
}

function validatePackageSpecifier(specifier: string): void {
	const segments = specifier.split("/");
	const packageParts = specifier.startsWith("@") ? 2 : 1;
	if (
		specifier.startsWith(".") ||
		specifier.startsWith("/") ||
		specifier.startsWith("#") ||
		specifier.includes(":") ||
		specifier.includes("\\") ||
		segments.length < packageParts ||
		segments.some((part) => part.length === 0 || part === "." || part === "..")
	) {
		throw new Error(`Unsupported import: ${specifier}`);
	}
}

function validateManifest(value: unknown, path: string): FacetBundleManifest {
	if (!isRecord(value) || value.format !== FACET_BUNDLE_FORMAT) {
		throw new Error(`Invalid manifest: ${path}`);
	}
	if (value.formatVersion !== FACET_BUNDLE_FORMAT_VERSION) {
		throw new Error(
			`Manifest version: ${String(value.formatVersion)}`,
		);
	}
	if (
		!isRecord(value.plugin) ||
		typeof value.plugin.id !== "string" ||
		value.plugin.id.length === 0
	) {
		throw new Error(`Invalid plugin: ${path}`);
	}
	if (
		value.plugin.version !== undefined &&
		(typeof value.plugin.version !== "string" || value.plugin.version.length === 0)
	) {
		throw new Error(`Invalid version: ${path}`);
	}
	if (!isRecord(value.entries) || Object.keys(value.entries).length === 0) {
		throw new Error(`Missing entries: ${path}`);
	}
	const entries: Record<string, FacetBundleEntry> = Object.create(null);
	for (const [name, candidate] of Object.entries(value.entries)) {
		if (name.length === 0 || isReservedEntryName(name) || !isRecord(candidate)) {
			throw new Error(`Invalid entry: ${path}`);
		}
		if (typeof candidate.file !== "string")
			throw new Error(`Missing file: ${name}`);
		resolveBundleFile(path, candidate.file, `entry ${name}`);
		if (typeof candidate.integrity !== "string")
			throw new Error(`Missing integrity: ${name}`);
		parseIntegrity(candidate.integrity);
		if (
			!Array.isArray(candidate.externalImports) ||
			candidate.externalImports.some((item) => typeof item !== "string")
		) {
			throw new Error(`Invalid imports: ${name}`);
		}
		const externalImports = Object.freeze([...(candidate.externalImports as readonly string[])]);
		if (new Set(externalImports).size !== externalImports.length) {
			throw new Error(`Duplicate imports: ${name}`);
		}
		if (candidate.sourceMap !== undefined) {
			if (typeof candidate.sourceMap !== "string")
				throw new Error(`Invalid map: ${name}`);
			resolveBundleFile(path, candidate.sourceMap, `entry ${name} source map`);
		}
		entries[name] = Object.freeze({
			file: candidate.file,
			integrity: candidate.integrity,
			externalImports,
			...(candidate.sourceMap === undefined ? {} : { sourceMap: candidate.sourceMap }),
		});
	}
	return Object.freeze({
		format: FACET_BUNDLE_FORMAT,
		formatVersion: FACET_BUNDLE_FORMAT_VERSION,
		plugin: Object.freeze({
			id: value.plugin.id,
			...(value.plugin.version === undefined ? {} : { version: value.plugin.version }),
		}),
		entries: Object.freeze(entries),
	});
}
