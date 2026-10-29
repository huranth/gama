export const FACET_BUNDLE_FORMAT = "chord.facet-bundle";

export const FACET_BUNDLE_FORMAT_VERSION = 2;

export const FACET_BUNDLE_MANIFEST_FILE = "chord-facets.json";

export const FACET_BUNDLE_ARTIFACT_FORMAT = "chord.facet-bundle-artifact";

export const FACET_BUNDLE_ARTIFACT_FORMAT_VERSION = 2;

const RESERVED_ENTRY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function isReservedEntryName(name: string): boolean {
	return RESERVED_ENTRY_NAMES.has(name);
}

export interface FacetBundleEntry {
	readonly file: string;
	readonly integrity: string;
	readonly externalImports: readonly string[];
	readonly sourceMap?: string;
}

export interface FacetBundleManifest {
	readonly format: typeof FACET_BUNDLE_FORMAT;
	readonly formatVersion: typeof FACET_BUNDLE_FORMAT_VERSION;
	readonly plugin: FacetBundlePlugin;
	readonly entries: Readonly<Record<string, FacetBundleEntry>>;
}

export interface FacetBundlePlugin {
	readonly id: string;
	readonly version?: string;
}

export interface FacetBundleArtifact {
	readonly format: typeof FACET_BUNDLE_ARTIFACT_FORMAT;
	readonly formatVersion: typeof FACET_BUNDLE_ARTIFACT_FORMAT_VERSION;
	readonly plugin: FacetBundlePlugin;
	readonly entryName: string;
	readonly entry: FacetBundleEntry;
	readonly source: string;
	readonly sourceMapContents?: string;
}
