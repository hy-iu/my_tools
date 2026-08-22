import { randomUUID } from "node:crypto";

/**
 * Minimal native `/api` client. The DSH Web server exposes unary host methods at
 * `POST /api/<method>` with a `client-request` body, and answers with a
 * `server-response` — both confirmed against the live server. This lets the
 * extension host read session trajectories cold (read-only) with plain `fetch`,
 * no `@deepseek-ai/dsh-client-connection` dependency. Loopback origin carries
 * no `Origin` header, so the browser trust fence does not apply.
 */
export class DshApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DshApiError";
  }
}

interface ServerResponse {
  type?: string;
  rpcId?: string;
  result?: {
    ok: boolean;
    value?: unknown;
    error?: { code: string; message: string };
  };
}

export async function apiCall<T>(baseUrl: string, method: string, payload: unknown): Promise<T> {
  const clean = baseUrl.replace(/\/+$/, "");
  const body = { type: "client-request", rpcId: randomUUID(), method, payload };

  let res: Response;
  try {
    res = await fetch(`${clean}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new DshApiError("transport", `dsh api ${method}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) throw new DshApiError("http", `dsh api ${method}: HTTP ${res.status}`);

  const msg = (await res.json()) as ServerResponse;
  if (msg.type !== "server-response") {
    throw new DshApiError("protocol", `dsh api ${method}: unexpected message type ${String(msg.type)}`);
  }
  const r = msg.result;
  if (!r || !r.ok) {
    throw new DshApiError(r?.error?.code ?? "internal", r?.error?.message ?? "unknown error");
  }
  return r.value as T;
}