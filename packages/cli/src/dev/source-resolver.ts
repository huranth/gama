import { existsSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface TsConfig {
	readonly compilerOptions?: {
		readonly paths?: Readonly<Record<string, readonly string[]>>;
	};
}

interface SourceAlias {
	readonly pattern: string;
	readonly prefix: string;
	readonly suffix: string;
	readonly replacements: readonly string[];
}

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));

const tsconfigPath = resolve(repositoryRoot, "tsconfig.json");

const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as TsConfig;

const paths = tsconfig.compilerOptions?.paths;
if (!paths) throw new Error(`Missing tsconfig paths: ${tsconfigPath}`);

// Extensions
const SOURCE_EXT: Readonly<Record<string, string>> = {
	".js": ".ts",
	".mjs": ".mts",
	".cjs": ".cts",
};

const PLAIN_EXT: ReadonlySet<string> = new Set([".ts", ".mts", ".cts", ".json"]);

const aliases: SourceAlias[] = Object.entries(paths)
	.filter(([pattern]) => pattern.startsWith("@huranth/"))
	.map(([pattern, replacements]) => {
		const wildcard = pattern.indexOf("*");
		if (wildcard !== -1 && pattern.indexOf("*", wildcard + 1) !== -1) {
			throw new Error(`Multiple wildcards: ${pattern}`);
		}
		return {
			pattern,
			prefix: wildcard === -1 ? pattern : pattern.slice(0, wildcard),
			suffix: wildcard === -1 ? "" : pattern.slice(wildcard + 1),
			replacements,
		};
	})
	.sort((left, right) => right.pattern.length - left.pattern.length);

function matchAlias(alias: SourceAlias, specifier: string): string | undefined {
	if (!alias.pattern.includes("*")) return specifier === alias.pattern ? "" : undefined;
	if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) return undefined;
	return specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
}

function candidatesFor(basePath: string): string[] {
	const extension = extname(basePath);
	const sourceExtension = SOURCE_EXT[extension];

	if (sourceExtension) {
		return [basePath, `${basePath.slice(0, -extension.length)}${sourceExtension}`];
	}

	if (PLAIN_EXT.has(extension)) return [basePath];

	return [basePath, `${basePath}.ts`, resolve(basePath, "index.ts")];
}

function resolveSourcePath(replacement: string): string | undefined {
	const basePath = resolve(repositoryRoot, replacement);
	const rootPrefix = repositoryRoot.endsWith(sep) ? repositoryRoot : `${repositoryRoot}${sep}`;

	if (!basePath.startsWith(rootPrefix)) return undefined;

	for (const candidate of candidatesFor(basePath)) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}

	return undefined;
}

function resolveAlias(specifier: string): string | undefined {
	let matchedPattern: string | undefined;

	for (const alias of aliases) {
		const wildcard = matchAlias(alias, specifier);
		if (wildcard === undefined) continue;

		matchedPattern ??= alias.pattern;

		for (const replacement of alias.replacements) {
			const resolved = resolveSourcePath(replacement.replace("*", wildcard));
			if (resolved) return resolved;
		}
	}

	if (matchedPattern) {
		throw new Error(
			`Source runtime could not resolve ${specifier} through tsconfig path ${matchedPattern}`,
		);
	}

	return undefined;
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		const resolved = resolveAlias(specifier);
		if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };

		return nextResolve(specifier, context);
	},
});
