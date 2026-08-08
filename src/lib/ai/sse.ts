import type { ChatStreamEvent } from "@/lib/types";

const encoder = new TextEncoder();

export function sseFrame(event: ChatStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function encodeSse(event: ChatStreamEvent): Uint8Array {
  return encoder.encode(sseFrame(event));
}

export interface SseMessage {
  event: string;
  data: string;
}

/**
 * Incremental decoder for upstream provider SSE. Frames are separated by a
 * blank line; multiple `data:` lines inside one frame join with "\n".
 */
export class SseDecoder {
  private buffer = "";

  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const out: SseMessage[] = [];
    for (;;) {
      const idx = this.buffer.indexOf("\n\n");
      if (idx === -1) break;
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const msg = parseSseBlock(block);
      if (msg) out.push(msg);
    }
    return out;
  }

  flush(): SseMessage[] {
    const rest = this.buffer;
    this.buffer = "";
    if (!rest.trim()) return [];
    const msg = parseSseBlock(rest);
    return msg ? [msg] : [];
  }
}

export function parseSseBlock(block: string): SseMessage | null {
  let event = "";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

export async function* iterateSse(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const textDecoder = new TextDecoder();
  const decoder = new SseDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const msg of decoder.push(textDecoder.decode(value, { stream: true }))) {
        yield msg;
      }
    }
    for (const msg of decoder.flush()) yield msg;
  } finally {
    reader.releaseLock();
  }
}
