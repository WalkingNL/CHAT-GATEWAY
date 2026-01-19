import http from "node:http";

import type { LLMProvider, ChatMessage } from "./providers/base.js";
import { TaskStore } from "./task_store.js";
import { CognitiveStore, type CognitiveStatus } from "./cognitive_store.js";

export type InternalApiOpts = {
  host: string;
  port: number;
  token: string;
  storageDir: string;
  provider: LLMProvider;
};

export type InternalApiHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const raw = Buffer.concat(chunks).toString("utf-8") || "{}";
  return JSON.parse(raw);
}

function badRequest(res: http.ServerResponse, msg: string) {
  res.statusCode = 400;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: false, error: msg }));
}

function unauthorized(res: http.ServerResponse) {
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
}

function notFound(res: http.ServerResponse) {
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: false, error: "not_found" }));
}

function okJson(res: http.ServerResponse, body: any) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function extractFirstJsonObject(text: string): string | null {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    } else {
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          return s.slice(start, i + 1);
        }
      }
    }
  }

  return null;
}

export function createInternalApiHandler(opts: InternalApiOpts): InternalApiHandler {
  const { host, port, token } = opts;
  if (!token) throw new Error("Missing CHAT_GATEWAY_TOKEN");

  return async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);

    // Auth (all endpoints)
    const auth = String(req.headers["authorization"] || "");
    if (auth !== `Bearer ${token}`) return unauthorized(res);

    // Health
    if (req.method === "GET" && url.pathname === "/health") {
      return okJson(res, { ok: true });
    }

    // Tasks (analyze/suggest)
    if (req.method === "POST" && url.pathname === "/v1/tasks") {
      const store = new TaskStore(opts.storageDir);

      let body: any;
      try {
        body = await readJson(req);
      } catch {
        return badRequest(res, "invalid_json");
      }

      const taskId = String(body.task_id || "").trim();
      const stage = String(body.stage || "").trim();
      const prompt = String(body.prompt || "").trim();
      const context = body.context ?? {};

      if (!taskId) return badRequest(res, "missing_task_id");
      if (stage !== "analyze" && stage !== "suggest") return badRequest(res, "unsupported_stage");
      if (!prompt) return badRequest(res, "missing_prompt");

      // idempotent
      const cached = store.get(taskId);
      if (cached) {
        return okJson(res, { ...cached, cached: true });
      }

      const t0 = Date.now();
      const systemAnalyze = "You are a rigorous engineering assistant. Facts-only. No predictions. No risky actions.";
      const systemSuggest =
        "You are a rigorous engineering assistant. Facts-only. No risky actions. " +
        "Return STRICT JSON only. No markdown.";

      const userAnalyze = `CONTEXT:\n${JSON.stringify(context).slice(0, 8000)}\n\nPROMPT:\n${prompt}`;

      const userSuggest =
        `You MUST return STRICT JSON only with keys:\n` +
        `- summary: string\n` +
        `- suggested_patch: string (MUST be a FULL git unified diff starting with "diff --git", or empty string)\n` +
        `- files_touched: string[] (repo-relative paths only, e.g. "tools/run_daily_activity_push.sh")\n` +
        `- verify_cmds: string[] (repo-relative commands; do NOT use absolute /srv paths)\n` +
        `- warnings: string[]\n` +
        `No extra keys. No markdown. No code fences.\n\n` +
        `Constraints:\n` +
        `1) If you output a patch, it MUST include standard headers like:\n` +
        `   diff --git a/<path> b/<path>\n` +
        `   --- a/<path>\n` +
        `   +++ b/<path>\n` +
        `   @@ ...\n` +
        `2) Use repo-relative paths ONLY. Never output absolute "/srv/...".\n` +
        `3) The patch MUST be minimal and safe.\n` +
        `4) If FILE SNIPPETS are provided below for a file, your patch MUST apply to that exact content.\n` +
        `   If the change is already present, set suggested_patch="" and add warning "already_applied".\n` +
        `5) Include sufficient hunk context (>=3 lines around changes) so 'git apply --check' can succeed.\n\n` +
        `FILE SNIPPETS (authoritative, if present):\n` +
        `${JSON.stringify((context as any)?.file_snippets || {}, null, 2).slice(0, 12000)}\n\n` +
        `OTHER CONTEXT:\n` +
        `${JSON.stringify({ ...context, file_snippets: undefined }).slice(0, 6000)}\n\n` +
        `ISSUE:\n${prompt}`;

      const messages: ChatMessage[] =
        stage === "suggest"
          ? [
            { role: "system", content: systemSuggest },
            { role: "user", content: userSuggest },
          ]
          : [
            { role: "system", content: systemAnalyze },
            { role: "user", content: userAnalyze },
          ];

      let output = "";
      try {
        output = await opts.provider.generate({ messages });
      } catch (e: any) {
        const out = {
          ok: false,
          task_id: taskId,
          stage,
          error: `llm_failed: ${String(e?.message || e)}`,
          ts_utc: new Date().toISOString(),
        };
        store.put(taskId, out);
        return okJson(res, out);
      }

      if (stage === "suggest") {
        let obj: any = null;
        let extracted_used = false;
        let extracted_tail: string | undefined = undefined;

        try {
          obj = JSON.parse(output);
        } catch {
          const extracted = extractFirstJsonObject(output);
          if (!extracted) {
            const out = {
              ok: false,
              task_id: taskId,
              stage,
              error: "llm_non_json",
              raw_tail: String(output).slice(-800),
              ts_utc: new Date().toISOString(),
              latency_ms: Date.now() - t0,
            };
            store.put(taskId, out);
            return okJson(res, out);
          }

          extracted_tail = String(extracted).slice(-800);

          try {
            obj = JSON.parse(extracted);
            extracted_used = true;
          } catch {
            const out = {
              ok: false,
              task_id: taskId,
              stage,
              error: "llm_non_json",
              raw_tail: String(output).slice(-800),
              extracted_tail,
              ts_utc: new Date().toISOString(),
              latency_ms: Date.now() - t0,
            };
            store.put(taskId, out);
            return okJson(res, out);
          }
        }

        // normalize helpers
        const toStrList = (x: any): string[] => (Array.isArray(x) ? x.map(String).filter(Boolean) : []);
        const warn: string[] = toStrList(obj.warnings);

        let suggestedPatch = String(obj.suggested_patch || "");
        let filesTouched = toStrList(obj.files_touched);
        let verifyCmds = toStrList(obj.verify_cmds);

        // ---- enforce repo-relative paths ----
        const isAbs = (p: string) => p.startsWith("/") || p.includes(":/");
        const hasSrv = (p: string) => p.includes("/srv/");

        const badPaths = filesTouched.filter(p => isAbs(p) || hasSrv(p));
        if (badPaths.length > 0) {
          warn.push(`files_touched_not_repo_relative: ${badPaths.slice(0, 3).join(", ")}`);
          // best-effort strip /srv/<project>/ prefix to repo-relative
          filesTouched = filesTouched.map(p => p.replace(/^\/srv\/[^/]+\//, ""));
          filesTouched = filesTouched.filter(p => !isAbs(p));
        }

        const badCmds = verifyCmds.filter(c => c.includes("/srv/") || c.startsWith("cd /srv/"));
        if (badCmds.length > 0) {
          warn.push("verify_cmds_contains_absolute_paths");
          verifyCmds = verifyCmds.map(c => c.replace(/^cd \/srv\/[^/]+ &&\s*/g, "").replace(/\/srv\/[^/]+\//g, ""));
        }

        // ---- patch format sanity ----
        // ---- patch completeness sanity (prevent corrupt/truncated diffs) ----
        const patchLooksComplete = (p: string): boolean => {
          const s = String(p || "");
          if (!s) return true; // empty patch is allowed
          if (!s.includes("diff --git ")) return false;
          if (!s.includes("\n--- a/")) return false;
          if (!s.includes("\n+++ b/")) return false;
          if (!s.includes("\n@@")) return false;

          // Must end with newline (common cause of "corrupt patch")
          if (!s.endsWith("\n")) return false;

          // Heuristic: after the LAST @@ hunk header, there should be at least one
          // line starting with ' ' or '+' or '-' (actual hunk content).
          const lastAt = s.lastIndexOf("\n@@");
          if (lastAt >= 0) {
            const tail = s.slice(lastAt + 1);
            const hasHunkLine = tail.split("\n").some(line =>
              line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"),
            );
            if (!hasHunkLine) return false;
          }

          return true;
        };

        if (suggestedPatch) {
          // normalize: ensure trailing newline
          if (!suggestedPatch.endsWith("\n")) {
            warn.push("patch_missing_trailing_newline");
            suggestedPatch = suggestedPatch + "\n";
          }

          // ensure index line exists (makes git apply more tolerant)
          const lines = suggestedPatch.split("\n");
          if (lines[0]?.startsWith("diff --git ") && !lines.some(l => l.startsWith("index "))) {
            // insert index line after first line
            lines.splice(1, 0, "index 0000000..0000000 100644");
            suggestedPatch = lines.join("\n");
            warn.push("patch_index_injected");
          }

          if (!patchLooksComplete(suggestedPatch)) {
            const out = {
              ok: false,
              task_id: taskId,
              stage,
              error: "patch_truncated_or_invalid",
              ts_utc: new Date().toISOString(),
              latency_ms: Date.now() - t0,
              extracted_used,
              ...(extracted_tail ? { extracted_tail } : {}),
              // keep audit tails
              patch_tail: String(suggestedPatch).slice(-1200),
              warnings: warn.concat(["patch_rejected_by_gateway"]),
            };
            store.put(taskId, out);
            return okJson(res, out);
          }
        }

        // optional: trim extremely long fields
        // optional: hard cap; if exceeded, reject (do NOT truncate into a corrupt diff)
        if (suggestedPatch.length > 20000) {
          const out = {
            ok: false,
            task_id: taskId,
            stage,
            error: "patch_too_long",
            ts_utc: new Date().toISOString(),
            latency_ms: Date.now() - t0,
            extracted_used,
            ...(extracted_tail ? { extracted_tail } : {}),
            patch_tail: String(suggestedPatch).slice(-1200),
            warnings: warn.concat(["patch_rejected_by_gateway: too_long"]),
          };
          store.put(taskId, out);
          return okJson(res, out);
        }
      }

      // analyze response (text)
      const resp = {
        ok: true,
        task_id: taskId,
        stage,
        ts_utc: new Date().toISOString(),
        latency_ms: Date.now() - t0,
        summary: output,
      };

      store.put(taskId, resp);
      return okJson(res, resp);
    }

    if (req.method === "GET" && url.pathname === "/v1/cognitive/items") {
      const store = new CognitiveStore(opts.storageDir);
      const rawStatus = String(url.searchParams.get("status") || "");
      const statusSet = new Set(["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "DISMISSED"]);
      const statuses = rawStatus
        .split(",")
        .map(s => s.trim().toUpperCase())
        .filter(s => statusSet.has(s));
      const limitRaw = Number(url.searchParams.get("limit") || 0);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 200;
      const items = store.listItems({ status: statuses.length ? (statuses as CognitiveStatus[]) : undefined, limit });
      return okJson(res, { ok: true, items });
    }

    if (req.method === "POST" && url.pathname === "/v1/cognitive/update") {
      let body: any;
      try {
        body = await readJson(req);
      } catch {
        return badRequest(res, "invalid_json");
      }
      const id = String(body.id || body.issue_id || body.short_id || "").trim();
      const status = String(body.status || "").trim().toUpperCase();
      const statusSet = new Set(["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "DISMISSED"]);
      if (!id) return badRequest(res, "missing_id");
      if (!statusSet.has(status)) return badRequest(res, "invalid_status");
      const store = new CognitiveStore(opts.storageDir);
      const item = await store.updateStatus(id, status as CognitiveStatus, body.updated_by);
      if (!item) return notFound(res);
      return okJson(res, { ok: true, item });
    }

    if (req.method === "POST" && url.pathname === "/v1/cognitive/migrate") {
      let body: any;
      try {
        body = await readJson(req);
      } catch {
        return badRequest(res, "invalid_json");
      }
      const items = Array.isArray(body?.items) ? body.items : null;
      if (!items || items.length === 0) return badRequest(res, "missing_items");
      const store = new CognitiveStore(opts.storageDir);
      const result = await store.importItems(items);
      return okJson(res, { ok: true, ...result });
    }

    return notFound(res);
  };
}

export function startInternalApi(opts: InternalApiOpts) {
  const { host, port } = opts;
  const handler = createInternalApiHandler(opts);
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });

  server.listen(port, host, () => {
    console.log(`[internal-api] listening on http://${host}:${port}`);
  });

  return server;
}
