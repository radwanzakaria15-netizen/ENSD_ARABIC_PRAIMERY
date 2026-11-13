import { getStore } from "@netlify/blobs";

const json = (value, status = 200) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });

export default async (req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "";
  const store = getStore("arabic-primary-lessons");

  const isAdmin = () => {
    const code = process.env.ADMIN_CODE;
    return Boolean(code) && req.headers.get("x-admin-code") === code;
  };

  try {
    if (url.pathname === "/api/lessons") {
      if (req.method === "POST") {
        return isAdmin()
          ? json({ ok: true })
          : json({ error: "unauthorized" }, 401);
      }

      if (req.method === "GET") {
        const { blobs } = await store.list();
        return json(blobs.map((blob) => blob.key));
      }

      return json({ error: "method_not_allowed" }, 405);
    }

    if (
      url.pathname !== "/api/file" ||
      !/^[AB]-\d{2}-\d{2}-\d{2}$/.test(key)
    ) {
      return json({ error: "not_found" }, 404);
    }

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

    if (!isAdmin()) {
      return json({ error: "unauthorized" }, 401);
    }

    if (req.method === "POST") {
      const data = await req.arrayBuffer();

      if (!data.byteLength) {
        return json({ error: "empty_file" }, 400);
      }
      if (data.byteLength > 5_500_000) {
        return json({ error: "file_too_large", limit: 5_500_000 }, 413);
      }

      const signature = new TextDecoder().decode(data.slice(0, 5));
      if (!signature.startsWith("%PDF-")) {
        return json({ error: "pdf_required" }, 400);
      }

      // Netlify Blobs accepts byte arrays; convert the request ArrayBuffer
      // explicitly before storing it to avoid upload failures.
      await store.set(key, new Uint8Array(data), {
        metadata: { contentType: "application/pdf" },
      });

      const saved = await store.get(key, { type: "arrayBuffer" });
      if (!saved || saved.byteLength !== data.byteLength) {
        throw new Error("Stored PDF verification failed");
      }

      return json({ ok: true, key, size: saved.byteLength });
    }

    if (req.method === "DELETE") {
      await store.delete(key);
      return json({ ok: true, key });
    }

    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    console.error("Lessons API error:", error);
    return json({ error: "storage_error" }, 500);
  }
};

export const config = { path: ["/api/lessons", "/api/file"] };
