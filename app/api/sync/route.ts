import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { syncStates } from "../../../db/schema";

type SyncRequest = {
  action?: "pull" | "push";
  code?: string;
  data?: unknown;
  revision?: number;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, { ...init, headers: { ...corsHeaders, ...init.headers } });
}

function normalizeCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function hashCode(value: string) {
  const bytes = new TextEncoder().encode(`xunji-sync-v1:${value}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SyncRequest;
    const code = normalizeCode(body.code ?? "");
    if (code.length < 12) return json({ error: "同步码至少需要 12 位" }, { status: 400 });

    const codeHash = await hashCode(code);
    const db = getDb();
    const [current] = await db.select().from(syncStates).where(eq(syncStates.codeHash, codeHash)).limit(1);

    if (body.action === "pull") {
      if (!current) return json({ found: false, revision: 0, data: null });
      return json({ found: true, revision: current.revision, data: JSON.parse(current.payload), updatedAt: current.updatedAt });
    }

    if (body.action !== "push" || body.data === undefined) {
      return json({ error: "请求内容不完整" }, { status: 400 });
    }

    const payload = JSON.stringify(body.data);
    if (payload.length > 900_000) return json({ error: "同步数据过大，请先导出归档" }, { status: 413 });
    const revision = Number.isInteger(body.revision) ? Number(body.revision) : 0;
    const now = new Date().toISOString();

    if (!current) {
      if (revision !== 0) return json({ conflict: true, revision: 0, data: null }, { status: 409 });
      await db.insert(syncStates).values({ codeHash, payload, revision: 1, updatedAt: now });
      return json({ revision: 1, updatedAt: now });
    }

    if (current.revision !== revision) {
      return json({ conflict: true, revision: current.revision, data: JSON.parse(current.payload) }, { status: 409 });
    }

    const nextRevision = current.revision + 1;
    const result = await db.update(syncStates)
      .set({ payload, revision: nextRevision, updatedAt: now })
      .where(and(eq(syncStates.codeHash, codeHash), eq(syncStates.revision, current.revision)));
    if (!result.success) return json({ error: "同步写入失败" }, { status: 500 });
    return json({ revision: nextRevision, updatedAt: now });
  } catch (error) {
    const message = error instanceof Error ? error.message : "同步服务暂时不可用";
    return json({ error: message }, { status: 500 });
  }
}
