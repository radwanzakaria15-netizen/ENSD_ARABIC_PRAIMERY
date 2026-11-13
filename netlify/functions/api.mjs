import { getStore } from "@netlify/blobs";

const json = (value, status = 200) => Response.json(value, {
  status,
  headers: { "cache-control": "no-store" },
});

const KEY_PATTERN = /^[AB]-\d{2}-\d{2}-\d{2}$/;
const STORE_NAME = "arabic-primary-lessons";

export default async (req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "";
  const isAdmin = () => {
    const expected = (process.env.ADMIN_CODE || "").trim();
    const supplied = (req.headers.get("x-admin-code") || "").trim();
    return Boolean(expected) && supplied === expected;
  };

  try {
    // Keep the admin check independent from storage initialization.
    // This lets the management login report an auth result even if Blobs
    // has a separate configuration problem.
    if (url.pathname === "/api/lessons") {
      if (req.method === "POST") {
        if (!(process.env.ADMIN_CODE || "").trim()) {
          return json({ error: "admin_code_not_configured" }, 503);
        }
        return isAdmin()
          ? json({ ok: true })
          : json({ error: "unauthorized" }, 401);
      }
      if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      const store = getStore(STORE_NAME);
      const { blobs } = await store.list();
      return json(blobs.map((blob) => blob.key));
    }

    if (url.pathname !== "/api/file" || !KEY_PATTERN.test(key)) {
      return json({ error: "not_found" }, 404);
    }

    if (req.method !== "GET" && !isAdmin()) {
      if (!(process.env.ADMIN_CODE || "").trim()) {
        return json({ error: "admin_code_not_configured" }, 503);
      }
      return json({ error: "unauthorized" }, 401);
    }

    const store = getStore(STORE_NAME);

    if (req.method === "GET") {
      const data = await store.get(key, { type: "arrayBuffer" });
      if (!data) return json({ error: "not_found" }, 404);
      return new Response(data, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'inline; filename="lecture.pdf"',
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }

    if (req.method === "POST") {
      const data = await req.arrayBuffer();
      if (!data.byteLength) return json({ error: "empty_file" }, 400);
      if (data.byteLength > 4_200_000) {
        return json({ error: "file_too_large", limit: 4_200_000 }, 413);
      }
      const signature = new TextDecoder().decode(data.slice(0, 5));
      if (!signature.startsWith("%PDF-")) return json({ error: "pdf_required" }, 400);

      // Pass a standards-based Blob to Netlify Blobs, rather than a typed
      // array view whose support can vary between runtime versions.
      const pdf = new Blob([data], { type: "application/pdf" });
      await store.set(key, pdf, {
        metadata: { contentType: "application/pdf" },
      });

      const saved = await store.get(key, { type: "arrayBuffer" });
      if (!saved || saved.byteLength !== data.byteLength) {
        throw new Error("Stored PDF verification failed");
      }
      return json({ ok: true, key, size: saved.byteLength });
    }

    if (req.method === "DELETE") {
      const existing = await store.getMetadata(key);
      if (!existing) return json({ error: "not_found" }, 404);
      await store.delete(key);
      return json({ ok: true, key });
    }

    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    console.error("Lessons API error:", error);
    return json({
      error: "storage_error",
      message: String(error?.message || "Unknown storage error").slice(0, 240),
    }, 500);
  }
};

export const config = { path: ["/api/lessons", "/api/file"] };
