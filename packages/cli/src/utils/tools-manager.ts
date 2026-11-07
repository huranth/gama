import { type SpawnSyncReturns, spawnSync } from "child_process";
import { createHash } from "crypto";
import {
	chmodSync,
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
} from "fs";
import { arch, platform } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { APP_NAME, getBinDir } from "../config.ts";
import { fetchWithRetry } from "./management-http.ts";

type ToolName = "fd" | "rg";

interface ToolConfig {
	name: string;
	repo: string;
	binaryName: string;
	systemBinaryNames?: string[];
	tagPrefix: string;
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

export interface ToolStatus {
	type: "info" | "warning";
	message: string;
}

const toolsDir = getBinDir();

const networkTimeoutMs = 10_000;

const downloadTimeoutMs = 120_000;

// Pin fd
const fdDarwinX64Version = "10.3.0";

const userAgent = `${APP_NAME}-coding-agent`;

const sha256Hex = /^[a-f0-9]{64}$/i;

const sha256Prefix = "sha256:";

const termuxPackages: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
};

function isOfflineModeEnabled(): boolean {
	const value = process.env.GAMA_OFFLINE;
	if (!value) return false;

	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function rustAssetName(
	name: string,
	version: string,
	plat: string,
	architecture: string,
): string | null {
	const arch = architecture === "arm64" ? "aarch64" : "x86_64";

	if (plat === "darwin") return `${name}${version}-${arch}-apple-darwin.tar.gz`;
	if (plat === "linux") return `${name}${version}-${arch}-unknown-linux-musl.tar.gz`;
	if (plat === "win32") return `${name}${version}-${arch}-pc-windows-msvc.zip`;

	return null;
}

const tools: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => rustAssetName("fd-v", version, plat, architecture),
	},

	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		getAssetName: (version, plat, architecture) => {
			return rustAssetName("ripgrep-", version, plat, architecture);
		},
	},
};

export function getToolPath(tool: ToolName): string | null {
	const config = tools[tool];
	if (!config) return null;

	const binaryName = config.binaryName + (platform() === "win32" ? ".exe" : "");
	const localPath = join(toolsDir, binaryName);
	if (existsSync(localPath)) {
		return localPath;
	}

	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		if (commandExists(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
}

export async function ensureTool(
	tool: ToolName,
	onStatus?: (status: ToolStatus) => void,
): Promise<string | undefined> {
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	const config = tools[tool];
	if (!config) return undefined;

	if (isOfflineModeEnabled()) {
		onStatus?.({
			type: "warning",
			message: `${config.name} not found. Offline mode enabled, skipping download.`,
		});
		return undefined;
	}

	if (platform() === "android") {
		const packageName = termuxPackages[tool] ?? tool;
		onStatus?.({
			type: "warning",
			message: `${config.name} not found. Install with: pkg install ${packageName}`,
		});
		return undefined;
	}

	onStatus?.({ type: "info", message: `Downloading: ${config.name}` });

	try {
		const path = await downloadTool(tool);
		onStatus?.({ type: "info", message: `Installed: ${config.name}` });
		return path;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		onStatus?.({
			type: "warning",
			message: `Download failed: ${config.name} (${detail})`,
		});
		return undefined;
	}
}

function commandExists(command: string): boolean {
	try {
		const result = spawnSync(command, ["--version"], { stdio: "pipe" });
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

export async function getLatestVersion(repo: string): Promise<string> {
	const response = await fetchWithRetry(
		`https://github.com/${repo}/releases/latest`,
		{
			headers: { "User-Agent": userAgent },
			redirect: "manual",
		},
		{ timeoutMs: networkTimeoutMs },
	);

	try {
		await response.body?.cancel();
	} catch {}

	const location =
		response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
	if (!location) {
		throw new Error(
			`Release lookup failed: ${repo}`,
		);
	}

	const tag = new URL(location, "https://github.com").pathname.split("/").pop();
	if (!tag || !location.includes("/releases/tag/")) {
		throw new Error(
			`Release redirect failed: ${repo}`,
		);
	}

	return decodeURIComponent(tag).replace(/^v/, "");
}

export async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetchWithRetry(url, undefined, { timeoutMs: downloadTimeoutMs });

	if (!response.ok) {
		try {
			await response.body?.cancel();
		} catch {}
		throw new Error(`Download failed: ${response.status}`);
	}

	if (!response.body) {
		throw new Error("Empty response");
	}

	// No clobber
	const fileStream = createWriteStream(dest, { flags: "wx", mode: 0o600 });
	await pipeline(Readable.fromWeb(response.body as any), fileStream);
}

async function fetchAssetDigest(repo: string, tag: string, assetName: string): Promise<string> {
	const response = await fetchWithRetry(
		`https://api.github.com/repos/${repo}/releases/tags/${tag}`,
		{ headers: { "User-Agent": userAgent } },
		{ timeoutMs: networkTimeoutMs },
	);

	if (!response.ok) {
		try {
			await response.body?.cancel();
		} catch {}
		throw new Error(`Release read failed: ${tag}`);
	}

	const release = (await response.json()) as {
		assets?: Array<{ name?: string; digest?: string }>;
	};

	const asset = release.assets?.find((item) => item.name === assetName);
	const digest = asset?.digest;
	if (!digest?.startsWith(sha256Prefix)) {
		throw new Error(`Missing digest: ${assetName}`);
	}

	return digest.slice(sha256Prefix.length);
}

async function fetchSidecarDigest(url: string): Promise<string | undefined> {
	try {
		const response = await fetchWithRetry(
			`${url}.sha256`,
			{ headers: { "User-Agent": userAgent } },
			{ timeoutMs: networkTimeoutMs },
		);

		if (!response.ok) {
			await response.body?.cancel();
			return undefined;
		}

		const text = (await response.text()).trim().split(/\s+/)[0] ?? "";
		return sha256Hex.test(text) ? text.toLowerCase() : undefined;
	} catch {
		return undefined;
	}
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	const stream = createReadStream(path);

	for await (const chunk of stream) {
		hash.update(chunk);
	}

	return hash.digest("hex");
}

export async function resolveExpectedDigest(
	downloadUrl: string,
	repo: string,
	tag: string,
	assetName: string,
): Promise<string> {
	const sidecar = await fetchSidecarDigest(downloadUrl);
	if (sidecar) return sidecar;

	return fetchAssetDigest(repo, tag, assetName);
}

export async function verifyAssetDigest(
	path: string,
	expected: string,
	assetName: string,
): Promise<void> {
	const actual = await hashFile(path);

	if (actual !== expected) {
		throw new Error(`Checksum mismatch: ${assetName}`);
	}
}

function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
	if (result.error?.message) {
		return result.error.message;
	}

	const stderr = result.stderr?.toString().trim();
	if (stderr) {
		return stderr;
	}

	const stdout = result.stdout?.toString().trim();
	if (stdout) {
		return stdout;
	}

	return `exit status ${result.status ?? "unknown"}`;
}

function runExtractionCommand(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { stdio: "pipe" });
	if (!result.error && result.status === 0) {
		return null;
	}

	return `${command}: ${formatSpawnFailure(result)}`;
}

function getWindowsTarCommand(): string {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (systemRoot) {
		const systemTar = join(systemRoot, "System32", "tar.exe");
		if (existsSync(systemTar)) {
			return systemTar;
		}
	}

	return "tar.exe";
}

function extractTarGzArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failure = runExtractionCommand("tar", ["xzf", archivePath, "-C", extractDir]);
	if (failure) {
		throw new Error(`Extract failed: ${assetName}`);
	}
}

function extractZipArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failures: string[] = [];

	if (platform() === "win32") {
		const tarFailure = runExtractionCommand(getWindowsTarCommand(), [
			"xf",
			archivePath,
			"-C",
			extractDir,
		]);
		if (!tarFailure) return;

		failures.push(tarFailure);

		const script =
			"& { param($archive, $destination) $ErrorActionPreference = 'Stop'; " +
			"Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
		const powershellFailure = runExtractionCommand("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
			archivePath,
			extractDir,
		]);
		if (!powershellFailure) return;

		failures.push(powershellFailure);
	} else {
		const unzipFailure = runExtractionCommand("unzip", ["-q", archivePath, "-d", extractDir]);
		if (!unzipFailure) return;

		failures.push(unzipFailure);

		const tarFailure = runExtractionCommand("tar", ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;

		failures.push(tarFailure);
	}

	throw new Error(`Extract failed: ${assetName}`);
}

function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;

		const entries = readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === binaryFileName) {
				return fullPath;
			}

			if (entry.isDirectory()) {
				stack.push(fullPath);
			}
		}
	}

	return null;
}

function extractArchive(archivePath: string, extractDir: string, assetName: string): void {
	if (assetName.endsWith(".tar.gz")) {
		extractTarGzArchive(archivePath, extractDir, assetName);
		return;
	}

	if (assetName.endsWith(".zip")) {
		extractZipArchive(archivePath, extractDir, assetName);
		return;
	}

	throw new Error(`Unsupported archive: ${assetName}`);
}

function locateBinary(
	extractDir: string,
	assetName: string,
	binaryFileName: string,
): string | undefined {
	const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
	const candidates = [join(extractedDir, binaryFileName), join(extractDir, binaryFileName)];
	const found = candidates.find((candidate) => existsSync(candidate));

	return found ?? findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
}

function resolveToolVersion(tool: ToolName, plat: string, architecture: string): Promise<string> {
	const config = tools[tool];
	if (!config) {
		return Promise.reject(new Error(`Unknown tool: ${tool}`));
	}

	const needsPin = tool === "fd" && plat === "darwin" && architecture === "x64";
	if (needsPin) {
		return Promise.resolve(fdDarwinX64Version);
	}

	return getLatestVersion(config.repo);
}

async function downloadTool(tool: ToolName): Promise<string> {
	const config = tools[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();
	const version = await resolveToolVersion(tool, plat, architecture);

	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform`);
	}

	mkdirSync(toolsDir, { recursive: true });

	const downloadUrl =
		`https://github.com/${config.repo}/releases/download/` +
		`${config.tagPrefix}${version}/${assetName}`;
	const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
	const archivePath = join(toolsDir, `${nonce}-${assetName}`);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(toolsDir, config.binaryName + binaryExt);

	try {
		await downloadFile(downloadUrl, archivePath);
	} catch (error) {
		rmSync(archivePath, { force: true });
		throw error;
	}

	// Fresh directory
	const extractDir = mkdtempSync(join(toolsDir, `extract_tmp_${config.binaryName}_`));

	try {
		const tag = `${config.tagPrefix}${version}`;
		const expected = await resolveExpectedDigest(downloadUrl, config.repo, tag, assetName);
		await verifyAssetDigest(archivePath, expected, assetName);

		extractArchive(archivePath, extractDir, assetName);

		const binaryFileName = config.binaryName + binaryExt;
		const extractedBinary = locateBinary(extractDir, assetName, binaryFileName);
		if (!extractedBinary) {
			throw new Error(
				`Missing binary: ${binaryFileName}`,
			);
		}

		renameSync(extractedBinary, binaryPath);

		if (plat !== "win32") {
			chmodSync(binaryPath, 0o755);
		}
	} finally {
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
}
