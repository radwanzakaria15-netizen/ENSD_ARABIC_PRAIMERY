/* ===== سجل النشاط داخل Cloudflare Worker =====
   - التخزين في Cloudflare KV (وليس B2): قيمة واحدة اسمها "history" محدودة بـ 500 حدث (~100KB).
   - الكتابة: مرة واحدة لكل دفعة أحداث (الموقع يجمّعها كل 20 ثانية) = عشرات المرات يوميًا كحد أقصى
     (الحد المجاني لـ KV: 1000 كتابة / 100,000 قراءة يوميًا).
   - القراءة: فقط عند ضغط المشرف على زر «السجل». لا يقرأ الطلبة شيئًا من هذا المسار.

   الإعداد (مرة واحدة):
   1) Cloudflare ▸ Workers & Pages ▸ KV ▸ Create namespace باسم HISTORY_KV
   2) في إعدادات الـ Worker ▸ Bindings ▸ KV namespace: الاسم HISTORY_KV
   3) الصق الدالة أدناه في ملف الـ Worker، ثم أضف في دالة fetch الرئيسية، قبل بقية المسارات:

        if (url.pathname === "/api/history") return handleHistory(request, env);

   4) عدّل isAdmin بحيث تستعمل نفس فحص الرمز الموجود عندك في بقية المسارات.
*/
const HISTORY_MAX = 500;

function isAdmin(request, env) {
  const code = request.headers.get("x-admin-code") || request.headers.get("x-academic-admin-code") || "";
  // عدّل أسماء المتغيرات هنا لتطابق ما هو مضبوط عندك فعلًا في الـ Worker:
  const valid = [env.ADMIN_CODE, env.ADMIN_CODE_A, env.ADMIN_CODE_B, env.ACADEMIC_ADMIN_CODE].filter(Boolean);
  return !!code && valid.includes(code);
}

async function handleHistory(request, env) {
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  if (!isAdmin(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.HISTORY_KV) return json({ ok: false, error: "history_not_configured" }, 501);

  const url = new URL(request.url);

  if (request.method === "GET") {
    const items = (await env.HISTORY_KV.get("history", "json")) || [];
    return json({ items });
  }

  if (request.method === "POST" && url.searchParams.get("action") === "log") {
    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
    const incoming = (Array.isArray(body.events) ? body.events : []).slice(0, 50);
    const clean = incoming.map((e) => ({
      id: String(e.id || "").slice(0, 24),
      ts: Number(e.ts) || Date.now(),
      kind: ["add", "edit", "delete", "approve", "login", "logout", "activity", "other"].includes(e.kind) ? e.kind : "other",
      text: String(e.text || "").slice(0, 160),
      target: String(e.target || "").slice(0, 220),
      by: String(e.by || "").slice(0, 60),
    })).filter((e) => e.id && e.text);
    if (!clean.length) return json({ ok: true, added: 0 });

    const cur = (await env.HISTORY_KV.get("history", "json")) || [];
    const seen = new Set(cur.map((x) => x.id));
    for (const e of clean) if (!seen.has(e.id)) cur.push(e);
    cur.sort((a, b) => a.ts - b.ts);
    await env.HISTORY_KV.put("history", JSON.stringify(cur.slice(-HISTORY_MAX)));
    return json({ ok: true, added: clean.length });
  }

  return json({ ok: false, error: "method_not_allowed" }, 405);
}
