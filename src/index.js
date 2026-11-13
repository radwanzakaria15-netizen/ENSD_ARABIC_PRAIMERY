const KEY_PATTERN = /^[AB]-\\d{2}-\\d{2}-\\d{2}$/;
const MAX_FILE_SIZE = 4_200_000;

const json = (value, status = 200) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });

function isAdmin(request, env) {
  const expected = String(env.ADMIN_CODE || "").trim();
  const supplied = String(request.headers.get("x-admin-code") || "").trim();
  return Boolean(expected) && supplied === expected;
}

async function listLessons(bucket) {
  const keys = [];
  let cursor;
  do {
    const page = await bucket.list({ cursor, limit: 1000 });
    for (const object of page.objects) {
      if (KEY_PATTERN.test(object.key)) keys.push(object.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";

  if (!env.LESSONS_BUCKET) {
    return json({ error: "storage_not_configured" }, 503);
  }

  if (url.pathname === "/api/lessons") {
    if (request.method === "GET") {
      try {
        return json(await listLessons(env.LESSONS_BUCKET));
      } catch (error) {
        console.error("Lessons list failed:", error);
        return json({ error: "storage_error", message: String(error?.message || "Unknown storage error").slice(0, 240) }, 500);
      }
    }

    if (request.method === "POST") {
      if (!String(env.ADMIN_CODE || "").trim()) {
        return json({ error: "admin_code_not_configured" }, 503);
      }
      return isAdmin(request, env)
        ? json({ ok: true })
        : json({ error: "unauthorized" }, 401);
    }

    return json({ error: "method_not_allowed" }, 405);
  }

  if (url.pathname !== "/api/file" || !KEY_PATTERN.test(key)) {
    return json({ error: "not_found" }, 404);
  }

  if (request.method !== "GET" && !isAdmin(request, env)) {
    if (!String(env.ADMIN_CODE || "").trim()) {
      return json({ error: "admin_code_not_configured" }, 503);
    }
    return json({ error: "unauthorized" }, 401);
  }

  try {
    if (request.method === "GET") {
      const object = await env.LESSONS_BUCKET.get(key);
      if (!object) return json({ error: "not_found" }, 404);

      const etag = object.httpEtag;
      if (etag && request.headers.get("if-none-match") === etag) {
        return new Response(null, {
          status: 304,
          headers: { etag, "cache-control": "private, max-age=0, must-revalidate" },
        });
      }

      const download = url.searchParams.get("download") === "1";
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("content-type", "application/pdf");
      headers.set(
        "content-disposition",
        download
          ? 'attachment; filename="lecture.pdf"'
          : 'inline; filename="lecture.pdf"',
      );
      headers.set("cache-control", "private, max-age=0, must-revalidate");
      headers.set("x-content-type-options", "nosniff");
      if (etag) headers.set("etag", etag);

      return new Response(object.body, { headers });
    }

    if (request.method === "POST") {
      const data = await request.arrayBuffer();
      if (!data.byteLength) return json({ error: "empty_file" }, 400);
      if (data.byteLength > MAX_FILE_SIZE) {
        return json({ error: "file_too_large", limit: MAX_FILE_SIZE }, 413);
      }

      const signature = new TextDecoder().decode(data.slice(0, 5));
      if (!signature.startsWith("%PDF-")) {
        return json({ error: "pdf_required" }, 400);
      }

      await env.LESSONS_BUCKET.put(key, data, {
        httpMetadata: {
          contentType: "application/pdf",
          contentDisposition: 'inline; filename="lecture.pdf"',
        },
        customMetadata: { uploadedAt: new Date().toISOString() },
      });

      const saved = await env.LESSONS_BUCKET.head(key);
      if (!saved || saved.size !== data.byteLength) {
        throw new Error("Stored PDF verification failed");
      }
      return json({ ok: true, key, size: saved.size });
    }

    if (request.method === "DELETE") {
      const existing = await env.LESSONS_BUCKET.head(key);
      if (!existing) return json({ error: "not_found" }, 404);
      await env.LESSONS_BUCKET.delete(key);
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
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/lessons" || url.pathname === "/api/file") {
      return handleApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
