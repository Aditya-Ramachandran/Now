export interface Env {
  API_KEY: string;
  FRONTEND_ORIGIN: string;
  STATUS_KV: KVNamespace;
}

const STATUS_KEY = "current_status";
const ALLOWED_STATUSES = new Set(["gym", "work", "study", "sleep"]);

type Status = "gym" | "work" | "study" | "sleep";

interface StatusRecord {
  status: Status;
  timestamp: string;
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({ Vary: "Origin" });
  const origin = request.headers.get("Origin");

  if (origin === env.FRONTEND_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
    headers.set("Access-Control-Max-Age", "86400");
  }

  return headers;
}

function jsonResponse(
  request: Request,
  env: Env,
  body: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers = corsHeaders(request, env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }

  return new Response(JSON.stringify(body), { status, headers });
}

// Compares all bytes of the configured key and avoids an early return on a
// mismatched prefix. API keys should still be long, random secrets.
function secureCompare(provided: string, expected: string): boolean {
  const actual = new TextEncoder().encode(provided);
  const target = new TextEncoder().encode(expected);
  let difference = actual.length ^ target.length;

  for (let index = 0; index < target.length; index += 1) {
    difference |= target[index] ^ (actual[index] ?? 0);
  }

  return difference === 0;
}

async function updateStatus(request: Request, env: Env): Promise<Response> {
  const apiKey = request.headers.get("X-API-Key");
  if (!apiKey || !secureCompare(apiKey, env.API_KEY)) {
    return jsonResponse(request, env, { error: "unauthorized" }, 401);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(request, env, { error: "invalid_json" }, 400);
  }

  const requestedStatus =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as { status?: unknown }).status
      : undefined;

  if (typeof requestedStatus !== "string" || !ALLOWED_STATUSES.has(requestedStatus)) {
    return jsonResponse(request, env, { error: "invalid_status" }, 400);
  }

  const record: StatusRecord = {
    status: requestedStatus as Status,
    timestamp: new Date().toISOString(),
  };

  try {
    await env.STATUS_KV.put(STATUS_KEY, JSON.stringify(record));
  } catch {
    return jsonResponse(request, env, { error: "storage_unavailable" }, 500);
  }

  return jsonResponse(request, env, record);
}

async function getStatus(request: Request, env: Env): Promise<Response> {
  let stored: string | null;
  try {
    stored = await env.STATUS_KV.get(STATUS_KEY);
  } catch {
    return jsonResponse(request, env, { error: "storage_unavailable" }, 500, {
      "Cache-Control": "no-store",
    });
  }

  if (stored === null) {
    return jsonResponse(request, env, { error: "status_not_set" }, 404, {
      "Cache-Control": "no-store",
    });
  }

  try {
    const record = JSON.parse(stored) as StatusRecord;
    if (!ALLOWED_STATUSES.has(record.status) || typeof record.timestamp !== "string") {
      throw new Error("invalid stored status");
    }
    return jsonResponse(request, env, record, 200, { "Cache-Control": "no-store" });
  } catch {
    return jsonResponse(request, env, { error: "stored_status_invalid" }, 500, {
      "Cache-Control": "no-store",
    });
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (request.headers.get("Origin") !== env.FRONTEND_ORIGIN) {
        return jsonResponse(request, env, { error: "origin_not_allowed" }, 403);
      }
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (url.pathname === "/update-status") {
      if (request.method !== "POST") {
        return jsonResponse(request, env, { error: "method_not_allowed" }, 405, {
          Allow: "POST, OPTIONS",
        });
      }
      return updateStatus(request, env);
    }

    if (url.pathname === "/status") {
      if (request.method !== "GET") {
        return jsonResponse(request, env, { error: "method_not_allowed" }, 405, {
          Allow: "GET, OPTIONS",
        });
      }
      return getStatus(request, env);
    }

    return jsonResponse(request, env, { error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
