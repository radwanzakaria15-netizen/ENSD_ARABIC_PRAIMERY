const KEY_PATTERN = /^[AB]-\d{2}-\d{2}-\d{2}$/;
const MAX_FILE_SIZE = 4_200_000;
const encoder = new TextEncoder();

const json = (value, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

function isAdmin(request, env) {
  const expected = String(env.ADMIN_CODE || "").trim();
  const supplied = String(request.headers.get("x-admin-code") || "").trim();
  return Boolean(expected) && supplied === expected;
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(value) {
  return hex(await crypto.subtle.digest("SHA-256", value));
}

async function hmac(key, value) {
  const imported = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(value)));
}

function encodeRFC3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function canonicalQuery(params) {
  return [...params.entries()]
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
    .map(([k, v]) => encodeRFC3986(k) + "=" + encodeRFC3986(v))
    .join("&");
}

async function signedB2Request(env, method, key = "", body = null, extraQuery = {}, contentType = "") {
  const endpoint = String(env.B2_ENDPOINT || "").replace(/\/$/, "");
  const bucket = String(env.B2_BUCKET || "");
  const region = String(env.B2_REGION || "");
  const accessKey = String(env.B2_KEY_ID || "");
  const secretKey = String(env.B2_APPLICATION_KEY || "");
  if (!endpoint || !bucket || !region || !accessKey || !secretKey) {
    throw new Error("Backblaze B2 credentials are not configured");
  }

  const base = new URL(endpoint);
  const encodedKey = key ? "/" + key.split("/").map(encodeRFC3986).join("/") : "/";
  const url = new URL(base.origin + "/" + encodeRFC3986(bucket) + encodedKey);
  for (const [name, value] of Object.entries(extraQuery)) {
    if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }

  const payloadHash = await sha256(body ?? new ArrayBuffer(0));
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const headersToSign = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) headersToSign["content-type"] = contentType;

  const signedHeaders = Object.keys(headersToSign).sort().join(";");
  const canonicalHeaders = Object.keys(headersToSign).sort()
    .map((name) => name + ":" + String(headersToSign[name]).trim() + "\n").join("");
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = dateStamp + "/" + region + "/s3/aws4_request";
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256(encoder.encode(canonicalRequest)),
  ].join("\n");

  const kDate = await hmac(encoder.encode("AWS4" + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey("raw", kSigning, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    encoder.encode(stringToSign)
  ));

  const headers = new Headers({
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    authorization: "AWS4-HMAC-SHA256 Credential=" + accessKey + "/" + scope +
      ", SignedHeaders=" + signedHeaders + ", Signature=" + signature,
  });
  if (contentType) headers.set("content-type", contentType);
  return fetch(url, { method, headers, body: body === null ? undefined : body });
}

function xmlText(xml, tag) {
  const match = xml.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">"));
  return match ? match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'") : "";
}

async function listLessons(env) {
  const keys = [];
  let token = "";
  for (let page = 0; page < 100; page++) {
    const response = await signedB2Request(env, "GET", "", null, {
      "list-type": "2",
      "max-keys": "1000",
      ...(token ? { "continuation-token": token } : {}),
    });
    if (!response.ok) throw new Error("B2 list failed (" + response.status + "): " + (await response.text()).slice(0, 180));
    const xml = await response.text();
    for (const match of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
      const key = match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<");
      if (KEY_PATTERN.test(key)) keys.push(key);
    }
    if (xmlText(xml, "IsTruncated") !== "true") break;
    token = xmlText(xml, "NextContinuationToken");
    if (!token) break;
  }
  return keys;
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";
  const hasB2 = env.B2_ENDPOINT && env.B2_BUCKET && env.B2_REGION &&
    env.B2_KEY_ID && env.B2_APPLICATION_KEY;
  if (!hasB2) return json({ error: "storage_not_configured" }, 503);

  if (url.pathname === "/api/lessons") {
    if (request.method === "GET") {
      try { return json(await listLessons(env)); }
      catch (error) {
        console.error("B2 list failed:", error);
        return json({ error: "storage_error", message: String(error.message || error).slice(0, 240) }, 502);
      }
    }
    if (request.method === "POST") {
      if (!String(env.ADMIN_CODE || "").trim()) return json({ error: "admin_code_not_configured" }, 503);
      return isAdmin(request, env) ? json({ ok: true }) : json({ error: "unauthorized" }, 401);
    }
    return json({ error: "method_not_allowed" }, 405);
  }

  if (url.pathname !== "/api/file" || !KEY_PATTERN.test(key)) return json({ error: "not_found" }, 404);
  if (request.method !== "GET" && !isAdmin(request, env)) {
    if (!String(env.ADMIN_CODE || "").trim()) return json({ error: "admin_code_not_configured" }, 503);
    return json({ error: "unauthorized" }, 401);
  }

  try {
    if (request.method === "GET") {
      const response = await signedB2Request(env, "GET", key);
      if (response.status === 404) return json({ error: "not_found" }, 404);
      if (!response.ok) throw new Error("B2 download failed (" + response.status + "): " + (await response.text()).slice(0, 180));
      const headers = new Headers({
        "content-type": "application/pdf",
        "content-disposition": url.searchParams.get("download") === "1"
          ? 'attachment; filename="lecture.pdf"' : 'inline; filename="lecture.pdf"',
        "cache-control": "private, max-age=0, must-revalidate",
        "x-content-type-options": "nosniff",
      });
      const length = response.headers.get("content-length");
      if (length) headers.set("content-length", length);
      return new Response(response.body, { headers });
    }

    if (request.method === "POST") {
      const data = await request.arrayBuffer();
      if (!data.byteLength) return json({ error: "empty_file" }, 400);
      if (data.byteLength > MAX_FILE_SIZE) return json({ error: "file_too_large", limit: MAX_FILE_SIZE }, 413);
      const signature = new TextDecoder().decode(data.slice(0, 5));
      if (!signature.startsWith("%PDF-")) return json({ error: "pdf_required" }, 400);
      const response = await signedB2Request(env, "PUT", key, data, {}, "application/pdf");
      if (!response.ok) throw new Error("B2 upload failed (" + response.status + "): " + (await response.text()).slice(0, 180));
      return json({ ok: true, key, size: data.byteLength });
    }

    if (request.method === "DELETE") {
      const response = await signedB2Request(env, "DELETE", key);
      if (!response.ok && response.status !== 404) {
        throw new Error("B2 delete failed (" + response.status + "): " + (await response.text()).slice(0, 180));
      }
      return json({ ok: true, key });
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    console.error("B2 file operation failed:", error);
    return json({ error: "storage_error", message: String(error.message || error).slice(0, 240) }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/lessons" || url.pathname === "/api/file") return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};
