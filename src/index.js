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
  const match = xml.match(new RegExp("<" + tag + ">([\s\S]*?)</" + tag + ">"));
  return match ? match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'") : "";
}

function safeFileName(value) {
  const name = String(value || "document").replace(/[\/\\\u0000-\u001f\u007f]/g, "_").trim().slice(0, 140);
  return name || "document";
}

function contentTypeForName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "application/octet-stream";
}

function fileInfo(key, size = 0) {
  if (KEY_PATTERN.test(key)) {
    return { lessonKey: key, key, name: "محاضرة سابقة.pdf", type: "application/pdf", size: Number(size) || 0, legacy: true };
  }
  const slash = key.indexOf("/");
  if (slash < 0) return null;
  const lessonKey = key.slice(0, slash);
  const storedName = key.slice(slash + 1);
  if (!KEY_PATTERN.test(lessonKey) || /^[\/\\\u0000-\u001f\u007f]/u.test(storedName) || storedName.length > 190) return null;
  const marker = storedName.indexOf("__");
  const name = marker >= 0 ? storedName.slice(marker + 2) : storedName;
  if (!name) return null;
  const type = contentTypeForName(name);
  if (type === "application/octet-stream") return null;
  return { lessonKey, key, name, type, size: Number(size) || 0, legacy: false };
}

function validStoredKey(key) {
  if (KEY_PATTERN.test(key)) return true;
  return Boolean(fileInfo(key));
}

async function listLessons(env) {
  const files = [];
  let token = "";
  for (let page = 0; page < 100; page++) {
    const response = await signedB2Request(env, "GET", "", null, {
      "list-type": "2",
      "max-keys": "1000",
      ...(token ? { "continuation-token": token } : {}),
    });
    if (!response.ok) throw new Error("B2 list failed (" + response.status + "): " + (await response.text()).slice(0, 180));
    const xml = await response.text();
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = match[1];
      const key = xmlText(block, "Key");
      const size = xmlText(block, "Size");
      const info = fileInfo(key, size);
      if (info) files.push(info);
    }
    if (xmlText(xml, "IsTruncated") !== "true") break;
    token = xmlText(xml, "NextContinuationToken");
    if (!token) break;
  }
  files.sort((a, b) => a.lessonKey.localeCompare(b.lessonKey) || a.name.localeCompare(b.name, "ar"));
  return files;
}


async function listObjectsByPrefix(env, prefix) {
 const out=[]; let token="";
 for(let page=0;page<20;page++){
  const r=await signedB2Request(env,"GET","",null,{"list-type":"2","max-keys":"1000",prefix,...(token?{"continuation-token":token}:{})});
  if(!r.ok)throw new Error("B2 list failed ("+r.status+")");
  const xml=await r.text();
  for(const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g))out.push({key:xmlText(m[1],"Key")});
  if(xmlText(xml,"IsTruncated")!=="true")break; token=xmlText(xml,"NextContinuationToken"); if(!token)break;
 }
 return out;
}
async function readResourceMeta(env,key){const r=await signedB2Request(env,"GET",key);if(!r.ok)return null;try{return await r.json()}catch{return null}}
async function deleteResourceObject(env,key){const r=await signedB2Request(env,"DELETE",key);if(!r.ok&&r.status!==404)throw new Error("B2 delete failed ("+r.status+")")}
async function handleResources(request,env){
 const u=new URL(request.url),action=u.searchParams.get("action")||"",id=u.searchParams.get("id")||"",admin=isAdmin(request,env);
 if(request.method==="GET"){
  const status=u.searchParams.get("status")==="pending"&&admin?"pending":"approved";
  if(u.searchParams.get("status")==="pending"&&!admin)return json({error:"unauthorized"},401);
  try{const objects=await listObjectsByPrefix(env,"resources/"+status+"/"),items=[];
   for(const o of objects){if(!o.key.endsWith(".json"))continue;const m=await readResourceMeta(env,o.key);if(m?.id&&m.fileKey)items.push({...m,status})}
   items.sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));return json(items);
  }catch(e){return json({error:"storage_error",message:String(e.message||e).slice(0,200)},502)}
 }
 if(request.method==="POST"&&action){
  if(!admin)return json({error:"unauthorized"},401);
  if(!/^[a-f0-9-]{36}$/i.test(id))return json({error:"invalid_resource_id"},400);
  const base="resources/pending/"+id,meta=await readResourceMeta(env,base+".json");
  if(!meta)return json({error:"not_found"},404);
  try{
   if(action==="approve"){
    const src=await signedB2Request(env,"GET",meta.fileKey);if(!src.ok)throw new Error("Pending file missing");
    const data=await src.arrayBuffer(),fileKey="resources/approved/"+id+"__"+safeFileName(meta.fileName);
    const put=await signedB2Request(env,"PUT",fileKey,data,{},meta.contentType);if(!put.ok)throw new Error("Could not publish resource");
    const approved={...meta,fileKey,status:"approved",approvedAt:new Date().toISOString()};
    const saved=await signedB2Request(env,"PUT","resources/approved/"+id+".json",encoder.encode(JSON.stringify(approved)),{},"application/json");
    if(!saved.ok)throw new Error("Could not save resource metadata");
   }else if(action!=="reject")return json({error:"invalid_action"},400);
   await deleteResourceObject(env,meta.fileKey);await deleteResourceObject(env,base+".json");return json({ok:true,action,id});
  }catch(e){return json({error:"storage_error",message:String(e.message||e).slice(0,200)},502)}
 }
 return json({error:"method_not_allowed"},405);
}
async function handleResourceFile(request,env){
 const u=new URL(request.url),key=u.searchParams.get("key")||"";
 if(request.method==="POST"){
  const name=safeFileName(u.searchParams.get("name")),type=contentTypeForName(name);
  if(type==="application/octet-stream")return json({error:"unsupported_file_type"},400);
  const meta={id:crypto.randomUUID(),title:String(u.searchParams.get("title")||"").trim().slice(0,120),year:String(u.searchParams.get("year")||""),semester:String(u.searchParams.get("semester")||""),subject:String(u.searchParams.get("subject")||"").trim().slice(0,100),kind:String(u.searchParams.get("kind")||""),fileName:name,contentType:type,createdAt:new Date().toISOString()};
  if(!/^السنة [1-6]$/.test(meta.year)||!/^السداسي [12]$/.test(meta.semester)||!meta.subject||!["كتاب","درس ومحاضرة","ملخص","تمارين محلولة","سلسلة تمارين","امتحانات سابقة","مراجع أخرى"].includes(meta.kind))return json({error:"invalid_resource_metadata"},400);
  const data=await request.arrayBuffer();if(!data.byteLength)return json({error:"empty_file"},400);if(data.byteLength>MAX_FILE_SIZE)return json({error:"file_too_large",limit:MAX_FILE_SIZE},413);
  const b=new Uint8Array(data),pdf=type==="application/pdf"&&new TextDecoder().decode(b.slice(0,5)).startsWith("%PDF-"),doc=type==="application/msword"&&b.length>=8&&b.slice(0,8).every((v,i)=>v===[0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1][i]),docx=type==="application/vnd.openxmlformats-officedocument.wordprocessingml.document"&&b[0]===0x50&&b[1]===0x4B;
  if(!(pdf||doc||docx))return json({error:"file_type_mismatch"},400);
  const base="resources/pending/"+meta.id;meta.fileKey=base+"__"+name;
  const put=await signedB2Request(env,"PUT",meta.fileKey,data,{},type);if(!put.ok)return json({error:"storage_error"},502);
  const save=await signedB2Request(env,"PUT",base+".json",encoder.encode(JSON.stringify(meta)),{},"application/json");
  if(!save.ok){await deleteResourceObject(env,meta.fileKey);return json({error:"storage_error"},502)}
  return json({ok:true,pending:true,id:meta.id});
 }
 if(request.method==="GET"){
  const approved=key.startsWith("resources/approved/")&&!key.includes(".."),pending=key.startsWith("resources/pending/")&&!key.includes("..")&&isAdmin(request,env);
  if(!approved&&!pending)return json({error:"not_found"},404);
  const r=await signedB2Request(env,"GET",key);if(!r.ok)return json({error:"not_found"},404);
  const name=safeFileName(key.split("__").slice(1).join("__")||"resource.pdf"),type=contentTypeForName(name);
  return new Response(r.body,{headers:{"content-type":type,"content-disposition":(type==="application/pdf"&&u.searchParams.get("download")!=="1"?"inline":"attachment")+'; filename="'+name.replace(/[^\x20-\x7E]/g,"_").replace(/["\\\\]/g,"_")+'"; filename*=UTF-8\'\''+encodeRFC3986(name),"cache-control":"private, max-age=0, must-revalidate","x-content-type-options":"nosniff"}});
 }
 return json({error:"method_not_allowed"},405);
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";
  if (url.pathname === "/api/lessons" && request.method === "POST") {
    if (!String(env.ADMIN_CODE || "").trim()) {
      return json({ error: "admin_code_not_configured" }, 503);
    }
    return isAdmin(request, env)
      ? json({ ok: true })
      : json({ error: "unauthorized" }, 401);
  }

  const requiredStorageSettings = ["B2_ENDPOINT", "B2_BUCKET", "B2_REGION", "B2_KEY_ID", "B2_APPLICATION_KEY"];
  const missingStorageSettings = requiredStorageSettings.filter((name) => !String(env[name] || "").trim());
  if (missingStorageSettings.length) {
    return json({ error: "storage_not_configured", missing: missingStorageSettings }, 503);
  }

  if (url.pathname === "/api/resources") return handleResources(request, env);
  if (url.pathname === "/api/resource") return handleResourceFile(request, env);

  if (url.pathname === "/api/lessons") {
    if (request.method === "GET") {
      try { return json(await listLessons(env)); }
      catch (error) {
        console.error("B2 list failed:", error);
        return json({ error: "storage_error", message: String(error.message || error).slice(0, 240) }, 502);
      }
    }
    return json({ error: "method_not_allowed" }, 405);
  }

  if (url.pathname !== "/api/file") return json({ error: "not_found" }, 404);
  if (request.method === "POST") {
    if (!KEY_PATTERN.test(key)) return json({ error: "invalid_lesson_key" }, 400);
  } else if (!validStoredKey(key)) {
    return json({ error: "not_found" }, 404);
  }

  if (request.method !== "GET" && !isAdmin(request, env)) {
    if (!String(env.ADMIN_CODE || "").trim()) return json({ error: "admin_code_not_configured" }, 503);
    return json({ error: "unauthorized" }, 401);
  }

  try {
    if (request.method === "GET") {
      const info = fileInfo(key);
      const response = await signedB2Request(env, "GET", key);
      if (response.status === 404) return json({ error: "not_found" }, 404);
      if (!response.ok) throw new Error("B2 download failed (" + response.status + "): " + (await response.text()).slice(0, 180));
      const type = info?.type || "application/pdf";
      const name = info?.name || "document.pdf";
      const fallback = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
      const disposition = type === "application/pdf" && url.searchParams.get("download") !== "1"
        ? "inline" : "attachment";
      const headers = new Headers({
        "content-type": type,
        "content-disposition": disposition + '; filename="' + fallback + '"; filename*=UTF-8\'\'' + encodeRFC3986(name),
        "cache-control": "private, max-age=0, must-revalidate",
        "x-content-type-options": "nosniff",
      });
      const length = response.headers.get("content-length");
      if (length) headers.set("content-length", length);
      return new Response(response.body, { headers });
    }

    if (request.method === "POST") {
      const name = safeFileName(url.searchParams.get("name"));
      const type = contentTypeForName(name);
      if (type === "application/octet-stream") return json({ error: "unsupported_file_type" }, 400);
      const data = await request.arrayBuffer();
      if (!data.byteLength) return json({ error: "empty_file" }, 400);
      if (data.byteLength > MAX_FILE_SIZE) return json({ error: "file_too_large", limit: MAX_FILE_SIZE }, 413);
      const bytes = new Uint8Array(data);
      const pdf = type === "application/pdf" && new TextDecoder().decode(bytes.slice(0, 5)).startsWith("%PDF-");
      const wordDoc = type === "application/msword" &&
        bytes.slice(0, 8).every((value, index) => value === [0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1][index]);
      const wordDocx = type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" &&
        bytes[0] === 0x50 && bytes[1] === 0x4B;
      if (!(pdf || wordDoc || wordDocx)) return json({ error: "file_type_mismatch" }, 400);
      const objectKey = key + "/" + crypto.randomUUID() + "__" + name;
      const response = await signedB2Request(env, "PUT", objectKey, data, {}, type);
      if (!response.ok) throw new Error("B2 upload failed (" + response.status + "): " + (await response.text()).slice(0, 180));
      return json({ ok: true, key: objectKey, lessonKey: key, name, size: data.byteLength });
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
    if (url.pathname === "/api/lessons" || url.pathname === "/api/file" || url.pathname === "/api/resources" || url.pathname === "/api/resource") return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};
