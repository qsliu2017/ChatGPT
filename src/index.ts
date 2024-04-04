/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { OpenAI } from 'openai';

const baseUrl = 'https://chat.openai.com';
const baseHeaders = {
	accept: '*/*',
	'accept-language': 'en-US,en;q=0.9',
	'cache-control': 'no-cache',
	'content-type': 'application/json',
	'oai-language': 'en-US',
	origin: baseUrl,
	pragma: 'no-cache',
	referer: baseUrl,
	'sec-ch-ua': '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
	'sec-ch-ua-mobile': '?0',
	'sec-ch-ua-platform': '"Windows"',
	'sec-fetch-dest': 'empty',
	'sec-fetch-mode': 'cors',
	'sec-fetch-site': 'same-origin',
	'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
};

async function randomSessionId() {
	const deviceId = randomUUID();
	const response = await fetch(`${baseUrl}/backend-anon/sentinel/chat-requirements`, {
		method: 'POST',
		headers: { 'oai-device-id': deviceId, ...baseHeaders },
	});
	const token = await response.json().then((data) => (data as { token: string }).token);
	return { deviceId, token };
}

async function* chunksToLines(chunksAsync: any) {
	let previous = '';
	for await (const chunk of chunksAsync) {
		const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		previous += bufferChunk;
		let eolIndex: number;
		while ((eolIndex = previous.indexOf('\n')) >= 0) {
			// line includes the EOL
			const line = previous.slice(0, eolIndex + 1).trimEnd();
			if (line === 'data: [DONE]') break;
			if (line.startsWith('data: ')) yield line;
			previous = previous.slice(eolIndex + 1);
		}
	}
}

async function* linesToMessages(linesAsync: any) {
	for await (const line of linesAsync) {
		const message = line.substring('data :'.length);

		yield message;
	}
}

const fetchChatApi = (init?: RequestInit<CfProperties<unknown>> | undefined) => fetch(`${baseUrl}/backend-api/conversation`, init);

export interface Env {
	// Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
	// MY_KV_NAMESPACE: KVNamespace;
	//
	// Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
	// MY_DURABLE_OBJECT: DurableObjectNamespace;
	//
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	// MY_BUCKET: R2Bucket;
	//
	// Example binding to a Service. Learn more at https://developers.cloudflare.com/workers/runtime-apis/service-bindings/
	// MY_SERVICE: Fetcher;
	//
	// Example binding to a Queue. Learn more at https://developers.cloudflare.com/queues/javascript-apis/
	// MY_QUEUE: Queue;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { deviceId, token } = await randomSessionId();
		const chatCompletionCreate = await request.json().then((data) => data as OpenAI.ChatCompletionCreateParams);
		const messages = chatCompletionCreate.messages.reduce((acc, message) => {
			acc.add(message.content);
			return acc;
		}, new Set<any>());
		const body = {
			action: 'next',
			messages: chatCompletionCreate.messages.map((message) => ({
				author: { role: message.role },
				content: { content_type: 'text', parts: [message.content] },
			})),
			parent_message_id: randomUUID(),
			model: chatCompletionCreate.model,
			timezone_offset_min: -180,
			suggestions: [],
			history_and_training_disabled: true,
			conversation_mode: { kind: 'primary_assistant' },
			websocket_request_id: randomUUID(),
		};
		const response = await fetchChatApi({
			method: 'POST',
			headers: { 'oai-device-id': deviceId, 'openai-sentinel-chat-requirements-token': token, ...baseHeaders },
			body: JSON.stringify(body),
		});
		let fullContent = '';
		for await (const message of linesToMessages(chunksToLines(response.body))) {
			const parsed = JSON.parse(message);
			console.debug(parsed);
			const content = parsed?.message?.content?.parts[0] ?? '';
			// if (content === '' || messages.has(content)) continue;
			fullContent = content;
		}
		return new Response(fullContent);
	},
};
