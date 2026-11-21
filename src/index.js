const KEY_PATTERN = /^(?:[A-Z]|Y\d{1,3}S[1-4][A-Z])-\d{2}-\d{2}-\d{2}$/;
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
  const match = /^(?:([A-Z])|Y\d{1,3}S[1-4]([A-Z]))-/.exec(String(key || ""));
  return match ? (match[1] || match[2]) : null;
}

/* رموز إدارة الدروس: المجموعتان A وB لهما رمزاهما، وأي مجموعة مضافة لاحقاً من قسم التوقيت (C, D, ...)
   تقبل رمزها الخاص ADMIN_CODE_<الحرف> إن وُجد، وإلا رمز المالك ADMIN_CODE_MOD. */
function lessonAdminCodes(env, group) {
  if (!/^[A-Z]$/.test(String(group || ""))) return [];
  if (group === "A" || group === "B") return [String(env["ADMIN_CODE_" + group] || "").trim()].filter(Boolean);
  return [String(env["ADMIN_CODE_" + group] || "").trim(), String(env.ADMIN_CODE_MOD || "").trim()].filter(Boolean);
}

function isLessonAdmin(request, env, group) {
  const expected = lessonAdminCodes(env, group);
  const supplied = String(request.headers.get("x-admin-code") || "").trim();
  const suppliedGroup = String(request.headers.get("x-admin-group") || "").trim().toUpperCase();
  return expected.length > 0 && suppliedGroup === group && expected.includes(supplied);
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

/* تنفيذ دوال غير متزامنة بتوازٍ محدود مع حفظ ترتيب النتائج */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/* مفاتيح المحاضرات تبدأ بـ A- أو B- أو Y: نسرد هذه البادئات الثلاث بالتوازي بدل سرد كل الحاوية
   (التي تضم الموارد والصور والإعلانات)، فيسرع الجلب بعد كل رفع مهما كبرت المكتبة */
const LESSON_PREFIXES = ["A-", "B-", "Y"];
async function listLessons(env) {
  const parts = await Promise.all(LESSON_PREFIXES.map((prefix) => listLessonsByPrefix(env, prefix)));
  const files = parts.flat();
  files.sort((a, b) => a.lessonKey.localeCompare(b.lessonKey) || (a.ts || 0) - (b.ts || 0) || a.name.localeCompare(b.name, "ar"));
  return files;
}
async function listLessonsByPrefix(env, prefix) {
  const files = [];
  let token = "";
  for (let page = 0; page < 100; page++) {
    const response = await signedB2Request(env, "GET", "", null, {
      "list-type": "2",
      "max-keys": "1000",
      prefix,
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
async function edgeFile(request, ttl, produce, cc) {
  const fail = () => json({ error: "storage_error" }, 502);
  if (!hasEdge() || request.method !== "GET") { try { return await produce(); } catch { return fail(); } }
  const cache = caches.default, ck = new Request(request.url), sk = new Request(EDGE + "stale-file:" + request.url);
  const client = (res, tag, age) => { const h = new Headers(res.headers); h.set("cache-control", cc && tag !== "stale" ? cc : "private, max-age=" + age); h.set("x-edge", tag); return new Response(res.body, { status: 200, headers: h }); };
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
/* تخزين الملفات في متصفح الطالب: مفاتيح الدروس الجديدة فيها طابع زمني (13 رقماً) فهي لا تتغير → 30 يوماً.
   الموارد قد تُستبدل بالاسم نفسه (owner_replace) فنكتفي بيوم واحد. المفاتيح القديمة بلا طابع → 10 دقائق. */
function fileCacheControl(key) {
  if (String(key).startsWith("resources/")) return "private, max-age=86400";
  const info = fileInfo(key);
  return info && info.ts ? "private, max-age=2592000, immutable" : "private, max-age=600";
}
const APPROVED_INDEX_KEY = "resources/index-approved.json";
/* مصالحة فهرس الموارد: تقارن قائمة الملفات في B2 بالفهرس وتقرأ الناقص فقط (حتى 38 مورداً في المرة)
   حتى لا تتجاوز حدّ 50 طلباً فرعياً في الخطة المجانية. remaining > 0 يعني: استدعِها مرة أخرى. */
const RECONCILE_MAX = 38;
async function reconcileApprovedIndex(env) {
  const prefix = "resources/approved/";
  const objects = (await listObjectsByPrefix(env, prefix)).filter((o) => o.key.endsWith(".json"));
  const onDisk = new Map(objects.map((o) => [o.key.slice(prefix.length, -5), o.key]));
  let items = [];
  try {
    const r = await signedB2Request(env, "GET", APPROVED_INDEX_KEY);
    if (r.ok) { const a = await r.json(); if (Array.isArray(a)) items = a; }
  } catch {}
  const have = new Set(items.map((x) => x && x.id));
  items = items.filter((x) => x && onDisk.has(x.id)); // نسقط ما حُذف ملفه
  const missing = [...onDisk.keys()].filter((id) => !have.has(id));
  const batch = missing.slice(0, RECONCILE_MAX);
  const metas = await mapLimit(batch, 10, (id) => readResourceMeta(env, onDisk.get(id)).catch(() => null));
  for (const m of metas) { if (m && m.id && m.fileKey) items.push({ ...publicResource(m), status: "approved" }); }
  items.sort((x, y) => String(y.createdAt || "").localeCompare(String(x.createdAt || "")));
  await signedB2Request(env, "PUT", APPROVED_INDEX_KEY, encoder.encode(JSON.stringify(items)), {}, "application/json");
  return { items, remaining: missing.length - batch.length };
}
async function rebuildApprovedIndex(env) { return (await reconcileApprovedIndex(env)).items; }
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
  try{const objects=(await listObjectsByPrefix(env,"resources/"+status+"/")).filter(o=>o.key.endsWith(".json")),items=[];
   const metas=await mapLimit(objects,10,o=>readResourceMeta(env,o.key).catch(()=>null));
   for(const m of metas){if(m?.id&&m.fileKey)items.push({...publicResource(m),status})}
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
/* شارة خاصة بكل مشرف (اسم الشارة + لونها): تُحفظ نسخة مستقلة في سجل المشرف، فلا يغيّرها تعديل الشارة العامة */
const supCustom = (x) => (x && /^#[0-9a-fA-F]{6}$/.test(String(x.bc || "")))
  ? { label: badgeText(x.bl, 24) || BADGE_DEFAULTS.supervisor.label, color: x.bc } : null;
const supUid = async (env, sid) => (await mac(env, "u|" + sid)).slice(0, 16);
const supOut = (list) => list.map((x) => ({ id: String(x.sid).slice(0, 12), name: x.name, at: x.at, perms: supEntryPerms(x), badge: supCustom(x) }));
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
    const custom = {};
    for (const x of await readSupervisors(env)) { const c = supCustom(x); if (c) custom[await supUid(env, x.sid)] = c; }
    return json({ ok: true, badges, custom });
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
  if (action === "set_sup_badge" || action === "reset_sup_badge") {
    const id = String(b.id || ""), i = list.findIndex((x) => String(x.sid).slice(0, 12) === id);
    if (i < 0) return json({ error: "not_found" }, 404);
    if (action === "reset_sup_badge") { delete list[i].bl; delete list[i].bc; }
    else {
      const color = String(b.color || "");
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) return json({ error: "invalid_input" }, 400);
      list[i].bl = badgeText(b.label, 24) || BADGE_DEFAULTS.supervisor.label;
      list[i].bc = color;
    }
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
/* من يُنشر مورده مباشرة دون مراجعة: المالك والأستاذ والمشرف (الدور يُحدَّد في الخادم فقط) */
const DIRECT_PUBLISH_ROLES=["owner","teacher","supervisor"];
async function handleResourceFile(request,env,ctx){
 const u=new URL(request.url),key=u.searchParams.get("key")||"";
 if(request.method==="POST"&&u.searchParams.get("action")==="reindex"){
  /* إعادة بناء فهرس الموارد المنشورة بعد رفع عدة أجزاء بالتوازي (لتفادي ضياع أحدها عند الكتابة المتزامنة) */
  const who=await uploaderInfo(request,env);
  if(!DIRECT_PUBLISH_ROLES.includes(who.role))return json({error:"unauthorized"},401);
  const rk="reidx:"+(who.uid||who.role);
  if(rlCount(rk,600000)>=6)return json({error:"rate_limited"},429);
  rlAdd(rk,600000);
  try{await edgeDrop("res-approved");const rc=await reconcileApprovedIndex(env);schedulePublish(ctx,env);return json({ok:true,remaining:rc.remaining})}
  catch(e){return json({error:"storage_error"},502)}
 }
 if(request.method==="POST"){
  const name=safeFileName(u.searchParams.get("name")),type=contentTypeForName(name);
  if(type==="application/octet-stream")return json({error:"unsupported_file_type"},400);
  const meta={id:crypto.randomUUID(),title:String(u.searchParams.get("title")||"").trim().slice(0,120),year:metaText(u.searchParams.get("year"),40),semester:metaText(u.searchParams.get("semester"),40),subject:metaText(u.searchParams.get("subject"),100),kind:metaText(u.searchParams.get("kind"),40),fileName:name,contentType:type,createdAt:new Date().toISOString()};
  if(!validMeta(meta))return json({error:"invalid_resource_metadata"},400);
  const data=await request.arrayBuffer();if(!data.byteLength)return json({error:"empty_file"},400);if(data.byteLength>MAX_FILE_SIZE)return json({error:"file_too_large",limit:MAX_FILE_SIZE},413);
  if(!fileBytesMatch(type,data))return json({error:"file_type_mismatch"},400);
  const up=await uploaderInfo(request,env);if(up.name)meta.uploader=up.name;if(up.role)meta.uploaderRole=up.role;if(up.uid)meta.uploaderId=up.uid;if(up.group)meta.uploaderGroup=up.group;
  const ownerRaw=String(u.searchParams.get("owner")||"").trim();if(/^[A-Za-z0-9_-]{16,128}$/.test(ownerRaw))meta.ownerHash=await sha256Hex(ownerRaw);
  const direct=DIRECT_PUBLISH_ROLES.includes(up.role);
  const base="resources/"+(direct?"approved/":"pending/")+meta.id;meta.fileKey=base+"__"+name;
  if(direct){meta.status="approved";meta.approvedAt=meta.createdAt}
  /* الملف وبياناته يُرفعان معًا (طلبان متوازيان بدل متتاليين)، وعند فشل أحدهما نمسح ما رُفع */
  const [put,save]=await Promise.all([
   signedB2Request(env,"PUT",meta.fileKey,data,{},type).catch(()=>null),
   signedB2Request(env,"PUT",base+".json",encoder.encode(JSON.stringify(meta)),{},"application/json").catch(()=>null)
  ]);
  if(!put||!put.ok||!save||!save.ok){await Promise.all([deleteResourceObject(env,meta.fileKey).catch(()=>{}),deleteResourceObject(env,base+".json").catch(()=>{})]);return json({error:"storage_error"},502)}
  if(direct){await refreshApproved(env,{upsert:meta});schedulePublish(ctx,env);return json({ok:true,pending:false,published:true,id:meta.id})}
  return json({ok:true,pending:true,id:meta.id});
 }
 if(request.method==="GET"){
  const approved=key.startsWith("resources/approved/")&&!key.includes(".."),pending=key.startsWith("resources/pending/")&&!key.includes("..")&&(await canModerateRes(request,env));
  if(!approved&&!pending)return json({error:"not_found"},404);
  const serve=async()=>{
  const r=await signedB2Request(env,"GET",key);if(r.status===404)return json({error:"not_found"},404);if(!r.ok)return json({error:"storage_error"},502);
  const name=safeFileName(key.split("__").slice(1).join("__")||"resource.pdf"),type=contentTypeForName(name);
  return new Response(r.body,{headers:{"content-type":type,"content-disposition":((type==="application/pdf"||type.startsWith("image/"))&&u.searchParams.get("download")!=="1"?"inline":"attachment")+'; filename="'+name.replace(/[^\x20-\x7E]/g,"_").replace(/["\\\\]/g,"_")+'"; filename*=UTF-8\'\''+encodeRFC3986(name),"cache-control":fileCacheControl(key),"x-content-type-options":"nosniff"}});
  };
  return approved?edgeFile(request,21600,serve,fileCacheControl(key)):serve();
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

/* ===== حاسبة المعدل: القراءة للجميع (بعد الدخول)، والتعديل للمالك وحده ===== */
const GPA_KEY = "tools/gpa-config.json";
function gpaClean(raw) {
  const clip = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
  const sems = Array.isArray(raw && raw.semesters) ? raw.semesters.slice(0, 6) : [];
  const out = [];
  for (const sm of sems) {
    const subs = [];
    const seen = new Set();
    for (const s of (Array.isArray(sm && sm.subjects) ? sm.subjects.slice(0, 80) : [])) {
      let id = clip(s && s.id, 24).replace(/[^A-Za-z0-9_-]/g, "");
      if (!id || seen.has(id)) id = "m" + crypto.randomUUID().slice(0, 6);
      seen.add(id);
      const name = clip(s && s.name, 60);
      if (!name) continue;
      const coef = Number(s && s.coef);
      const item = { id, name, coef: coef > 0 && coef <= 50 ? coef : 1, td: !!(s && s.td), tp: !!(s && s.tp) };
      if (s && s.ex === false) item.ex = false;
      const group = clip(s && s.group, 40);
      if (group) item.group = group;
      subs.push(item);
    }
    const title = clip(sm && sm.title, 60);
    let sid = clip(sm && sm.id, 24).replace(/[^A-Za-z0-9_-]/g, "");
    if (!sid) sid = "s" + crypto.randomUUID().slice(0, 6);
    out.push({ id: sid, title: title || "سداسي", subjects: subs });
  }
  return { v: 1, allowRt: !!(raw && raw.allowRt), semesters: out, updatedAt: new Date().toISOString() };
}

async function handleGpa(request, env) {
  if (request.method === "GET") return edgeJson("gpa", 120, async () => {
    try {
      const response = await signedB2Request(env, "GET", GPA_KEY);
      if (response.status === 404) return json({ config: null });
      if (!response.ok) throw new Error("GPA config read failed (" + response.status + ")");
      return json({ config: await response.json() });
    } catch (error) {
      return json({ error: "gpa_config_read_failed", message: String(error.message || error).slice(0, 180) }, 502);
    }
  });
  // كل ما عدا القراءة للمالك فقط (جلسة المالك أو رمز الإدارة الأكاديمية)
  if (!(await isOwnerSession(request, env))) return json({ error: "unauthorized" }, 401);
  if (request.method === "POST") return json({ ok: true, owner: true });
  if (request.method === "PUT") {
    let body = {};
    try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
    const config = gpaClean(body && body.config);
    if (!config.semesters.length) return json({ error: "invalid_config" }, 400);
    const r = await signedB2Request(env, "PUT", GPA_KEY, encoder.encode(JSON.stringify(config)), {}, "application/json");
    if (!r.ok) return json({ error: "storage_error", status: r.status }, 502);
    await edgeDrop("gpa");
    return json({ ok: true, config });
  }
  return json({ error: "method_not_allowed" }, 405);
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
/* إعدادات «إدارة المكتبة» تُحفظ كإعلان بهذا العنوان؛ تعديلها (إضافة/تعديل/حذف) للمالك وحده */
const LIB_CFG_TITLE = "__ensd_library_config__";
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
   ann = إدارة الإعلانات · res = إدارة المشاركات الجديدة (مراجعة الموارد المعلّقة) · academic = إدارة الدروس والمواد (الوحدات والمواضيع)
   «إدارة المكتبة» (التصنيفات والألوان) للمالك وحده، ولا تُمنح لأي مشرف أو أستاذ. */
const SUP_PERMS = ["ann", "res", "academic"];
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
/* إدارة الإعلانات: المالك والأستاذ، والمشرف الذي منحه المالك صلاحية «ann» */
async function isTeacherAccess(request, env) {
  const hdr = String(request.headers.get("x-admin-code") || "").trim();
  if (hdr && [env.ADMIN_CODE_A, env.ADMIN_CODE_B].some((v) => { const e = String(v || "").trim(); return e && safeEq(hdr, e); })) return true;
  try { const ss = await readSession(request, env); return !!(ss.ok && ss.sid === "admin" && (await readRole(request, env)) === "teacher"); } catch { return false; }
}
async function canManageAnn(request, env) {
  return (await isOwnerSession(request, env)) || (await isTeacherAccess(request, env)) || (await supervisorHas(request, env, "ann"));
}
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
      // check يخدم واجهة الموارد أيضاً: الإعلانات للمالك والأستاذ والمشرف بصلاحية ann، والمشرف بصلاحية الموارد يمرّ للموارد
      const resOk = annOk || (await canModerateRes(request, env));
      return resOk ? json({ ok: true, ann: annOk, res: resOk }) : json({ ok: false, error: "unauthorized" }, 401);
    }
    if (!annOk) return json({ ok: false, error: "unauthorized" }, 401);

    const list = await readAnnouncements(env);
    const isOwner = await isOwnerSession(request, env);
    if (action === "add") {
      let body = {};
      try { body = await request.json(); } catch {}
      const title = annClip(body.title, 120);
      if (!title) return json({ ok: false, error: "title_required" }, 400);
      if (title === LIB_CFG_TITLE && !isOwner) return json({ ok: false, error: "owner_only" }, 403);
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
    if (annClip(list[idx].title, 120) === LIB_CFG_TITLE && !isOwner) return json({ ok: false, error: "owner_only" }, 403);
    if (action === "edit") {
      // تعديل إعلان موجود: يحافظ على المعرّف والتصويت والتفاعلات والتعليقات
      let body = {};
      try { body = await request.json(); } catch {}
      const title = annClip(body.title, 120);
      if (!title) return json({ ok: false, error: "title_required" }, 400);
      if (title === LIB_CFG_TITLE && !isOwner) return json({ ok: false, error: "owner_only" }, 403);
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

/* ===== D1 (قاعدة Cloudflare المجانية): التفاعلات والإشعارات وآخر ظهور =====
   لماذا D1؟ حدّ KV المجاني 1,000 كتابة يومياً فقط، أما D1 فيسمح بـ 100 ألف كتابة و5 ملايين قراءة يومياً.
   الجداول تُنشأ تلقائياً عند أول استعمال (CREATE TABLE IF NOT EXISTS) ولا تحتاج أي أمر يدوي.
   rx(id,me,t)  : من تفاعل (me) مع أي عنصر (id)         rxc(id,n) : عدّاد جاهز لكل عنصر (يُقرأ بدل العدّ كل مرة)
   nt(uid,...)  : إشعارات صاحب الملف                      seen(sid,t): آخر ظهور للطالب (لعدّاد النشطين) */
let dbReady = null;
async function dbInit(env) {
  const db = env && env.DB && typeof env.DB.prepare === "function" ? env.DB : null;
  if (!db) throw new Error("d1_not_configured");
  if (!dbReady) {
    dbReady = db.batch([
      db.prepare("CREATE TABLE IF NOT EXISTS rx (id TEXT NOT NULL, me TEXT NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (id, me))"),
      db.prepare("CREATE INDEX IF NOT EXISTS rx_me ON rx (me, t)"),
      db.prepare("CREATE TABLE IF NOT EXISTS rxc (id TEXT PRIMARY KEY, n INTEGER NOT NULL)"),
      db.prepare("CREATE TABLE IF NOT EXISTS nt (uid TEXT NOT NULL, i TEXT NOT NULL, r TEXT, x TEXT, t INTEGER NOT NULL, n TEXT, o TEXT, u TEXT, PRIMARY KEY (uid, i))"),
      db.prepare("CREATE TABLE IF NOT EXISTS seen (sid TEXT PRIMARY KEY, t INTEGER NOT NULL)")
    ]).then(() => db, (e) => { dbReady = null; throw e; });
  }
  return dbReady;
}
const dbErr = (e) => (e && e.message === "d1_not_configured" ? json({ error: "d1_not_configured" }, 503) : json({ error: "storage_error" }, 503));

/* ===== التفاعلات (قلب مشترك على الملفات والموارد والإعلانات) =====
   المعرّف: res:<مفتاح المورد> | lesson:<مفتاح ملف الدرس> | ann:<معرّف الإعلان> */
const RX_ID = /^(?:res|lesson|ann):[^\u0000-\u001f\u007f]{1,260}$/u;
const RX_MINE_MAX = 400, RX_ITEM_MAX = 3000, RX_SYNC_CHUNK = 15, RX_TTL = 60000;
/* إضافة/إزالة تفاعل: عملية واحدة ذرّية (الصف + العدّاد + القراءة) */
async function rxApply(db, id, me, on) {
  const r = await db.batch([
    on
      ? db.prepare("INSERT OR IGNORE INTO rx (id, me, t) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM rx WHERE id = ?1) < ?4").bind(id, me, Date.now(), RX_ITEM_MAX)
      : db.prepare("DELETE FROM rx WHERE id = ?1 AND me = ?2").bind(id, me),
    db.prepare("INSERT INTO rxc (id, n) SELECT ?1, COUNT(*) FROM rx WHERE id = ?1 ON CONFLICT(id) DO UPDATE SET n = excluded.n").bind(id),
    db.prepare("SELECT n FROM rxc WHERE id = ?1").bind(id)
  ]);
  const changed = Number(r[0] && r[0].meta && r[0].meta.changes) > 0;
  const row = r[2] && r[2].results && r[2].results[0];
  return { n: row ? Number(row.n) || 0 : 0, changed };
}
async function rxMine(db, me) {
  const r = await db.prepare("SELECT id FROM rx WHERE me = ?1 ORDER BY t DESC LIMIT ?2").bind(me, RX_MINE_MAX).all();
  return (r.results || []).map((x) => x.id);
}
async function rxPurge(env, id) {
  try {
    const db = await dbInit(env);
    await db.batch([db.prepare("DELETE FROM rx WHERE id = ?1").bind(id), db.prepare("DELETE FROM rxc WHERE id = ?1").bind(id)]);
    rxDrop();
  } catch {}
}
/* أعداد القلوب: تُحفظ 60 ثانية في ذاكرة الـ isolate (لا Cache API ولا list). الاستعلام يقرأ جدول العدّادات الصغير فقط */
let rxMemo = { t: 0, counts: null, p: null };
function rxDrop() { rxMemo.t = 0; }
async function rxCounts(env) {
  if (rxMemo.counts && Date.now() - rxMemo.t < RX_TTL) return rxMemo.counts;
  if (rxMemo.p) return rxMemo.p;
  rxMemo.p = (async () => {
    try {
      const db = await dbInit(env), r = await db.prepare("SELECT id, n FROM rxc WHERE n > 0").all(), counts = {};
      for (const x of r.results || []) counts[x.id] = Number(x.n) || 0;
      rxMemo = { t: Date.now(), counts, p: null };
      return counts;
    } catch (e) {
      rxMemo.p = null;
      if (rxMemo.counts) return rxMemo.counts; // عند الفشل نخدم آخر نسخة ناجحة
      throw e;
    }
  })();
  return rxMemo.p;
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
  if (hit && Date.now() - hit.t < 300000) return { name: sup && sup.name ? sup.name : hit.name, role: sup ? "supervisor" : "", u: sup ? await supUid(env, me) : "" };
  const kv = kvOf(env);
  let name = "";
  try { name = ((await kv.get("prof:" + me, { type: "json" })) || {}).n || ""; } catch {}
  if (!name) { const r = ctxData.roster && ctxData.roster[me]; if (r && r[0]) name = r[0]; }
  if (!name) { try { const rec = await kv.get("dev:" + me, { type: "json" }); if (rec && rec.n) name = rec.n; } catch {} }
  name = String(name || "طالب").slice(0, 60);
  if (personCache.size > 500) personCache.clear();
  personCache.set(me, { name, t: Date.now() });
  return { name: sup && sup.name ? sup.name : name, role: sup ? "supervisor" : "", u: sup ? await supUid(env, me) : "" };
}
async function rxPersonCtx(env, needRoster) {
  const kv = kvOf(env);
  let roster = null;
  if (needRoster) { try { roster = (await kv.get("roster", { type: "json", cacheTtl: 60 })) || {}; } catch { roster = {}; } }
  return { cfg: mergeBadgeCfg(await readBadgeRaw(env)), sups: await readSupervisors(env), roster };
}
/* ===== إشعارات صاحب الملف (جدول nt في D1؛ n = اسم المتفاعل، o = دوره) ===== */
const NT_MAX = 60, NT_DAYS = 60;
let idxMemo = { t: 0, items: null };
async function approvedIndexMemo(env) {
  if (idxMemo.items && Date.now() - idxMemo.t < 60000) return idxMemo.items;
  const items = await approvedIndex(env);
  idxMemo = { t: Date.now(), items };
  return items;
}
async function notifyOwnerOfReaction(env, id, reactor) {
  if (!id.startsWith("res:")) return;
  const key = id.slice(4);
  let meta = null;
  try { meta = (await approvedIndexMemo(env)).find((x) => x && x.fileKey === key) || null; } catch { return; }
  if (!meta || !meta.uploaderId || meta.uploaderId === reactor.uid) return;
  const title = String(meta.title || meta.fileName || "ملف").replace(/[\s_]*\(\s*جزء\s*\d+\s*من\s*\d+\s*\)[\s_]*(?:\.pdf)?\s*$/i, "").slice(0, 120);
  const db = await dbInit(env), uid = String(meta.uploaderId);
  const nid = (await sha256Hex(reactor.me + "|" + id)).slice(0, 10);
  const dup = await db.prepare("SELECT 1 AS x FROM nt WHERE uid = ?1 AND i = ?2").bind(uid, nid).first();
  if (dup) return; // نفس الشخص لا يكرّر الإشعار
  let person = { name: "", role: "" };
  try { person = await rxPerson(env, reactor.me, await rxPersonCtx(env, true)); } catch {}
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO nt (uid, i, r, x, t, n, o, u) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
      .bind(uid, nid, id, title, now, String(person.name || ""), String(person.role || ""), person.role === "supervisor" ? String(person.u || "") : ""),
    db.prepare("DELETE FROM nt WHERE uid = ?1 AND (t < ?2 OR i NOT IN (SELECT i FROM nt WHERE uid = ?1 ORDER BY t DESC LIMIT ?3))")
      .bind(uid, now - NT_DAYS * 86400000, NT_MAX)
  ]);
}
const NT_SQL = "SELECT i, r, x, t, n, o, u FROM nt WHERE uid = ?1 ORDER BY t DESC LIMIT ?2";
const ntShape = (rows) => (rows || []).map((x) => ({ i: x.i, r: x.r, x: x.x, t: Number(x.t), n: x.n || "", o: x.o || "", u: x.u || "" }));
async function handleNotifications(request, env) {
  const ss = await readSession(request, env);
  if (!ss.ok) return json({ error: "login_required" }, 401);
  try {
    const db = await dbInit(env), who = await rxIdentity(request, env, ss);
    if (request.method === "GET") {
      const list = ntShape((await db.prepare(NT_SQL).bind(who.uid, NT_MAX).all()).results);
      return json({ ok: true, list, n: list.length });
    }
    if (request.method === "POST") {
      await db.prepare("DELETE FROM nt WHERE uid = ?1").bind(who.uid).run();
      return json({ ok: true });
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (e) { return dbErr(e); }
}
/* مزامنة واحدة بدل طلبين: أعداد القلوب + تفاعلاتي + إشعاراتي (GET /api/sync) */
async function handleSync(request, env) {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const ss = await readSession(request, env);
  if (!ss.ok) return json({ error: "login_required" }, 401);
  const u = new URL(request.url), wantMine = u.searchParams.get("mine") !== "0";
  try {
    const db = await dbInit(env), who = await rxIdentity(request, env, ss);
    const [counts, rs] = await Promise.all([
      rxCounts(env),
      db.batch([
        ...(wantMine ? [db.prepare("SELECT id FROM rx WHERE me = ?1 ORDER BY t DESC LIMIT ?2").bind(who.me, RX_MINE_MAX)] : []),
        db.prepare(NT_SQL).bind(who.uid, NT_MAX)
      ])
    ]);
    const out = { ok: true, counts };
    if (wantMine) out.mine = (rs[0].results || []).map((x) => x.id);
    out.list = ntShape((rs[wantMine ? 1 : 0] || {}).results);
    out.n = out.list.length;
    return json(out);
  } catch (e) { return dbErr(e); }
}
async function handleReactions(request, env, ctx) {
  const u = new URL(request.url), action = u.searchParams.get("action") || "react";
  const ss = await readSession(request, env);
  try {
    if (request.method === "GET" && action === "who") {
      // من تفاعل مع العنصر (للضغط المطوّل على القلب): يتطلب تسجيل الدخول
      if (!ss.ok) return json({ error: "login_required" }, 401);
      const id = String(u.searchParams.get("id") || "");
      if (!RX_ID.test(id)) return json({ error: "invalid_input" }, 400);
      const db = await dbInit(env);
      const [tot, rows] = await db.batch([
        db.prepare("SELECT n FROM rxc WHERE id = ?1").bind(id),
        db.prepare("SELECT me FROM rx WHERE id = ?1 ORDER BY t DESC LIMIT 20").bind(id)
      ]);
      const total = tot.results && tot.results[0] ? Number(tot.results[0].n) || 0 : 0;
      const ctxData = await rxPersonCtx(env, true), list = [];
      for (const r of rows.results || []) list.push(await rxPerson(env, r.me, ctxData));
      return json({ ok: true, total, list });
    }
    if (request.method === "GET") {
      const out = { ok: true, counts: await rxCounts(env) };
      if (u.searchParams.get("mine") !== "0") {
        if (ss.ok) { try { out.mine = await rxMine(await dbInit(env), (await rxIdentity(request, env, ss)).me); } catch {} } else out.mine = [];
      }
      return json(out);
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!ss.ok) return json({ error: "login_required" }, 401);
    const who = await rxIdentity(request, env, ss);
    if (rlCount("rx:" + who.me, 60000) >= 40) return json({ error: "rate_limited" }, 429);
    rlAdd("rx:" + who.me, 60000);
    const db = await dbInit(env);
    let b = {}; try { b = await request.json(); } catch {}
    const me = who.me;
    if (action === "sync") {
      const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter((x) => RX_ID.test(x)))].slice(0, RX_SYNC_CHUNK);
      if (!ids.length) return json({ error: "invalid_input" }, 400);
      const counts = {};
      for (const id of ids) counts[id] = (await rxApply(db, id, me, true)).n;
      rxDrop();
      return json({ ok: true, counts, mine: await rxMine(db, me) });
    }
    if (action !== "react") return json({ error: "unknown_action" }, 400);
    const id = String(b.id || ""), on = b.on === true;
    if (!RX_ID.test(id)) return json({ error: "invalid_input" }, 400);
    const r = await rxApply(db, id, me, on);
    if (r.changed) rxDrop();
    if (r.changed && on) {
      const job = notifyOwnerOfReaction(env, id, who).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    }
    return json({ ok: true, id, on, n: r.n });
  } catch (e) { return dbErr(e); }
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
  const admin = isModerator(request, env) || (ss.ok && ss.sid === "admin") || (ss.ok && await supervisorHas(request, env, "ann"));
  try {
    let list = (await kv.get("cm:" + id, { type: "json" })) || [];
    if (!Array.isArray(list)) list = [];
    const roleOf = (c) => c.role || (c.adm ? "supervisor" : "");
    if (request.method === "GET") {
      const uc = new Map(), outList = [];
      for (const c of list) {
        const role = roleOf(c); let u = "";
        if (role === "supervisor" && c.s && c.s !== "admin") { if (!uc.has(c.s)) uc.set(c.s, await supUid(env, c.s)); u = uc.get(c.s); }
        outList.push({ i: c.i, n: c.n, t: c.t, x: c.x, own: !!(ss.ok && c.s === ss.sid), adm: !!c.adm, role, u });
      }
      return json({ ok: true, admin, me: ss.ok ? ss.sid : "", list: outList });
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
    if (!/^[A-Z]$/.test(group)) return json({ error: "invalid_lesson_group" }, 400);
    if (!lessonAdminCodes(env, group).length) {
      return json({ error: "admin_code_not_configured", group }, 503);
    }
    return isLessonAdmin(request, env, group)
      ? json({ ok: true, group })
      : json({ error: "unauthorized" }, 401);
  }

  if (url.pathname === "/api/badges") return handleBadges(request, env);
  if (url.pathname === "/api/reactions") return handleReactions(request, env, ctx);
  if (url.pathname === "/api/literary") return handleLiterary(request, env, ctx);
  if (url.pathname === "/api/notifications") return handleNotifications(request, env);
  if (url.pathname === "/api/sync") return handleSync(request, env);
  if (url.pathname === "/api/polls") return handlePolls(request, env);
  if (url.pathname === "/api/comments") return handleComments(request, env);

  const requiredStorageSettings = ["B2_ENDPOINT", "B2_BUCKET", "B2_REGION", "B2_KEY_ID", "B2_APPLICATION_KEY"];
  const missingStorageSettings = requiredStorageSettings.filter((name) => !String(env[name] || "").trim());
  if (missingStorageSettings.length) {
    return json({ error: "storage_not_configured", missing: missingStorageSettings }, 503);
  }

  if (url.pathname === "/api/academic") return handleAcademic(request, env);
  if (url.pathname === "/api/gpa") return handleGpa(request, env);
  if (url.pathname === "/api/academic-image") return handleAcademicImage(request, env);
  if (url.pathname === "/api/resources") return handleResources(request, env);
  if (url.pathname === "/api/announcements") return handleAnnouncements(request, env);
  if (url.pathname === "/api/resource") return handleResourceFile(request, env, ctx);

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
    if (!lessonGroup || !lessonAdminCodes(env, lessonGroup).length) return json({ error: "admin_code_not_configured" }, 503);
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
        "cache-control": fileCacheControl(key),
        "x-content-type-options": "nosniff",
      });
      const length = response.headers.get("content-length");
      if (length) headers.set("content-length", length);
      return new Response(response.body, { headers });
    }, fileCacheControl(key));

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
  // رقم إصدار صغير يتغير فقط عند تغير أي قائمة: تقرؤه الصفحات من الموقع الثابت بدل جلب القوائم كل 30 ثانية
  if (!errors.length) {
    const sorted = Object.keys(files).sort();
    files["data/version.json"] = JSON.stringify({ v: (await gitBlobSha(sorted.map((k) => k + "\n" + files[k]).join("\n"))).slice(0, 12) });
  }
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

/* هوية من يسجّل العملية (تُحدَّد في الخادم فقط): أستاذ/مالك، أو مشرف معيَّن */
async function historyActor(request, env) {
  try {
    const ss = await readSession(request, env);
    const id = await staffIdentity(request, env, ss);
    if (id) return { by: await staffLabel(env, id) };
    if (ss.ok && ss.sid !== "admin") {
      const hit = (await readSupervisors(env)).find((x) => x.sid === ss.sid);
      if (hit) {
        const c = supCustom(hit) || mergeBadgeCfg(await readBadgeRaw(env)).supervisor;
        return { by: String((hit.name || "مشرف") + " · " + c.label).slice(0, 60) };
      }
    }
  } catch {}
  return null;
}

async function handleHistory(request, env) {
  const url = new URL(request.url);
  const isLog = request.method === "POST" && url.searchParams.get("action") === "log";
  const actor = isLog ? await historyActor(request, env) : null;
  if (!isHistoryAdmin(request, env) && !actor) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.HISTORY_KV) return json({ ok: false, error: "history_not_configured" }, 501);

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
      by: actor ? actor.by : String(e.by || "").slice(0, 60),
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
/* «هذا حسابي»: مهلة التنفيذ تُحسب من وقت الطلب. غيّر القيمتين هنا إن أردت. */
const CLAIM_DELAY_MS = 24 * 3600000;        // جهاز غير معروف
const CLAIM_DELAY_TRUSTED_MS = 3600000;     // جهاز معروف لهذا الحساب (ضع 0 لإلغاء المهلة)
const CLAIM_LOG_MAX = 300;
const CLAIM_IMG_MAX = 900 * 1024;           // أقصى حجم لصورة البطاقة بعد التصغير

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
  // أي جلسة جديدة تُصدَر بعد لحظة آخر إبطال لهذا الحساب (وإلا عُدّت ملغاة)
  let at = Date.now();
  if (sid !== "admin") { try { const rv = Number((await getRevoked(env))[sid]) || 0; if (rv) at = Math.max(at, rv + 1000); } catch {} }
  const exp = Math.floor(at / 1000) + SESSION_DAYS * 86400;
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

/* فوج الأستاذ (A/B) في كوكي موقّع منفصل، ليُعرف أي أستاذ هو صاحب الجلسة */
async function groupCookie(env, group) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const sig = (await mac(env, "g|" + group + "|" + exp)).slice(0, 40);
  return setCookie("ensd_g", group + "." + exp + "." + sig, SESSION_DAYS * 86400);
}
async function readGroup(request, env) {
  const v = String(readCookies(request).ensd_g || "").split(".");
  if (v.length !== 3) return "";
  const [g, exp, sig] = v;
  if (g !== "A" && g !== "B") return "";
  if (!(Number(exp) > Date.now() / 1000)) return "";
  return safeEq(sig, (await mac(env, "g|" + g + "|" + exp)).slice(0, 40)) ? g : "";
}

/* ===== حضور الأساتذة (دخول / خروج / نشاط) ===== */
function staffByCode(request, env) {
  const supplied = [request.headers.get("x-academic-admin-code"), request.headers.get("x-admin-code")]
    .map((v) => String(v || "").trim()).filter(Boolean);
  if (!supplied.length) return null;
  const owner = String(env.ADMIN_CODE_MOD || "").trim();
  if (owner && supplied.some((x) => safeEq(x, owner))) return { role: "owner", group: "" };
  const a = String(env.ADMIN_CODE_A || "").trim(), b = String(env.ADMIN_CODE_B || "").trim();
  if (a && supplied.some((x) => safeEq(x, a))) return { role: "teacher", group: "A" };
  if (b && supplied.some((x) => safeEq(x, b))) return { role: "teacher", group: "B" };
  return null;
}
async function staffIdentity(request, env, ss) {
  let id = staffByCode(request, env);
  if (!id) {
    if (!ss || !ss.ok || ss.sid !== "admin") return null;
    const role = (await readRole(request, env)) || "teacher";
    const group = role === "owner" ? "" : await readGroup(request, env);
    if (role === "teacher" && !group) return null;
    id = { role, group };
  }
  id.key = id.role === "owner" ? "owner" : "teacher-" + id.group;
  return id;
}
async function staffLabel(env, id) {
  const c = mergeBadgeCfg(await readBadgeRaw(env))[id.role], base = c.name || c.label;
  return String(id.role === "teacher" ? base + " · فوج " + id.group : base).slice(0, 60);
}
const staffSeen = new Map();
async function markStaff(env, id, t) {
  const kv = kvOf(env); if (!kv) return;
  staffSeen.set(id.key, t);
  try { await kv.put("staff:" + id.key, "1", { expirationTtl: 30 * 86400, metadata: { t, role: id.role, group: id.group } }); } catch {}
}
async function logStaffEvent(env, id, kind, text) {
  try {
    await logHistoryEvent(env, {
      id: ("st" + kind.charAt(0) + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 24),
      ts: Date.now(), kind, text, target: "", by: await staffLabel(env, id)
    });
  } catch {}
}
/* نشاط الأستاذ: كتابة محدودة كل 4 دقائق؛ وإن عاد بعد خمول أكثر من 30 دقيقة يُسجَّل «عاد إلى النشاط» */
async function trackStaff(request, env, ss) {
  try {
    const id = await staffIdentity(request, env, ss); if (!id) return;
    const now = Date.now();
    if (now - (staffSeen.get(id.key) || 0) < 240000) return;
    const kv = kvOf(env); if (!kv) return;
    let prev = 0;
    try { if (typeof kv.getWithMetadata === "function") { const r = await kv.getWithMetadata("staff:" + id.key); prev = Number(r && r.metadata && r.metadata.t) || 0; } } catch {}
    await markStaff(env, id, now);
    if (now - prev > 1800000) await logStaffEvent(env, id, "activity", "عاد إلى النشاط");
  } catch {}
}

/* ----- آخر نشاط للطلبة (لعدّاد النشطين): كتابة في D1 (لا KV) على الأكثر كل 5 دقائق لكل طالب ----- */
const seenMap = new Map();
function touchSeen(env, sid, ctx) {
  if (!sid || sid === "admin") return;
  const now = Date.now();
  if (now - (seenMap.get(sid) || 0) < 3600000) return;
  if (seenMap.size > 5000) seenMap.clear();
  seenMap.set(sid, now);
  const p = dbInit(env)
    .then((db) => db.prepare("INSERT INTO seen (sid, t) VALUES (?1, ?2) ON CONFLICT(sid) DO UPDATE SET t = excluded.t").bind(sid, now).run())
    .catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}
async function seenAll(env) {
  try {
    const r = await (await dbInit(env)).prepare("SELECT sid, t FROM seen WHERE t > ?1").bind(Date.now() - 7 * 86400000).all();
    return new Map((r.results || []).map((x) => [x.sid, Number(x.t) || 0]));
  } catch { return new Map(); }
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
  if (sid !== "admin") {
    // جلسة صدرت قبل آخر «استعادة حساب» منفَّذة تُعدّ ملغاة
    const rv = Number((await getRevoked(env))[sid]) || 0;
    if (rv && (Number(exp) - SESSION_DAYS * 86400) <= Math.floor(rv / 1000)) return { ok: false, revoked: true };
  }
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

/* ----- كلمة المرور: PBKDF2-SHA256 مع ملح عشوائي (تُحفظ مشفّرة فقط) ----- */
const PW_ITER = 50000, PW_MIN = 6, PW_MAX = 100;
const validPw = (p) => typeof p === "string" && p.length >= PW_MIN && p.length <= PW_MAX;
async function pbkdf2Hex(password, saltHex, iter) {
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}
async function hashPw(password) {
  const s = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { s, i: PW_ITER, h: await pbkdf2Hex(password, s, PW_ITER) };
}
async function checkPw(password, pw) {
  if (!pw || !pw.s || !pw.h || typeof password !== "string" || !password) return false;
  return safeEq(await pbkdf2Hex(password, pw.s, pw.i || PW_ITER), pw.h);
}


/* ===== أجهزة الحساب + استعادة الحساب («هذا حسابي») ===== */
function deviceLabel(request) {
  const ua = String(request.headers.get("user-agent") || "");
  const type = /iPad|Tablet|Android(?!.*Mobile)/i.test(ua) ? "لوحي" : /Mobi|iPhone|iPod|Android/i.test(ua) ? "هاتف" : "حاسوب";
  const os = /iPhone|iPad|iPod/i.test(ua) ? "iOS" : /Android/i.test(ua) ? "Android" : /Windows/i.test(ua) ? "Windows"
    : /CrOS/i.test(ua) ? "ChromeOS" : /Mac OS X|Macintosh/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "";
  const br = /Edg(e|A|iOS)?\//i.test(ua) ? "Edge" : /OPR\/|Opera/i.test(ua) ? "Opera" : /SamsungBrowser/i.test(ua) ? "Samsung Internet"
    : /Firefox|FxiOS/i.test(ua) ? "Firefox" : /Chrome|CriOS/i.test(ua) ? "Chrome" : /Safari/i.test(ua) ? "Safari" : "";
  return [type, os, br].filter(Boolean).join(" · ").slice(0, 48);
}
/* يسجّل الجهاز في قائمة أجهزة الحساب (rec.dv) ويحدّث آخر استعمال كل 6 ساعات على الأكثر؛ يعيد true إن تغيّر السجل */
function touchDevice(rec, dh, label, now) {
  if (!rec.dv || typeof rec.dv !== "object") rec.dv = {};
  const e = rec.dv[dh];
  if (!e) { rec.dv[dh] = { l: label, t: now, s: now }; return true; }
  if (now - (e.s || 0) > 6 * 3600000 || (label && e.l !== label)) { e.s = now; if (label) e.l = label; return true; }
  return false;
}
function pruneDv(rec) {
  if (!rec.dv) return;
  for (const k of Object.keys(rec.dv)) if (!rec.d.includes(k)) delete rec.dv[k];
}

let revCache = { t: 0, map: {} };
async function getRevoked(env) {
  if (Date.now() - revCache.t < 30000) return revCache.map;
  try {
    const a = await kvOf(env).get("revoked", { type: "json", cacheTtl: 60 });
    revCache = { t: Date.now(), map: a && typeof a === "object" && !Array.isArray(a) ? a : {} };
  } catch { revCache.t = Date.now(); }
  return revCache.map;
}
async function revokeSessions(env, sid) {
  const kv = kvOf(env), now = Date.now(), cut = now - (SESSION_DAYS + 1) * 86400000;
  const cur = (await kv.get("revoked", { type: "json" })) || {};
  const next = {};
  for (const [k, v] of Object.entries(cur)) if (Number(v) > cut) next[k] = v;
  next[sid] = now;
  await kv.put("revoked", JSON.stringify(next));
  revCache = { t: now, map: next };
}

/* كوكي قصير العمر يثبت أن هذا المتصفح أخطأ للتو في كلمة مرور هذا الحساب (شرط ظهور «هذا حسابي») */
async function wrongCookie(env, sid) {
  const exp = Math.floor(Date.now() / 1000) + 1800;
  const sig = (await mac(env, "w|" + sid + "|" + exp)).slice(0, 40);
  return setCookie("ensd_w", sid + "." + exp + "." + sig, 1800);
}
async function hasWrongCookie(request, env, sid) {
  const v = String(readCookies(request).ensd_w || "").split(".");
  if (v.length !== 3 || v[0] !== sid || !(Number(v[1]) > Date.now() / 1000)) return false;
  return safeEq(v[2], (await mac(env, "w|" + sid + "|" + v[1])).slice(0, 40));
}

/* فهرس طلبات الاستعادة لكل حساب: [{dh, ts, kd, dl, st: "p" معلّق | "s" مجدول, at}] */
async function claimsGet(env, sid) {
  const a = await kvOf(env).get("claims:" + sid, { type: "json" });
  return Array.isArray(a) ? a : [];
}
async function claimsPut(env, sid, list) {
  const kv = kvOf(env);
  if (!list.length) await kv.delete("claims:" + sid);
  else await kv.put("claims:" + sid, JSON.stringify(list.slice(-5)), { expirationTtl: 30 * 86400 });
}
/* سجل كل طلبات الاستعادة: الوقت والجهاز والقرار */
async function claimLog(env, ev) {
  try {
    const kv = kvOf(env);
    const cur = (await kv.get("claimlog", { type: "json" })) || [];
    cur.push({ ts: Date.now(), ...ev });
    await kv.put("claimlog", JSON.stringify(cur.slice(-CLAIM_LOG_MAX)));
  } catch {}
}
function parseDob(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
  if (!m) return "";
  const y = +m[1], mo = +m[2], d = +m[3], dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return "";
  const age = (Date.now() - dt.getTime()) / 31557600000;
  return age >= 14 && age <= 90 ? m[0] : "";
}
function parseIdImage(v) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(String(v || ""));
  if (!m || m[1].length > Math.ceil(CLAIM_IMG_MAX * 4 / 3) + 8) return null;
  let bytes;
  try { bytes = b64ToBytes(m[1]); } catch { return null; }
  if (bytes.length > CLAIM_IMG_MAX || bytes.length < 2000 || bytes[0] !== 0xFF || bytes[1] !== 0xD8 || bytes[2] !== 0xFF) return null;
  return { bytes, dataUrl: m[0] };
}
/* فحص استشاري بالذكاء الاصطناعي: هل يظهر وجه في صورة البطاقة؟ (face | ok | na). لا يرفض الطلب، بل يُخفي الصورة عند الإدارة */
async function faceCheck(env, bytes) {
  if (!env.AI || typeof env.AI.run !== "function") return "na";
  try {
    const r = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
      image: Array.from(bytes),
      prompt: "Is a clear photograph of a person's face visible in this image? Answer with only YES or NO.",
      max_tokens: 8,
    });
    const t = String((r && (r.description || r.response)) || "").trim().toUpperCase().replace(/^[^A-Z]+/, "");
    if (/^YES\b/.test(t)) return "face";
    if (/^NO\b/.test(t)) return "ok";
    return "na";
  } catch { return "na"; }
}
async function dropClaimData(env, dh) {
  const kv = kvOf(env);
  await kv.delete("pend:" + dh); await kv.delete("pimg:" + dh); await kv.delete("sched:" + dh);
}
/* تنفيذ الاستعادة فعلياً: كلمة المرور الجديدة + إلغاء كل الجلسات القديمة + ربط جهاز الطالب وحده */
async function execClaim(env, sc, by) {
  const kv = kvOf(env), now = Date.now();
  if (!(await kv.get("sched:" + sc.dh))) return false;   // نُفِّذ أو أُلغي قبل لحظات
  await kv.delete("sched:" + sc.dh);
  const known = await lookupStudent(env, sc.sid);
  const rec = (await kv.get("dev:" + sc.sid, { type: "json" })) ||
    { d: [], n: known ? known[0] : sc.n, g: known ? known[1] : "", ts: now };
  rec.d = [sc.dh];
  rec.dv = { [sc.dh]: { l: sc.dl || "", t: now, s: now } };
  rec.pw = sc.pw;
  await putDev(env, sc.sid, rec);
  await revokeSessions(env, sc.sid);
  await kv.put("res:" + sc.dh, JSON.stringify({ ok: true, sid: sc.sid }), { expirationTtl: 3600 });
  // أي طلبات أخرى لنفس الحساب تصبح بلا معنى بعد تغيّر كلمة المرور
  for (const c of await claimsGet(env, sc.sid)) {
    if (c.dh === sc.dh) continue;
    await dropClaimData(env, c.dh);
    await kv.put("res:" + c.dh, JSON.stringify({ ok: false }), { expirationTtl: 3600 });
    await claimLog(env, { k: "auto_cancel", n: rec.n, dl: c.dl, kd: !!c.kd, by: "system" });
  }
  await claimsPut(env, sc.sid, []);
  await claimLog(env, { k: "exec", n: rec.n, dl: sc.dl, kd: !!sc.kd, by: by || "system", rq: sc.ts });
  return true;
}
/* تنفيذ كسول: أي تعامل مع الحساب بعد انتهاء المهلة ينفّذ المستحق أولاً (إضافة إلى الـ Cron) */
async function execDueForSid(env, sid) {
  const kv = kvOf(env), now = Date.now();
  let hit = false;
  for (const c of await claimsGet(env, sid)) {
    if (c.st !== "s" || !(Number(c.at) <= now)) continue;
    const sc = await kv.get("sched:" + c.dh, { type: "json" });
    if (sc && (await execClaim(env, sc, "system"))) hit = true;
  }
  return hit;
}
async function execDueAll(env) {
  const kv = kvOf(env);
  if (!kv || !secretOf(env)) return;
  const now = Date.now();
  for (const k of await listAll(kv, "sched:")) {
    if (!(Number(k.metadata && k.metadata.at) <= now)) continue;
    const sc = await kv.get(k.name, { type: "json" });
    if (sc) await execClaim(env, sc, "system");
  }
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

async function createPending(env, dev, type, sid, typedName, rec, ip, pw, extra) {
  const kv = kvOf(env);
  const exists = await kv.get("pend:" + dev.dh);
  if (!exists) {
    // منع إغراق طابور الموافقات: حدّ لكل شبكة ولكل رقم تسجيل في الساعة
    if (rlCount("pip:" + ip, 3600000) >= 4 || rlCount("psid:" + sid, 3600000) >= 4) return false;
    rlAdd("pip:" + ip, 3600000); rlAdd("psid:" + sid, 3600000);
    const list = await kv.list({ prefix: "pend:", limit: MAX_PENDING + 1 });
    if (list.keys.length > MAX_PENDING) return false;
  }
  const v = { t: type, sid, name: typedName, rn: rec ? rec[0] : "", g: rec ? rec[1] : "", ts: Date.now(), ...(extra || {}) };
  await kv.put("pend:" + dev.dh, JSON.stringify(pw ? { ...v, pw } : v), { expirationTtl: PEND_TTL, metadata: v });
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
    const sid0 = { role, group, key: role === "owner" ? "owner" : "teacher-" + group };
    await markStaff(env, sid0, Date.now());
    await logStaffEvent(env, sid0, "login", "سجّل الدخول");
    return jsonC({ status: "ok", role, group }, 200, [await sessionCookie(env, "admin"), await roleCookie(env, role), group ? await groupCookie(env, group) : setCookie("ensd_g", "", 0)]);
  }

  /* مسار الطلبة: الخطوات check / setup / login / claim / join
     - check: يتحقق من رقم التسجيل فقط ويعيد الاسم ليؤكد الطالب أنه هو، ويحدد الوضع (setup/legacy/login)
     - setup: أول مرة (أو حساب قديم بلا كلمة مرور): اختيار كلمة المرور
     - login: رقم التسجيل + كلمة المرور؛ حتى MAX_DEVICES أجهزة، والجهاز الزائد يطلب موافقة
     - claim: «هذا حسابي»: يضع كلمة مرور جديدة بعد موافقة المالك، ويُصفَّر ارتباط الأجهزة
     - join: طلب انضمام لغير المدرج في القائمة */
  if (rlCount("fail:" + ip, 900000) >= 10) return jsonC({ error: "rate_limited" }, 429);
  const step = String(body.step || (kind === "request" ? "join" : "check"));
  const regno = normRegno(body.regno), password = typeof body.password === "string" ? body.password : "";
  const name = String(body.name || "").trim().slice(0, 80);
  if (!regno) return jsonC({ error: "invalid_input" }, 400);
  const sid = (await mac(env, "r|" + regno)).slice(0, 24);
  const rec = await lookupStudent(env, sid);
  if (rec && (await getBans(env)).has(sid)) return jsonC({ status: "banned" }, 403);
  if (rec && step !== "join") { try { await execDueForSid(env, sid); } catch {} }
  const cur = rec ? await kv.get("dev:" + sid, { type: "json" }) : null;
  const mode = !cur ? "setup" : (cur.pw ? "login" : "legacy");
  const hasName = normName(name).split(" ").filter(Boolean).length >= 2;

  if (step === "check") {
    if (!rec) { rlAdd("fail:" + ip, 900000); return jsonC({ status: "unknown" }); }
    return jsonC({ status: "found", name: rec[0], mode });
  }

  if (step === "join") {
    // طلب انضمام: لغير المدرج في القائمة (أو رقم موجود يتعلق به طلب «هذا حسابي»)
    if (rec) return jsonC({ error: "invalid_input" }, 400);
    if (!hasName || !validPw(password)) return jsonC({ error: "invalid_input" }, 400);
    if (rlCount("req:" + ip, 3600000) >= 3) return jsonC({ error: "rate_limited" }, 429);
    rlAdd("req:" + ip, 3600000);
    const dev = await deviceOf(request, env);
    if (!(await createPending(env, dev, "new", sid, name, null, ip, await hashPw(password)))) return jsonC({ error: "rate_limited" }, 429);
    return jsonC({ status: "pending" }, 200, [devCookie(dev.token)]);
  }

  if (!rec) { rlAdd("fail:" + ip, 900000); return jsonC({ status: "unknown" }, 404); }
  const dev = await deviceOf(request, env);
  const devCk = dev.fresh ? [devCookie(dev.token)] : [];
  const dl = deviceLabel(request);

  if (step === "setup") {
    if (mode === "login") return jsonC({ status: "has_password" }, 409);
    if (!validPw(password)) return jsonC({ error: "weak_password" }, 400);
    const pw = await hashPw(password);
    if (mode === "setup") {
      // أول مرة: يُنشأ الحساب ويُربط بهذا الجهاز مباشرة
      const now0 = Date.now();
      await putDev(env, sid, { d: [dev.dh], dv: { [dev.dh]: { l: dl, t: now0, s: now0 } }, n: rec[0], g: rec[1], ts: now0, pw });
      return jsonC({ status: "ok" }, 200, [...devCk, await sessionCookie(env, sid)]);
    }
    // حساب قديم بلا كلمة مرور: من جهاز مسجَّل عنده فقط، وإلا فبموافقة المالك
    if (cur.d.includes(dev.dh)) {
      cur.pw = pw; touchDevice(cur, dev.dh, dl, Date.now()); await putDev(env, sid, cur);
      return jsonC({ status: "ok" }, 200, [...devCk, await sessionCookie(env, sid)]);
    }
    if (!(await createPending(env, dev, "device", sid, rec[0], rec, ip, pw, { dl }))) return jsonC({ error: "rate_limited" }, 429);
    return jsonC({ status: "pending" }, 200, [devCookie(dev.token)]);
  }

  if (step === "login") {
    if (mode !== "login") return jsonC({ status: "needs_setup" }, 409);
    if (!(await checkPw(password, cur.pw))) { rlAdd("fail:" + ip, 900000); return jsonC({ status: "wrongpw" }, 401, [...devCk, await wrongCookie(env, sid)]); }
    if (cur.d.includes(dev.dh)) {
      if (touchDevice(cur, dev.dh, dl, Date.now())) { try { await putDev(env, sid, cur); } catch {} }
      return jsonC({ status: "ok" }, 200, [...devCk, await sessionCookie(env, sid)]);
    }
    if (cur.d.length < MAX_DEVICES) {
      cur.d.push(dev.dh); touchDevice(cur, dev.dh, dl, Date.now()); await putDev(env, sid, cur);
      return jsonC({ status: "ok" }, 200, [...devCk, await sessionCookie(env, sid)]);
    }
    if (!(await createPending(env, dev, "device", sid, rec[0], rec, ip, null, { dl }))) return jsonC({ error: "rate_limited" }, 429);
    return jsonC({ status: "pending" }, 200, [devCookie(dev.token)]);
  }

  if (step === "claim") {
    // «هذا حسابي»: لا يظهر إلا بعد خطأ في كلمة المرور، ويتطلب تاريخ الميلاد وصورة البطاقة (بلا وجه).
    // لا يتغيّر شيء في الحساب قبل موافقة المالك، ثم تأتي مهلة التنفيذ.
    if (mode !== "login") return jsonC({ status: "needs_setup" }, 409);
    if (!(await hasWrongCookie(request, env, sid))) return jsonC({ error: "claim_locked" }, 403);
    if (!hasName || !validPw(password)) return jsonC({ error: "invalid_input" }, 400);
    const dob = parseDob(body.dob);
    if (!dob) return jsonC({ error: "invalid_dob" }, 400);
    const img = parseIdImage(body.idimg);
    if (!img) return jsonC({ error: "invalid_image" }, 400);
    if (rlCount("req:" + ip, 3600000) >= 3) return jsonC({ error: "rate_limited" }, 429);
    rlAdd("req:" + ip, 3600000);
    const kd = cur.d.includes(dev.dh);
    const fc = await faceCheck(env, img.bytes);
    if (!(await createPending(env, dev, "claim", sid, name, rec, ip, await hashPw(password), { dl, kd, dob, im: 1, fc }))) return jsonC({ error: "rate_limited" }, 429);
    try {
      await kv.put("pimg:" + dev.dh, img.dataUrl, { expirationTtl: PEND_TTL });
      const list = (await claimsGet(env, sid)).filter((c) => c.dh !== dev.dh);
      list.push({ dh: dev.dh, ts: Date.now(), kd, dl, st: "p" });
      await claimsPut(env, sid, list);
    } catch { await dropClaimData(env, dev.dh); return jsonC({ error: "kv_error" }, 502); }
    await claimLog(env, { k: "request", n: rec[0], dl, kd, by: "student" });
    return jsonC({ status: "pending" }, 200, [devCookie(dev.token)]);
  }

  return jsonC({ error: "bad_step" }, 400);
}

async function authStatus(request, env) {
  const kv = kvOf(env), c = readCookies(request).ensd_dev || "";
  if (!/^[a-f0-9]{48}$/.test(c)) return jsonC({ status: "none" });
  const dh = (await mac(env, "d|" + c)).slice(0, 24);
  let res = await kv.get("res:" + dh, { type: "json" });
  if (!res) {
    const sc = await kv.get("sched:" + dh, { type: "json" });
    if (sc) {
      if (Number(sc.at) <= Date.now()) { await execClaim(env, sc, "system"); res = await kv.get("res:" + dh, { type: "json" }); }
      else return jsonC({ status: "scheduled", at: sc.at });
    }
  }
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
      const seen = await seenAll(env);
      const nowMs = Date.now();
      users.forEach((u) => { u.ls = seen.get(u.sid) || 0; });
      const cnt = (ms) => users.filter((u) => u.ls && nowMs - u.ls < ms).length;
      const active = { now: cnt(600000), day: cnt(86400000), week: cnt(7 * 86400000) };
      pend.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      users.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      // طلبات «هذا حسابي»: متى يُنفَّذ الطلب لو قُبل الآن؟ + الطلبات المقبولة المنتظرة للتنفيذ + سجل الاستعادة
      pend.forEach((p) => { if (p.t === "claim") p.at = Math.max(nowMs, (p.ts || nowMs) + (p.kd ? CLAIM_DELAY_TRUSTED_MS : CLAIM_DELAY_MS)); });
      const sched = (await listAll(kv, "sched:")).map((k) => ({ id: k.name.slice(6), ...(k.metadata || {}) })).sort((a, b) => (a.at || 0) - (b.at || 0));
      const claimlog = ((await kv.get("claimlog", { type: "json" })) || []).slice(-150).reverse();
      // الأساتذة (رمزا الفوجين A/B) والمالك والمشرفون: العدد وهل هم نشطون
      const stf = new Map((await listAll(kv, "staff:")).map((k) => [k.name.slice(6), Number(k.metadata && k.metadata.t) || 0]));
      const bcfg = mergeBadgeCfg(await readBadgeRaw(env));
      const mk = (ls) => ({ ls, on: !!ls && nowMs - ls < 600000 });
      const tmeta = new Map((await listAll(kv, "tprof:")).map((k) => [k.name.slice(6), k.metadata || {}]));
      const teachers = [["A", env.ADMIN_CODE_A], ["B", env.ADMIN_CODE_B]]
        .filter(([g, c]) => String(c || "").trim())
        .map(([g]) => { const tm = tmeta.get("teacher-" + g) || {}; return { group: g, subject: tm.s || "", pg: tm.g || "", name: bcfg.teacher.name || bcfg.teacher.label, ...mk(stf.get("teacher-" + g) || 0) }; });
      const profs = new Map((await listAll(kv, "prof:")).map((k) => [k.name.slice(5), (k.metadata && k.metadata.g) || ""]));
      users.forEach((u) => { u.pg = profs.get(u.sid) || ""; });
      const supsL = (await readSupervisors(env)).map((x) => ({ name: x.name, pg: profs.get(x.sid) || "", ...mk(seen.get(x.sid) || 0) }));
      const staff = {
        teachers, teacherCount: teachers.length, teacherActive: teachers.filter((t) => t.on).length,
        owner: { name: bcfg.owner.name || bcfg.owner.label, ...mk(stf.get("owner") || 0) },
        supervisors: supsL, supCount: supsL.length, supActive: supsL.filter((x) => x.on).length
      };
      return jsonC({ pending: pend, users, rosterCount: Object.keys(roster).length, bans: bans.length, active, staff, sched, claimlog });
    }
    if (action === "pimg" && request.method === "GET") {
      // صورة البطاقة (بلا وجه): تُعرض للمالك فقط أثناء انتظار القرار، وتُحذف تلقائياً بعده
      const pid = url.searchParams.get("id") || "";
      if (!/^[a-f0-9]{24}$/.test(pid)) return jsonC({ error: "bad_id" }, 400);
      const im = await kv.get("pimg:" + pid);
      return jsonC({ image: im || "" });
    }
    if (action === "devices" && request.method === "GET") {
      const dsid = url.searchParams.get("sid") || "";
      if (!/^[a-f0-9]{24}$/.test(dsid)) return jsonC({ error: "bad_sid" }, 400);
      const r = await kv.get("dev:" + dsid, { type: "json" });
      if (!r) return jsonC({ error: "not_found" }, 404);
      return jsonC({ devices: (r.d || []).map((h) => { const e = (r.dv || {})[h] || {}; return { l: e.l || "", t: e.t || 0, s: e.s || 0 }; }) });
    }
    if (request.method !== "POST") return jsonC({ error: "method_not_allowed" }, 405);

    if (action === "migrate") {
      // نقل مرة واحدة لتفاعلات وإشعارات KV القديمة إلى D1 (على دفعات صغيرة لتفادي حدّ الطلبات الفرعية)
      const kind = url.searchParams.get("kind") === "nt" ? "nt" : "rx", cursor = url.searchParams.get("cursor") || "";
      const db = await dbInit(env);
      const r = await kv.list({ prefix: kind + ":", limit: 8, ...(cursor ? { cursor } : {}) });
      const stmts = [], touched = new Set(), now = Date.now(); let moved = 0;
      const ins = (table, cols, rows) => { for (let i = 0; i < rows.length; i += 30) { const part = rows.slice(i, i + 30), ph = part.map(() => "(" + cols.map(() => "?").join(",") + ")").join(","); stmts.push(db.prepare("INSERT OR IGNORE INTO " + table + " (" + cols.join(",") + ") VALUES " + ph).bind(...part.flat())); } };
      for (const k of r.keys) {
        let v = null; try { v = await kv.get(k.name, { type: "json" }); } catch { continue; }
        if (!Array.isArray(v)) continue;
        if (kind === "rx") {
          const rid = k.metadata && k.metadata.id;
          if (typeof rid !== "string" || !RX_ID.test(rid)) continue;
          ins("rx", ["id", "me", "t"], v.map((me) => [rid, String(me), now]));
          touched.add(rid);
        } else {
          const uid = k.name.slice(3);
          ins("nt", ["uid", "i", "r", "x", "t", "n", "o", "u"], v.filter((x) => x && x.i).map((x) => [uid, String(x.i), String(x.r || ""), String(x.x || ""), Number(x.t) || now, String(x.n || ""), String(x.o || ""), String(x.u || "")]));
        }
        moved++;
      }
      for (const rid of touched) stmts.push(db.prepare("INSERT INTO rxc (id, n) SELECT ?1, COUNT(*) FROM rx WHERE id = ?1 ON CONFLICT(id) DO UPDATE SET n = excluded.n").bind(rid));
      for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
      rxDrop();
      return jsonC({ ok: true, kind, moved, done: !!r.list_complete, cursor: r.cursor || "" });
    }

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
      if (p.t === "claim") {
        const nm = String(p.rn || p.name || "").slice(0, 60);
        if (action === "approve") {
          // الموافقة تحجز التنفيذ فقط: لا تتغير كلمة المرور ولا الجلسات قبل انتهاء المهلة (أو «ننفّذ الآن»)
          if (!p.pw) return jsonC({ error: "no_password" }, 400);
          const now = Date.now(), delay = p.kd ? CLAIM_DELAY_TRUSTED_MS : CLAIM_DELAY_MS;
          const at = url.searchParams.get("now") === "1" ? now : Math.max(now, (p.ts || now) + delay);
          const sc = { dh: id, sid: p.sid, pw: p.pw, dl: p.dl || "", kd: !!p.kd, ts: p.ts || now, n: nm, at };
          await kv.put("sched:" + id, JSON.stringify(sc), { expirationTtl: 30 * 86400, metadata: { sid: p.sid, at, n: nm, dl: sc.dl, kd: sc.kd, ts: sc.ts } });
          await kv.delete("pend:" + id); await kv.delete("pimg:" + id);   // قرارك اتُّخذ: تُحذف صورة البطاقة
          const list = (await claimsGet(env, p.sid)).filter((c) => c.dh !== id);
          list.push({ dh: id, ts: sc.ts, kd: sc.kd, dl: sc.dl, st: "s", at });
          await claimsPut(env, p.sid, list);
          await claimLog(env, { k: "approve", n: nm, dl: sc.dl, kd: sc.kd, by: "admin", rq: sc.ts, at });
          if (at <= now) { await execClaim(env, sc, "admin"); return jsonC({ ok: true, executed: true }); }
          return jsonC({ ok: true, executed: false, at });
        }
        await dropClaimData(env, id);
        await claimsPut(env, p.sid, (await claimsGet(env, p.sid)).filter((c) => c.dh !== id));
        await kv.put("res:" + id, JSON.stringify({ ok: false }), { expirationTtl: 3600 });
        await claimLog(env, { k: "reject", n: nm, dl: p.dl || "", kd: !!p.kd, by: "admin", rq: p.ts });
        return jsonC({ ok: true });
      }
      if (action === "approve") {
        const known = await lookupStudent(env, p.sid);
        if (!known) await kv.put("extra:" + p.sid, JSON.stringify([p.name, p.g || ""]));
        const rec = (await kv.get("dev:" + p.sid, { type: "json" })) ||
          { d: [], n: known ? known[0] : p.name, g: known ? known[1] : (p.g || ""), ts: Date.now() };
        if (p.t === "claim") {
          // «هذا حسابي»: كلمة المرور الجديدة هي التي اختارها صاحب الطلب، ويبقى جهازه وحده
          rec.d = [id]; if (p.pw) rec.pw = p.pw;
        } else {
          if (!rec.d.includes(id)) rec.d.push(id);
          rec.d = rec.d.slice(-MAX_DEVICES);
          if (p.pw && !rec.pw) rec.pw = p.pw;
          touchDevice(rec, id, p.dl || "", Date.now());
        }
        pruneDv(rec);
        await putDev(env, p.sid, rec);
        await kv.put("res:" + id, JSON.stringify({ ok: true, sid: p.sid }), { expirationTtl: 3600 });
      } else {
        await kv.put("res:" + id, JSON.stringify({ ok: false }), { expirationTtl: 3600 });
      }
      await kv.delete("pend:" + id);
      return jsonC({ ok: true });
    }

    if (action === "execnow" || action === "cancelsched") {
      if (!/^[a-f0-9]{24}$/.test(id)) return jsonC({ error: "bad_id" }, 400);
      const sc = await kv.get("sched:" + id, { type: "json" });
      if (!sc) return jsonC({ error: "not_found" }, 404);
      if (action === "execnow") { await execClaim(env, sc, "admin"); return jsonC({ ok: true }); }
      await dropClaimData(env, id);
      await claimsPut(env, sc.sid, (await claimsGet(env, sc.sid)).filter((c) => c.dh !== id));
      await kv.put("res:" + id, JSON.stringify({ ok: false }), { expirationTtl: 3600 });
      await claimLog(env, { k: "cancel", n: sc.n, dl: sc.dl, kd: !!sc.kd, by: "admin", rq: sc.ts });
      return jsonC({ ok: true });
    }

    const sid = url.searchParams.get("sid") || "";
    if (!/^[a-f0-9]{24}$/.test(sid)) return jsonC({ error: "bad_sid" }, 400);
    if (action === "ban") { await updateBans(env, (a) => [...a, sid]); return jsonC({ ok: true }); }
    if (action === "unban") { await updateBans(env, (a) => a.filter((x) => x !== sid)); return jsonC({ ok: true }); }
    if (action === "resetdev") { await kv.delete("dev:" + sid); return jsonC({ ok: true }); }
    if (action === "resetpw") {
      // تصفير كلمة المرور: تبقى الأجهزة؛ يضع الطالب كلمة جديدة من جهازه أو بطلب «هذا حسابي»
      const r = await kv.get("dev:" + sid, { type: "json" });
      if (!r) return jsonC({ error: "not_found" }, 404);
      delete r.pw; await putDev(env, sid, r);
      return jsonC({ ok: true });
    }
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
    let saved;
    try { saved = await readBadgeRaw(env); } catch { return jsonC({ error: "kv_error" }, 502); }
    const cur = { ...(saved[role] || {}) };
    // المقياس والمجموعة: للأستاذ فقط، وتُحفظ في بياناته هو (لا في إعدادات الشارة المشتركة)
    let tp = null, tkey = "";
    if (role === "teacher") {
      const tid = await staffIdentity(request, env, ss);
      if (tid) { tkey = "tprof:" + tid.key; tp = (await kv.get(tkey, { type: "json" })) || {}; }
    }
    if (body.name !== undefined) {
      const n = String(body.name || "").normalize("NFKC").replace(/\s+/g, " ").trim();
      if (!/^[\p{L}\p{M}' .\-]{2,60}$/u.test(n)) return jsonC({ error: "invalid_name" }, 400);
      cur.name = badgeText(n, 60);
    }
    if (body.subject !== undefined && tp) {
      const sj = String(body.subject || "").normalize("NFKC").replace(/\s+/g, " ").trim();
      if (sj.length > 80) return jsonC({ error: "invalid_subject" }, 400);
      tp.subject = sj;
    }
    if (body.group !== undefined && tp) {
      if (body.group !== "A" && body.group !== "B" && body.group !== "") return jsonC({ error: "invalid_group" }, 400);
      tp.group = body.group;
    }
    saved[role] = cur;
    try {
      await kv.put("badges:cfg", JSON.stringify(saved));
      if (tp) await kv.put(tkey, JSON.stringify(tp), { metadata: { s: tp.subject || "", g: tp.group || "" } });
    } catch { return jsonC({ error: "kv_error" }, 502); }
    return jsonC({ ok: true, name: cur.name || "", subject: (tp && tp.subject) || "", group: (tp && tp.group) || "" });
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
  try { await kv.put("prof:" + ss.sid, JSON.stringify(next), { metadata: { g: next.g || "", n: next.n || "" } }); }
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

/* ===== الصورة الشخصية: تخزين في KV + فحص بالذكاء الاصطناعي (Workers AI) على الخادم =====
   يتطلب Binding باسم AI (Workers AI). إن لم يوجد، تُرفض كل الصور (فشل آمن). */
const PHOTO_MAX = 150 * 1024;
async function photoKeyOf(request, env, ss) {
  if (ss.sid !== "admin") return "photo:" + ss.sid;
  const role = (await readRole(request, env)) || "teacher";
  if (role === "owner") return "photo:owner";
  try { const tid = await staffIdentity(request, env, ss); if (tid && tid.key) return "photo:t:" + tid.key; } catch {}
  return "photo:teacher";
}
function b64ToBytes(b64) {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function moderatePhoto(env, bytes) {
  if (!env.AI || typeof env.AI.run !== "function") return { v: "unavailable" };
  try {
    const r = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
      image: Array.from(bytes),
      prompt: "Does this image contain nudity, sexual or suggestive content, pornography, gore, graphic violence, or hate symbols? Answer with only YES or NO.",
      max_tokens: 16,
    });
    const raw = String((r && (r.description || r.response)) || "").trim();
    const t = raw.toUpperCase().replace(/^[^A-Z]+/, "");
    let v = "unclear";
    if (/^(NO\b|SAFE\b)/.test(t) || /(DOES NOT|DOESN'T|NOT) (CONTAIN|APPEAR|SHOW|DEPICT)/.test(t)) v = "safe";
    else if (/^(YES\b|UNSAFE\b)/.test(t)) v = "unsafe";
    return { v, raw: raw.slice(0, 60) };
  } catch (e) { return { v: "unavailable", raw: String(e && e.message || e).slice(0, 80) }; }
}
async function authPhoto(request, env) {
  const ss = await readSession(request, env);
  if (!ss.ok) return jsonC({ error: "login_required" }, 401);
  const kv = kvOf(env), key = await photoKeyOf(request, env, ss);
  if (request.method === "GET") {
    const v = await kv.get(key);
    return v ? jsonC({ ok: true, image: v }) : jsonC({ ok: true, image: "" });
  }
  if (rlCount("photo:" + ss.sid, 600000) >= 8) return jsonC({ error: "rate_limited" }, 429);
  rlAdd("photo:" + ss.sid, 600000);
  let body = {};
  try { body = await request.json(); } catch {}
  const setFlag = async (on) => {
    if (ss.sid === "admin") return;
    const p = { ...((await kv.get("prof:" + ss.sid, { type: "json" })) || {}) };
    if (on) p.p = 1; else delete p.p;
    await kv.put("prof:" + ss.sid, JSON.stringify(p), { metadata: { g: p.g || "", n: p.n || "" } });
  };
  if (body.remove) {
    try { await kv.delete(key); await setFlag(false); } catch { return jsonC({ error: "kv_error" }, 502); }
    return jsonC({ ok: true });
  }
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(String(body.image || ""));
  if (!m) return jsonC({ error: "invalid_image" }, 400);
  let bytes;
  try { bytes = b64ToBytes(m[1]); } catch { return jsonC({ error: "invalid_image" }, 400); }
  if (bytes.length > PHOTO_MAX || bytes.length < 200 || bytes[0] !== 0xFF || bytes[1] !== 0xD8 || bytes[2] !== 0xFF) return jsonC({ error: "invalid_image" }, 400);
  const mod = await moderatePhoto(env, bytes);
  if (mod.v === "unavailable") return jsonC({ error: "moderation_unavailable", detail: mod.raw || "" }, 503);
  if (mod.v === "unclear") return jsonC({ error: "image_unclear", detail: mod.raw || "" }, 422);
  if (mod.v !== "safe") return jsonC({ error: "image_rejected" }, 422);
  try { await kv.put(key, "data:image/jpeg;base64," + m[1]); await setFlag(true); } catch { return jsonC({ error: "kv_error" }, 502); }
  return jsonC({ ok: true });
}

/* صاحب الحساب (وهو داخل) يضغط «لا، ارفض»: يُلغى كل طلب استعادة معلّق أو مجدول فوراً ويُسجَّل تنبيه للمالك */
async function authClaimReject(request, env) {
  const ss = await readSession(request, env);
  if (!ss.ok || ss.sid === "admin") return jsonC({ error: "login_required" }, 401);
  if (rlCount("crej:" + ss.sid, 600000) >= 10) return jsonC({ error: "rate_limited" }, 429);
  rlAdd("crej:" + ss.sid, 600000);
  const kv = kvOf(env);
  try {
    const list = await claimsGet(env, ss.sid);
    const known = await lookupStudent(env, ss.sid);
    for (const c of list) {
      await dropClaimData(env, c.dh);
      await kv.put("res:" + c.dh, JSON.stringify({ ok: false }), { expirationTtl: 3600 });
      await claimLog(env, { k: "owner_reject", n: known ? known[0] : "", dl: c.dl || "", kd: !!c.kd, by: "owner", rq: c.ts });
    }
    await claimsPut(env, ss.sid, []);
    return jsonC({ ok: true, n: list.length });
  } catch { return jsonC({ error: "kv_error" }, 502); }
}

async function handleAuth(request, env, url, ctx) {
  if (!kvOf(env) || !secretOf(env)) return jsonC({ error: "auth_not_configured" }, 503);
  const a = url.pathname.slice("/api/auth/".length);
  if (a === "admin") return authAdmin(request, env, url);
  if (a === "me" && request.method === "GET") {
    // إن حلّ موعد تنفيذ استعادة مجدولة لهذا الحساب فنفّذها قبل قراءة الجلسة (فتُلغى الجلسات القديمة فوراً)
    const rawSid = String(readCookies(request).ensd_s || "").split(".")[0];
    let cl0 = null;
    if (/^[a-f0-9]{24}$/.test(rawSid)) {
      try {
        cl0 = await claimsGet(env, rawSid);
        if (cl0.some((c) => c.st === "s" && Number(c.at) <= Date.now())) { await execDueForSid(env, rawSid); cl0 = []; }
      } catch { cl0 = null; }
    }
    const ss = await readSession(request, env);
    const out = { in: !!ss.ok, admin: !!ss.ok && ss.sid === "admin" };
    if (out.admin) {
      out.role = (await readRole(request, env)) || "teacher";
      try { const c0 = mergeBadgeCfg(await readBadgeRaw(env))[out.role]; out.name = c0.name || c0.label; out.label = c0.label; } catch {}
      try {
        out.subject = ""; out.group = "";
        if (out.role === "teacher") {
          const tid = await staffIdentity(request, env, ss);
          const tp = tid ? ((await kvOf(env).get("tprof:" + tid.key, { type: "json" })) || {}) : {};
          out.subject = String(tp.subject || ""); out.group = tp.group === "A" || tp.group === "B" ? tp.group : "";
        }
      } catch {}
      if (out.role === "owner") out.perms = SUP_PERMS.slice();
      try { out.photo = !!(await kvOf(env).get(await photoKeyOf(request, env, ss))); } catch {}
    }
    if (ss.ok) {
      touchSeen(env, ss.sid, ctx);
      if (ss.sid === "admin" && ctx && ctx.waitUntil) ctx.waitUntil(trackStaff(request, env, ss));
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
          out.photo = prof.p === 1;
          out.devices = rec && Array.isArray(rec.d) ? rec.d.length : 1;
          try {
            const me0 = await deviceOf(request, env);
            out.devList = ((rec && rec.d) || []).map((h) => { const e = ((rec && rec.dv) || {})[h] || {}; return { l: e.l || "", t: e.t || 0, s: e.s || 0, cur: h === me0.dh }; });
            const cl = ss.sid === rawSid && cl0 ? cl0 : await claimsGet(env, ss.sid);
            out.claims = cl.filter((c) => c.st === "s" || Date.now() - c.ts < PEND_TTL * 1000).map((c) => ({ ts: c.ts, kd: !!c.kd, dl: c.dl || "", at: c.at || 0 }));
          } catch {}
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
  if (a === "photo") return authPhoto(request, env);
  if (request.method !== "POST") return jsonC({ error: "method_not_allowed" }, 405);
  if (a === "profile") return authProfile(request, env);
  if (a === "claim-reject") return authClaimReject(request, env);
  if (a === "login") return authLogin(request, env, "login");
  if (a === "request") return authLogin(request, env, "request");
  if (a === "logout") {
    try {
      const ss = await readSession(request, env);
      if (ss.ok && ss.sid === "admin") {
        const id = await staffIdentity(request, env, ss);
        if (id) { await markStaff(env, id, 0); await logStaffEvent(env, id, "logout", "سجّل الخروج"); }
      }
    } catch {}
    return jsonC({ ok: true }, 200, [setCookie("ensd_s", "", 0), setCookie("ensd_r", "", 0), setCookie("ensd_g", "", 0)]);
  }
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
  if (s.ok) {
    touchSeen(env, s.sid, ctx);
    if (s.sid === "admin" && ctx && ctx.waitUntil) ctx.waitUntil(trackStaff(request, env, s));
    return null;
  }
  if (p.startsWith("/api/") && anyAdmin(request, env)) {
    if (ctx && ctx.waitUntil) ctx.waitUntil(trackStaff(request, env, s));
    return null;
  }
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
.tabs{overflow-x:auto;scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}.tab{flex:1 0 auto;padding:0 12px;white-space:nowrap}
.idimg{display:block;width:100%;max-height:380px;object-fit:contain;border-radius:12px;border:1px solid var(--bd);margin-top:8px;background:#000}
.idimg.blur{filter:blur(18px);cursor:pointer}
.alertbar{margin:0 0 12px;padding:12px 14px;border-radius:14px;background:var(--badbg);color:var(--bad);font-size:13.5px;font-weight:700}
.alertbar button{margin-top:8px}
.sub{margin:14px 0 8px;font-size:14px;font-weight:800}
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
 <div class="card stat"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 2 9l10 5 10-5z"/><path d="M6 11.5V16c0 1.4 2.7 3 6 3s6-1.6 6-3v-4.5"/></svg></span><div><b id="sTeach">0</b><small>عدد الأساتذة</small></div></div>
  <div class="card stat live"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 2 9l10 5 10-5z"/><path d="M6 11.5V16c0 1.4 2.7 3 6 3s6-1.6 6-3v-4.5"/></svg></span><div><b id="sTeachOn">0</b><small>أساتذة نشطون الآن</small></div></div>
 </section>

 <div class="alertbar" id="clAlert" hidden></div>
 <nav class="tabs" role="tablist">
  <button class="tab" role="tab" data-t="pending" aria-selected="true">الطلبات<i id="tPend" hidden>0</i></button>
  <button class="tab" role="tab" data-t="users" aria-selected="false">المسجّلون</button>
  <button class="tab" role="tab" data-t="claims" aria-selected="false">الاستعادة<i id="tCl" hidden>0</i></button>
  <button class="tab" role="tab" data-t="staff" aria-selected="false">الأساتذة</button>
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

 <section class="card panel" id="p-claims" hidden>
  <div class="panel-h"><h2>استعادة الحسابات («هذا حسابي»)</h2><span id="clCount"></span></div>
  <div class="sub">مقبولة وبانتظار التنفيذ</div>
  <div id="schedBox"></div>
  <div class="sub">السجل (الوقت · الجهاز · القرار)</div>
  <div id="clLog"></div>
 </section>

 <section class="card panel" id="p-staff" hidden>
  <div class="panel-h"><h2>الأساتذة والمشرفون</h2><span id="stCount"></span></div>
  <div id="staffBox"></div>
 </section>

 <section class="card panel" id="p-import" hidden>
  <div class="panel-h"><h2>استيراد قائمة الطلبة</h2></div>
  <label class="drop"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4"/></svg><b>اختر ملف CSV</b><small>group,seq,reg_no,name</small><input id="csv" type="file" accept=".csv,text/csv,text/plain"></label>
  <div class="note">الاستيراد يستبدل القائمة الحالية بالكامل.</div>
  <div id="im"></div>
 <div class="note" style="margin-top:18px">بعد التحديث إلى D1: انقل مرة واحدة التفاعلات والإشعارات القديمة المحفوظة في KV.</div>
 <button class="btn" id="mig" type="button" style="margin-top:10px;width:100%">نقل التفاعلات والإشعارات إلى D1</button>
 <div id="migOut"></div>
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
 var sf=data.staff||{};$('sTeach').textContent=sf.teacherCount||0;$('sTeachOn').textContent=sf.teacherActive||0;
 var t=$('tPend');t.hidden=!data.pending.length;t.textContent=data.pending.length;
 $('upd').textContent='آخر تحديث: '+new Date().toLocaleTimeString('ar-DZ');
}
var KIND_TX={request:'طلب جديد',approve:'قُبل (مجدول)',reject:'رُفض',exec:'نُفِّذ',owner_reject:'رفضه صاحب الحساب',cancel:'أُلغي من الإدارة',auto_cancel:'أُلغي تلقائياً'};
function remain(ms){
 if(ms<=0)return 'الآن';
 var m=Math.ceil(ms/60000),h=Math.floor(m/60);
 if(h>=24){var d=Math.floor(h/24);return d+' يوم'+(h%24?' و '+(h%24)+' س':'')}
 return h?h+' س'+(m%60?' و '+(m%60)+' د':''):m+' د';
}
function trustTag(kd){return el('span',kd?'✅ جهاز موثوق':'⚠️ جهاز غير معروف','tag '+(kd?'ok':'bad'))}
function loadCard(p,holder,b){
 b.disabled=true;b.textContent='جارٍ التحميل…';
 api('pimg',{id:p.id}).then(function(j){
  if(!j.image){b.textContent='الصورة غير متوفرة';return}
  var im=new Image();im.className='idimg'+(p.fc==='face'?' blur':'');im.alt='صورة البطاقة';im.src=j.image;
  holder.textContent='';holder.appendChild(im);
  if(p.fc==='face'){holder.appendChild(el('div','قد يظهر وجه في الصورة فأُخفيت مؤقتاً. اضغط عليها لإظهارها.','note'));im.onclick=function(){im.classList.remove('blur')}}
 }).catch(function(){b.disabled=false;b.textContent='تعذّر التحميل، أعد المحاولة'});
}
function renderPending(){
 var P=$('pend');P.textContent='';
 $('pCount').textContent=data.pending.length?data.pending.length+' طلب':'';
 if(!data.pending.length){P.appendChild(el('div','لا توجد طلبات حالياً ✓','empty'));return}
 data.pending.forEach(function(p,i){
  var it=el('div',null,'item');it.style.animationDelay=(i*40)+'ms';
  it.appendChild(avatar(p.name));
  var b=el('div',null,'body'),nm=el('div',null,'name'),claim=p.t==='claim';
  nm.appendChild(el('span',p.name||''));
  var kind=p.t==='new'?'طلب انضمام (غير مدرج)':claim?'«هذا حسابي» (كلمة مرور جديدة)':p.t==='mismatch'?'اسم غير مطابق':'جهاز جديد';
  nm.appendChild(el('span',kind,'tag warn'));
  if(claim||p.t==='device')nm.appendChild(trustTag(!!p.kd));
  b.appendChild(nm);
  b.appendChild(el('div',(p.rn?'في القائمة: '+p.rn+(p.g?' · فوج '+p.g:''):'غير موجود في القائمة'),'meta'));
  if(p.dl)b.appendChild(el('div','الجهاز: '+p.dl,'meta'));
  if(claim&&p.dob)b.appendChild(el('div','تاريخ الميلاد المكتوب: '+p.dob,'meta'));
  b.appendChild(el('div',when(p.ts),'meta'));
  if(claim){
   b.appendChild(el('div',p.at>Date.now()?'إن قبلتَ الآن يُنفَّذ بعد '+remain(p.at-Date.now())+' (المهلة تُحسب من وقت الطلب)':'انتهت المهلة: يُنفَّذ فور القبول','meta'));
   var holder=el('div',null,'');b.appendChild(holder);
   var cb=btn('عرض صورة البطاقة','soft',function(){loadCard(p,holder,cb)});
   var ca=el('div',null,'acts');ca.appendChild(cb);b.appendChild(ca);
  }
  var ac=el('div',null,'acts');
  if(claim){
   ac.appendChild(btn('قبول','',function(){
    api('approve',{id:p.id},'').then(function(j){
     if(j.error)toast('خطأ: '+j.error);else toast(j.executed?'تم التنفيذ':'قُبل، يُنفَّذ بعد '+remain((j.at||0)-Date.now()));
     return load(true)});
   }));
   ac.appendChild(btn('قبول وننفّذ الآن','danger',function(){
    ask('تنفيذ فوري','ستتغير كلمة مرور «'+(p.rn||p.name||'')+'» وتُلغى كل جلساتها القديمة الآن، دون انتظار المهلة.','ننفّذ الآن',function(){act('approve',{id:p.id,now:'1'},'تم التنفيذ')});
   }));
  }else ac.appendChild(btn('قبول','',function(){act('approve',{id:p.id},'تم قبول الطلب')}));
  ac.appendChild(btn('رفض','ghost',function(){act('reject',{id:p.id},'تم رفض الطلب')}));
  b.appendChild(ac);it.appendChild(b);P.appendChild(it);
 });
}
function renderClaims(){
 var S2=$('schedBox'),L=$('clLog');S2.textContent='';L.textContent='';
 var sc=data.sched||[],lg=data.claimlog||[];
 $('clCount').textContent=sc.length?sc.length+' مجدول':'';
 if(!sc.length)S2.appendChild(el('div','لا توجد طلبات مجدولة.','empty'));
 sc.forEach(function(x,i){
  var it=el('div',null,'item');it.appendChild(avatar(x.n));
  var b=el('div',null,'body'),nm=el('div',null,'name');
  nm.appendChild(el('span',x.n||''));nm.appendChild(trustTag(!!x.kd));b.appendChild(nm);
  if(x.dl)b.appendChild(el('div','الجهاز: '+x.dl,'meta'));
  b.appendChild(el('div','طُلب: '+when(x.ts)+' · يُنفَّذ بعد '+remain((x.at||0)-Date.now()),'meta'));
  var ac=el('div',null,'acts');
  ac.appendChild(btn('ننفّذ الآن','danger',function(){ask('تنفيذ فوري','ستتغير كلمة المرور وتُلغى الجلسات القديمة الآن.','ننفّذ الآن',function(){act('execnow',{id:x.id},'تم التنفيذ')})}));
  ac.appendChild(btn('إلغاء الطلب','ghost',function(){ask('إلغاء','سيُلغى هذا الطلب ولن يتغير شيء في الحساب.','إلغاء الطلب',function(){act('cancelsched',{id:x.id},'تم الإلغاء')})}));
  b.appendChild(ac);it.appendChild(b);S2.appendChild(it);
 });
 if(!lg.length)L.appendChild(el('div','السجل فارغ.','empty'));
 lg.forEach(function(e){
  var it=el('div',null,'item'),b=el('div',null,'body'),nm=el('div',null,'name');
  nm.appendChild(el('span',e.n||'—'));
  nm.appendChild(el('span',KIND_TX[e.k]||e.k,'tag '+(e.k==='owner_reject'?'bad':e.k==='exec'?'ok':'warn')));
  if(e.k==='request'||e.k==='approve')nm.appendChild(trustTag(!!e.kd));
  b.appendChild(nm);
  b.appendChild(el('div',when(e.ts)+(e.dl?' · '+e.dl:''),'meta'));
  it.appendChild(b);L.appendChild(it);
 });
}
function renderAlert(){
 var seen=Number(localStorage.getItem('ensd_cl_seen')||0),lg=data.claimlog||[];
 var n=lg.filter(function(e){return e.k==='owner_reject'&&e.ts>seen}).length;
 var box=$('clAlert'),t=$('tCl');
 t.hidden=!n;t.textContent=n;box.hidden=!n;box.textContent='';
 if(n){
  box.appendChild(document.createTextNode('تنبيه: رفض صاحب الحساب '+n+' طلب استعادة. راجع تبويب «الاستعادة».'));
  box.appendChild(document.createElement('br'));
  box.appendChild(btn('تم الاطلاع','ghost',function(){localStorage.setItem('ensd_cl_seen',String(Date.now()));renderAlert()}));
 }
}
function showDevices(u){
 api('devices',{sid:u.sid}).then(function(j){
  var o=el('div',null,'ov'),m=el('div',null,'card modal');
  m.appendChild(el('h3','أجهزة '+(u.n||'')));
  var list=j.devices||[];
  if(!list.length)m.appendChild(el('p','لا توجد أجهزة مسجّلة.'));
  list.forEach(function(d){m.appendChild(el('p',(d.l||'جهاز (بلا تفاصيل)')+' · أول استعمال '+(d.t?when(d.t):'—')+' · آخر استعمال '+(d.s?when(d.s):'—')))});
  var c=el('button','إغلاق','btn ghost');c.style.width='100%';c.onclick=function(){o.remove()};
  o.onclick=function(e){if(e.target===o)o.remove()};m.appendChild(c);o.appendChild(m);document.body.appendChild(o);
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
  if(u.pg||u.g)nm.appendChild(el('span','المجموعة '+(u.pg||u.g),'tag'));
  b.appendChild(nm);
  var m=el('div',null,'meta');m.appendChild(el('span',ago(u.ls),'seen'+(on?' on':'')));
  m.appendChild(document.createTextNode(' · أجهزة: '+(u.c||1)+' · انضم '+when(u.ts)));b.appendChild(m);
  var ac=el('div',null,'acts');
  ac.appendChild(btn(u.banned?'إلغاء الحظر':'حظر',u.banned?'soft':'danger',function(){
   if(u.banned)act('unban',{sid:u.sid},'تم إلغاء الحظر');
   else ask('حظر الطالب','سيُمنع «'+(u.n||'')+'» من الدخول فوراً.','حظر',function(){act('ban',{sid:u.sid},'تم الحظر')});
  }));
  ac.appendChild(btn('الأجهزة','soft',function(){showDevices(u)}));
  ac.appendChild(btn('تصفير كلمة المرور','ghost',function(){
   ask('تصفير كلمة المرور','ستُحذف كلمة مرور «'+(u.n||'')+'» وتبقى أجهزته، ليضع كلمة جديدة.','تصفير',function(){act('resetpw',{sid:u.sid},'تم تصفير كلمة المرور')});
  }));
  ac.appendChild(btn('تصفير الأجهزة','ghost',function(){
   ask('تصفير الأجهزة','سيُحذف ارتباط أجهزة «'+(u.n||'')+'» وسيحتاج للموافقة عند الدخول من جهاز جديد.','تصفير',function(){act('resetdev',{sid:u.sid},'تم تصفير الأجهزة')});
  }));
  b.appendChild(ac);it.appendChild(b);U.appendChild(it);
 });
}
function staffItem(name,tagText,tagCls,ls,on,i){
 var it=el('div',null,'item');it.style.animationDelay=Math.min(i,10)*30+'ms';
 it.appendChild(avatar(name,on));
 var b=el('div',null,'body'),nm=el('div',null,'name');
 nm.appendChild(el('span',name||''));nm.appendChild(el('span',tagText,'tag '+tagCls));
 b.appendChild(nm);
 var m=el('div',null,'meta');m.appendChild(el('span',on?'نشط الآن':(ls?ago(ls):'لم يدخل بعد'),'seen'+(on?' on':'')));
 b.appendChild(m);it.appendChild(b);return it;
}
function renderStaff(){
 var S=$('staffBox'),sf=data.staff||{};S.textContent='';
 var T=sf.teachers||[],P=sf.supervisors||[],i=0;
 $('stCount').textContent=(sf.teacherCount||0)+' أستاذ · نشط: '+(sf.teacherActive||0);
 var h1=el('h3','الأساتذة ('+(sf.teacherCount||0)+') · نشطون: '+(sf.teacherActive||0));h1.style.cssText='margin:6px 0 10px;font-size:14px';S.appendChild(h1);
 if(!T.length)S.appendChild(el('div','لم يُضبط أي رمز أستاذ.','empty'));
 T.forEach(function(t){S.appendChild(staffItem((t.name||'الأستاذ')+(t.subject?' · أستاذ '+t.subject:'')+' · المجموعة '+(t.pg||t.group),t.on?'نشط':'غير نشط',t.on?'ok':'',t.ls,t.on,i++))});
 if(sf.owner){var h0=el('h3','المالك');h0.style.cssText='margin:14px 0 10px;font-size:14px';S.appendChild(h0);
  S.appendChild(staffItem(sf.owner.name||'المالك',sf.owner.on?'نشط':'غير نشط',sf.owner.on?'ok':'',sf.owner.ls,sf.owner.on,i++))}
 var h2=el('h3','المشرفون ('+(sf.supCount||0)+') · نشطون: '+(sf.supActive||0));h2.style.cssText='margin:14px 0 10px;font-size:14px';S.appendChild(h2);
 if(!P.length)S.appendChild(el('div','لا يوجد مشرفون معيَّنون.','empty'));
 P.forEach(function(x){S.appendChild(staffItem((x.name||'')+(x.pg?' · المجموعة '+x.pg:''),x.on?'نشط':'غير نشط',x.on?'ok':'',x.ls,x.on,i++))});
}
function render(){renderStats();renderPending();renderClaims();renderAlert();renderUsers();renderStaff()}
function setTab(t){
 tab=t;
 [].forEach.call(document.querySelectorAll('.tab'),function(b){b.setAttribute('aria-selected',String(b.getAttribute('data-t')===t))});
 ['pending','users','claims','staff','import'].forEach(function(k){$('p-'+k).hidden=k!==t});
}
function load(silent){
 var rf=$('rf');if(!silent)rf.classList.add('spin');
 return api('list').then(function(j){
  rf.classList.remove('spin');
  if(j.http===401){sessionStorage.removeItem('ac');code='';$('lg').hidden=false;$('app').hidden=true;$('m').textContent='رمز غير صحيح';return}
  if(j.error){$('m').textContent='خطأ: '+j.error;return}
  data=j;$('lg').hidden=true;$('app').hidden=false;render();
  if(!timer)timer=setInterval(function(){if(!document.hidden&&code)load(true)},300000);
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
$('mig').onclick=function(){
 var b=this,out=$('migOut'),total=0;b.disabled=true;
 function show(t,bad){var r=el('div',null,'res'+(bad?' bad':''));r.textContent=t;out.textContent='';out.appendChild(r)}
 function step(kind,cur){
  return api('migrate',{kind:kind,cursor:cur||''},'').then(function(j){
   if(!j.ok)throw new Error(j.error||('HTTP '+j.http));
   total+=j.moved||0;show('جارٍ النقل ('+(kind==='rx'?'التفاعلات':'الإشعارات')+')... '+total);
   if(!j.done&&j.cursor)return step(kind,j.cursor);
  });
 }
 step('rx','').then(function(){return step('nt','')}).then(function(){show('اكتمل النقل: '+total+' عنصراً.');b.disabled=false})
 .catch(function(e){show('تعذر النقل: '+e.message,true);b.disabled=false});
};
if(code)load();
</script></body></html>
`;



/* ===== الأعمال الأدبية المشتركة (قصائد، قصص، خواطر…) — تُحفظ في D1 فتظهر لكل الطلبة =====
   GET /api/literary            قائمة خفيفة (مقتطفات)         GET ?id=…   العمل كاملًا
   POST /api/literary           إنشاء/تعديل (id للتعديل)       POST ?action=like   {id,on}
   DELETE /api/literary?id=…    حذف (صاحب العمل أو الإدارة) */
const LIT_TYPES = ["poem", "story", "novel", "khat", "text", "other"];
const LIT_MAX_BODY = 60000, LIT_MAX_TITLE = 120, LIT_MAX_VERSES = 200, LIT_MAX_HEMI = 300, LIT_PER_USER = 100, LIT_LIST_MAX = 500;
let litReady = null;
async function litInit(env) {
  const db = env && env.DB && typeof env.DB.prepare === "function" ? env.DB : null;
  if (!db) throw new Error("d1_not_configured");
  if (!litReady) {
    litReady = db.batch([
      db.prepare("CREATE TABLE IF NOT EXISTS lit (id TEXT PRIMARY KEY, me TEXT NOT NULL, name TEXT, type TEXT NOT NULL, title TEXT, ex TEXT, pv TEXT, nv INTEGER, body TEXT, ts INTEGER NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS lit_ts ON lit (ts)"),
      db.prepare("CREATE INDEX IF NOT EXISTS lit_me ON lit (me)"),
      db.prepare("CREATE TABLE IF NOT EXISTS lit_lk (id TEXT NOT NULL, me TEXT NOT NULL, PRIMARY KEY (id, me))")
    ]).then(() => db, (e) => { litReady = null; throw e; });
  }
  return litReady;
}
const litStrip = (h) => String(h || "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
function litVerses(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, LIT_MAX_VERSES)
    .map((r) => [String((r && r[0]) || "").slice(0, LIT_MAX_HEMI).trim(), String((r && r[1]) || "").slice(0, LIT_MAX_HEMI).trim()])
    .filter((r) => r[0] || r[1]);
}
function litView(r, full) {
  const o = { id: r.id, type: r.type, title: r.title || "", author: { name: r.name || "طالب" }, ts: r.ts, likes: Number(r.likes) || 0, liked: !!Number(r.liked), mine: !!Number(r.mine) };
  if (full) {
    if (r.type === "poem") { try { o.v = JSON.parse(r.body || "[]"); } catch { o.v = []; } } else o.body = r.body || "";
  } else {
    o.ex = r.ex || ""; o.nv = Number(r.nv) || 0; o.part = 1;
    if (r.type === "poem") { try { o.pv = JSON.parse(r.pv || "[]"); } catch { o.pv = []; } }
  }
  return o;
}
/* شارة الكاتب (المالك/الأستاذ/مشرف) تُحسب في الخادم من هوية صاحب العمل */
async function litViewA(env, r, full, pc) {
  const o = litView(r, full), who = String(r.who || "");
  let role = "", u = "";
  if (who.startsWith("a-")) { const k = who.slice(2); if (BADGE_ROLES.includes(k)) { role = k; u = "r-" + k; } }
  else if (pc && pc.sups.some((x) => x.sid === who)) { role = "supervisor"; try { u = await supUid(env, who); } catch {} }
  if (role) { o.author.role = role; o.author.u = u; }
  return o;
}
const LIT_SEL = "SELECT l.id, l.type, l.title, l.ex, l.pv, l.nv, l.name, l.ts, l.me AS who, (l.me = ?1) AS mine, (SELECT COUNT(*) FROM lit_lk k WHERE k.id = l.id) AS likes, EXISTS(SELECT 1 FROM lit_lk k WHERE k.id = l.id AND k.me = ?1) AS liked";
async function handleLiterary(request, env, ctx) {
  const ss = await readSession(request, env);
  if (!ss.ok) return json({ error: "login_required" }, 401);
  const u = new URL(request.url), action = u.searchParams.get("action") || "", id = String(u.searchParams.get("id") || "");
  const who = await rxIdentity(request, env, ss), me = who.me;
  try {
    const db = await litInit(env);
    const pc = await rxPersonCtx(env, false);
    if (request.method === "GET") {
      if (id) {
        const r = await db.prepare(LIT_SEL + ", l.body FROM lit l WHERE l.id = ?2").bind(me, id).first();
        return r ? json({ item: await litViewA(env, r, true, pc) }) : json({ error: "not_found" }, 404);
      }
      const rs = await db.prepare(LIT_SEL + " FROM lit l ORDER BY l.ts DESC LIMIT ?2").bind(me, LIT_LIST_MAX).all();
      return json({ items: await Promise.all((rs.results || []).map((r) => litViewA(env, r, false, pc))) });
    }
    if (request.method === "POST" && action === "like") {
      let b = {}; try { b = await request.json(); } catch {}
      const lid = String(b.id || "");
      if (!(await db.prepare("SELECT 1 AS x FROM lit WHERE id = ?1").bind(lid).first())) return json({ error: "not_found" }, 404);
      if (rlCount("lit:" + me, 60000) >= 60) return json({ error: "rate_limited" }, 429);
      rlAdd("lit:" + me, 60000);
      await db.prepare(b.on ? "INSERT OR IGNORE INTO lit_lk (id, me) VALUES (?1, ?2)" : "DELETE FROM lit_lk WHERE id = ?1 AND me = ?2").bind(lid, me).run();
      const c = await db.prepare("SELECT COUNT(*) AS n FROM lit_lk WHERE id = ?1").bind(lid).first();
      return json({ ok: true, likes: Number(c && c.n) || 0 });
    }
    if (request.method === "DELETE") {
      if (!id) return json({ error: "invalid_input" }, 400);
      const r = await db.prepare("SELECT me FROM lit WHERE id = ?1").bind(id).first();
      if (!r) return json({ ok: true });
      if (r.me !== me && !who.admin) return json({ error: "forbidden" }, 403);
      await db.batch([db.prepare("DELETE FROM lit WHERE id = ?1").bind(id), db.prepare("DELETE FROM lit_lk WHERE id = ?1").bind(id)]);
      return json({ ok: true });
    }
    if (request.method === "POST") {
      let d = null; try { d = await request.json(); } catch {}
      if (!d || !LIT_TYPES.includes(d.type)) return json({ error: "invalid_input" }, 400);
      if (rlCount("litw:" + me, 60000) >= 12) return json({ error: "rate_limited" }, 429);
      rlAdd("litw:" + me, 60000);
      const title = String(d.title || "").slice(0, LIT_MAX_TITLE).trim();
      let body = "", v = [], ex = "", pv = "[]", nv = 0;
      if (d.type === "poem") {
        v = litVerses(d.v);
        if (!v.length) return json({ error: "empty" }, 400);
        body = JSON.stringify(v); pv = JSON.stringify(v.slice(0, 1)); nv = v.length;
      } else {
        body = String(d.body || "").slice(0, LIT_MAX_BODY);
        const t = litStrip(body);
        if (!t && !/<table/i.test(body)) return json({ error: "empty" }, 400);
        ex = t.length > 150 ? t.slice(0, 150) + "…" : t;
      }
      const name = String(((await rxPerson(env, me, await rxPersonCtx(env, true))) || {}).name || "طالب").slice(0, 60);
      let lid = String(d.id || "");
      if (lid) {
        const r = await db.prepare("SELECT me FROM lit WHERE id = ?1").bind(lid).first();
        if (!r) return json({ error: "not_found" }, 404);
        if (r.me !== me) return json({ error: "forbidden" }, 403);
        await db.prepare("UPDATE lit SET type = ?2, title = ?3, ex = ?4, pv = ?5, nv = ?6, body = ?7, name = ?8 WHERE id = ?1").bind(lid, d.type, title, ex, pv, nv, body, name).run();
      } else {
        const cnt = await db.prepare("SELECT COUNT(*) AS n FROM lit WHERE me = ?1").bind(me).first();
        if ((Number(cnt && cnt.n) || 0) >= LIT_PER_USER) return json({ error: "limit" }, 429);
        const now = Date.now();
        const ts = Number.isFinite(d.ts) && d.ts > 1577836800000 && d.ts <= now ? Math.floor(d.ts) : now; // يحفظ تاريخ الأعمال المنقولة من الجهاز
        lid = "l" + now.toString(36) + Math.random().toString(36).slice(2, 7);
        await db.prepare("INSERT INTO lit (id, me, name, type, title, ex, pv, nv, body, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)").bind(lid, me, name, d.type, title, ex, pv, nv, body, ts).run();
      }
      const r = await db.prepare(LIT_SEL + ", l.body FROM lit l WHERE l.id = ?2").bind(me, lid).first();
      return json({ item: await litViewA(env, r, true, pc) });
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (e) { return dbErr(e); }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(execDueAll(env).catch(() => {}));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const gate = await authGate(request, env, url, ctx);
    if (gate) return gate;
    if (url.pathname === "/api/publish") return handlePublish(request, env);
    if (url.pathname === "/api/history") return handleHistory(request, env);
    if (url.pathname === "/api/lessons" || url.pathname === "/api/file" || url.pathname === "/api/gpa" || url.pathname === "/api/academic" || url.pathname === "/api/academic-image" || url.pathname === "/api/resources" || url.pathname === "/api/resource" || url.pathname === "/api/announcements" || url.pathname === "/api/badges" || url.pathname === "/api/reactions" || url.pathname === "/api/literary" || url.pathname === "/api/notifications" || url.pathname === "/api/sync" || url.pathname === "/api/polls" || url.pathname === "/api/comments") {
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
            element.setAttribute("src", "/academic-admin.js?v=20261120-ctx");
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
