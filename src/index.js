const KEY_PATTERN = /^(?:[AB]|Y[1-6]S[1-4][AB])-\d{2}-\d{2}-\d{2}$/;
const MAX_FILE_SIZE = 4_200_000;
const encoder = new TextEncoder();

const json = (value, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

function isAdmin(request, env) {
  const expected = String(env.ADMIN_CODE_A || "").trim();
  const supplied = String(request.headers.get("x-admin-code") || "").trim();
  return Boolean(expected) && supplied === expected;
}

function lessonGroupFromKey(key) {
  const match = /^(?:([AB])|Y[1-6]S[1-4]([AB]))-/.exec(String(key || ""));
  return match ? (match[1] || match[2]) : null;
}

function isLessonAdmin(request, env, group) {
  if (group !== "A" && group !== "B") return false;
  const expected = String(env[group === "A" ? "ADMIN_CODE_A" : "ADMIN_CODE_B"] || "").trim();
  const supplied = String(request.headers.get("x-admin-code") || "").trim();
  const suppliedGroup = String(request.headers.get("x-admin-group") || "").trim().toUpperCase();
  return Boolean(expected) && supplied === expected && suppliedGroup === group;
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

function safeFileName(value) {
  const name = String(value || "document").replace(/[\/\\\u0000-\u001f\u007f]/g, "_").trim().slice(0, 140);
  return name || "document";
}

function contentTypeForName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (/\.jpe?g$/.test(lower)) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
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
  const tsMatch = storedName.match(/^(\d{13})-/);
  return { lessonKey, key, name, type, size: Number(size) || 0, legacy: false, ts: tsMatch ? Number(tsMatch[1]) : 0 };
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
  files.sort((a, b) => a.lessonKey.localeCompare(b.lessonKey) || (a.ts || 0) - (b.ts || 0) || a.name.localeCompare(b.name, "ar"));
  return files;
}



/* ===== ذاكرة الحافة (Cloudflare Cache): يقرأ الـ Worker من B2 مرة واحدة ثم يخدم كل الزوار من الذاكرة ===== */
const EDGE = "https://edge-cache.ensd.internal/";
const hasEdge = () => typeof caches !== "undefined" && !!caches.default;
async function edgeDrop(key) {
  if (!hasEdge()) return;
  for (const k of [key, "stale:" + key]) { try { await caches.default.delete(new Request(EDGE + k)); } catch {} }
}
async function edgeJson(key, ttl, produce) {
  if (!hasEdge()) return produce();
  const cache = caches.default, fresh = new Request(EDGE + key), stale = new Request(EDGE + "stale:" + key);
  const out = (res, tag) => new Response(res.body, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store", "x-edge": tag } });
  try { const hit = await cache.match(fresh); if (hit) return out(hit, "hit"); } catch {}
  let res = null;
  try { res = await produce(); } catch { res = null; }
  if (res && res.status === 200) {
    try {
      const text = await res.clone().text();
      const mk = (age) => new Response(text, { status: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=" + age } });
      await cache.put(fresh, mk(ttl)); await cache.put(stale, mk(86400));
    } catch {}
    return res;
  }
  // فشل B2 (مثلاً تجاوز الحد اليومي): نخدم آخر نسخة ناجحة بدل إظهار الخطأ
  try { const old = await cache.match(stale); if (old) return out(old, "stale"); } catch {}
  return res || json({ error: "storage_error" }, 502);
}
async function edgeFile(request, ttl, produce) {
  const fail = () => json({ error: "storage_error" }, 502);
  if (!hasEdge() || request.method !== "GET") { try { return await produce(); } catch { return fail(); } }
  const cache = caches.default, ck = new Request(request.url), sk = new Request(EDGE + "stale-file:" + request.url);
  const client = (res, tag, age) => { const h = new Headers(res.headers); h.set("cache-control", "private, max-age=" + age); h.set("x-edge", tag); return new Response(res.body, { status: 200, headers: h }); };
  try { const hit = await cache.match(ck); if (hit) return client(hit, "hit", 600); } catch {}
  let res = null;
  try { res = await produce(); } catch { res = null; }
  if (res && res.status === 200) {
    let buf;
    try { buf = await res.arrayBuffer(); } catch { return fail(); }
    try {
      const mk = (age) => { const h = new Headers(res.headers); h.set("cache-control", "public, max-age=" + age); return new Response(buf, { status: 200, headers: h }); };
      await cache.put(ck, mk(ttl));
      await cache.put(sk, mk(604800)); // نسخة احتياطية 7 أيام تُستخدم فقط عند فشل B2
    } catch {}
    return client(new Response(buf, { status: 200, headers: res.headers }), "miss", 600);
  }
  // أخطاء عادية (404، 400...) تُعاد كما هي. أما فشل B2 (403 تجاوز الحد، 429، 5xx، أو استثناء) فنحاول النسخة الاحتياطية
  if (res && res.status !== 403 && res.status !== 429 && res.status < 500) return res;
  try { const old = await cache.match(sk); if (old) return client(old, "stale", 60); } catch {}
  return res || fail();
}
const APPROVED_INDEX_KEY = "resources/index-approved.json";
async function rebuildApprovedIndex(env) {
  const objects = await listObjectsByPrefix(env, "resources/approved/"), items = [];
  for (const o of objects) { if (!o.key.endsWith(".json")) continue; const m = await readResourceMeta(env, o.key); if (m?.id && m.fileKey) items.push({ ...publicResource(m), status: "approved" }); }
  items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  try { await signedB2Request(env, "PUT", APPROVED_INDEX_KEY, encoder.encode(JSON.stringify(items)), {}, "application/json"); } catch {}
  return items;
}
async function approvedIndex(env) {
  const r = await signedB2Request(env, "GET", APPROVED_INDEX_KEY);
  if (r.ok) { try { const a = await r.json(); if (Array.isArray(a)) return a; } catch {} }
  return rebuildApprovedIndex(env);
}
// تحديث تدريجي للفهرس: طلبان فقط (قراءة + كتابة) بدل قراءة كل ملفات الموارد.
// change = { upsert: meta } لإضافة/تعديل مورد، أو { remove: id } لحذفه. بدون change = إعادة بناء كاملة.
async function refreshApproved(env, change) {
  await edgeDrop("res-approved");
  try {
    if (change) {
      const r = await signedB2Request(env, "GET", APPROVED_INDEX_KEY);
      if (r.ok) {
        let items = null;
        try { const a = await r.json(); if (Array.isArray(a)) items = a; } catch {}
        if (items) {
          if (change.remove) items = items.filter((x) => x.id !== change.remove);
          else if (change.upsert?.id) {
            const entry = { ...publicResource(change.upsert), status: "approved" };
            const i = items.findIndex((x) => x.id === entry.id);
            if (i >= 0) items[i] = entry; else items.push(entry);
          }
          items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
          const w = await signedB2Request(env, "PUT", APPROVED_INDEX_KEY, encoder.encode(JSON.stringify(items)), {}, "application/json");
          if (w.ok) return;
        }
      }
    }
    // احتياط: الفهرس مفقود أو تالف أو فشلت الكتابة → إعادة بناء كاملة
    await rebuildApprovedIndex(env);
  } catch {}
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

/* ===== صلاحيات صاحب المورد (رمز يُحفظ على جهاز الرافع، ويُخزَّن هنا بصيغة SHA-256 فقط) ===== */
async function sha256Hex(s){const d=await crypto.subtle.digest("SHA-256",encoder.encode(String(s)));return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join("")}
function publicResource(m){const {ownerHash,...rest}=m||{};return rest}
function fileBytesMatch(type,data){
 const b=new Uint8Array(data);
 if(type==="application/pdf")return new TextDecoder().decode(b.slice(0,5)).startsWith("%PDF-");
 if(type==="application/msword")return b.length>=8&&b.slice(0,8).every((v,i)=>v===[0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1][i]);
 if(type==="application/vnd.openxmlformats-officedocument.wordprocessingml.document")return b[0]===0x50&&b[1]===0x4B;
 if(type==="image/jpeg")return b[0]===0xFF&&b[1]===0xD8&&b[2]===0xFF;
 if(type==="image/png")return b.length>=8&&[0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A].every((v,i)=>b[i]===v);
 if(type==="image/webp"){const t=new TextDecoder();return b.length>=12&&t.decode(b.slice(0,4))==="RIFF"&&t.decode(b.slice(8,12))==="WEBP"}
 return false;
}
/* التصنيفات (سنة/سداسي/نوع/مقياس) تُدار الآن من «إدارة المكتبة» في الواجهة، لذا يُتحقق من شكلها فقط لا من قائمة ثابتة. */
const metaText=(v,max)=>{const t=String(v||"").replace(/[\u0000-\u001f\u007f<>]/g,"").trim();return t.length>=1&&t.length<=max?t:""};
function validMeta(m){return !!(metaText(m.year,40)&&metaText(m.semester,40)&&metaText(m.subject,100)&&metaText(m.kind,40))}
async function findResource(env,id){
 for(const status of ["approved","pending"]){
  const base="resources/"+status+"/"+id,meta=await readResourceMeta(env,base+".json");
  if(meta)return {meta,status,base};
 }
 return null;
}
async function saveResourceMeta(env,base,meta){
 const r=await signedB2Request(env,"PUT",base+".json",encoder.encode(JSON.stringify(meta)),{},"application/json");
 if(!r.ok)throw new Error("Could not save resource metadata");
}
async function handleResourceOwnerAction(request,env,action,id,admin){
 if(!/^[a-f0-9-]{36}$/i.test(id))return json({error:"invalid_resource_id"},400);
 const found=await findResource(env,id);if(!found)return json({error:"not_found"},404);
 const {meta,base}=found;
 const token=String(request.headers.get("x-owner-token")||"").trim();
 const isOwner=!!token&&!!meta.ownerHash&&(await sha256Hex(token))===meta.ownerHash;
 try{
  if(action==="delete"){
   if(!admin)return json({error:"unauthorized"},401);
  }else{
   if(!isOwner)return json({error:"unauthorized"},403);
  }
  if(action==="delete"||action==="owner_delete"){
   await deleteResourceObject(env,meta.fileKey);await deleteResourceObject(env,base+".json");
   if(found.status==="approved")await refreshApproved(env,{remove:id});
   return json({ok:true,action,id});
  }
  if(action==="owner_update"){
   let b={};try{b=await request.json()}catch{}
   const next={title:String(b.title||"").trim().slice(0,120),year:metaText(b.year,40),semester:metaText(b.semester,40),subject:metaText(b.subject,100),kind:metaText(b.kind,40)};
   if(!validMeta(next))return json({error:"invalid_resource_metadata"},400);
   const updated={...meta,...next,updatedAt:new Date().toISOString()};
   await saveResourceMeta(env,base,updated);
   if(found.status==="approved")await refreshApproved(env,{upsert:updated});
   return json({ok:true,action,id,resource:publicResource(updated)});
  }
  if(action==="owner_replace"){
   const u=new URL(request.url),name=safeFileName(u.searchParams.get("name")),type=contentTypeForName(name);
   if(type==="application/octet-stream")return json({error:"unsupported_file_type"},400);
   const data=await request.arrayBuffer();
   if(!data.byteLength)return json({error:"empty_file"},400);
   if(data.byteLength>MAX_FILE_SIZE)return json({error:"file_too_large",limit:MAX_FILE_SIZE},413);
   if(!fileBytesMatch(type,data))return json({error:"file_type_mismatch"},400);
   const newKey=base+"__"+name;
   const put=await signedB2Request(env,"PUT",newKey,data,{},type);if(!put.ok)return json({error:"storage_error"},502);
   const updated={...meta,fileName:name,contentType:type,fileKey:newKey,updatedAt:new Date().toISOString()};
   await saveResourceMeta(env,base,updated);
   if(meta.fileKey&&meta.fileKey!==newKey)await deleteResourceObject(env,meta.fileKey);
   if(found.status==="approved")await refreshApproved(env,{upsert:updated});
   return json({ok:true,action,id,resource:publicResource(updated)});
  }
  return json({error:"invalid_action"},400);
 }catch(e){return json({error:"storage_error",message:String(e.message||e).slice(0,200)},502)}
}
async function handleResources(request,env){
 const u=new URL(request.url),action=u.searchParams.get("action")||"",id=u.searchParams.get("id")||"",admin=await canModerateRes(request,env);
 if(request.method==="GET"){
  const status=u.searchParams.get("status")==="pending"&&admin?"pending":"approved";
  if(u.searchParams.get("status")==="pending"&&!admin)return json({error:"unauthorized"},401);
  if(status==="approved")return edgeJson("res-approved",120,async()=>{try{return json(await approvedIndex(env))}catch(e){return json({error:"storage_error",message:String(e.message||e).slice(0,200)},502)}});
  try{const objects=await listObjectsByPrefix(env,"resources/"+status+"/"),items=[];
   for(const o of objects){if(!o.key.endsWith(".json"))continue;const m=await readResourceMeta(env,o.key);if(m?.id&&m.fileKey)items.push({...publicResource(m),status})}
   items.sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));return json(items);
  }catch(e){return json({error:"storage_error",message:String(e.message||e).slice(0,200)},502)}
 }
 if(request.method==="POST"&&["delete","owner_delete","owner_update","owner_replace"].includes(action))return handleResourceOwnerAction(request,env,action,id,admin);
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
    await refreshApproved(env,{upsert:approved});
   }else if(action!=="reject")return json({error:"invalid_action"},400);
   await deleteResourceObject(env,meta.fileKey);await deleteResourceObject(env,base+".json");return json({ok:true,action,id});
  }catch(e){return json({error:"storage_error",message:String(e.message||e).slice(0,200)},502)}
 }
 return json({error:"method_not_allowed"},405);
}
/* ===== الشارات: المالك / الأستاذ / المشرف =====
   المالك  = رمز الإدارة الأكاديمية (ADMIN_CODE_MOD)
   الأستاذ = رمز المحاضرات (ADMIN_CODE_A أو ADMIN_CODE_B)
   المشرف  = طالب يعيّنه المالك فقط (قائمة محفوظة في KV) */
const BADGE_ROLES = ["owner", "teacher", "supervisor"];
const BADGE_DEFAULTS = {
  owner: { label: "المالك", color: "#b9802f", name: "" },
  teacher: { label: "الأستاذ", color: "#3b6fb6", name: "" },
  supervisor: { label: "مشرف", color: "#2f8f6b", name: "" }
};
const badgeText = (v, max) => String(v || "").replace(/[\u0000-\u001f\u007f<>"'`]/g, "").trim().slice(0, max);
async function readBadgeRaw(env) {
  try { const v = await kvOf(env).get("badges:cfg", { type: "json" }); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
function mergeBadgeCfg(saved) {
  const out = {};
  for (const r of BADGE_ROLES) {
    const sv = saved[r] || {}, d = BADGE_DEFAULTS[r];
    out[r] = {
      label: badgeText(sv.label, 24) || d.label,
      color: /^#[0-9a-fA-F]{6}$/.test(String(sv.color || "")) ? sv.color : d.color,
      name: badgeText(sv.name, 60)
    };
  }
  return out;
}
async function readSupervisors(env) {
  try { const a = await kvOf(env).get("badges:sup", { type: "json" }); return Array.isArray(a) ? a : []; } catch { return []; }
}
function badgeRoleByCode(request, env) {
  const supplied = [request.headers.get("x-academic-admin-code"), request.headers.get("x-admin-code")]
    .map((v) => String(v || "").trim()).filter(Boolean);
  if (!supplied.length) return "";
  const owner = String(env.ADMIN_CODE_MOD || "").trim();
  if (owner && supplied.some((x) => safeEq(x, owner))) return "owner";
  const teachers = [env.ADMIN_CODE_A, env.ADMIN_CODE_B].map((v) => String(v || "").trim()).filter(Boolean);
  if (supplied.some((x) => teachers.some((c) => safeEq(x, c)))) return "teacher";
  return "";
}
/* الدور والاسم الظاهر عند الرفع (يُحدَّدان في الخادم فقط) */
async function uploaderInfo(request, env) {
  const role = badgeRoleByCode(request, env);
  if (role) {
    const cfg = mergeBadgeCfg(await readBadgeRaw(env));
    return { role, name: cfg[role].name, uid: "r-" + role };
  }
  const name = await uploaderName(request, env);
  let uid = "", group = "";
  try {
    const ss0 = await readSession(request, env);
    if (ss0.ok && ss0.sid === "admin") {
      const r0 = (await readRole(request, env)) || "teacher";
      const cfg0 = mergeBadgeCfg(await readBadgeRaw(env));
      return { role: r0, name: cfg0[r0].name, uid: "r-" + r0 };
    }
  } catch {}
  try {
    const ss = await readSession(request, env);
    if (ss.ok && ss.sid !== "admin") {
      uid = (await mac(env, "u|" + ss.sid)).slice(0, 16); // معرّف مشتق لا يكشف رقم الطالب
      try { const pf = (await kvOf(env).get("prof:" + ss.sid, { type: "json" })) || {}; if (pf.g === "A" || pf.g === "B") group = pf.g; } catch {}
      const hit = (await readSupervisors(env)).find((x) => x.sid === ss.sid);
      if (hit) return { role: "supervisor", name: hit.name || name, uid, group };
    }
  } catch {}
  return { role: "", name: name === "المشرف" ? "الإدارة" : name, uid, group };
}
const supOut = (list) => list.map((x) => ({ id: String(x.sid).slice(0, 12), name: x.name, at: x.at, perms: supEntryPerms(x) }));
async function handleBadges(request, env) {
  const u = new URL(request.url), action = u.searchParams.get("action") || "";
  const owner = isAcademicAdmin(request, env);
  const kv = kvOf(env);
  if (!kv) return json({ error: "kv_not_configured" }, 503);
  if (request.method === "GET") {
    const badges = mergeBadgeCfg(await readBadgeRaw(env));
    if (u.searchParams.get("manage") === "1") {
      if (!owner) return json({ error: "unauthorized" }, 401);
      const supervisors = supOut(await readSupervisors(env));
      return json({ ok: true, badges, supervisors });
    }
    return json({ ok: true, badges });
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!owner) return json({ error: "unauthorized" }, 401);
  let b = {}; try { b = await request.json(); } catch {}
  if (action === "save_badge" || action === "reset_badge") {
    const role = String(b.role || "");
    if (!BADGE_ROLES.includes(role)) return json({ error: "invalid_role" }, 400);
    const saved = await readBadgeRaw(env);
    if (action === "reset_badge") delete saved[role];
    else saved[role] = {
      label: badgeText(b.label, 24) || BADGE_DEFAULTS[role].label,
      color: /^#[0-9a-fA-F]{6}$/.test(String(b.color || "")) ? b.color : BADGE_DEFAULTS[role].color,
      name: role === "supervisor" ? "" : badgeText(b.name, 60)
    };
    await kv.put("badges:cfg", JSON.stringify(saved));
    return json({ ok: true, badges: mergeBadgeCfg(saved) });
  }
  const list = await readSupervisors(env);
  if (action === "add_supervisor") {
    const name = String(b.name || "").trim().slice(0, 80), regno = normRegno(b.regno);
    if (!regno || normName(name).split(" ").filter(Boolean).length < 2) return json({ error: "invalid_input" }, 400);
    const sid = (await mac(env, "r|" + regno)).slice(0, 24), rec = await lookupStudent(env, sid);
    if (!rec || !nameMatches(name, rec[0])) return json({ error: "student_not_found" }, 404);
    if (list.some((x) => x.sid === sid)) return json({ error: "already_supervisor" }, 409);
    if (list.length >= 50) return json({ error: "too_many_supervisors" }, 400);
    list.push({ sid, name: badgeText(rec[0], 60), at: Date.now(), perms: [] });
    await kv.put("badges:sup", JSON.stringify(list));
    return json({ ok: true, supervisors: supOut(list) });
  }
  if (action === "set_perms") {
    const id = String(b.id || ""), i = list.findIndex((x) => String(x.sid).slice(0, 12) === id);
    if (i < 0) return json({ error: "not_found" }, 404);
    list[i].perms = [...new Set((Array.isArray(b.perms) ? b.perms : []).map(String).filter((p) => SUP_PERMS.includes(p)))];
    await kv.put("badges:sup", JSON.stringify(list));
    return json({ ok: true, supervisors: supOut(list) });
  }
  if (action === "edit_supervisor" || action === "delete_supervisor") {
    const id = String(b.id || ""), i = list.findIndex((x) => String(x.sid).slice(0, 12) === id);
    if (i < 0) return json({ error: "not_found" }, 404);
    if (action === "delete_supervisor") list.splice(i, 1);
    else { const nm = badgeText(b.name, 60); if (!nm) return json({ error: "invalid_input" }, 400); list[i].name = nm; }
    await kv.put("badges:sup", JSON.stringify(list));
    return json({ ok: true, supervisors: supOut(list) });
  }
  return json({ error: "unknown_action" }, 400);
}
/* اسم صاحب الملف: يُؤخذ من جلسة الرافع (الاسم الذي اختاره في ملفه، وإلا اسمه في القائمة) */
async function uploaderName(request,env){
 try{
  if(String(env.AUTH_DISABLED||"")==="1")return "";
  if(anyAdmin(request,env))return "المشرف";
  const ss=await readSession(request,env);
  if(!ss.ok)return "";
  if(ss.sid==="admin")return "المشرف";
  const kv=kvOf(env),prof=(await kv.get("prof:"+ss.sid,{type:"json"}))||{};
  if(prof.n)return String(prof.n).slice(0,60);
  const known=await lookupStudent(env,ss.sid);
  if(known&&known[0])return String(known[0]).slice(0,60);
  const rec=await kv.get("dev:"+ss.sid,{type:"json"});
  return rec&&rec.n?String(rec.n).slice(0,60):"";
 }catch{return ""}
}
async function handleResourceFile(request,env){
 const u=new URL(request.url),key=u.searchParams.get("key")||"";
 if(request.method==="POST"){
  const name=safeFileName(u.searchParams.get("name")),type=contentTypeForName(name);
  if(type==="application/octet-stream")return json({error:"unsupported_file_type"},400);
  const meta={id:crypto.randomUUID(),title:String(u.searchParams.get("title")||"").trim().slice(0,120),year:metaText(u.searchParams.get("year"),40),semester:metaText(u.searchParams.get("semester"),40),subject:metaText(u.searchParams.get("subject"),100),kind:metaText(u.searchParams.get("kind"),40),fileName:name,contentType:type,createdAt:new Date().toISOString()};
  if(!validMeta(meta))return json({error:"invalid_resource_metadata"},400);
  const data=await request.arrayBuffer();if(!data.byteLength)return json({error:"empty_file"},400);if(data.byteLength>MAX_FILE_SIZE)return json({error:"file_too_large",limit:MAX_FILE_SIZE},413);
  if(!fileBytesMatch(type,data))return json({error:"file_type_mismatch"},400);
  const up=await uploaderInfo(request,env);if(up.name)meta.uploader=up.name;if(up.role)meta.uploaderRole=up.role;if(up.uid)meta.uploaderId=up.uid;if(up.group)meta.uploaderGroup=up.group;
  const ownerRaw=String(u.searchParams.get("owner")||"").trim();if(/^[A-Za-z0-9_-]{16,128}$/.test(ownerRaw))meta.ownerHash=await sha256Hex(ownerRaw);
  const base="resources/pending/"+meta.id;meta.fileKey=base+"__"+name;
  const put=await signedB2Request(env,"PUT",meta.fileKey,data,{},type);if(!put.ok)return json({error:"storage_error"},502);
  const save=await signedB2Request(env,"PUT",base+".json",encoder.encode(JSON.stringify(meta)),{},"application/json");
  if(!save.ok){await deleteResourceObject(env,meta.fileKey);return json({error:"storage_error"},502)}
  return json({ok:true,pending:true,id:meta.id});
 }
 if(request.method==="GET"){
  const approved=key.startsWith("resources/approved/")&&!key.includes(".."),pending=key.startsWith("resources/pending/")&&!key.includes("..")&&(await canModerateRes(request,env));
  if(!approved&&!pending)return json({error:"not_found"},404);
  const serve=async()=>{
  const r=await signedB2Request(env,"GET",key);if(r.status===404)return json({error:"not_found"},404);if(!r.ok)return json({error:"storage_error"},502);
  const name=safeFileName(key.split("__").slice(1).join("__")||"resource.pdf"),type=contentTypeForName(name);
  return new Response(r.body,{headers:{"content-type":type,"content-disposition":((type==="application/pdf"||type.startsWith("image/"))&&u.searchParams.get("download")!=="1"?"inline":"attachment")+'; filename="'+name.replace(/[^\x20-\x7E]/g,"_").replace(/["\\\\]/g,"_")+'"; filename*=UTF-8\'\''+encodeRFC3986(name),"cache-control":"private, max-age=0, must-revalidate","x-content-type-options":"nosniff"}});
  };
  return approved?edgeFile(request,21600,serve):serve();
 }
 return json({error:"method_not_allowed"},405);
}


async function isSupervisorSession(request, env) {
  return supervisorHas(request, env, "academic");
}
/* بنية البرنامج بدون الدروس/الوحدات (chapters) ولا وقت التحديث: ما لا يحق للمشرف تغييره */
function academicSkeleton(config) {
  const c = JSON.parse(JSON.stringify(config || {}));
  delete c.updatedAt;
  for (const y of c.years || []) for (const sm of y.semesters || []) for (const sb of sm.subjects || []) for (const ax of sb.axes || []) ax.chapters = [];
  return JSON.stringify(c);
}

function isAcademicAdmin(request, env) {
  const expected = String(env.ADMIN_CODE_MOD || "").trim();
  const supplied = String(request.headers.get("x-academic-admin-code") || "").trim();
  return Boolean(expected) && supplied === expected;
}

async function handleAcademic(request, env) {
  const key = "academic/config.json";
  if (request.method === "POST") {
    return isAcademicAdmin(request, env) ? json({ ok: true }) : json({ error: "unauthorized" }, 401);
  }
  if (request.method === "GET") return edgeJson("acad", 300, async () => {
    try {
      const response = await signedB2Request(env, "GET", key);
      if (response.status === 404) return json({ config: null });
      if (!response.ok) throw new Error("Academic config read failed (" + response.status + ")");
      const config = await response.json();
      return json({ config });
    } catch (error) {
      return json({ error: "academic_config_read_failed", message: String(error.message || error).slice(0, 180) }, 502);
    }
  });
  if (request.method === "PUT") {
    const owner = isAcademicAdmin(request, env);
    const supervisor = !owner && await isSupervisorSession(request, env);
    if (!owner && !supervisor) return json({ error: "unauthorized" }, 401);
    let config;
    try { config = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }
    if (supervisor) {
      // المشرف يعدّل الدروس/الوحدات والمواضيع فقط؛ أي تغيير في السنوات/السداسيات/المقاييس/المحاور/المعاملات/الأفواج مرفوض
      try {
        const cur = await signedB2Request(env, "GET", key);
        if (!cur.ok) return json({ error: "supervisor_scope" }, 403);
        const existing = await cur.json();
        if (academicSkeleton(existing) !== academicSkeleton(config)) return json({ error: "supervisor_scope" }, 403);
      } catch { return json({ error: "supervisor_scope" }, 403); }
    }
    if (!config || typeof config !== "object" || !Array.isArray(config.years) || config.years.length > 10) {
      return json({ error: "invalid_academic_config" }, 400);
    }
    const validText = (value, max = 100) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
    const ids = new Set();
    for (const year of config.years) {
      if (!year || !validText(year.id, 80) || !validText(year.name, 80) || ids.has(year.id) || !Array.isArray(year.semesters) || year.semesters.length > 4) {
        return json({ error: "invalid_year_entry" }, 400);
      }
      ids.add(year.id);
      for (const semester of year.semesters) {
        if (!semester || !validText(semester.id, 80) || !validText(semester.name, 80) || ids.has(semester.id) || !Array.isArray(semester.subjects) || semester.subjects.length > 100) {
          return json({ error: "invalid_semester_entry" }, 400);
        }
        ids.add(semester.id);
        for (const subject of semester.subjects) {
          if (!subject || !validText(subject.id, 80) || !validText(subject.name, 120) || !validText(subject.symbol, 8) || ids.has(subject.id) || (subject.lessonNames !== undefined && (typeof subject.lessonNames !== "object" || subject.lessonNames === null || ["A", "B"].some(g => subject.lessonNames[g] !== undefined && (typeof subject.lessonNames[g] !== "string" || subject.lessonNames[g].length > 120)))) || !Array.isArray(subject.axes) || subject.axes.length > 100 || (subject.programImage && (typeof subject.programImage !== "string" || subject.programImage.length > 220 || !subject.programImage.startsWith("/api/academic-image?key=academic%2Fimages%2F")))) {
            return json({ error: "invalid_subject_entry" }, 400);
          }
          ids.add(subject.id);
          for (const axis of subject.axes) {
            if (!axis || !validText(axis.id, 80) || !validText(axis.name, 160) || ids.has(axis.id) || !Array.isArray(axis.chapters) || axis.chapters.length > 200) {
              return json({ error: "invalid_axis_entry" }, 400);
            }
            ids.add(axis.id);
            for (const chapter of axis.chapters) {
              if (!chapter || !validText(chapter.id, 80) || !validText(chapter.name, 180) || ids.has(chapter.id) || !Array.isArray(chapter.topics) || chapter.topics.length > 100) {
                return json({ error: "invalid_chapter_entry" }, 400);
              }
              ids.add(chapter.id);
              if (chapter.topics.some(topic => !validText(topic, 180))) return json({ error: "invalid_topic_entry" }, 400);
            }
          }
        }
      }
    }
    if (config.lessonsMode !== undefined && config.lessonsMode !== "hide" && config.lessonsMode !== "show") {
      return json({ error: "invalid_lessons_mode" }, 400);
    }
    // المجموعات والأفواج اختيارية للتوافق مع الإعدادات الأكاديمية القديمة.
    if (config.groups !== undefined) {
      if (!Array.isArray(config.groups) || config.groups.length > 30) {
        return json({ error: "invalid_academic_groups" }, 400);
      }
      for (const group of config.groups) {
        if (!group || !validText(group.id, 80) || !validText(group.name, 100) ||
            (group.hall !== undefined && (typeof group.hall !== "string" || group.hall.length > 100)) ||
            (group.code !== undefined && (typeof group.code !== "string" || group.code.length > 12)) ||
            ids.has(group.id) || !Array.isArray(group.fogs) || group.fogs.length > 50) {
          return json({ error: "invalid_academic_group_entry" }, 400);
        }
        ids.add(group.id);
        for (const fog of group.fogs) {
          if (!fog || !validText(fog.id, 80) || !validText(fog.name, 100) || ids.has(fog.id) ||
              (fog.scheduleImage !== undefined && fog.scheduleImage !== "" &&
               (typeof fog.scheduleImage !== "string" || fog.scheduleImage.length > 220 ||
                !/^\/api\/academic-image\?key=academic%2Fimages%2F[a-f0-9-]{36}\.(?:jpg|png|webp)$/.test(fog.scheduleImage)))) {
            return json({ error: "invalid_academic_fog_entry" }, 400);
          }
          ids.add(fog.id);
        }
      }
    }
    const body = encoder.encode(JSON.stringify({ ...config, updatedAt: new Date().toISOString() }));
    if (body.byteLength > 500_000) return json({ error: "academic_config_too_large" }, 413);
    try {
      const response = await signedB2Request(env, "PUT", key, body, {}, "application/json");
      if (!response.ok) throw new Error("Academic config save failed (" + response.status + ")");
      await edgeDrop("acad");
      return json({ ok: true, updatedAt: new Date().toISOString() });
    } catch (error) {
      return json({ error: "academic_config_save_failed", message: String(error.message || error).slice(0, 180) }, 502);
    }
  }
  return json({ error: "method_not_allowed" }, 405);
}


async function handleAcademicImage(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";
  const validKey = /^academic\/images\/[a-f0-9-]{36}\.(?:jpg|png|webp)$/.test(key);
  if (request.method === "POST") {
    if (!isAcademicAdmin(request, env)) return json({ error: "unauthorized" }, 401);
    const type = String(request.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
    const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" })[type];
    if (!extension) return json({ error: "unsupported_image_type" }, 400);
    const data = await request.arrayBuffer();
    if (!data.byteLength) return json({ error: "empty_image" }, 400);
    if (data.byteLength > 8_000_000) return json({ error: "image_too_large" }, 413);
    const bytes = new Uint8Array(data);
    const jpeg = type === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = type === "image/png" && bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v);
    const webp = type === "image/webp" && new TextDecoder().decode(bytes.slice(0,4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8,12)) === "WEBP";
    if (!(jpeg || png || webp)) return json({ error: "invalid_image_data" }, 400);
    const imageKey = "academic/images/" + crypto.randomUUID() + "." + extension;
    const saved = await signedB2Request(env, "PUT", imageKey, data, {}, type);
    if (!saved.ok) return json({ error: "image_storage_failed" }, 502);
    return json({ ok: true, key: imageKey, url: "/api/academic-image?key=" + encodeURIComponent(imageKey) });
  }
  if (!validKey) return json({ error: "not_found" }, 404);
  if (request.method === "GET") return edgeFile(request, 86400, async () => {
    const image = await signedB2Request(env, "GET", key);
    if (image.status === 404) return json({ error: "not_found" }, 404);
    if (!image.ok) return json({ error: "image_read_failed" }, 502);
    const extension = key.split(".").pop();
    const type = extension === "jpg" ? "image/jpeg" : extension === "png" ? "image/png" : "image/webp";
    return new Response(image.body, { headers: { "content-type": type, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
  });
  if (request.method === "DELETE") {
    if (!isAcademicAdmin(request, env)) return json({ error: "unauthorized" }, 401);
    const removed = await signedB2Request(env, "DELETE", key);
    if (!removed.ok && removed.status !== 404) return json({ error: "image_delete_failed" }, 502);
    return json({ ok: true });
  }
  return json({ error: "method_not_allowed" }, 405);
}


// ===== الإعلانات: تُحفظ في Backblaze B2 داخل ملف واحد announcements/list.json =====
const ANN_KEY = "announcements/list.json";
const annClip = (v, n) => String(v ?? "").trim().slice(0, n);
// صورة خلفية البطاقة: data-URI صغيرة (JPG/PNG/WEBP) أو رابط http(s)/مسار داخلي
const annImg = (v) => { const s = String(v || ""); return s.length <= 150000 && /^(data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+\/=]+|(?:https?:\/\/|\/)[^\s"'()<>\\]+)$/.test(s) ? s : ""; };
async function readAnnouncements(env) {
  const r = await signedB2Request(env, "GET", ANN_KEY);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error("B2 read failed (" + r.status + "): " + (await r.text()).slice(0, 150));
  try { const a = await r.json(); return Array.isArray(a) ? a : []; } catch { return []; }
}
async function writeAnnouncements(env, list) {
  const r = await signedB2Request(env, "PUT", ANN_KEY, encoder.encode(JSON.stringify(list)), {}, "application/json");
  if (!r.ok) throw new Error("B2 write failed (" + r.status + "): " + (await r.text()).slice(0, 150));
}
// مشرف المحتوى: رمز الدروس (ADMIN_CODE_A) أو رمز الإدارة الأكاديمية (ADMIN_CODE_MOD) عبر أي من الترويستين
function isModerator(request, env) {
  if (isAdmin(request, env) || isAcademicAdmin(request, env)) return true;
  const expected = String(env.ADMIN_CODE_MOD || "").trim();
  return Boolean(expected) && String(request.headers.get("x-admin-code") || "").trim() === expected;
}
/* ===== الصلاحيات: المالك فقط / المشرف بصلاحيات يمنحها المالك =====
   ann = إدارة الإعلانات · res = إدارة الموارد · academic = إدارة الدروس والمواد (الوحدات والمواضيع) */
const SUP_PERMS = ["res", "academic"];
const supEntryPerms = (e) => Array.isArray(e && e.perms) ? e.perms.filter((p) => SUP_PERMS.includes(p)) : ["academic"]; // المشرفون القدامى يحتفظون بما كان لهم
function isOwnerCode(request, env) {
  const expected = String(env.ADMIN_CODE_MOD || "").trim();
  if (!expected) return false;
  return [request.headers.get("x-academic-admin-code"), request.headers.get("x-admin-code")]
    .some((v) => safeEq(String(v || "").trim(), expected));
}
async function isOwnerSession(request, env) {
  if (isOwnerCode(request, env)) return true;
  try { const ss = await readSession(request, env); return !!(ss.ok && ss.sid === "admin" && (await readRole(request, env)) === "owner"); } catch { return false; }
}
async function supervisorPerms(request, env) {
  try {
    const ss = await readSession(request, env);
    if (!ss.ok || ss.sid === "admin") return [];
    const hit = (await readSupervisors(env)).find((x) => x.sid === ss.sid);
    return hit ? supEntryPerms(hit) : [];
  } catch { return []; }
}
async function supervisorHas(request, env, perm) { return (await supervisorPerms(request, env)).includes(perm); }
/* إدارة الإعلانات: المالك (رمز الإدارة الأكاديمية) والأستاذ (رمز المحاضرات) فقط، ولا أحد غيرهما */
async function isTeacherAccess(request, env) {
  const hdr = String(request.headers.get("x-admin-code") || "").trim();
  if (hdr && [env.ADMIN_CODE_A, env.ADMIN_CODE_B].some((v) => { const e = String(v || "").trim(); return e && safeEq(hdr, e); })) return true;
  try { const ss = await readSession(request, env); return !!(ss.ok && ss.sid === "admin" && (await readRole(request, env)) === "teacher"); } catch { return false; }
}
async function canManageAnn(request, env) { return (await isOwnerSession(request, env)) || (await isTeacherAccess(request, env)); }
async function canModerateRes(request, env) { return isModerator(request, env) || (await isOwnerSession(request, env)) || (await supervisorHas(request, env, "res")); }
async function handleAnnouncements(request, env) {
  const u = new URL(request.url), action = u.searchParams.get("action") || "";
  try {
    if (request.method === "GET") return edgeJson("ann", 120, async () => {
      try { return json(await readAnnouncements(env)); }
      catch (e) { return json({ ok: false, error: "storage_error", message: String(e.message || e).slice(0, 200) }, 502); }
    });
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const annOk = await canManageAnn(request, env);
    if (action === "check") {
      // check يخدم واجهة الموارد أيضاً: الإعلانات للمالك والأستاذ فقط، والمشرف بصلاحية الموارد يمرّ للموارد فقط
      const resOk = annOk || (await canModerateRes(request, env));
      return resOk ? json({ ok: true, ann: annOk, res: resOk }) : json({ ok: false, error: "unauthorized" }, 401);
    }
    if (!annOk) return json({ ok: false, error: "unauthorized" }, 401);

    const list = await readAnnouncements(env);
    if (action === "add") {
      let body = {};
      try { body = await request.json(); } catch {}
      const title = annClip(body.title, 120);
      if (!title) return json({ ok: false, error: "title_required" }, 400);
      const link = annClip(body.link, 500);
      const item = {
        id: crypto.randomUUID().slice(0, 8),
        title,
        body: annClip(body.body, 1500),
        category: annClip(body.category, 30) || "عام",
        date: /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : new Date().toISOString().slice(0, 10),
        pinned: !!body.pinned,
        link: /^(https?:\/\/|\/)/.test(link) ? link : "",
        linkText: annClip(body.linkText, 40),
        cm: body.cm === true,
        nc: body.nc === true,
        nr: body.nr === true,
      };
      const pl = annPoll(body.poll); if (pl) item.poll = pl;
      const bi = annImg(body.bgImage); if (bi) item.bgImage = bi;
      list.unshift(item);
      await writeAnnouncements(env, list.slice(0, 200)); await edgeDrop("ann");
      return json({ ok: true, id: item.id });
    }

    const id = u.searchParams.get("id") || "";
    const idx = list.findIndex((a) => a.id === id);
    if (idx < 0) return json({ ok: false, error: "not_found" }, 404);
    if (action === "edit") {
      // تعديل إعلان موجود: يحافظ على المعرّف والتصويت والتفاعلات والتعليقات
      let body = {};
      try { body = await request.json(); } catch {}
      const title = annClip(body.title, 120);
      if (!title) return json({ ok: false, error: "title_required" }, 400);
      const link = annClip(body.link, 500), it = list[idx];
      it.title = title;
      it.body = annClip(body.body, 1500);
      it.category = annClip(body.category, 30) || "عام";
      if (/^\d{4}-\d{2}-\d{2}$/.test(body.date || "")) it.date = body.date;
      it.pinned = !!body.pinned;
      it.link = /^(https?:\/\/|\/)/.test(link) ? link : "";
      it.linkText = annClip(body.linkText, 40);
      it.cm = body.cm === true;
      it.nc = body.nc === true;
      it.nr = body.nr === true;
      const bi = annImg(body.bgImage);
      if (bi) it.bgImage = bi; else if ("bgImage" in body) delete it.bgImage;
      await writeAnnouncements(env, list); await edgeDrop("ann");
      return json({ ok: true, id });
    }
    if (action === "delete") { list.splice(idx, 1); await writeAnnouncements(env, list); await edgeDrop("ann"); await rxPurge(env, "ann:" + id); await pcPurge(env, id); return json({ ok: true }); }
    if (action === "toggle_cm_btn") { list[idx].nc = !list[idx].nc; await writeAnnouncements(env, list); await edgeDrop("ann"); return json({ ok: true, nc: list[idx].nc }); }
    if (action === "toggle_rx_btn") { list[idx].nr = !list[idx].nr; await writeAnnouncements(env, list); await edgeDrop("ann"); return json({ ok: true, nr: list[idx].nr }); }
    if (action === "toggle_comments") { list[idx].cm = list[idx].cm !== true; await writeAnnouncements(env, list); await edgeDrop("ann"); return json({ ok: true, cm: list[idx].cm }); }
    if (action === "toggle_poll") { if (!list[idx].poll) return json({ ok: false, error: "no_poll" }, 400); list[idx].poll.closed = !list[idx].poll.closed; await writeAnnouncements(env, list); await edgeDrop("ann"); return json({ ok: true, closed: list[idx].poll.closed }); }
    if (action === "pin") { list[idx].pinned = !list[idx].pinned; await writeAnnouncements(env, list); await edgeDrop("ann"); return json({ ok: true, pinned: list[idx].pinned }); }
    return json({ ok: false, error: "bad_action" }, 400);
  } catch (e) {
    return json({ ok: false, error: "storage_error", message: String(e.message || e).slice(0, 200) }, 502);
  }
}

/* ===== التفاعلات (قلب مشترك على الملفات والموارد والإعلانات) =====
   rx:<hash> : مصفوفة معرّفات الطلبة المتفاعلين مع العنصر، وعدّها في metadata ليُقرأ الكل بعملية list واحدة
   ru:<sid>  : معرّفات العناصر التي تفاعل معها الطالب (لتظهر حالته على كل أجهزته)
   المعرّف: res:<مفتاح المورد> | lesson:<مفتاح ملف الدرس> | ann:<معرّف الإعلان> */
const RX_ID = /^(?:res|lesson|ann):[^\u0000-\u001f\u007f]{1,260}$/u;
const RX_MINE_MAX = 400, RX_ITEM_MAX = 3000, RX_SYNC_CHUNK = 15;
async function rxKey(id) { return "rx:" + (await sha256Hex(id)).slice(0, 40); }
async function rxMine(kv, sid) {
  const v = await kv.get("ru:" + sid, { type: "json" }); // أي خطأ قراءة يُرمى: لا نكتب فوق قائمة موجودة
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}
async function rxApply(kv, id, me, on) {
  const k = await rxKey(id);
  let list = [];
  const v = await kv.get(k, { type: "json" }); // أي خطأ قراءة يُرمى: لا نكتب فوق قائمة موجودة
  if (Array.isArray(v)) list = v;
  const has = list.includes(me);
  if (on === has) return { n: list.length, changed: false };
  if (on) { if (list.length >= RX_ITEM_MAX) return { n: list.length, changed: false }; list.push(me); }
  else list = list.filter((x) => x !== me);
  if (list.length) await kv.put(k, JSON.stringify(list), { metadata: { n: list.length, id } });
  else await kv.delete(k);
  return { n: list.length, changed: true };
}
async function rxPurge(env, id) {
  const kv = kvOf(env); if (!kv) return;
  try { await kv.delete(await rxKey(id)); await edgeDrop("rx"); } catch {}
}
async function rxCounts(env) {
  return edgeJson("rx", 20, async () => {
    const kv = kvOf(env), counts = {};
    let cursor;
    for (let i = 0; i < 5; i++) {
      const r = await kv.list({ prefix: "rx:", limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const k of r.keys) { const m = k.metadata; if (m && typeof m.id === "string" && m.n > 0) counts[m.id] = m.n; }
      if (r.list_complete) break;
      cursor = r.cursor;
    }
    return json({ ok: true, counts });
  });
}
/* هوية المتفاعل: الطالب = معرّف جلسته، المالك/الأستاذ = معرّف ثابت بحسب دوره (حتى تُحسب تفاعلاتهم) */
async function rxIdentity(request, env, ss) {
  if (ss.sid === "admin") {
    const role = (await readRole(request, env)) || "teacher";
    return { me: "a-" + role, uid: "r-" + role, admin: true };
  }
  return { me: ss.sid, uid: (await mac(env, "u|" + ss.sid)).slice(0, 16), admin: false };
}
/* اسم المتفاعل ودوره (للقائمة المطوّلة وللإشعارات) */
const personCache = new Map();
async function rxPerson(env, me, ctxData) {
  if (String(me).startsWith("a-")) {
    const role = String(me).slice(2), c = ctxData.cfg[role];
    return { name: (c && (c.name || c.label)) || "الإدارة", role: BADGE_ROLES.includes(role) ? role : "" };
  }
  const sup = ctxData.sups.find((x) => x.sid === me);
  const hit = personCache.get(me);
  if (hit && Date.now() - hit.t < 300000) return { name: sup && sup.name ? sup.name : hit.name, role: sup ? "supervisor" : "" };
  const kv = kvOf(env);
  let name = "";
  try { name = ((await kv.get("prof:" + me, { type: "json" })) || {}).n || ""; } catch {}
  if (!name) { const r = ctxData.roster && ctxData.roster[me]; if (r && r[0]) name = r[0]; }
  if (!name) { try { const rec = await kv.get("dev:" + me, { type: "json" }); if (rec && rec.n) name = rec.n; } catch {} }
  name = String(name || "طالب").slice(0, 60);
  if (personCache.size > 500) personCache.clear();
  personCache.set(me, { name, t: Date.now() });
  return { name: sup && sup.name ? sup.name : name, role: sup ? "supervisor" : "" };
}
async function rxPersonCtx(env, needRoster) {
  const kv = kvOf(env);
  let roster = null;
  if (needRoster) { try { roster = (await kv.get("roster", { type: "json", cacheTtl: 60 })) || {}; } catch { roster = {}; } }
  return { cfg: mergeBadgeCfg(await readBadgeRaw(env)), sups: await readSupervisors(env), roster };
}
/* ===== إشعارات صاحب الملف: nt:<uid> = [{i,r,x,t,n,o}]  (n = اسم المتفاعل، o = دوره) ===== */
const NT_MAX = 60;
async function notifyOwnerOfReaction(env, id, reactor) {
  if (!id.startsWith("res:")) return;
  const key = id.slice(4), kv = kvOf(env);
  let meta = null;
  try { meta = (await approvedIndex(env)).find((x) => x && x.fileKey === key) || null; } catch { return; }
  if (!meta || !meta.uploaderId || meta.uploaderId === reactor.uid) return;
  const title = String(meta.title || meta.fileName || "ملف").replace(/[\s_]*\(\s*جزء\s*\d+\s*من\s*\d+\s*\)[\s_]*(?:\.pdf)?\s*$/i, "").slice(0, 120);
  const nk = "nt:" + meta.uploaderId;
  let list = (await kv.get(nk, { type: "json" })) || [];
  if (!Array.isArray(list)) list = [];
  const nid = (await sha256Hex(reactor.me + "|" + id)).slice(0, 10);
  if (list.some((x) => x.i === nid)) return; // نفس الشخص لا يكرّر الإشعار
  let person = { name: "", role: "" };
  try { person = await rxPerson(env, reactor.me, await rxPersonCtx(env, true)); } catch {}
  list.push({ i: nid, r: id, x: title, t: Date.now(), n: person.name, o: person.role });
  if (list.length > NT_MAX) list = list.slice(-NT_MAX);
  await kv.put(nk, JSON.stringify(list), { expirationTtl: 60 * 86400 });
}
async function handleNotifications(request, env) {
  const kv = kvOf(env);
  if (!kv) return json({ error: "kv_not_configured" }, 503);
  const ss = await readSession(request, env);
  if (!ss.ok) return json({ error: "login_required" }, 401);
  const who = await rxIdentity(request, env, ss), nk = "nt:" + who.uid;
  try {
    if (request.method === "GET") {
      let list = (await kv.get(nk, { type: "json" })) || [];
      if (!Array.isArray(list)) list = [];
      return json({ ok: true, list: list.slice().reverse().map((x) => ({ i: x.i, r: x.r, x: x.x, t: x.t, n: x.n || "", o: x.o || "" })), n: list.length });
    }
    if (request.method === "POST") {
      await kv.delete(nk);
      return json({ ok: true });
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch { return json({ error: "storage_error" }, 503); }
}
async function handleReactions(request, env, ctx) {
  const u = new URL(request.url), action = u.searchParams.get("action") || "react";
  const kv = kvOf(env);
  if (!kv) return json({ error: "kv_not_configured" }, 503);
  const ss = await readSession(request, env);
  if (request.method === "GET" && action === "who") {
    // من تفاعل مع العنصر (للضغط المطوّل على القلب): يتطلب تسجيل الدخول
    if (!ss.ok) return json({ error: "login_required" }, 401);
    const id = String(u.searchParams.get("id") || "");
    if (!RX_ID.test(id)) return json({ error: "invalid_input" }, 400);
    try {
      const v = await kv.get(await rxKey(id), { type: "json" });
      const all = Array.isArray(v) ? v : [];
      const shown = all.slice(-30).reverse();
      const ctxData = await rxPersonCtx(env, true);
      const list = [];
      for (const me of shown) list.push(await rxPerson(env, me, ctxData));
      return json({ ok: true, total: all.length, list });
    } catch { return json({ error: "storage_error" }, 503); }
  }
  if (request.method === "GET") {
    let counts = {};
    try { const d = await (await rxCounts(env)).json(); if (d && d.counts) counts = d.counts; } catch {}
    const out = { ok: true, counts };
    if (u.searchParams.get("mine") !== "0") {
      if (ss.ok) { try { out.mine = await rxMine(kv, (await rxIdentity(request, env, ss)).me); } catch {} } else out.mine = [];
    }
    return json(out);
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!ss.ok) return json({ error: "login_required" }, 401);
  const who = await rxIdentity(request, env, ss);
  if (rlCount("rx:" + who.me, 60000) >= 40) return json({ error: "rate_limited" }, 429);
  rlAdd("rx:" + who.me, 60000);
  try {
    let b = {}; try { b = await request.json(); } catch {}
    const me = who.me;
    if (action === "sync") {
      const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter((x) => RX_ID.test(x)))].slice(0, RX_SYNC_CHUNK);
      if (!ids.length) return json({ error: "invalid_input" }, 400);
      const counts = {}, mine = await rxMine(kv, me);
      for (const id of ids) { counts[id] = (await rxApply(kv, id, me, true)).n; if (!mine.includes(id)) mine.push(id); }
      if (mine.length > RX_MINE_MAX) mine.splice(0, mine.length - RX_MINE_MAX);
      await kv.put("ru:" + me, JSON.stringify(mine));
      await edgeDrop("rx");
      return json({ ok: true, counts, mine });
    }
    if (action !== "react") return json({ error: "unknown_action" }, 400);
    const id = String(b.id || ""), on = b.on === true;
    if (!RX_ID.test(id)) return json({ error: "invalid_input" }, 400);
    const r = await rxApply(kv, id, me, on);
    const mine = await rxMine(kv, me), at = mine.indexOf(id);
    if (on && at < 0) mine.push(id); else if (!on && at > -1) mine.splice(at, 1);
    if (mine.length > RX_MINE_MAX) mine.splice(0, mine.length - RX_MINE_MAX);
    if (r.changed || (on !== (at > -1))) await kv.put("ru:" + me, JSON.stringify(mine));
    if (r.changed) await edgeDrop("rx");
    if (r.changed && on) {
      const job = notifyOwnerOfReaction(env, id, who).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    }
    return json({ ok: true, id, on, n: r.n });
  } catch (e) {
    return json({ error: "storage_error" }, 503);
  }
}

/* ===== التصويت والتعليقات على الإعلانات =====
   pv:<id> : { "<sid>": [فهارس الخيارات] }   cm:<id> : مصفوفة تعليقات {i,s,n,t,x} */
function annPoll(p) {
  if (!p || typeof p !== "object") return null;
  const q = annClip(p.q, 200);
  const o = (Array.isArray(p.o) ? p.o : []).map((x) => annClip(x, 100)).filter(Boolean).slice(0, 10);
  if (!q || o.length < 2) return null;
  return { q, o, multi: !!p.multi, closed: false };
}
const PV_MAX = 5000, CM_MAX = 300, CM_LEN = 500;
const annKeyOk = (id) => /^[\w-]{1,40}$/.test(id);
async function pcPurge(env, id) {
  const kv = kvOf(env); if (!kv) return;
  try { await kv.delete("pv:" + id); await kv.delete("cm:" + id); } catch {}
}
async function annFind(env, id) {
  try { return (await readAnnouncements(env)).find((a) => a.id === id) || null; } catch { return null; }
}
async function handlePolls(request, env) {
  const u = new URL(request.url), id = u.searchParams.get("id") || "";
  const kv = kvOf(env);
  if (!kv) return json({ error: "kv_not_configured" }, 503);
  if (!annKeyOk(id)) return json({ error: "invalid_input" }, 400);
  const ss = await readSession(request, env);
  try {
    const votes = (await kv.get("pv:" + id, { type: "json" })) || {};
    const view = (o) => {
      const counts = o.map(() => 0); let voters = 0;
      for (const sid in votes) { const a = votes[sid]; if (!Array.isArray(a) || !a.length) continue; voters++; for (const i of a) if (counts[i] !== undefined) counts[i]++; }
      return { counts, voters };
    };
    if (request.method === "GET") {
      const n = Math.min(10, Number(u.searchParams.get("n")) || 10);
      const mine = ss.ok && votes[ss.sid] ? votes[ss.sid] : [];
      const c = Array(n).fill(0); let voters = 0;
      for (const sid in votes) { const a = votes[sid]; if (!Array.isArray(a) || !a.length) continue; voters++; for (const i of a) if (i >= 0 && i < n) c[i]++; }
      return json({ ok: true, counts: c, voters, mine });
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!ss.ok) return json({ error: "login_required" }, 401);
    if (ss.sid === "admin") return json({ error: "no_student_session" }, 403);
    if (rlCount("pv:" + ss.sid, 60000) >= 20) return json({ error: "rate_limited" }, 429);
    rlAdd("pv:" + ss.sid, 60000);
    const a = await annFind(env, id);
    if (!a || !a.poll) return json({ error: "not_found" }, 404);
    if (a.poll.closed) return json({ error: "poll_closed" }, 403);
    let b = {}; try { b = await request.json(); } catch {}
    let pick = (Array.isArray(b.choice) ? b.choice : []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < a.poll.o.length);
    pick = [...new Set(pick)];
    if (!a.poll.multi) pick = pick.slice(0, 1);
    if (pick.length) { if (!votes[ss.sid] && Object.keys(votes).length >= PV_MAX) return json({ error: "full" }, 429); votes[ss.sid] = pick; }
    else delete votes[ss.sid];
    if (Object.keys(votes).length) await kv.put("pv:" + id, JSON.stringify(votes)); else await kv.delete("pv:" + id);
    const r = view(a.poll.o);
    return json({ ok: true, counts: r.counts, voters: r.voters, mine: pick });
  } catch (e) { return json({ error: "storage_error" }, 503); }
}
/* سجل التاريخ (History): حذف التعليقات يُسجَّل في الخادم نفسه ليشمل الجميع */
async function logHistoryEvent(env, ev) {
  const hk = env && env.HISTORY_KV;
  if (!isKv(hk)) return;
  try {
    const cur = (await hk.get("history", "json")) || [];
    if (cur.some((x) => x.id === ev.id)) return;
    cur.push(ev);
    cur.sort((a, b) => a.ts - b.ts);
    await hk.put("history", JSON.stringify(cur.slice(-HISTORY_MAX)));
  } catch {}
}
async function handleComments(request, env) {
  const u = new URL(request.url), id = u.searchParams.get("id") || "";
  const kv = kvOf(env);
  if (!kv) return json({ error: "kv_not_configured" }, 503);
  if (!annKeyOk(id)) return json({ error: "invalid_input" }, 400);
  const ss = await readSession(request, env);
  const admin = isModerator(request, env) || (ss.ok && ss.sid === "admin");
  try {
    let list = (await kv.get("cm:" + id, { type: "json" })) || [];
    if (!Array.isArray(list)) list = [];
    const roleOf = (c) => c.role || (c.adm ? "supervisor" : "");
    if (request.method === "GET") {
      return json({ ok: true, admin, me: ss.ok ? ss.sid : "", list: list.map((c) => ({ i: c.i, n: c.n, t: c.t, x: c.x, own: !!(ss.ok && c.s === ss.sid), adm: !!c.adm, role: roleOf(c) })) });
    }
    if (request.method === "DELETE") {
      const cid = u.searchParams.get("cid") || "";
      const c = list.find((x) => x.i === cid);
      if (!c) return json({ ok: true });
      if (!admin && !(ss.ok && c.s === ss.sid)) return json({ error: "forbidden" }, 403);
      list = list.filter((x) => x.i !== cid);
      if (list.length) await kv.put("cm:" + id, JSON.stringify(list)); else await kv.delete("cm:" + id);
      // تسجيل الحذف في History: من حذف، ومن كتب التعليق، ونصه، وعلى أي إعلان
      try {
        const me = await uploaderInfo(request, env), cfg = mergeBadgeCfg(await readBadgeRaw(env));
        const byRole = me.role || (admin ? "teacher" : "");
        const by = byRole ? (me.name || cfg[byRole].label) : (me.name || "طالب");
        const ann = await annFind(env, id), title = ann ? String(ann.title || "").slice(0, 60) : "إعلان محذوف";
        const own = !!(ss.ok && c.s === ss.sid) && !byRole;
        await logHistoryEvent(env, {
          id: ("cm" + cid + Date.now().toString(36)).slice(0, 24),
          ts: Date.now(),
          kind: "delete",
          text: ("حُذف تعليق " + c.n + (own ? " (حذفه صاحبه)" : "") + " على «" + title + "»").slice(0, 160),
          target: String(c.x || "").slice(0, 220),
          by: String(by).slice(0, 30),
        });
      } catch {}
      return json({ ok: true });
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!ss.ok && !admin) return json({ error: "login_required" }, 401);
    const who = ss.ok ? ss.sid : "admin";
    if (rlCount("cm:" + who, 60000) >= 8) return json({ error: "rate_limited" }, 429);
    rlAdd("cm:" + who, 60000);
    const a = await annFind(env, id);
    if (!a) return json({ error: "not_found" }, 404);
    if (a.cm !== true) return json({ error: "comments_closed" }, 403);
    let b = {}; try { b = await request.json(); } catch {}
    const x = String(b.text || "").trim().slice(0, CM_LEN);
    if (!x) return json({ error: "invalid_input" }, 400);
    // هوية المعلّق: مالك / أستاذ / مشرف / طالب (تُحدَّد في الخادم فقط)
    const info = await uploaderInfo(request, env), cfg = mergeBadgeCfg(await readBadgeRaw(env));
    let role = info.role;
    if (!role && (isModerator(request, env) || (ss.ok && ss.sid === "admin"))) role = "teacher";
    const n = role ? (info.name || cfg[role].name || cfg[role].label) : (info.name || "طالب");
    const c = { i: crypto.randomUUID().slice(0, 8), s: who, n, t: Date.now(), x, adm: !!role, role };
    list.push(c);
    if (list.length > CM_MAX) list = list.slice(-CM_MAX);
    await kv.put("cm:" + id, JSON.stringify(list));
    return json({ ok: true, c: { i: c.i, n, t: c.t, x, own: true, adm: !!role, role } });
  } catch (e) { return json({ error: "storage_error" }, 503); }
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";
  if (url.pathname === "/api/lessons" && request.method === "POST") {
    const group = String(request.headers.get("x-admin-group") || "").trim().toUpperCase();
    if (group !== "A" && group !== "B") return json({ error: "invalid_lesson_group" }, 400);
    const secretName = group === "A" ? "ADMIN_CODE_A" : "ADMIN_CODE_B";
    if (!String(env[secretName] || "").trim()) {
      return json({ error: "admin_code_not_configured", group }, 503);
    }
    return isLessonAdmin(request, env, group)
      ? json({ ok: true, group })
      : json({ error: "unauthorized" }, 401);
  }

  if (url.pathname === "/api/badges") return handleBadges(request, env);
  if (url.pathname === "/api/reactions") return handleReactions(request, env, ctx);
  if (url.pathname === "/api/notifications") return handleNotifications(request, env);
  if (url.pathname === "/api/polls") return handlePolls(request, env);
  if (url.pathname === "/api/comments") return handleComments(request, env);

  const requiredStorageSettings = ["B2_ENDPOINT", "B2_BUCKET", "B2_REGION", "B2_KEY_ID", "B2_APPLICATION_KEY"];
  const missingStorageSettings = requiredStorageSettings.filter((name) => !String(env[name] || "").trim());
  if (missingStorageSettings.length) {
    return json({ error: "storage_not_configured", missing: missingStorageSettings }, 503);
  }

  if (url.pathname === "/api/academic") return handleAcademic(request, env);
  if (url.pathname === "/api/academic-image") return handleAcademicImage(request, env);
  if (url.pathname === "/api/resources") return handleResources(request, env);
  if (url.pathname === "/api/announcements") return handleAnnouncements(request, env);
  if (url.pathname === "/api/resource") return handleResourceFile(request, env);

  if (url.pathname === "/api/lessons") {
    if (request.method === "GET") {
      return edgeJson("lessons", 120, async () => {
        try { return json(await listLessons(env)); }
        catch (error) {
          console.error("B2 list failed:", error);
          return json({ error: "storage_error", message: String(error.message || error).slice(0, 240) }, 502);
        }
      });
    }
    return json({ error: "method_not_allowed" }, 405);
  }

  if (url.pathname !== "/api/file") return json({ error: "not_found" }, 404);
  if (request.method === "POST") {
    if (!KEY_PATTERN.test(key)) return json({ error: "invalid_lesson_key" }, 400);
  } else if (!validStoredKey(key)) {
    return json({ error: "not_found" }, 404);
  }

  const lessonGroup = lessonGroupFromKey(key);
  if (request.method !== "GET" && !isLessonAdmin(request, env, lessonGroup)) {
    const secretName = lessonGroup === "A" ? "ADMIN_CODE_A" : lessonGroup === "B" ? "ADMIN_CODE_B" : "";
    if (!secretName || !String(env[secretName] || "").trim()) return json({ error: "admin_code_not_configured" }, 503);
    return json({ error: "unauthorized" }, 401);
  }

  try {
    if (request.method === "GET") return await edgeFile(request, 21600, async () => {
      const info = fileInfo(key);
      const response = await signedB2Request(env, "GET", key);
      if (response.status === 404) return json({ error: "not_found" }, 404);
      if (!response.ok) throw new Error("B2 download failed (" + response.status + "): " + (await response.text()).slice(0, 180));
      const type = info?.type || "application/pdf";
      const name = info?.name || "document.pdf";
      const fallback = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
      const disposition = (type === "application/pdf" || type.startsWith("image/")) && url.searchParams.get("download") !== "1"
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
    });

    if (request.method === "POST") {
      const name = safeFileName(url.searchParams.get("name"));
      const type = contentTypeForName(name);
      if (type === "application/octet-stream") return json({ error: "unsupported_file_type" }, 400);
      const data = await request.arrayBuffer();
      if (!data.byteLength) return json({ error: "empty_file" }, 400);
      if (data.byteLength > MAX_FILE_SIZE) return json({ error: "file_too_large", limit: MAX_FILE_SIZE }, 413);
      if (!fileBytesMatch(type, data)) return json({ error: "file_type_mismatch" }, 400);
      const objectKey = key + "/" + String(Date.now()).padStart(13, "0") + "-" + crypto.randomUUID().slice(0, 8) + "__" + name;
      const response = await signedB2Request(env, "PUT", objectKey, data, {}, type);
      if (!response.ok) throw new Error("B2 upload failed (" + response.status + "): " + (await response.text()).slice(0, 180));
      await edgeDrop("lessons");
      return json({ ok: true, key: objectKey, lessonKey: key, name, size: data.byteLength });
    }

    if (request.method === "DELETE") {
      const response = await signedB2Request(env, "DELETE", key);
      if (!response.ok && response.status !== 404) {
        throw new Error("B2 delete failed (" + response.status + "): " + (await response.text()).slice(0, 180));
      }
      await edgeDrop("lessons");
      return json({ ok: true, key });
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    console.error("B2 file operation failed:", error);
    return json({ error: "storage_error", message: String(error.message || error).slice(0, 240) }, 502);
  }
}


/* ===== النشر الثابت: يكتب الخادم نسخاً من القوائم العامة (data/*.json) في GitHub، فتقرؤها الصفحات كملفات ثابتة بلا حد يومي ===== */
const PUBLISH_DELAY_MS = 10000; // انتظار قصير لتجميع الرفعات المتتالية في نشر واحد
const PUBLISH_PATHS = new Set(["/api/file", "/api/lessons", "/api/announcements", "/api/resources", "/api/academic"]);
const publishState = { waiting: false, running: false, again: false };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gitBlobSha(text) {
  const body = encoder.encode(text), head = encoder.encode("blob " + body.length + "\0");
  const all = new Uint8Array(head.length + body.length);
  all.set(head); all.set(body, head.length);
  return hex(await crypto.subtle.digest("SHA-1", all));
}

async function staticSnapshot(env) {
  const jobs = {
    "data/lessons.json": async () => JSON.stringify(await listLessons(env)),
    "data/announcements.json": async () => JSON.stringify(await readAnnouncements(env)),
    "data/resources.json": async () => JSON.stringify(await approvedIndex(env)),
    "data/academic.json": async () => {
      const r = await signedB2Request(env, "GET", "academic/config.json");
      if (r.status === 404) return JSON.stringify({ config: null });
      if (!r.ok) throw new Error("academic read failed (" + r.status + ")");
      return JSON.stringify({ config: await r.json() });
    },
  };
  const paths = Object.keys(jobs);
  const settled = await Promise.allSettled(paths.map((path) => jobs[path]()));
  const files = {}, errors = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") files[paths[i]] = result.value;
    else errors.push(paths[i] + ": " + String(result.reason && result.reason.message || result.reason).slice(0, 120));
  });
  return { files, errors };
}

function github(env, path, init = {}) {
  return fetch("https://api.github.com/repos/" + String(env.GITHUB_REPO).trim() + path, {
    ...init,
    headers: {
      authorization: "Bearer " + String(env.GITHUB_TOKEN).trim(),
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "ensd-static-publisher",
      "content-type": "application/json",
    },
  });
}

async function publishStatic(env, attempt = 0) {
  if (!String(env.GITHUB_TOKEN || "").trim() || !String(env.GITHUB_REPO || "").trim()) {
    return { ok: false, error: "github_not_configured" };
  }
  const branch = String(env.GITHUB_BRANCH || "main").trim();
  const { files, errors } = await staticSnapshot(env);
  const paths = Object.keys(files);
  if (!paths.length) return { ok: false, error: "nothing_to_publish", errors };

  const ref = await github(env, "/git/ref/heads/" + encodeURI(branch));
  if (!ref.ok) return { ok: false, error: "github_ref_" + ref.status };
  const commitSha = (await ref.json()).object.sha;
  const treeRes = await github(env, "/git/trees/" + commitSha + "?recursive=1");
  if (!treeRes.ok) return { ok: false, error: "github_tree_" + treeRes.status };
  const tree = await treeRes.json();
  const existing = new Map((tree.tree || []).map((e) => [e.path, e.sha]));

  const changed = [];
  for (const path of paths) if (existing.get(path) !== await gitBlobSha(files[path])) changed.push(path);
  if (!changed.length) return { ok: true, changed: [], errors };

  const newTree = await github(env, "/git/trees", {
    method: "POST",
    body: JSON.stringify({
      base_tree: tree.sha,
      tree: changed.map((path) => ({ path, mode: "100644", type: "blob", content: files[path] })),
    }),
  });
  if (!newTree.ok) return { ok: false, error: "github_newtree_" + newTree.status };
  const commit = await github(env, "/git/commits", {
    method: "POST",
    body: JSON.stringify({ message: "تحديث البيانات العامة تلقائياً", tree: (await newTree.json()).sha, parents: [commitSha] }),
  });
  if (!commit.ok) return { ok: false, error: "github_commit_" + commit.status };
  const move = await github(env, "/git/refs/heads/" + encodeURI(branch), {
    method: "PATCH",
    body: JSON.stringify({ sha: (await commit.json()).sha, force: false }),
  });
  if (!move.ok) {
    // تعارض مع نشر متزامن: نعيد المحاولة مرة واحدة بالحالة الأحدث
    if ((move.status === 422 || move.status === 409) && attempt < 2) return publishStatic(env, attempt + 1);
    return { ok: false, error: "github_ref_update_" + move.status };
  }
  return { ok: true, changed, errors };
}

function schedulePublish(ctx, env) {
  if (!ctx || !String(env.GITHUB_TOKEN || "").trim() || !String(env.GITHUB_REPO || "").trim()) return;
  if (publishState.waiting) return;                       // ينتظر الآن وسيقرأ أحدث حالة
  if (publishState.running) { publishState.again = true; return; }
  publishState.waiting = true;
  ctx.waitUntil((async () => {
    try {
      await sleep(PUBLISH_DELAY_MS);
      publishState.waiting = false;
      publishState.running = true;
      do {
        publishState.again = false;
        try { const result = await publishStatic(env); if (!result.ok) console.error("publish failed:", JSON.stringify(result)); }
        catch (error) { console.error("publish error:", error); }
      } while (publishState.again);
    } finally {
      publishState.waiting = false;
      publishState.running = false;
    }
  })());
}

async function handlePublish(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!isModerator(request, env)) return json({ error: "unauthorized" }, 401);
  try { return json(await publishStatic(env)); }
  catch (error) { return json({ ok: false, error: "publish_error", message: String(error.message || error).slice(0, 200) }, 502); }
}

/* ===== سجل النشاط (Cloudflare KV: HISTORY_KV) ===== */
const HISTORY_MAX = 500;

function isHistoryAdmin(request, env) {
  if (isModerator(request, env)) return true;
  const expectedB = String(env.ADMIN_CODE_B || "").trim();
  const supplied = String(request.headers.get("x-admin-code") || "").trim();
  return Boolean(expectedB) && supplied === expectedB;
}

async function handleHistory(request, env) {
  if (!isHistoryAdmin(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
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
      kind: ["add", "edit", "delete", "approve", "other"].includes(e.kind) ? e.kind : "other",
      text: String(e.text || "").slice(0, 160),
      target: String(e.target || "").slice(0, 220),
      by: String(e.by || "").slice(0, 30),
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

/* =====================================================================
   حماية الدخول: اسم + رقم التسجيل (مطابقة قائمة الطلبة) + ربط بجهاز + موافقة يدوية
   التخزين: Cloudflare KV (AUTH_KV أو HISTORY_KV) — لا يُخزَّن أي رقم تسجيل صريح، فقط بصمات HMAC.
   الأسرار المطلوبة: AUTH_SECRET (نص عشوائي طويل). أوقف الحماية مؤقتاً بـ AUTH_DISABLED=1
   ===================================================================== */
const SESSION_DAYS = 30;
const MAX_DEVICES = 4;
const MAX_PENDING = 300;
const PEND_TTL = 14 * 86400;

const isKv = (v) => v && typeof v === "object" && typeof v.get === "function" && typeof v.put === "function";
const kvOf = (env) => [env.STUDENTS_KV, env.AUTH_KV, env.HISTORY_KV].find(isKv) || null;
const secretOf = (env) => {
  // السر: AUTH_SECRET، أو STUDENTS_KV إن كان نصاً (سراً) لا ربط KV
  const s = String(env.AUTH_SECRET || env.SESSION_SECRET || (typeof env.STUDENTS_KV === "string" ? env.STUDENTS_KV : "") || "");
  return s.length >= 16 ? encoder.encode(s) : null;
};

function safeEq(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function anyAdmin(request, env) {
  const codes = [env.ADMIN_CODE_A, env.ADMIN_CODE_B, env.ADMIN_CODE_MOD].map((v) => String(v || "").trim()).filter(Boolean);
  const sup = [request.headers.get("x-admin-code"), request.headers.get("x-academic-admin-code")]
    .map((v) => String(v || "").trim()).filter(Boolean);
  return sup.some((s) => codes.some((c) => safeEq(s, c)));
}

async function mac(env, msg) { return hex(await hmac(secretOf(env), msg)); }

function readCookies(request) {
  const out = {};
  for (const part of String(request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const setCookie = (name, value, age) =>
  name + "=" + value + "; Path=/; Max-Age=" + age + "; HttpOnly; Secure; SameSite=Lax";

function jsonC(value, status = 200, cookies = []) {
  const h = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(JSON.stringify(value), { status, headers: h });
}

async function sessionCookie(env, sid) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const sig = (await mac(env, "s|" + sid + "|" + exp)).slice(0, 40);
  return setCookie("ensd_s", sid + "." + exp + "." + sig, SESSION_DAYS * 86400);
}

/* دور الإدارة (مالك/أستاذ) في كوكي موقّع منفصل؛ جلسة "admin" نفسها لا تتغير */
async function roleCookie(env, role) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const sig = (await mac(env, "r|" + role + "|" + exp)).slice(0, 40);
  return setCookie("ensd_r", role + "." + exp + "." + sig, SESSION_DAYS * 86400);
}
async function readRole(request, env) {
  const v = String(readCookies(request).ensd_r || "").split(".");
  if (v.length !== 3) return "";
  const [role, exp, sig] = v;
  if (role !== "owner" && role !== "teacher") return "";
  if (!(Number(exp) > Date.now() / 1000)) return "";
  const ok = (await mac(env, "r|" + role + "|" + exp)).slice(0, 40);
  return safeEq(sig, ok) ? role : "";
}

/* ----- آخر نشاط للطلبة (لعدّاد النشطين): كتابة محدودة كل 4 دقائق لكل طالب ----- */
const seenMap = new Map();
function touchSeen(env, sid, ctx) {
  if (!sid || sid === "admin") return;
  const now = Date.now();
  if (now - (seenMap.get(sid) || 0) < 240000) return;
  if (seenMap.size > 5000) seenMap.clear();
  seenMap.set(sid, now);
  const kv = kvOf(env);
  if (!kv) return;
  const p = kv.put("seen:" + sid, "1", { expirationTtl: 7 * 86400, metadata: { t: now } }).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}

/* ----- قائمة الحظر (مخزّنة مؤقتاً 30 ثانية داخل الـ isolate) ----- */
let bansCache = { t: 0, set: new Set() };
async function getBans(env) {
  if (Date.now() - bansCache.t < 30000) return bansCache.set;
  try {
    const a = await kvOf(env).get("bans", { type: "json", cacheTtl: 60 });
    bansCache = { t: Date.now(), set: new Set(Array.isArray(a) ? a : []) };
  } catch { bansCache.t = Date.now(); }
  return bansCache.set;
}

async function readSession(request, env) {
  const raw = readCookies(request).ensd_s;
  if (!raw) return { ok: false };
  const [sid, exp, sig] = raw.split(".");
  if (!sid || !exp || !sig || Number(exp) < Date.now() / 1000) return { ok: false };
  if (!safeEq(sig, (await mac(env, "s|" + sid + "|" + exp)).slice(0, 40))) return { ok: false };
  if (sid !== "admin" && (await getBans(env)).has(sid)) return { ok: false, banned: true };
  return { ok: true, sid };
}

/* ----- تحديد المحاولات (داخل الـ isolate؛ يُستحسن إضافة Rate Limiting Rule في Cloudflare أيضاً) ----- */
const rlMap = new Map();
function rlCount(key, windowMs) {
  const now = Date.now(), e = rlMap.get(key);
  if (!e || now - e.t > windowMs) return 0;
  return e.n;
}
function rlAdd(key, windowMs) {
  const now = Date.now(), e = rlMap.get(key);
  if (rlMap.size > 5000) rlMap.clear();
  if (!e || now - e.t > windowMs) rlMap.set(key, { n: 1, t: now }); else e.n++;
}

/* ----- تطبيع الأسماء العربية والأرقام ----- */
function normName(s) {
  return String(s || "").normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/[^\p{L}\s]/gu, " ").toLowerCase().replace(/\s+/g, " ").trim();
}
function normRegno(s) {
  const d = String(s || "")
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x660))
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x6F0))
    .replace(/\D/g, "");
  return /^\d{10,14}$/.test(d) ? d : "";
}
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  arr.forEach((x, i) => {
    for (const p of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) out.push([x, ...p]);
  });
  return out;
}
function nameMatches(typed, stored) {
  const tokens = normName(typed).split(" ").filter(Boolean);
  const flat = normName(stored).replace(/ /g, "");
  if (tokens.length < 2 || !flat) return false;
  if (tokens.every((t) => t.length >= 2 && flat.includes(t))) return true;
  const limit = Math.max(2, Math.floor(flat.length * 0.2));
  for (const p of (tokens.length <= 5 ? permutations(tokens) : [tokens])) {
    if (lev(p.join(""), flat) <= limit) return true;
  }
  return false;
}

/* ----- قراءة ملف CSV (group,seq,reg_no,name) ----- */
function splitCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
async function buildRoster(env, text) {
  const roster = {}; let rows = 0, dup = 0, skipped = 0;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = splitCsvLine(line);
    const regno = f.length >= 4 ? normRegno(f[2]) : "";
    const name = f.slice(3).join(",").trim().slice(0, 80);
    if (!regno || !name) { skipped++; continue; }
    const sid = (await mac(env, "r|" + regno)).slice(0, 24);
    if (roster[sid]) dup++;
    roster[sid] = [name, String(f[0] || "").trim().slice(0, 12)];
    rows++;
  }
  return { roster, rows, dup, skipped };
}

/* ----- تسجيل الدخول ----- */
async function putDev(env, sid, rec) {
  await kvOf(env).put("dev:" + sid, JSON.stringify(rec), { metadata: { n: rec.n, g: rec.g, ts: rec.ts, c: rec.d.length } });
}
async function lookupStudent(env, sid) {
  const kv = kvOf(env);
  const roster = (await kv.get("roster", { type: "json", cacheTtl: 60 })) || {};
  return roster[sid] || (await kv.get("extra:" + sid, { type: "json" })) || null;
}
async function deviceOf(request, env) {
  let token = readCookies(request).ensd_dev || "", fresh = false;
  if (!/^[a-f0-9]{48}$/.test(token)) { token = hex(crypto.getRandomValues(new Uint8Array(24))); fresh = true; }
  return { token, fresh, dh: (await mac(env, "d|" + token)).slice(0, 24) };
}
const devCookie = (token) => setCookie("ensd_dev", token, 365 * 86400);

async function createPending(env, dev, type, sid, typedName, rec, ip) {
  const kv = kvOf(env);
  const exists = await kv.get("pend:" + dev.dh);
  if (!exists) {
    // منع إغراق طابور الموافقات: حدّ لكل شبكة ولكل رقم تسجيل في الساعة
    if (rlCount("pip:" + ip, 3600000) >= 4 || rlCount("psid:" + sid, 3600000) >= 4) return false;
    rlAdd("pip:" + ip, 3600000); rlAdd("psid:" + sid, 3600000);
    const list = await kv.list({ prefix: "pend:", limit: MAX_PENDING + 1 });
    if (list.keys.length > MAX_PENDING) return false;
  }
  const v = { t: type, sid, name: typedName, rn: rec ? rec[0] : "", g: rec ? rec[1] : "", ts: Date.now() };
  await kv.put("pend:" + dev.dh, JSON.stringify(v), { expirationTtl: PEND_TTL, metadata: v });
  return true;
}

async function authLogin(request, env, kind) {
  const kv = kvOf(env), ip = request.headers.get("cf-connecting-ip") || "0";
  let body = {};
  try { body = await request.json(); } catch {}

  if (body.admin) {
    if (rlCount("fail:" + ip, 900000) >= 8) return jsonC({ error: "rate_limited" }, 429);
    const codes = [env.ADMIN_CODE_A, env.ADMIN_CODE_B, env.ADMIN_CODE_MOD].map((v) => String(v || "").trim()).filter(Boolean);
    const sup = String(body.code || "").trim();
    if (!sup || !codes.some((c) => safeEq(sup, c))) { rlAdd("fail:" + ip, 900000); return jsonC({ status: "nomatch" }, 401); }
    const ownerCode = String(env.ADMIN_CODE_MOD || "").trim(), aCode = String(env.ADMIN_CODE_A || "").trim();
    const role = ownerCode && safeEq(sup, ownerCode) ? "owner" : "teacher";
    const group = role === "owner" ? "" : (aCode && safeEq(sup, aCode) ? "A" : "B");
    return jsonC({ status: "ok", role, group }, 200, [await sessionCookie(env, "admin"), await roleCookie(env, role)]);
  }

  if (rlCount("fail:" + ip, 900000) >= 10) return jsonC({ error: "rate_limited" }, 429);
  const name = String(body.name || "").trim().slice(0, 80), regno = normRegno(body.regno);
  if (!regno || normName(name).split(" ").filter(Boolean).length < 2) return jsonC({ error: "invalid_input" }, 400);
  const sid = (await mac(env, "r|" + regno)).slice(0, 24);
  const rec = await lookupStudent(env, sid);
  const matched = !!rec && nameMatches(name, rec[0]);

  if (kind === "request") {
    if (rlCount("req:" + ip, 3600000) >= 3) return jsonC({ error: "rate_limited" }, 429);
    if (matched) kind = "login";
  }

  if (kind === "login") {
    if (!matched) { rlAdd("fail:" + ip, 900000); return jsonC({ status: "nomatch" }, 401); }
    if ((await getBans(env)).has(sid)) return jsonC({ status: "banned" }, 403);
    const dev = await deviceOf(request, env);
    const cookies = dev.fresh ? [devCookie(dev.token)] : [];
    const cur = await kv.get("dev:" + sid, { type: "json" });
    if (!cur) {
      await putDev(env, sid, { d: [dev.dh], n: rec[0], g: rec[1], ts: Date.now() });
      return jsonC({ status: "ok" }, 200, [...cookies, await sessionCookie(env, sid)]);
    }
    if (cur.d.includes(dev.dh)) return jsonC({ status: "ok" }, 200, [...cookies, await sessionCookie(env, sid)]);
    if (!(await createPending(env, dev, "device", sid, name, rec, ip))) return jsonC({ error: "rate_limited" }, 429);
    return jsonC({ status: "pending" }, 200, [devCookie(dev.token)]);
  }

  // طلب مراجعة يدوية (اسم غير مطابق أو طالب غير مدرج)
  rlAdd("req:" + ip, 3600000);
  if (sid && (await getBans(env)).has(sid)) return jsonC({ status: "banned" }, 403);
  const dev = await deviceOf(request, env);
  const ok = await createPending(env, dev, rec ? "mismatch" : "new", sid, name, rec, ip);
  if (!ok) return jsonC({ error: "rate_limited" }, 429);
  return jsonC({ status: "pending" }, 200, [devCookie(dev.token)]);
}

async function authStatus(request, env) {
  const kv = kvOf(env), c = readCookies(request).ensd_dev || "";
  if (!/^[a-f0-9]{48}$/.test(c)) return jsonC({ status: "none" });
  const dh = (await mac(env, "d|" + c)).slice(0, 24);
  const res = await kv.get("res:" + dh, { type: "json" });
  if (res) {
    await kv.delete("res:" + dh);
    if (!res.ok) return jsonC({ status: "rejected" });
    if ((await getBans(env)).has(res.sid)) return jsonC({ status: "rejected" });
    return jsonC({ status: "ok" }, 200, [await sessionCookie(env, res.sid)]);
  }
  return jsonC({ status: (await kv.get("pend:" + dh)) ? "pending" : "none" });
}

/* ----- واجهة الإدارة ----- */
async function updateBans(env, fn) {
  const kv = kvOf(env);
  const cur = (await kv.get("bans", { type: "json" })) || [];
  const next = [...new Set(fn(Array.isArray(cur) ? cur : []))];
  await kv.put("bans", JSON.stringify(next));
  bansCache = { t: Date.now(), set: new Set(next) };
  return next;
}
async function listAll(kv, prefix) {
  const out = []; let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await kv.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    out.push(...r.keys);
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  return out;
}

async function authAdmin(request, env, url) {
  // إدارة الدخول (قبول الطلبة والحظر واستيراد القائمة): للمالك فقط
  if (!isOwnerCode(request, env)) return jsonC({ error: "unauthorized" }, 401);
  const kv = kvOf(env), action = url.searchParams.get("action") || "";
  try {
    if (action === "list" && request.method === "GET") {
      const bans = await getBansFresh(env);
      const pend = (await listAll(kv, "pend:")).map((k) => ({ id: k.name.slice(5), ...(k.metadata || {}) }));
      const users = (await listAll(kv, "dev:")).map((k) => ({ sid: k.name.slice(4), banned: bans.includes(k.name.slice(4)), ...(k.metadata || {}) }));
      const roster = (await kv.get("roster", { type: "json" })) || {};
      const seen = new Map((await listAll(kv, "seen:")).map((k) => [k.name.slice(5), Number(k.metadata && k.metadata.t) || 0]));
      const nowMs = Date.now();
      users.forEach((u) => { u.ls = seen.get(u.sid) || 0; });
      const cnt = (ms) => users.filter((u) => u.ls && nowMs - u.ls < ms).length;
      const active = { now: cnt(600000), day: cnt(86400000), week: cnt(7 * 86400000) };
      pend.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      users.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return jsonC({ pending: pend, users, rosterCount: Object.keys(roster).length, bans: bans.length, active });
    }
    if (request.method !== "POST") return jsonC({ error: "method_not_allowed" }, 405);

    if (action === "import") {
      if (!secretOf(env)) return jsonC({ error: "auth_not_configured" }, 503);
      const { roster, rows, dup, skipped } = await buildRoster(env, await request.text());
      if (rows < 1) return jsonC({ error: "no_rows" }, 400);
      await kv.put("roster", JSON.stringify(roster));
      return jsonC({ ok: true, imported: rows, unique: Object.keys(roster).length, duplicates: dup, skipped });
    }

    const id = url.searchParams.get("id") || "";
    if (action === "approve" || action === "reject") {
      if (!/^[a-f0-9]{24}$/.test(id)) return jsonC({ error: "bad_id" }, 400);
      const p = await kv.get("pend:" + id, { type: "json" });
      if (!p) return jsonC({ error: "not_found" }, 404);
      if (action === "approve") {
        const known = await lookupStudent(env, p.sid);
        if (!known) await kv.put("extra:" + p.sid, JSON.stringify([p.name, p.g || ""]));
        const rec = (await kv.get("dev:" + p.sid, { type: "json" })) ||
          { d: [], n: known ? known[0] : p.name, g: known ? known[1] : (p.g || ""), ts: Date.now() };
        if (!rec.d.includes(id)) rec.d.push(id);
        rec.d = rec.d.slice(-MAX_DEVICES);
        await putDev(env, p.sid, rec);
        await kv.put("res:" + id, JSON.stringify({ ok: true, sid: p.sid }), { expirationTtl: 3600 });
      } else {
        await kv.put("res:" + id, JSON.stringify({ ok: false }), { expirationTtl: 3600 });
      }
      await kv.delete("pend:" + id);
      return jsonC({ ok: true });
    }

    const sid = url.searchParams.get("sid") || "";
    if (!/^[a-f0-9]{24}$/.test(sid)) return jsonC({ error: "bad_sid" }, 400);
    if (action === "ban") { await updateBans(env, (a) => [...a, sid]); return jsonC({ ok: true }); }
    if (action === "unban") { await updateBans(env, (a) => a.filter((x) => x !== sid)); return jsonC({ ok: true }); }
    if (action === "resetdev") { await kv.delete("dev:" + sid); return jsonC({ ok: true }); }
    return jsonC({ error: "bad_action" }, 400);
  } catch (e) {
    return jsonC({ error: "kv_error", message: String(e.message || e).slice(0, 160) }, 502);
  }
}
async function getBansFresh(env) {
  const a = await kvOf(env).get("bans", { type: "json" });
  return Array.isArray(a) ? a : [];
}

/* ----- تعديل الملف الشخصي: الاسم المعروض + اختيار المجموعة (لا يمسّ مطابقة الدخول بالقائمة) ----- */
async function authProfile(request, env) {
  const ss = await readSession(request, env);
  if (!ss.ok) return jsonC({ error: "login_required" }, 401);
  if (rlCount("prof:" + ss.sid, 600000) >= 30) return jsonC({ error: "rate_limited" }, 429);
  rlAdd("prof:" + ss.sid, 600000);
  let body = {};
  try { body = await request.json(); } catch {}
  const kv = kvOf(env);
  if (ss.sid === "admin") {
    // المالك/الأستاذ: يغيّر الاسم الظاهر لدوره (يُحفظ في إعدادات الشارة)
    const role = (await readRole(request, env)) || "teacher";
    const n = String(body.name || "").normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!/^[\p{L}\p{M}' .\-]{2,60}$/u.test(n)) return jsonC({ error: "invalid_name" }, 400);
    try {
      const saved = await readBadgeRaw(env);
      saved[role] = { ...(saved[role] || {}), name: badgeText(n, 60) };
      await kv.put("badges:cfg", JSON.stringify(saved));
    } catch { return jsonC({ error: "kv_error" }, 502); }
    return jsonC({ ok: true, name: n, group: "" });
  }
  const next = { ...((await kv.get("prof:" + ss.sid, { type: "json" })) || {}) };
  if (body.name !== undefined) {
    const n = String(body.name || "").normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!/^[\p{L}\p{M}' .\-]{2,60}$/u.test(n)) return jsonC({ error: "invalid_name" }, 400);
    next.n = n;
  }
  if (body.group !== undefined) {
    if (body.group !== "A" && body.group !== "B" && body.group !== "") return jsonC({ error: "invalid_group" }, 400);
    next.g = body.group;
  }
  try { await kv.put("prof:" + ss.sid, JSON.stringify(next)); }
  catch { return jsonC({ error: "kv_error" }, 502); }
  if (body.name !== undefined && next.n) {
    // إن كان مشرفاً فاسمه الظاهر على تعليقاته وموارده يتبع اسمه الجديد
    try {
      const sups = await readSupervisors(env), hit = sups.find((x) => x.sid === ss.sid);
      if (hit) { hit.name = badgeText(next.n, 60); await kv.put("badges:sup", JSON.stringify(sups)); }
    } catch {}
  }
  return jsonC({ ok: true, name: next.n || "", group: next.g || "" });
}

async function handleAuth(request, env, url, ctx) {
  if (!kvOf(env) || !secretOf(env)) return jsonC({ error: "auth_not_configured" }, 503);
  const a = url.pathname.slice("/api/auth/".length);
  if (a === "admin") return authAdmin(request, env, url);
  if (a === "me" && request.method === "GET") {
    const ss = await readSession(request, env);
    const out = { in: !!ss.ok, admin: !!ss.ok && ss.sid === "admin" };
    if (out.admin) {
      out.role = (await readRole(request, env)) || "teacher";
      try { const c0 = mergeBadgeCfg(await readBadgeRaw(env))[out.role]; out.name = c0.name || c0.label; out.label = c0.label; } catch {}
      if (out.role === "owner") out.perms = SUP_PERMS.slice();
    }
    if (ss.ok) {
      touchSeen(env, ss.sid, ctx);
      const exp = Number(String(readCookies(request).ensd_s || "").split(".")[1]);
      if (exp) out.exp = exp;
      if (!out.admin) {
        // بيانات الملف الشخصي: الاسم والمجموعة من قائمة الطلبة، وعدد الأجهزة وتاريخ أول دخول من سجل الجهاز
        try {
          const rec = await kvOf(env).get("dev:" + ss.sid, { type: "json" });
          const known = await lookupStudent(env, ss.sid);
          const prof = (await kvOf(env).get("prof:" + ss.sid, { type: "json" })) || {};
          // الاسم: ما اختاره الطالب، وإلا اسمه في القائمة. المجموعة: اختياره هو فقط (لا تُستنتج من القائمة)
          out.name = prof.n || (known ? known[0] : (rec && rec.n) || "");
          out.group = prof.g === "A" || prof.g === "B" ? prof.g : "";
          out.devices = rec && Array.isArray(rec.d) ? rec.d.length : 1;
          out.since = (rec && rec.ts) || 0;
          out.maxDevices = MAX_DEVICES;
          const supHit = (await readSupervisors(env)).find((x) => x.sid === ss.sid);
          out.supervisor = !!supHit;
          if (supHit) out.perms = supEntryPerms(supHit);
        } catch {}
      }
    }
    return jsonC(out);
  }
  if (a === "status" && request.method === "GET") return authStatus(request, env);
  if (request.method !== "POST") return jsonC({ error: "method_not_allowed" }, 405);
  if (a === "profile") return authProfile(request, env);
  if (a === "login") return authLogin(request, env, "login");
  if (a === "request") return authLogin(request, env, "request");
  if (a === "logout") return jsonC({ ok: true }, 200, [setCookie("ensd_s", "", 0), setCookie("ensd_r", "", 0)]);
  return jsonC({ error: "not_found" }, 404);
}

function htmlPage(body, status = 200) {
  return new Response(body, { status, headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  } });
}

async function authGate(request, env, url, ctx) {
  if (String(env.AUTH_DISABLED || "") === "1") return null;
  const p = url.pathname;
  if (p === "/auth-admin") return htmlPage(ADMIN_HTML);
  if (p === "/login") return Response.redirect(url.origin + "/#login", 302);
  if (p.startsWith("/api/auth/")) return handleAuth(request, env, url, ctx);
  if (!kvOf(env) || !secretOf(env)) {
    return new Response("الحماية غير مهيّأة: أضف السر AUTH_SECRET واربط KV.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const s = await readSession(request, env);
  if (s.ok) { touchSeen(env, s.sid, ctx); return null; }
  if (p.startsWith("/api/") && anyAdmin(request, env)) return null;
  // الواجهة (HTML/JS/CSS) عامة لتظهر الصفحة الرئيسية، أما البيانات والملفات فمحمية بتسجيل الدخول
  const isData = p.startsWith("/api/") || p.startsWith("/data/") || (/\.json$/i.test(p) && p !== "/manifest.json");
  if (isData) return json({ error: "login_required", banned: !!s.banned }, 401);
  return null;
}

const PAGE_STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--tx:#14171c;--mu:#5b6573;--bd:#d9dee5;--ac:#1d6b57;--acx:#fff;--bad:#b3261e;--ok:#1d6b57}
@media (prefers-color-scheme:dark){:root{--bg:#101316;--card:#1a1f24;--tx:#eef1f4;--mu:#9aa5b1;--bd:#2c343c;--ac:#3fb596;--acx:#06201a;--bad:#ff8a80;--ok:#5fd0b0}}
*{box-sizing:border-box}html,body{margin:0}body{font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;background:var(--bg);color:var(--tx);line-height:1.6;padding:env(safe-area-inset-top,0) 0 env(safe-area-inset-bottom,0)}
.wrap{max-width:460px;margin:0 auto;padding:20px}.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:20px}
h1{font-size:1.25rem;margin:0 0 4px}p{margin:0 0 14px;color:var(--mu);font-size:.92rem}label{display:block;font-size:.88rem;margin:12px 0 4px}
input{width:100%;padding:12px;border:1px solid var(--bd);border-radius:10px;background:var(--bg);color:var(--tx);font-size:1rem}
button{font:inherit;cursor:pointer;border:0;border-radius:10px;padding:12px 16px;background:var(--ac);color:var(--acx);font-weight:600;width:100%;margin-top:14px}
button.s{background:transparent;color:var(--tx);border:1px solid var(--bd);font-weight:500}button:disabled{opacity:.55}
.bad{color:var(--bad)}.ok{color:var(--ok)}#m{min-height:1.4em;margin:12px 0 0;font-size:.9rem}[hidden]{display:none!important}
a{color:var(--ac)}.f{text-align:center;margin-top:14px;font-size:.85rem}`;

const ADMIN_HTML = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>إدارة الدخول</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#f2f6f7;--card:#fff;--tx:#14202a;--mu:#64727e;--bd:#e0e8ec;--ac:#1f7a70;--ac2:#37a592;--soft:#e5f3f0;--bad:#c9382f;--badbg:#fdecea;--warn:#a96d12;--warnbg:#fdf3df;--ok:#18935f;--okbg:#e2f6ec;--sh:0 10px 28px rgba(20,40,50,.07)}
@media(prefers-color-scheme:dark){:root{--bg:#0b1216;--card:#141d23;--tx:#eaf1f4;--mu:#93a3ae;--bd:#24323b;--ac:#3fb8a6;--ac2:#2c8f80;--soft:#13302c;--bad:#ff8f86;--badbg:#351a18;--warn:#e8b96a;--warnbg:#33290f;--ok:#4fd6a0;--okbg:#10301f;--sh:0 10px 28px rgba(0,0,0,.35)}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0}
body{font-family:"Tajawal",system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;background:var(--bg);color:var(--tx);line-height:1.6;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
[hidden]{display:none!important}
button,input{font:inherit;color:inherit}
button{cursor:pointer}
.wrap{max-width:880px;margin:0 auto;padding:16px 14px 40px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:20px;box-shadow:var(--sh)}

/* login */
.login{max-width:400px;margin:9vh auto 0;padding:28px 22px;text-align:center}
.login .logo{width:64px;height:64px;border-radius:20px;margin:0 auto 14px;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,var(--ac),var(--ac2))}
.login h1{margin:0 0 4px;font-size:22px;font-weight:800}
.login p{margin:0 0 18px;color:var(--mu);font-size:14px}
.field{width:100%;height:50px;border-radius:14px;border:1.5px solid var(--bd);background:var(--bg);padding:0 14px;font-size:16px;outline:0;transition:border-color .2s,box-shadow .2s}
.field:focus{border-color:var(--ac);box-shadow:0 0 0 4px rgba(55,165,146,.18)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:0;border-radius:13px;padding:0 16px;height:44px;font-weight:700;font-size:14px;background:var(--ac);color:#fff;transition:transform .12s,opacity .2s}
.btn:active{transform:scale(.96)}
.btn:disabled{opacity:.55;cursor:default}
.btn.wide{width:100%;height:50px;margin-top:12px;font-size:16px}
.btn.ghost{background:transparent;border:1.5px solid var(--bd);color:var(--tx)}
.btn.soft{background:var(--soft);color:var(--ac)}
.btn.danger{background:var(--badbg);color:var(--bad)}
.btn.sm{height:36px;padding:0 13px;font-size:13px;border-radius:11px}
.err{min-height:1.4em;margin:12px 0 0;color:var(--bad);font-size:14px}

/* header */
.hero{position:relative;overflow:hidden;border-radius:24px;padding:20px 18px 18px;color:#fff;background:linear-gradient(120deg,#1b5f5b,#2b8a7e 60%,#47a695);box-shadow:var(--sh)}
.hero:before,.hero:after{content:"";position:absolute;border-radius:50%;border:1px solid rgba(255,255,255,.16);pointer-events:none}
.hero:before{width:220px;height:220px;left:-70px;top:-110px;box-shadow:0 0 0 24px rgba(255,255,255,.04),0 0 0 50px rgba(255,255,255,.025)}
.hero:after{width:130px;height:130px;right:-40px;bottom:-70px}
.hero-top{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:10px}
.hero h1{margin:0;font-size:22px;font-weight:800}
.hero p{margin:2px 0 0;font-size:12.5px;color:#d3ebe6}
.hero-btns{display:flex;gap:8px}
.ibtn{width:40px;height:40px;border-radius:13px;border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.15);color:#fff;display:grid;place-items:center;padding:0;transition:background .2s,transform .15s}
.ibtn:hover{background:rgba(255,255,255,.27)}
.ibtn:active{transform:scale(.92)}
.ibtn svg{width:19px;height:19px}
.ibtn.spin svg{animation:sp .8s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}

/* stats */
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:14px 0}
@media(min-width:640px){.stats{grid-template-columns:repeat(3,1fr)}}
.stat{padding:14px;display:flex;align-items:center;gap:12px;min-width:0}
.stat .ic{width:42px;height:42px;border-radius:13px;display:grid;place-items:center;flex:none;background:var(--soft);color:var(--ac)}
.stat .ic svg{width:21px;height:21px}
.stat b{display:block;font-size:24px;line-height:1.1;font-weight:800}
.stat small{display:block;color:var(--mu);font-size:12px;margin-top:2px}
.stat.live{background:linear-gradient(135deg,var(--okbg),var(--card) 70%);border-color:transparent;box-shadow:inset 0 0 0 1.5px rgba(24,147,95,.3),var(--sh)}
.stat.live .ic{background:var(--ok);color:#fff;position:relative}
.stat.live .ic:after{content:"";position:absolute;inset:0;border-radius:inherit;border:2px solid var(--ok);animation:pl 2s ease-out infinite}
@keyframes pl{0%{opacity:.7;transform:scale(1)}100%{opacity:0;transform:scale(1.55)}}
.stat.warn .ic{background:var(--warnbg);color:var(--warn)}
.stat.bad .ic{background:var(--badbg);color:var(--bad)}

/* tabs */
.tabs{display:flex;gap:6px;padding:5px;border-radius:16px;background:var(--card);border:1px solid var(--bd);margin-bottom:12px;position:sticky;top:6px;z-index:5;box-shadow:var(--sh)}
.tab{flex:1;border:0;background:transparent;border-radius:12px;height:42px;font-weight:700;font-size:13.5px;color:var(--mu);display:flex;align-items:center;justify-content:center;gap:6px;transition:background .2s,color .2s}
.tab[aria-selected=true]{background:var(--ac);color:#fff}
.tab i{font-style:normal;min-width:20px;height:20px;padding:0 6px;border-radius:10px;font-size:11.5px;line-height:20px;background:var(--warnbg);color:var(--warn);font-weight:800}
.tab[aria-selected=true] i{background:rgba(255,255,255,.25);color:#fff}

.panel{padding:14px}
.panel-h{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 12px}
.panel-h h2{margin:0;font-size:16px;font-weight:800}
.panel-h span{font-size:12px;color:var(--mu)}
.empty{text-align:center;padding:30px 10px;color:var(--mu);font-size:14px}

/* rows */
.item{display:flex;gap:12px;align-items:flex-start;padding:12px;border:1px solid var(--bd);border-radius:16px;margin-bottom:10px;animation:up .3s both}
@keyframes up{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.av{position:relative;flex:none;width:44px;height:44px;border-radius:14px;display:grid;place-items:center;font-weight:800;font-size:18px;color:#fff;background:linear-gradient(135deg,hsl(var(--h) 50% 45%),hsl(calc(var(--h) + 30) 52% 35%))}
.av.on:after{content:"";position:absolute;right:-3px;bottom:-3px;width:13px;height:13px;border-radius:50%;background:var(--ok);border:2.5px solid var(--card)}
.body{flex:1;min-width:0}
.name{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-weight:800;font-size:15px;overflow-wrap:anywhere}
.tag{font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px;background:var(--soft);color:var(--ac);white-space:nowrap}
.tag.warn{background:var(--warnbg);color:var(--warn)}
.tag.bad{background:var(--badbg);color:var(--bad)}
.tag.ok{background:var(--okbg);color:var(--ok)}
.meta{margin-top:3px;font-size:12.5px;color:var(--mu);overflow-wrap:anywhere}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.seen{display:inline-flex;align-items:center;gap:5px}
.seen:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--mu);opacity:.5}
.seen.on{color:var(--ok);font-weight:700}
.seen.on:before{background:var(--ok);opacity:1}

/* tools */
.search{display:flex;align-items:center;gap:8px;height:46px;padding:0 13px;border-radius:14px;border:1.5px solid var(--bd);background:var(--bg);margin-bottom:10px}
.search:focus-within{border-color:var(--ac)}
.search svg{width:18px;height:18px;color:var(--mu);flex:none}
.search input{flex:1;min-width:0;border:0;outline:0;background:transparent;font-size:15px}
.chips{display:flex;gap:7px;overflow-x:auto;padding-bottom:10px;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{flex:none;border:1.5px solid var(--bd);background:transparent;border-radius:20px;height:34px;padding:0 13px;font-size:13px;font-weight:700;color:var(--mu)}
.chip[aria-pressed=true]{background:var(--soft);border-color:var(--ac);color:var(--ac)}

/* import */
.drop{display:grid;justify-items:center;gap:8px;padding:26px 14px;border:2px dashed var(--bd);border-radius:18px;text-align:center;cursor:pointer;transition:border-color .2s,background .2s}
.drop:hover{border-color:var(--ac);background:var(--soft)}
.drop svg{width:34px;height:34px;color:var(--ac)}
.drop b{font-size:15px}
.drop small{color:var(--mu);font-size:12.5px;direction:ltr}
.drop input{display:none}
.note{margin-top:12px;padding:11px 13px;border-radius:13px;background:var(--warnbg);color:var(--warn);font-size:13px}
.res{margin-top:12px;padding:11px 13px;border-radius:13px;font-size:13.5px;background:var(--okbg);color:var(--ok)}
.res.bad{background:var(--badbg);color:var(--bad)}

/* modal + toast */
.ov{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:18px;background:rgba(5,15,20,.55);backdrop-filter:blur(4px)}
.modal{width:100%;max-width:360px;padding:22px 18px 16px;text-align:center;animation:up .25s both}
.modal h3{margin:0 0 6px;font-size:17px}
.modal p{margin:0 0 16px;color:var(--mu);font-size:14px}
.modal .row{display:flex;gap:8px}.modal .row .btn{flex:1;height:46px}
.toast{position:fixed;left:50%;bottom:calc(22px + env(safe-area-inset-bottom));transform:translate(-50%,20px);opacity:0;z-index:60;background:#1c2d33;color:#fff;padding:11px 18px;border-radius:14px;font-size:14px;font-weight:700;pointer-events:none;transition:.25s;max-width:92vw;text-align:center}
.toast.on{opacity:1;transform:translate(-50%,0)}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>

<div class="card login" id="lg">
 <div class="logo"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5.500c0 4.300-2.900 7.600-7 9.500-4.100-1.900-7-5.200-7-9.500V6l7-3z"/><path d="m9 12 2 2 4-4"/></svg></div>
 <h1>إدارة الدخول</h1><p>أدخل رمز الإدارة للمتابعة</p>
 <input class="field" id="code" type="password" autocomplete="off" placeholder="رمز الإدارة">
 <button class="btn wide" id="in">دخول</button>
 <div class="err" id="m" role="alert"></div>
</div>

<div class="wrap" id="app" hidden>
 <header class="hero">
  <div class="hero-top">
   <div><h1>إدارة الدخول</h1><p id="upd">فضاء طلبة الملحقة</p></div>
   <div class="hero-btns">
    <button class="ibtn" id="rf" type="button" aria-label="تحديث"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.500-5.800M20 4v5h-5"/></svg></button>
    <button class="ibtn" id="out" type="button" aria-label="خروج"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H6.500A2.500 2.500 0 0 0 4 6.500v11A2.500 2.500 0 0 0 6.500 20H9M15 8l4 4-4 4M19 12H9"/></svg></button>
   </div>
  </div>
 </header>

 <section class="stats">
  <div class="card stat live"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg></span><div><b id="sNow">0</b><small>نشطون الآن</small></div></div>
  <div class="card stat"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.500"/><path d="M12 7.500V12l3 2"/></svg></span><div><b id="sDay">0</b><small>نشطون خلال 24 ساعة</small></div></div>
  <div class="card stat"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.200"/><path d="M3 19c0-3 2.700-5 6-5s6 2 6 5M16 5.200a3 3 0 0 1 0 5.600M18 14.300c1.800.7 3 2.200 3 4.700"/></svg></span><div><b id="sUsers">0</b><small>المسجّلون</small></div></div>
  <div class="card stat warn"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l2 2"/><circle cx="12" cy="12" r="9"/></svg></span><div><b id="sPend">0</b><small>بانتظار الموافقة</small></div></div>
  <div class="card stat"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.500h16v13H4zM8 10h8M8 14h5"/></svg></span><div><b id="sRoster">0</b><small>طلبة القائمة</small></div></div>
  <div class="card stat bad"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.600 5.600l12.800 12.800"/></svg></span><div><b id="sBan">0</b><small>المحظورون</small></div></div>
 </section>

 <nav class="tabs" role="tablist">
  <button class="tab" role="tab" data-t="pending" aria-selected="true">الطلبات<i id="tPend" hidden>0</i></button>
  <button class="tab" role="tab" data-t="users" aria-selected="false">المسجّلون</button>
  <button class="tab" role="tab" data-t="import" aria-selected="false">الاستيراد</button>
 </nav>

 <section class="card panel" id="p-pending">
  <div class="panel-h"><h2>طلبات بانتظار الموافقة</h2><span id="pCount"></span></div>
  <div id="pend"></div>
 </section>

 <section class="card panel" id="p-users" hidden>
  <div class="panel-h"><h2>المسجّلون</h2><span id="uCount"></span></div>
  <label class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input id="q" type="search" placeholder="بحث بالاسم…" autocomplete="off"></label>
  <div class="chips" id="chips">
   <button class="chip" data-f="all" aria-pressed="true">الكل</button>
   <button class="chip" data-f="now" aria-pressed="false">نشطون الآن</button>
   <button class="chip" data-f="day" aria-pressed="false">نشطون اليوم</button>
   <button class="chip" data-f="ban" aria-pressed="false">المحظورون</button>
  </div>
  <div id="users"></div>
 </section>

 <section class="card panel" id="p-import" hidden>
  <div class="panel-h"><h2>استيراد قائمة الطلبة</h2></div>
  <label class="drop"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4"/></svg><b>اختر ملف CSV</b><small>group,seq,reg_no,name</small><input id="csv" type="file" accept=".csv,text/csv,text/plain"></label>
  <div class="note">الاستيراد يستبدل القائمة الحالية بالكامل.</div>
  <div id="im"></div>
 </section>
</div>

<div class="toast" id="tt" role="status"></div>

<script>
var $=function(i){return document.getElementById(i)},code=sessionStorage.getItem('ac')||'',data=null,tab='pending',flt='all',timer=0;
var NOW_MS=600000,DAY_MS=86400000;
function el(t,x,c){var e=document.createElement(t);if(x!=null)e.textContent=x;if(c)e.className=c;return e}
function api(a,p,body){var q=new URLSearchParams(Object.assign({action:a},p||{}));
 return fetch('/api/auth/admin?'+q,{method:body===undefined?'GET':'POST',headers:{'x-admin-code':code,'content-type':'text/csv'},body:body}).then(function(r){return r.json().then(function(j){j.http=r.status;return j})})}
function toast(m){var t=$('tt');t.textContent=m;t.classList.add('on');clearTimeout(toast.t);toast.t=setTimeout(function(){t.classList.remove('on')},2400)}
function when(ts){return ts?new Date(ts).toLocaleString('ar-DZ'):''}
function hue(s){var n=0;for(var i=0;i<s.length;i++)n=(n*31+s.charCodeAt(i))%360;return n}
function ago(ts){
 if(!ts)return 'لم يدخل بعد';
 var d=Date.now()-ts;
 if(d<NOW_MS)return 'نشط الآن';
 var m=Math.floor(d/60000);if(m<60)return 'منذ '+m+' د';
 var h=Math.floor(m/60);if(h<24)return 'منذ '+h+' س';
 return 'منذ '+Math.floor(h/24)+' يوم';
}
function avatar(name,on){var a=el('div',(name||'؟').trim().charAt(0)||'؟','av'+(on?' on':''));a.style.setProperty('--h',hue(name||''));return a}
function ask(title,msg,okText,fn){
 var o=el('div',null,'ov'),m=el('div',null,'card modal');
 m.appendChild(el('h3',title));m.appendChild(el('p',msg));
 var r=el('div',null,'row'),y=el('button',okText,'btn danger'),n=el('button','إلغاء','btn ghost');
 function close(){o.remove()}
 y.onclick=function(){close();fn()};n.onclick=close;o.onclick=function(e){if(e.target===o)close()};
 r.appendChild(y);r.appendChild(n);m.appendChild(r);o.appendChild(m);document.body.appendChild(o);
}
function act(a,p,okMsg){return api(a,p,'').then(function(j){if(j.error)toast('خطأ: '+j.error);else if(okMsg)toast(okMsg);return load(true)})}
function btn(t,cls,fn){var b=el('button',t,'btn sm '+cls);b.onclick=fn;return b}

function renderStats(){
 var a=data.active||{};
 $('sNow').textContent=a.now||0;$('sDay').textContent=a.day||0;
 $('sUsers').textContent=data.users.length;$('sPend').textContent=data.pending.length;
 $('sRoster').textContent=data.rosterCount;$('sBan').textContent=data.bans;
 var t=$('tPend');t.hidden=!data.pending.length;t.textContent=data.pending.length;
 $('upd').textContent='آخر تحديث: '+new Date().toLocaleTimeString('ar-DZ');
}
function renderPending(){
 var P=$('pend');P.textContent='';
 $('pCount').textContent=data.pending.length?data.pending.length+' طلب':'';
 if(!data.pending.length){P.appendChild(el('div','لا توجد طلبات حالياً ✓','empty'));return}
 data.pending.forEach(function(p,i){
  var it=el('div',null,'item');it.style.animationDelay=(i*40)+'ms';
  it.appendChild(avatar(p.name));
  var b=el('div',null,'body'),nm=el('div',null,'name');
  nm.appendChild(el('span',p.name||''));
  var kind=p.t==='new'?'طالب غير مدرج':p.t==='mismatch'?'اسم غير مطابق':'جهاز جديد';
  nm.appendChild(el('span',kind,'tag warn'));b.appendChild(nm);
  b.appendChild(el('div',(p.rn?'في القائمة: '+p.rn+(p.g?' · فوج '+p.g:''):'غير موجود في القائمة'),'meta'));
  b.appendChild(el('div',when(p.ts),'meta'));
  var ac=el('div',null,'acts');
  ac.appendChild(btn('قبول','',function(){act('approve',{id:p.id},'تم قبول الطلب')}));
  ac.appendChild(btn('رفض','ghost',function(){act('reject',{id:p.id},'تم رفض الطلب')}));
  b.appendChild(ac);it.appendChild(b);P.appendChild(it);
 });
}
function renderUsers(){
 var U=$('users'),f=($('q').value||'').trim(),now=Date.now();U.textContent='';
 var list=data.users.filter(function(u){
  if(f&&(u.n||'').indexOf(f)<0)return false;
  if(flt==='now')return u.ls&&now-u.ls<NOW_MS;
  if(flt==='day')return u.ls&&now-u.ls<DAY_MS;
  if(flt==='ban')return u.banned;
  return true;
 }).sort(function(a,b){return (b.ls||0)-(a.ls||0)||(b.ts||0)-(a.ts||0)});
 $('uCount').textContent=list.length+' من '+data.users.length;
 if(!list.length){U.appendChild(el('div','لا توجد نتائج.','empty'));return}
 list.slice(0,200).forEach(function(u,i){
  var on=u.ls&&now-u.ls<NOW_MS;
  var it=el('div',null,'item');it.style.animationDelay=Math.min(i,10)*30+'ms';
  it.appendChild(avatar(u.n,on));
  var b=el('div',null,'body'),nm=el('div',null,'name');
  nm.appendChild(el('span',u.n||''));
  if(u.banned)nm.appendChild(el('span','محظور','tag bad'));
  if(u.g)nm.appendChild(el('span','فوج '+u.g,'tag'));
  b.appendChild(nm);
  var m=el('div',null,'meta');m.appendChild(el('span',ago(u.ls),'seen'+(on?' on':'')));
  m.appendChild(document.createTextNode(' · أجهزة: '+(u.c||1)+' · انضم '+when(u.ts)));b.appendChild(m);
  var ac=el('div',null,'acts');
  ac.appendChild(btn(u.banned?'إلغاء الحظر':'حظر',u.banned?'soft':'danger',function(){
   if(u.banned)act('unban',{sid:u.sid},'تم إلغاء الحظر');
   else ask('حظر الطالب','سيُمنع «'+(u.n||'')+'» من الدخول فوراً.','حظر',function(){act('ban',{sid:u.sid},'تم الحظر')});
  }));
  ac.appendChild(btn('تصفير الأجهزة','ghost',function(){
   ask('تصفير الأجهزة','سيُحذف ارتباط أجهزة «'+(u.n||'')+'» وسيحتاج للموافقة عند الدخول من جهاز جديد.','تصفير',function(){act('resetdev',{sid:u.sid},'تم تصفير الأجهزة')});
  }));
  b.appendChild(ac);it.appendChild(b);U.appendChild(it);
 });
}
function render(){renderStats();renderPending();renderUsers()}
function setTab(t){
 tab=t;
 [].forEach.call(document.querySelectorAll('.tab'),function(b){b.setAttribute('aria-selected',String(b.getAttribute('data-t')===t))});
 ['pending','users','import'].forEach(function(k){$('p-'+k).hidden=k!==t});
}
function load(silent){
 var rf=$('rf');if(!silent)rf.classList.add('spin');
 return api('list').then(function(j){
  rf.classList.remove('spin');
  if(j.http===401){sessionStorage.removeItem('ac');code='';$('lg').hidden=false;$('app').hidden=true;$('m').textContent='رمز غير صحيح';return}
  if(j.error){$('m').textContent='خطأ: '+j.error;return}
  data=j;$('lg').hidden=true;$('app').hidden=false;render();
  if(!timer)timer=setInterval(function(){if(!document.hidden&&code)load(true)},30000);
 }).catch(function(){rf.classList.remove('spin');if(!silent)toast('تعذّر الاتصال')});
}
function login(){code=$('code').value.trim();if(!code)return;sessionStorage.setItem('ac',code);$('m').textContent='';load()}
$('in').onclick=login;
$('code').onkeydown=function(e){if(e.key==='Enter')login()};
$('rf').onclick=function(){load()};
$('out').onclick=function(){sessionStorage.removeItem('ac');code='';data=null;clearInterval(timer);timer=0;$('app').hidden=true;$('lg').hidden=false;$('code').value=''};
[].forEach.call(document.querySelectorAll('.tab'),function(b){b.onclick=function(){setTab(b.getAttribute('data-t'))}});
[].forEach.call(document.querySelectorAll('.chip'),function(b){b.onclick=function(){flt=b.getAttribute('data-f');[].forEach.call(document.querySelectorAll('.chip'),function(c){c.setAttribute('aria-pressed',String(c===b))});if(data)renderUsers()}});
$('q').oninput=function(){if(data)renderUsers()};
$('csv').onchange=function(){
 var inp=this,f=inp.files[0];if(!f)return;
 ask('استبدال القائمة','سيُستبدل ملف القائمة الحالي بالكامل بـ «'+f.name+'».','متابعة',function(){
  f.text().then(function(t){return api('import',{},t)}).then(function(j){
   var r=el('div',null,'res'+(j.ok?'':' bad'));
   r.textContent=j.ok?('تم استيراد '+j.imported+' طالب'+(j.duplicates?' · تكرار: '+j.duplicates:'')+(j.skipped?' · أسطر متجاهلة: '+j.skipped:'')):('فشل: '+(j.error||''));
   var box=$('im');box.textContent='';box.appendChild(r);inp.value='';load(true);
  });
 });
 inp.value='';
};
if(code)load();
</script></body></html>
`;


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const gate = await authGate(request, env, url, ctx);
    if (gate) return gate;
    if (url.pathname === "/api/publish") return handlePublish(request, env);
    if (url.pathname === "/api/history") return handleHistory(request, env);
    if (url.pathname === "/api/lessons" || url.pathname === "/api/file" || url.pathname === "/api/academic" || url.pathname === "/api/academic-image" || url.pathname === "/api/resources" || url.pathname === "/api/resource" || url.pathname === "/api/announcements" || url.pathname === "/api/badges" || url.pathname === "/api/reactions" || url.pathname === "/api/notifications" || url.pathname === "/api/polls" || url.pathname === "/api/comments") {
      const response = await handleApi(request, env, ctx);
      if (request.method !== "GET" && request.method !== "HEAD" && response.status >= 200 && response.status < 300 && PUBLISH_PATHS.has(url.pathname)) schedulePublish(ctx, env);
      return response;
    }
    const response = await env.ASSETS.fetch(request);
    if ((url.pathname === "/" || url.pathname === "/index.html") &&
        (response.headers.get("content-type") || "").includes("text/html")) {
      return new HTMLRewriter()
        .on('script[src="/academic-admin.js"]', {
          element(element) {
            element.setAttribute("src", "/academic-admin.js?v=20261116-ui");
          }
        })
        .on('script[src*="/schedule-view.js"]', {
          element(element) {
            element.setAttribute("src", "/schedule-view.js?v=20261116-admin-only");
          }
        })
        .transform(response);
    }
    return response;
  },
};
