#!/usr/bin/env node

import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const aiDistDir = join(repoRoot, "packages", "ai", "dist");
const codingAgentDistDir = join(codingAgentDir, "dist");
const bundleDir = join(codingAgentDistDir, "bundle");
const banner = {
	js:
		'import { createRequire as __piCreateRequire } from "node:module"; ' +
		"const require = __piCreateRequire(import.meta.url);",
};
const allowedExternalPackages = new Set([
	"@silvia-odwyer/photon-node",
	"jiti",
	"bufferutil",
	"utf-8-validate",
	"kerberos",
	"supports-color",
]);

const lazyJitiPlugin = {
	name: "lazy-jiti-transform",
	setup(build) {
		build.onResolve({ filter: /^jiti\/static$/ }, () => ({
			namespace: "lazy-jiti",
			path: "jiti/static",
		}));
		build.onLoad({ filter: /.*/, namespace: "lazy-jiti" }, () => ({
			contents: `
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let createJitiImpl;

export function createJiti(...args) {
	createJitiImpl ??= require("jiti").createJiti;
	return createJitiImpl(...args);
}
`,
			loader: "js",
		}));
	},
};

const httpsProxyAgentNamedExportPlugin = {
	name: "https-proxy-agent-named-export",
	setup(build) {
		build.onResolve({ filter: /^https-proxy-agent$/ }, (args) => {
			if (args.kind !== "dynamic-import") return undefined;
			return {
				namespace: "https-proxy-agent-named-export",
				path: args.path,
			};
		});
		build.onLoad(
			{
				filter: /^https-proxy-agent$/,
				namespace: "https-proxy-agent-named-export",
			},
			() => ({
				contents: 'export { HttpsProxyAgent } from "https-proxy-agent";',
				loader: "js",
				resolveDir: repoRoot,
			}),
		);
	},
};

function commonBuildOptions() {
	return {
		absWorkingDir: repoRoot,
		banner,
		bundle: true,
		define: { GAMA_BUNDLED_NODE: "true" },
		external: ["@silvia-odwyer/photon-node"],
		format: "esm",
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
		minifySyntax: true,
		minifyWhitespace: true,
		platform: "node",
		plugins: [lazyJitiPlugin, httpsProxyAgentNamedExportPlugin],
		sourcemap: false,
		target: "node22.19",
		tsconfigRaw: { compilerOptions: {} },
	};
}

function validateExternalImports(metafiles) {
	const unexpected = new Set();
	for (const metafile of metafiles) {
		for (const input of Object.values(metafile.inputs)) {
			for (const imported of input.imports) {
				const allowed = isBuiltin(imported.path) || allowedExternalPackages.has(imported.path);
				if (!imported.external || allowed) {
					continue;
				}
				unexpected.add(imported.path);
			}
		}
	}
	if (unexpected.size > 0) {
		const names = Array.from(unexpected).sort().join(", ");
		throw new Error(`Bundle left unexpected external imports: ${names}`);
	}
}

function findContainingOutput(metafile, inputSuffix) {
	const normalizedSuffix = inputSuffix.replaceAll("\\", "/");
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		const inputs = Object.keys(output.inputs).map((inputPath) => inputPath.replaceAll("\\", "/"));
		if (inputs.some((inputPath) => inputPath.endsWith(normalizedSuffix))) {
			return resolve(repoRoot, outputPath);
		}
	}
	throw new Error(`Could not locate bundled output containing ${inputSuffix}`);
}

function outputBytes(metafiles) {
	return metafiles.reduce(
		(total, metafile) => {
			const outputs = Object.values(metafile.outputs);
			return total + outputs.reduce((subtotal, output) => subtotal + output.bytes, 0);
		},
		0,
	);
}

for (const entry of [
	join(codingAgentDistDir, "cli.js"),
	join(codingAgentDistDir, "index.js"),
	join(codingAgentDistDir, "rpc-entry.js"),
	join(codingAgentDistDir, "utils", "image-resize-worker.js"),
	join(codingAgentDistDir, "ext", "codemode", "worker.js"),
	join(aiDistDir, "api", "bedrock-converse-stream.js"),
]) {
	if (!existsSync(entry)) {
		const missing = relative(repoRoot, entry);
		throw new Error(`Bundle input is missing: ${missing}. Build the workspace packages first.`);
	}
}

rmSync(bundleDir, { force: true, recursive: true });
mkdirSync(bundleDir, { recursive: true });

const mainResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: {
		"cli-runtime": join(codingAgentDistDir, "cli.js"),
		index: join(codingAgentDistDir, "index.js"),
		"rpc-entry": join(codingAgentDistDir, "rpc-entry.js"),
	},
	outdir: bundleDir,
	chunkNames: "chunks/[name]-[hash]",
	splitting: true,
});

const mainMetafile = mainResult.metafile;
const bedrockDist = "packages/ai/dist/api/bedrock-converse-stream.lazy.js";
const imageResizeDist = "packages/coding-agent/dist/utils/image-resize.js";
const configDist = "packages/coding-agent/dist/config.js";
const bedrockLoaderOutput = findContainingOutput(mainMetafile, bedrockDist);
const imageResizeOutput = findContainingOutput(mainMetafile, imageResizeDist);
const configOutput = findContainingOutput(mainMetafile, configDist);

const lazyEntryPoints = {
	"bedrock-converse-stream": join(aiDistDir, "api", "bedrock-converse-stream.js"),
	"codemode-worker": join(codingAgentDistDir, "ext", "codemode", "worker.js"),
	"image-resize-worker": join(codingAgentDistDir, "utils", "image-resize-worker.js"),
};

const lazyResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: lazyEntryPoints,
	outdir: dirname(bedrockLoaderOutput),
	splitting: false,
});

const imageResizeWorkerOutput = resolve(dirname(bedrockLoaderOutput), "image-resize-worker.js");
if (dirname(imageResizeOutput) !== dirname(imageResizeWorkerOutput)) {
	throw new Error("Image resize implementation and worker were emitted into different directories");
}
if (dirname(configOutput) !== dirname(bedrockLoaderOutput)) {
	throw new Error("config.ts and the codemode worker were emitted into different directories");
}

validateExternalImports([mainResult.metafile, lazyResult.metafile]);
const cliLauncher = `#!/usr/bin/env node
import { createRequire, enableCompileCache } from "node:module";

enableCompileCache();
createRequire(import.meta.url)("./cli-runtime.js");
`;
writeFileSync(join(bundleDir, "cli.js"), cliLauncher);
chmodSync(join(bundleDir, "cli.js"), 0o755);
chmodSync(join(bundleDir, "rpc-entry.js"), 0o755);

const mainOutputs = Object.keys(mainMetafile.outputs);
const lazyOutputs = Object.keys(lazyResult.metafile.outputs);
const outputPaths = [...mainOutputs, ...lazyOutputs];
const files = new Set(outputPaths).size + 1;
const metafiles = [mainMetafile, lazyResult.metafile];
const mib = (outputBytes(metafiles) + cliLauncher.length) / (1024 * 1024);
console.log(`Built ${relative(repoRoot, bundleDir)} (${files} files, ${mib.toFixed(1)} MiB)`);

if (process.argv.includes("--public-release")) {
	preparePublicRelease();
}

function preparePublicRelease() {
	const releaseDir = join(codingAgentDistDir, "public-release");
	if (existsSync(releaseDir)) {
		throw new Error("Public release output already exists. Rebuild before preparing it again.");
	}
	mkdirSync(join(releaseDir, "dist"), { recursive: true });
	for (const entry of readdirSync(codingAgentDistDir)) {
		if (entry.startsWith("public-")) continue;
		cpSync(join(codingAgentDistDir, entry), join(releaseDir, "dist", entry), {
			recursive: true,
			filter: (source) =>
				source.startsWith(bundleDir) ||
				source.startsWith(join(codingAgentDistDir, "core", "html")) ||
				source.startsWith(join(codingAgentDistDir, "modes", "tui", "theme")) ||
				(!source.endsWith(".js") && !source.endsWith(".map")),
		});
	}

	const workspaceDirs = ["chord", "agent", "ai", "codemode", "tui", "telemetry"];
	const workspaces = new Map();
	const packageJson = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8"));
	const dependencies = {};

	for (const directory of ["coding-agent", ...workspaceDirs]) {
		const manifestPath = join(repoRoot, "packages", directory, "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (directory !== "coding-agent") workspaces.set(manifest.name, { directory, manifest });
		for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
			if (name.startsWith("@huranth/")) continue;
			if (dependencies[name] && dependencies[name] !== version) {
				throw new Error(
					`Conflicting dependency versions for ${name}: ${dependencies[name]} and ${version}`,
				);
			}
			dependencies[name] = version;
		}
	}

	const vendorDir = join(releaseDir, "dist", "vendor");
	for (const { directory } of workspaces.values()) {
		cpSync(join(repoRoot, "packages", directory, "dist"), join(vendorDir, directory), {
			recursive: true,
			filter: (source) => !source.endsWith(".js") && !source.endsWith(".map"),
		});
	}

	function rewriteDeclarations(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const file = join(directory, entry.name);
			if (entry.isDirectory()) {
				rewriteDeclarations(file);
				continue;
			}
			if (!entry.name.endsWith(".d.ts")) continue;
			const content = readFileSync(file, "utf8");
			const updated = content.replace(/(["'])(@huranth\/[\w-]+)(\/[^"']*)?\1/g, (match, quote, name, subpath = "") => {
				const workspace = workspaces.get(name);
				if (!workspace) throw new Error(`Unknown internal declaration import: ${name}${subpath}`);
				const exports = workspace.manifest.exports;
				const key = subpath ? `.${subpath}` : ".";
				let target = exports?.[key]?.types;
				if (!target && subpath && exports) {
					const wildcard = Object.keys(exports).find((item) => item.endsWith("/*") && key.startsWith(item.slice(0, -1)));
					if (wildcard) target = exports[wildcard].types.replace("*", key.slice(wildcard.length - 1));
				}
				target ??= subpath ? `./dist${subpath}.d.ts` : workspace.manifest.types;
				if (!target?.startsWith("./dist/")) throw new Error(`Cannot resolve declaration import: ${name}${subpath}`);
				const declaration = join(vendorDir, workspace.directory, target.slice("./dist/".length));
				if (!existsSync(declaration)) throw new Error(`Missing declaration: ${declaration}`);
				let specifier = relative(dirname(file), declaration).replaceAll("\\", "/").replace(/\.d\.ts$/, ".js");
				if (!specifier.startsWith(".")) specifier = `./${specifier}`;
				return `${quote}${specifier}${quote}`;
			});
			if (updated !== content) writeFileSync(file, updated);
		}
	}
	rewriteDeclarations(join(releaseDir, "dist"));

	const nativeDir = join(repoRoot, "packages", "tui", "native");
	for (const platform of ["win32", "darwin", "linux"]) {
		cpSync(
			join(nativeDir, platform, "prebuilds"),
			join(releaseDir, "dist", "bundle", "native", platform, "prebuilds"),
			{ recursive: true },
		);
	}
	packageJson.name = "@huranth/gama-harness";
	packageJson.main = "./dist/bundle/index.js";
	packageJson.exports["."].import = "./dist/bundle/index.js";
	packageJson.dependencies = Object.fromEntries(
		Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
	);
	delete packageJson.devDependencies;
	delete packageJson.scripts;
	cpSync(join(codingAgentDir, "CHANGELOG.md"), join(releaseDir, "CHANGELOG.md"));
	cpSync(join(codingAgentDir, "README.md"), join(releaseDir, "README.md"));
	writeFileSync(join(releaseDir, "package.json"), `${JSON.stringify(packageJson, null, "\t")}\n`);
	console.log(`Prepared ${relative(repoRoot, releaseDir)}`);
}
