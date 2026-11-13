import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

const JSONRPC_MEMBERS = ["jsonrpc", "id", "method", "params", "result", "error"];

/** A JSON-RPC message (or batch) with only the members JSON-RPC defines; anything else is returned as it is. */
export function jsonRpcMembers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonRpcMembers);
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("jsonrpc" in value)) return value;
  const message = value as Record<string, unknown>;
  return Object.fromEntries(JSONRPC_MEMBERS.filter((k) => k in message).map((k) => [k, message[k]]));
}

/** The JSON text normalized by `jsonRpcMembers`; null when it isn't JSON. */
function jsonRpcText(text: string): string | null {
  try {
    return JSON.stringify(jsonRpcMembers(JSON.parse(text)));
  } catch {
    return null;
  }
}

/**
 * Rewrites each SSE event whose data is JSON as one `data:` line; every other line passes as it came. An event's data
 * may span several `data:` lines (joined with \n) and lines may end in \r\n, \r or \n, as SSE allows.
 */
function sseJsonRpcEvents(): TransformStream<string, string> {
  let rest = "";
  let data: string[] = [];
  let raw: string[] = [];
  const line = (l: string, out: TransformStreamDefaultController<string>) => {
    if (l.startsWith("data:")) {
      data.push(l.slice(l.startsWith("data: ") ? 6 : 5));
      raw.push(l);
      return;
    }
    if (l === "") {
      const json = data.length > 0 ? jsonRpcText(data.join("\n")) : null;
      for (const r of json === null ? raw : [`data: ${json}`]) out.enqueue(`${r}\n`);
      data = [];
      raw = [];
    }
    out.enqueue(`${l}\n`);
  };
  return new TransformStream({
    transform(chunk, out) {
      const text = rest + chunk;
      // A trailing \r may be the first half of \r\n: wait for the next chunk to tell.
      const cut = text.endsWith("\r") ? text.length - 1 : text.length;
      const lines = text.slice(0, cut).split(/\r\n|\r|\n/);
      rest = (lines.pop() ?? "") + text.slice(cut);
      for (const l of lines) line(l, out);
    },
    flush(out) {
      if (rest.endsWith("\r")) line(rest.slice(0, -1), out);
      else if (rest) raw.push(rest);
      for (const r of raw) out.enqueue(`${r}\n`);
    },
  });
}

/**
 * A fetch for the MCP transport that drops members JSON-RPC doesn't define from the server's messages before the SDK
 * reads them: the SDK refuses a whole response for one extra top-level member (some servers add their own, like a
 * `fonte` beside `result`), where other MCP clients ignore it. `result` and `error` pass untouched, so their shapes are
 * still checked; redirects and failed responses pass as they came.
 */
export function tolerantMcpFetch(base: FetchLike = fetch): FetchLike {
  return async (url, init) => {
    const res = await base(url, init);
    if (!res.ok || !res.body) return res;
    const type = res.headers.get("content-type") ?? "";
    let body: string | ReadableStream<Uint8Array>;
    if (type.includes("application/json")) {
      const text = await res.text();
      body = jsonRpcText(text) ?? text;
    } else if (type.includes("text/event-stream")) {
      body = res.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(sseJsonRpcEvents())
        .pipeThrough(new TextEncoderStream());
    } else {
      return res;
    }
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
  };
}
