import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface AnthropicMockServer {
	baseUrl: string;
	// Requests.
	requests: unknown[];
	close: () => Promise<void>;
}

function collectText(value: unknown, output: string[]): void {
	if (typeof value === "string") {
		output.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectText(item, output);
		}
		return;
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const key of ["text", "content", "thinking", "output"]) {
			if (key in record) collectText(record[key], output);
		}
	}
}

function extractRequestText(body: unknown): string {
	const messages = (body as { messages?: unknown } | undefined)?.messages;
	const collected: string[] = [];
	collectText(messages, collected);
	return collected.join("\n").slice(0, 4000);
}

function textReply(text: string): unknown[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_test",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
		{ type: "message_stop" },
	];
}

export async function startAnthropicMockServer(
	options: { reply?: (text: string) => string } = {},
): Promise<AnthropicMockServer> {
	const requests: unknown[] = [];
	const reply = options.reply ?? ((text: string) => text || "ok");

	const server: Server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf-8");
			const body = raw ? JSON.parse(raw) : undefined;
			requests.push(body);

			response.statusCode = 200;
			response.setHeader("content-type", "text/event-stream");
			for (const event of textReply(reply(extractRequestText(body)))) {
				response.write(
					`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
				);
			}
			response.end();
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
