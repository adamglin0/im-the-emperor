// 上奏（官员 → 皇帝待办）、待办查询、审批列表。
import type { Hono } from "hono";
import type { NotificationCategory, PetitionReq } from "@court/shared";
import { bad, forbidden, notFound, type HubCtx } from "../ctx.ts";
import { principal, queryInt, readJson, requireActingPost, requireTool } from "../auth.ts";
import { PETITION_CATEGORIES, type NotificationServiceExt } from "../services/notifications.ts";
import type { ApprovalServiceExt } from "../services/approvals.ts";

const DEFAULT_PETITION_OPTIONS = [
  { id: "approve", label: "准奏" },
  { id: "reject", label: "不准" },
  { id: "ack", label: "已阅" },
];

export function register(app: Hono, ctx: HubCtx): void {
  const notifications = () => ctx.notifications as NotificationServiceExt;

  app.post("/api/notifications", async (c) => {
    const req = await readJson<PetitionReq>(c);
    const p = principal(c);
    if (p.kind === "gateway") throw forbidden("网关不能上奏");
    if (req.kind !== "action_required" && req.kind !== "fyi") throw bad("kind 只能是 action_required（需批复）或 fyi（知会）");
    requireTool(c, req.kind === "fyi" ? "report_progress" : "petition_emperor");
    const post = requireActingPost(c, req.post);
    const from = post === "emperor" || post.startsWith("system:") ? post : `post:${post}`;
    const title = String(req.title ?? "").trim();
    if (!title) throw bad("title（奏章标题）不能为空");
    if (title.length > 200) throw bad("title 过长（上限 200 字）");
    const body = String(req.body ?? "");
    if (body.length > 20_000) throw bad("正文过长（上限 20000 字），长内容请存为资产后附 ID");
    const category: NotificationCategory = req.category ?? (req.kind === "fyi" ? "progress" : "petition");
    if (!PETITION_CATEGORIES.includes(category)) throw bad(`上奏类别只能是 ${PETITION_CATEGORIES.join("/")}`);
    let options = req.kind === "fyi" ? [] : (req.options ?? DEFAULT_PETITION_OPTIONS);
    if (!Array.isArray(options) || options.length > 6) throw bad("options 必须是数组且不超过 6 项");
    options = options.map((o) => {
      if (!o || typeof o.id !== "string" || !o.id || typeof o.label !== "string") throw bad("每个选项须有 id 与 label");
      return { id: o.id.slice(0, 40), label: o.label.slice(0, 40) };
    });
    const key = req.idem_key ? `petition:${from}:${req.idem_key}` : undefined;
    const n = ctx.idem.wrap(key, () =>
      ctx.db.tx(() => {
        if (from.startsWith("post:")) {
          if (req.kind === "fyi") notifications().checkFyiRate(from);
          else ctx.notifications.checkPetitionRate(from);
        }
        return ctx.notifications.create({
          kind: req.kind,
          category,
          title,
          body,
          from,
          options,
          related: req.related,
          trace_id: req.trace_id,
        });
      }),
    );
    return c.json(n);
  });

  app.get("/api/notifications", (c) => {
    const status = c.req.query("status") || undefined;
    if (status && !["pending", "resolved", "dismissed"].includes(status)) throw bad("status 只能是 pending/resolved/dismissed");
    return c.json(ctx.notifications.list(status, queryInt(c, "limit", 100, 1, 500)));
  });

  app.get("/api/notifications/:id", (c) => {
    const n = ctx.notifications.get(c.req.param("id"));
    if (!n) throw notFound(`待办 ${c.req.param("id")}`);
    return c.json(n);
  });

  app.get("/api/approvals", (c) => {
    const status = c.req.query("status") || undefined;
    if (status && !["pending", "approved", "rejected"].includes(status)) throw bad("status 只能是 pending/approved/rejected");
    return c.json((ctx.approvals as ApprovalServiceExt).list(status, queryInt(c, "limit", 100, 1, 500)));
  });
}
