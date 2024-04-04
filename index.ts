import { randomUUID } from "node:crypto";
import { OpenAI } from "openai";

const TOKEN_TIMEOUT_MS = 10 * 60 * 1000;
const DEBUG = true;

const baseUrl = "https://chat.openai.com";
const baseHeaders = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  "content-type": "application/json",
  "oai-language": "en-US",
  origin: baseUrl,
  pragma: "no-cache",
  referer: baseUrl,
  "sec-ch-ua":
    '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
};

const randomSessionId = (function () {
  let last = 0;
  let deviceId = "",
    token = "";
  return async () => {
    const current = Date.now();
    if (current - last > TOKEN_TIMEOUT_MS) {
      deviceId = randomUUID();
      const response = await fetch(
        `${baseUrl}/backend-anon/sentinel/chat-requirements`,
        {
          keepalive: true,
          verbose: DEBUG,
          method: "POST",
          headers: { "oai-device-id": deviceId, ...baseHeaders },
        }
      );
      token = await response.json().then((data) => (data as any)?.token);
      last = current;
    }
    return { deviceId, token };
  };
})();

async function* chunksToLines(chunksAsync: any) {
  let previous = "";
  for await (const chunk of chunksAsync) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    previous += bufferChunk;
    let eolIndex: number;
    while ((eolIndex = previous.indexOf("\n")) >= 0) {
      // line includes the EOL
      const line = previous.slice(0, eolIndex + 1).trimEnd();
      if (line === "data: [DONE]") break;
      if (line.startsWith("data: ")) yield line;
      previous = previous.slice(eolIndex + 1);
    }
  }
}

async function* linesToMessages(linesAsync: any) {
  for await (const line of linesAsync) {
    const message = line.substring("data :".length);

    yield message;
  }
}

Bun.serve({
  port: process.env.PORT || 3000,
  async fetch(request) {
    const { deviceId, token } = await randomSessionId();
    const chatCompletionCreate = await request
      .json()
      .then((data) => data as OpenAI.ChatCompletionCreateParams);
    const body = {
      action: "next",
      messages: chatCompletionCreate.messages.map((message) => ({
        author: { role: message.role },
        content: { content_type: "text", parts: [message.content] },
      })),
      parent_message_id: randomUUID(),
      model: chatCompletionCreate.model,
      timezone_offset_min: -180,
      suggestions: [],
      history_and_training_disabled: true,
      conversation_mode: { kind: "primary_assistant" },
      websocket_request_id: randomUUID(),
    };
    const response = await fetch(`${baseUrl}/backend-api/conversation`, {
      verbose: DEBUG,
      method: "POST",
      keepalive: true,
      headers: {
        "oai-device-id": deviceId,
        "openai-sentinel-chat-requirements-token": token,
        ...baseHeaders,
      },
      body: JSON.stringify(body),
    });
    let id, created, content;
    for await (const message of linesToMessages(chunksToLines(response.body))) {
      const parsed = JSON.parse(message);
      id = parsed?.message?.id;
      created = parsed?.message?.create_time;
      content = parsed?.message?.content?.parts[0] ?? "";
    }
    return new Response(
      JSON.stringify({
        id,
        created,
        model: "gpt-3.5-turbo",
        object: "chat.completion",
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: {
              content,
              role: "assistant",
            },
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      })
    );
  },
});
