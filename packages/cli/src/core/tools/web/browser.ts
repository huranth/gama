import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "./util.ts";

// Chrome launch
const LAUNCH_TIMEOUT_MS = 10_000;

const PAGE_TIMEOUT_MS = 20_000;

const MIN_TEXT = 20;

const POLL_MS = 150;

// Socket types
interface SocketEvent {
	data: unknown;
}

interface Socket {
	addEventListener(
		type: "open" | "message" | "error" | "close",
		fn: (event: SocketEvent) => void,
	): void;
	close(): void;
	send(data: string): void;
}

type SocketCtor = new (url: string) => Socket;

interface CdpMessage {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { message?: string };
	sessionId?: string;
}

type CdpHandler = (params: Record<string, unknown>) => void;

// Rendered page
export interface BrowserPage {
	html: string;
	finalUrl: string;
	title?: string;
}

// Candidate paths
function chromeCandidates(): string[] {
	const env = process.env;
	const paths: string[] = [];

	for (const key of ["CHROME_PATH", "CHROME_BIN", "PUPPETEER_EXECUTABLE_PATH"]) {
		const value = env[key]?.trim();
		if (value) paths.push(value);
	}

	if (process.platform === "win32") {
		for (const root of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]) {
			if (!root) continue;
			paths.push(join(root, "Google", "Chrome", "Application", "chrome.exe"));
			paths.push(join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
			paths.push(join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"));
		}
	} else if (process.platform === "darwin") {
		paths.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
		paths.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
		paths.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
		paths.push("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
	} else {
		paths.push("/usr/bin/google-chrome");
		paths.push("/usr/bin/google-chrome-stable");
		paths.push("/usr/bin/chromium");
		paths.push("/usr/bin/chromium-browser");
		paths.push("/usr/bin/microsoft-edge");
		paths.push("/usr/bin/brave-browser");
	}

	return paths;
}

export function findChrome(): string | undefined {
	return chromeCandidates().find((path) => path && existsSync(path));
}

// Process stop
function stopProcess(child: ReturnType<typeof spawn>): void {
	const pid = child.pid;
	if (!pid) return;

	if (process.platform === "win32") {
		execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {});
		return;
	}

	try {
		child.kill("SIGKILL");
	} catch {
		// Already gone
	}
}

// Debug port
async function readPort(dir: string, child: ReturnType<typeof spawn>): Promise<number> {
	const file = join(dir, "DevToolsActivePort");
	const started = Date.now();

	while (Date.now() - started < LAUNCH_TIMEOUT_MS) {
		if (child.exitCode !== null) {
			throw new Error("Chrome failed");
		}

		const text = await readFile(file, "utf8").catch(() => "");
		const port = Number(text.split(/\r?\n/)[0]);

		if (Number.isInteger(port) && port > 0) return port;

		await sleep(POLL_MS);
	}

	throw new Error("Chrome failed");
}

// Devtools socket
async function browserSocket(port: number): Promise<string> {
	const endpoint = `http://127.0.0.1:${port}/json/version`;
	const response = await fetch(endpoint);
	if (!response.ok) throw new Error("DevTools failed");

	const data = (await response.json()) as { webSocketDebuggerUrl?: string };
	const url = data.webSocketDebuggerUrl;
	if (!url) throw new Error("DevTools failed");

	return url;
}

// Cdp client
class Cdp {
	private readonly socket: Socket;
	private readonly pending = new Map<
		number,
		{ resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
	>();
	private readonly handlers = new Map<string, Set<CdpHandler>>();
	private nextId = 1;

	private constructor(socket: Socket) {
		this.socket = socket;

		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string") return;

			let message: CdpMessage;
			try {
				message = JSON.parse(event.data) as CdpMessage;
			} catch {
				return;
			}

			if (message.id !== undefined) {
				const pending = this.pending.get(message.id);
				if (!pending) return;

				this.pending.delete(message.id);
				if (message.error) pending.reject(new Error(message.error.message ?? "CDP error"));
				else pending.resolve(message.result ?? {});
				return;
			}

			if (message.method) {
				for (const handler of this.handlers.get(message.method) ?? []) {
					handler(message.params ?? {});
				}
			}
		});

		socket.addEventListener("close", () => {
			for (const pending of this.pending.values())
				pending.reject(new Error("CDP socket closed"));
			this.pending.clear();
		});
	}

	static async connect(url: string): Promise<Cdp> {
		const Ctor = (globalThis as { WebSocket?: SocketCtor }).WebSocket;
		if (!Ctor) throw new Error("No WebSocket");

		const socket = new Ctor(url);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(new Error("CDP socket failed")));
		});

		return new Cdp(socket);
	}

	send(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<Record<string, unknown>> {
		const id = this.nextId++;
		const message: Record<string, unknown> = { id, method, params };
		if (sessionId) message.sessionId = sessionId;

		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.socket.send(JSON.stringify(message));
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	on(method: string, handler: CdpHandler): () => void {
		let handlers = this.handlers.get(method);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(method, handlers);
		}
		handlers.add(handler);

		return () => handlers?.delete(handler);
	}

	close(): void {
		try {
			this.socket.close();
		} catch {
			// Already closed
		}
	}
}

// Load wait
function waitForLoad(cdp: Cdp, sessionId: string, timeoutMs: number): Promise<void> {
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			offLoad();
			offIdle();
			resolve();
		};

		const offLoad = cdp.on("Page.loadEventFired", finish);
		const offIdle = cdp.on("Page.lifecycleEvent", (params) => {
			const name = params.name;
			if (name === "networkIdle" || name === "networkAlmostIdle") finish();
		});
		const timer = setTimeout(finish, timeoutMs);

		// Already loaded
		void cdp
			.send(
				"Runtime.evaluate",
				{ expression: "document.readyState", returnByValue: true },
				sessionId,
			)
			.then((result) => {
				const state = (result.result as { value?: string } | undefined)?.value;
				if (state === "complete") finish();
			})
			.catch(() => {});
	});
}

// Text wait
async function waitForText(cdp: Cdp, sessionId: string, timeoutMs: number): Promise<void> {
	const started = Date.now();

	while (Date.now() - started < timeoutMs) {
		const result = await cdp
			.send(
				"Runtime.evaluate",
				{
					expression: "document.body ? document.body.innerText.length : 0",
					returnByValue: true,
				},
				sessionId,
			)
			.catch(() => undefined);

		const length = (result?.result as { value?: number } | undefined)?.value ?? 0;
		if (length >= MIN_TEXT) return;

		await sleep(POLL_MS);
	}
}

// Evaluate string
async function evaluateString(cdp: Cdp, sessionId: string, expression: string): Promise<string> {
	const result = await cdp.send(
		"Runtime.evaluate",
		{ expression, returnByValue: true, awaitPromise: true },
		sessionId,
	);
	const value = (result.result as { value?: unknown } | undefined)?.value;

	return typeof value === "string" ? value : "";
}

// Page metadata
async function pageMeta(
	cdp: Cdp,
	sessionId: string,
): Promise<{ title?: string; finalUrl: string }> {
	const raw = await evaluateString(
		cdp,
		sessionId,
		"JSON.stringify({title: document.title, url: location.href})",
	);

	try {
		const data = JSON.parse(raw) as { title?: string; url?: string };
		return {
			...(data.title ? { title: data.title } : {}),
			finalUrl: data.url ?? "",
		};
	} catch {
		return { finalUrl: "" };
	}
}

// Rendered fetch
export async function browserFetch(
	url: string,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		allowRequest?: (url: string) => Promise<void>;
	} = {},
): Promise<BrowserPage> {
	const chrome = findChrome();
	if (!chrome) throw new Error("No browser");

	const dir = await mkdtemp(join(tmpdir(), "gama-chrome-"));
	const timeoutMs = options.timeoutMs ?? PAGE_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;
	const remaining = () => Math.max(1, deadline - Date.now());
	let stderr = "";
	let child: ReturnType<typeof spawn> | undefined;
	let cdp: Cdp | undefined;
	let targetId: string | undefined;
	let offRequest: (() => void) | undefined;
	let cancelWait: (error: Error) => void = () => {};
	const cancelled = new Promise<never>((_, reject) => {
		cancelWait = reject;
	});

	const abort = () => {
		cancelWait(new Error("Cancelled"));
		if (child) stopProcess(child);
	};

	if (options.signal?.aborted) throw new Error("Cancelled");
	options.signal?.addEventListener("abort", abort, { once: true });

	try {
		child = spawn(
			chrome,
			[
				"--headless=new",
				"--remote-debugging-port=0",
				`--user-data-dir=${dir}`,
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-gpu",
				"--disable-background-networking",
				"--disable-component-update",
				"--disable-sync",
				"--disable-extensions",
				"--disable-default-apps",
				"--mute-audio",
				"--hide-scrollbars",
				"--window-size=1280,720",
				"about:blank",
			],
			{ stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
		);

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000);
		});

		const port = await Promise.race([readPort(dir, child), cancelled]);
		const socketUrl = await Promise.race([browserSocket(port), cancelled]);
		cdp = await Promise.race([Cdp.connect(socketUrl), cancelled]);

		const created = await Promise.race([
			cdp.send("Target.createTarget", { url: "about:blank" }),
			cancelled,
		]);
		targetId = String(created.targetId ?? "");
		if (!targetId) throw new Error("Chrome failed");

		const attached = await Promise.race([
			cdp.send("Target.attachToTarget", {
				targetId,
				flatten: true,
			}),
			cancelled,
		]);
		const sessionId = String(attached.sessionId ?? "");
		if (!sessionId) throw new Error("Chrome failed");

		await Promise.race([cdp.send("Page.enable", {}, sessionId), cancelled]);
		await Promise.race([cdp.send("Runtime.enable", {}, sessionId), cancelled]);
		await Promise.race([
			cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId),
			cancelled,
		]);

		if (options.allowRequest) {
			offRequest = cdp.on("Fetch.requestPaused", (params) => {
				const requestId = String(params.requestId ?? "");
				const request = params.request as { url?: string } | undefined;
				if (!requestId || !request?.url) return;

				void options.allowRequest!(request.url)
					.then(() => cdp?.send("Fetch.continueRequest", { requestId }, sessionId))
					.catch(() =>
						cdp
							?.send(
								"Fetch.failRequest",
								{ requestId, errorReason: "BlockedByClient" },
								sessionId,
							)
							.catch(() => {}),
					);
			});

			await Promise.race([
				cdp.send(
					"Fetch.enable",
					{ patterns: [{ urlPattern: "*", requestStage: "Request" }] },
					sessionId,
				),
				cancelled,
			]);
		}

		const navigation = await Promise.race([
			cdp.send("Page.navigate", { url }, sessionId),
			cancelled,
		]);

		if (typeof navigation.errorText === "string" && navigation.errorText) {
			throw new Error("Navigation failed");
		}

		const loaded = waitForLoad(cdp, sessionId, remaining());
		await Promise.race([loaded, cancelled]);
		await Promise.race([waitForText(cdp, sessionId, remaining()), cancelled]);

		const html = await Promise.race([
			evaluateString(cdp, sessionId, "document.documentElement.outerHTML"),
			cancelled,
		]);
		const meta = await Promise.race([pageMeta(cdp, sessionId), cancelled]);

		if (!html) throw new Error("Empty document");

		return {
			html,
			finalUrl: meta.finalUrl || url,
			...(meta.title ? { title: meta.title } : {}),
		};
	} finally {
		options.signal?.removeEventListener("abort", abort);
		offRequest?.();

		if (cdp && targetId) {
			await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
		}
		cdp?.close();

		if (child) stopProcess(child);

		// Profile delay
		await sleep(100);
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}
