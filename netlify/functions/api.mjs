import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const store = getStore("arabic-primary-lessons");
  const key = url.searchParams.get("key") || "";
  const isAdmin = () => {
    const code = process.env.ADMIN_CODE;
    return !!code && req.headers.get("x-admin-code") === code;
  };

  if (url.pathname === "/api/lessons") {
    if (req.method === "POST") {
      return isAdmin() ? Response.json({ ok: true }) : new Response("unauthorized", { status: 401 });
    }
    if (req.method === "GET") {
      const { blobs } = await store.list();
      return Response.json(blobs.map((blob) => blob.key), {
        headers: { "cache-control": "no-store" },
      });
    }
  }

  if (url.pathname !== "/api/file" || !/^[AB]-\d{2}-\d{2}-\d{2}$/.test(key)) {
    return new Response("not found", { status: 404 });
  }

  if (req.method === "GET") {
    const data = await store.get(key, { type: "arrayBuffer" });
    if (!data) return new Response("not found", { status: 404 });
    return new Response(data, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": "inline",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  }

  if (!isAdmin()) return new Response("unauthorized", { status: 401 });

  if (req.method === "POST") {
    const data = await req.arrayBuffer();
    if (data.byteLength > 5_500_000) return new Response("file too large", { status: 413 });
    if (new TextDecoder().decode(data.slice(0, 4)) !== "%PDF") {
      return new Response("PDF required", { status: 400 });
    }
    await store.set(key, data, { metadata: { contentType: "application/pdf" } });
    return Response.json({ ok: true });
  }

  if (req.method === "DELETE") {
    await store.delete(key);
    return Response.json({ ok: true });
  }

  return new Response("method not allowed", { status: 405 });
};

export const config = { path: ["/api/lessons", "/api/file"] };
