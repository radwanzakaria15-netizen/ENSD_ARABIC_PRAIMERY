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
  const client = (res, tag, age) => { const h = new Headers(res.headers); h.set("cache-control", "public, max-age=" + age); h.set("x-edge", tag); return new Response(res.body, { status: 200, headers: h }); };
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
 const u=new URL(request.url),action=u.searchParams.get("action")||"",id=u.searchParams.get("id")||"",admin=isModerator(request,env);
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
async function handleResourceFile(request,env){
 const u=new URL(request.url),key=u.searchParams.get("key")||"";
 if(request.method==="POST"){
  const name=safeFileName(u.searchParams.get("name")),type=contentTypeForName(name);
  if(type==="application/octet-stream")return json({error:"unsupported_file_type"},400);
  const meta={id:crypto.randomUUID(),title:String(u.searchParams.get("title")||"").trim().slice(0,120),year:metaText(u.searchParams.get("year"),40),semester:metaText(u.searchParams.get("semester"),40),subject:metaText(u.searchParams.get("subject"),100),kind:metaText(u.searchParams.get("kind"),40),fileName:name,contentType:type,createdAt:new Date().toISOString()};
  if(!validMeta(meta))return json({error:"invalid_resource_metadata"},400);
  const data=await request.arrayBuffer();if(!data.byteLength)return json({error:"empty_file"},400);if(data.byteLength>MAX_FILE_SIZE)return json({error:"file_too_large",limit:MAX_FILE_SIZE},413);
  const b=new Uint8Array(data),pdf=type==="application/pdf"&&new TextDecoder().decode(b.slice(0,5)).startsWith("%PDF-"),doc=type==="application/msword"&&b.length>=8&&b.slice(0,8).every((v,i)=>v===[0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1][i]),docx=type==="application/vnd.openxmlformats-officedocument.wordprocessingml.document"&&b[0]===0x50&&b[1]===0x4B;
  if(!(pdf||doc||docx))return json({error:"file_type_mismatch"},400);
  const ownerRaw=String(u.searchParams.get("owner")||"").trim();if(/^[A-Za-z0-9_-]{16,128}$/.test(ownerRaw))meta.ownerHash=await sha256Hex(ownerRaw);
  const base="resources/pending/"+meta.id;meta.fileKey=base+"__"+name;
  const put=await signedB2Request(env,"PUT",meta.fileKey,data,{},type);if(!put.ok)return json({error:"storage_error"},502);
  const save=await signedB2Request(env,"PUT",base+".json",encoder.encode(JSON.stringify(meta)),{},"application/json");
  if(!save.ok){await deleteResourceObject(env,meta.fileKey);return json({error:"storage_error"},502)}
  return json({ok:true,pending:true,id:meta.id});
 }
 if(request.method==="GET"){
  const approved=key.startsWith("resources/approved/")&&!key.includes(".."),pending=key.startsWith("resources/pending/")&&!key.includes("..")&&isModerator(request,env);
  if(!approved&&!pending)return json({error:"not_found"},404);
  const serve=async()=>{
  const r=await signedB2Request(env,"GET",key);if(r.status===404)return json({error:"not_found"},404);if(!r.ok)return json({error:"storage_error"},502);
  const name=safeFileName(key.split("__").slice(1).join("__")||"resource.pdf"),type=contentTypeForName(name);
  return new Response(r.body,{headers:{"content-type":type,"content-disposition":(type==="application/pdf"&&u.searchParams.get("download")!=="1"?"inline":"attachment")+'; filename="'+name.replace(/[^\x20-\x7E]/g,"_").replace(/["\\\\]/g,"_")+'"; filename*=UTF-8\'\''+encodeRFC3986(name),"cache-control":"private, max-age=0, must-revalidate","x-content-type-options":"nosniff"}});
  };
  return approved?edgeFile(request,21600,serve):serve();
 }
 return json({error:"method_not_allowed"},405);
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
    if (!isAcademicAdmin(request, env)) return json({ error: "unauthorized" }, 401);
    let config;
    try { config = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }
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
          if (!subject || !validText(subject.id, 80) || !validText(subject.name, 120) || !validText(subject.symbol, 8) || ids.has(subject.id) || !Array.isArray(subject.axes) || subject.axes.length > 100 || (subject.programImage && (typeof subject.programImage !== "string" || subject.programImage.length > 220 || !subject.programImage.startsWith("/api/academic-image?key=academic%2Fimages%2F")))) {
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
async function handleAnnouncements(request, env) {
  const u = new URL(request.url), action = u.searchParams.get("action") || "";
  try {
    if (request.method === "GET") return edgeJson("ann", 120, async () => {
      try { return json(await readAnnouncements(env)); }
      catch (e) { return json({ ok: false, error: "storage_error", message: String(e.message || e).slice(0, 200) }, 502); }
    });
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!isModerator(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
    if (action === "check") return json({ ok: true });

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
      };
      list.unshift(item);
      await writeAnnouncements(env, list.slice(0, 200)); await edgeDrop("ann");
      return json({ ok: true, id: item.id });
    }

    const id = u.searchParams.get("id") || "";
    const idx = list.findIndex((a) => a.id === id);
    if (idx < 0) return json({ ok: false, error: "not_found" }, 404);
    if (action === "delete") { list.splice(idx, 1); await writeAnnouncements(env, list); await edgeDrop("ann"); return json({ ok: true }); }
    if (action === "pin") { list[idx].pinned = !list[idx].pinned; await writeAnnouncements(env, list); await edgeDrop("ann"); return json({ ok: true, pinned: list[idx].pinned }); }
    return json({ ok: false, error: "bad_action" }, 400);
  } catch (e) {
    return json({ ok: false, error: "storage_error", message: String(e.message || e).slice(0, 200) }, 502);
  }
}

async function handleApi(request, env) {
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
    });

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/lessons" || url.pathname === "/api/file" || url.pathname === "/api/academic" || url.pathname === "/api/academic-image" || url.pathname === "/api/resources" || url.pathname === "/api/resource" || url.pathname === "/api/announcements") return handleApi(request, env);
    const response = await env.ASSETS.fetch(request);
    if ((url.pathname === "/" || url.pathname === "/index.html") &&
        (response.headers.get("content-type") || "").includes("text/html")) {
      return new HTMLRewriter()
        .on('script[src="/academic-admin.js"]', {
          element(element) {
            element.setAttribute("src", "/academic-admin.js?v=1751ed0");
          }
        })
        .on('script[src*="/schedule-view.js"]', {
          element(element) {
            element.setAttribute("src", "/schedule-view.js?v=7e8e47b");
          }
        })
        .transform(response);
    }
    return response;
  },
};
