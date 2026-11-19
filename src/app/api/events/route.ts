import { NextRequest } from "next/server";
import { sse } from "@/lib/events";
import { requireSession } from "@/lib/authz";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  const canViewAllRex = auth.user.permissions.rex.viewAll;
  const userRexId = auth.user.rex_id;

  const enc = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let onUpdate: ((payload?: any) => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const cleanup = () => {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (onUpdate) {
          sse.off("update", onUpdate);
          onUpdate = null;
        }
        try {
          controller.close();
        } catch {}
      };

      try {
        controller.enqueue(enc.encode("retry: 3000\n: heartbeat\n\n"));
      } catch {}

      onUpdate = (payload?: any) => {
        try {
          // Scope real-time updates to the connected user's Rex group unless Admin/viewAll.
          if (!canViewAllRex) {
            const eventRexId =
              payload && typeof payload === "object" && "rexId" in payload
                ? payload.rexId
                : undefined;
            if (eventRexId !== undefined && eventRexId !== userRexId) {
              return;
            }
          }
          const line =
            payload === undefined
              ? "data: update\n\n"
              : `data: update ${JSON.stringify(payload)}\n\n`;
          controller.enqueue(enc.encode(line));
        } catch {}
      };

      sse.on("update", onUpdate);

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": heartbeat\n\n"));
        } catch {
          cleanup();
        }
      }, 15000);

      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (onUpdate) {
        sse.off("update", onUpdate);
        onUpdate = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
