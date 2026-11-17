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

/* ===================================================================
   بوابة دخول الطلبة (تحقق بالاسم + رقم التسجيل، ربط بجهاز، موافقة يدوية)
   الإعداد المطلوب في Cloudflare:
   - KV binding باسم STUDENTS_KV
   - Secret باسم SESSION_SECRET (نص عشوائي طويل، لا يُغيَّر بعد رفع القائمة)
   - المفتاح "roster" في STUDENTS_KV يُرفع بواسطة seed-roster.mjs
   =================================================================== */
const SESSION_DAYS = 180;
const BANS_TTL_MS = 30_000;
const authMem = { bans: null, bansAt: 0, hits: new Map() };

const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uText = (text) => b64u(encoder.encode(text));
const unb64uText = (s) => {
  try { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))); }
  catch { return ""; }
};

function authSecret(env) { return String(env.SESSION_SECRET || ""); }
function authReady(env) { return Boolean(env.STUDENTS_KV) && authSecret(env).length >= 16; }

async function macHex(env, value, len = 32) {
  return hex(await hmac(encoder.encode(authSecret(env)), value)).slice(0, len);
}

function normDigits(value) {
  return String(value || "")
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/\D/g, "");
}

function normName(value) {
  return String(value || "")
    .replace(/[\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/[^\u0621-\u064a a-zA-Z]/g, " ")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function namesMatch(typed, stored) {
  const a = normName(typed), b = normName(stored);
  if (!a || !b) return false;
  if (a.replace(/ /g, "") === b.replace(/ /g, "")) return true;
  const at = a.split(" "), bt = b.split(" "), bJoined = bt.join("");
  let hit = 0;
  for (const t of at) {
    const ok = bt.some((s) => editDistance(t, s, t.length >= 5 ? 1 : 0) <= (t.length >= 5 ? 1 : 0)) ||
      (t.length >= 4 && bJoined.includes(t));
    if (ok) hit++;
  }
  return hit >= 1 && hit / at.length >= 0.5;
}

function clientIp(request) { return request.headers.get("cf-connecting-ip") || "0"; }

function rateLimited(request, limit = 8, windowMs = 600_000) {
  const ip = clientIp(request), now = Date.now();
  const rec = authMem.hits.get(ip);
  if (!rec || now - rec.t > windowMs) { authMem.hits.set(ip, { t: now, n: 0 }); return false; }
  return rec.n >= limit;
}
function rateHit(request) {
  const rec = authMem.hits.get(clientIp(request));
  if (rec) rec.n++;
  if (authMem.hits.size > 5000) authMem.hits.clear();
}

function parseCookies(request) {
  const out = {};
  for (const part of String(request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function signSession(env, uid, did, role = "s") {
  const payload = b64uText([uid, did, role, Date.now() + SESSION_DAYS * 86400_000].join("|"));
  return payload + "." + (await macHex(env, "sess:" + payload, 40));
}

async function readBans(env) {
  const now = Date.now();
  if (authMem.bans && now - authMem.bansAt < BANS_TTL_MS) return authMem.bans;
  const list = (await env.STUDENTS_KV.get("bans", "json")) || [];
  authMem.bans = new Set(list);
  authMem.bansAt = now;
  return authMem.bans;
}

async function readSession(request, env) {
  const raw = parseCookies(request).sid;
  if (!raw || !authReady(env)) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || sig !== (await macHex(env, "sess:" + payload, 40))) return null;
  const [uid, did, role, exp] = unb64uText(payload).split("|");
  if (!uid || Number(exp) < Date.now()) return null;
  const bans = await readBans(env);
  if (role !== "a" && (bans.has(uid) || bans.has(did))) return null;
  return { uid, did, role };
}

function sessionCookie(request, token) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return "sid=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + SESSION_DAYS * 86400 + secure;
}

function isAnyAdmin(request, env) {
  const supplied = String(request.headers.get("x-admin-code") || "").trim();
  if (!supplied) return false;
  return [env.ADMIN_CODE_A, env.ADMIN_CODE_B, env.ADMIN_CODE_MOD]
    .some((c) => String(c || "").trim() && String(c).trim() === supplied);
}

async function loadRoster(env) {
  return (await env.STUDENTS_KV.get("roster", "json")) || {};
}

function validDid(value) { return /^[a-f0-9]{32}$/.test(String(value || "")); }

async function authLogin(request, env) {
  if (!authReady(env)) return json({ ok: false, error: "auth_not_configured" }, 503);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (rateLimited(request)) return json({ ok: false, error: "too_many_attempts" }, 429);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const did = String(body.did || "");
  if (!validDid(did)) return json({ ok: false, error: "bad_device" }, 400);

  // دخول المشرف
  const adminCode = String(body.admin || "").trim();
  if (adminCode) {
    const ok = [env.ADMIN_CODE_A, env.ADMIN_CODE_B, env.ADMIN_CODE_MOD]
      .some((c) => String(c || "").trim() && String(c).trim() === adminCode);
    if (!ok) { rateHit(request); return json({ ok: false, error: "bad_admin" }, 401); }
    return new Response(JSON.stringify({ ok: true, status: "in" }), {
      headers: { "content-type": "application/json", "cache-control": "no-store",
        "set-cookie": sessionCookie(request, await signSession(env, "admin", did, "a")) },
    });
  }

  const reg = normDigits(body.reg);
  const name = String(body.name || "").trim().slice(0, 80);
  if (reg.length < 8 || reg.length > 20 || normName(name).length < 3) {
    return json({ ok: false, error: "bad_input" }, 400);
  }
  const uid = await macHex(env, "reg:" + reg);
  const bans = await readBans(env);
  if (bans.has(uid) || bans.has(did)) return json({ ok: false, error: "banned" }, 403);

  const roster = await loadRoster(env);
  const entry = roster[uid];
  const known = entry && namesMatch(name, entry.n);
  const st = await env.STUDENTS_KV.get("st:" + uid, "json");
  const now = Date.now();

  const issue = async (extra = {}) => new Response(JSON.stringify({ ok: true, status: "in", ...extra }), {
    headers: { "content-type": "application/json", "cache-control": "no-store",
      "set-cookie": sessionCookie(request, await signSession(env, uid, did)) },
  });

  if (known || st) {
    // قبول الاسم بالقائمة أو سبقت الموافقة عليه يدوياً
    if (!st) {
      await env.STUDENTS_KV.put("st:" + uid, JSON.stringify({ n: entry.n, g: entry.g, d: did, t: now, src: "roster" }));
      return issue();
    }
    if (st.d === did) return issue();
    if (!st.d) { // أعاد المشرف تهيئة الجهاز: يُربط بالجهاز الجديد مباشرة
      await env.STUDENTS_KV.put("st:" + uid, JSON.stringify({ ...st, d: did, t: now }));
      return issue();
    }
    if (!known && !namesMatch(name, st.n)) { rateHit(request); return json({ ok: false, error: "name_mismatch" }, 401); }
    return queue(env, did, { kind: "device", uid, n: st.n, reg: reg.slice(-4), g: st.g || "", t: now });
  }
  rateHit(request);
  return queue(env, did, { kind: "new", uid, n: name, reg, g: entry ? entry.g : "", t: now,
    note: entry ? "الرقم موجود لكن الاسم لا يطابق القائمة" : "الرقم غير موجود في القائمة" });
}

async function queue(env, did, record) {
  await env.STUDENTS_KV.put("p:" + did, JSON.stringify(record), { expirationTtl: 30 * 86400 });
  return json({ ok: true, status: "pending" });
}

async function authStatus(request, env) {
  if (!authReady(env)) return json({ ok: false, error: "auth_not_configured" }, 503);
  const did = new URL(request.url).searchParams.get("did") || "";
  if (!validDid(did)) return json({ ok: false, error: "bad_device" }, 400);
  const bans = await readBans(env);
  if (bans.has(did)) return json({ ok: false, status: "banned" }, 403);
  const approved = await env.STUDENTS_KV.get("ok:" + did, "json");
  if (approved) {
    await env.STUDENTS_KV.delete("ok:" + did);
    return new Response(JSON.stringify({ ok: true, status: "in" }), {
      headers: { "content-type": "application/json", "cache-control": "no-store",
        "set-cookie": sessionCookie(request, await signSession(env, approved.uid, did)) },
    });
  }
  const pending = await env.STUDENTS_KV.get("p:" + did);
  return json({ ok: true, status: pending ? "pending" : "none" });
}

async function writeBans(env, set) {
  await env.STUDENTS_KV.put("bans", JSON.stringify([...set]));
  authMem.bans = set; authMem.bansAt = Date.now();
}

async function listPrefix(env, prefix) {
  const out = []; let cursor;
  do {
    const page = await env.STUDENTS_KV.list({ prefix, cursor, limit: 1000 });
    out.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

async function authAdmin(request, env) {
  if (!authReady(env)) return json({ ok: false, error: "auth_not_configured" }, 503);
  if (!isAnyAdmin(request, env)) { rateHit(request); return json({ ok: false, error: "unauthorized" }, 401); }
  if (rateLimited(request, 60)) return json({ ok: false, error: "too_many_attempts" }, 429);
  const url = new URL(request.url);

  if (request.method === "GET") {
    const [pKeys, sKeys, roster, bans] = await Promise.all([
      listPrefix(env, "p:"), listPrefix(env, "st:"), loadRoster(env), readBans(env),
    ]);
    const pending = (await Promise.all(pKeys.map(async (k) => {
      const r = await env.STUDENTS_KV.get(k, "json");
      return r ? { did: k.slice(2), ...r } : null;
    }))).filter(Boolean).sort((a, b) => b.t - a.t);
    const students = (await Promise.all(sKeys.map(async (k) => {
      const r = await env.STUDENTS_KV.get(k, "json");
      return r ? { uid: k.slice(3), n: r.n, g: r.g, t: r.t, src: r.src, banned: bans.has(k.slice(3)) } : null;
    }))).filter(Boolean).sort((a, b) => b.t - a.t);
    return json({ ok: true, pending, students, rosterSize: Object.keys(roster).length,
      bannedCount: [...bans].length });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
    const action = String(body.action || "");
    const did = String(body.did || ""), uid = String(body.uid || "");

    if (action === "approve" || action === "reject") {
      const rec = await env.STUDENTS_KV.get("p:" + did, "json");
      if (!rec) return json({ ok: false, error: "not_found" }, 404);
      if (action === "approve") {
        const prev = await env.STUDENTS_KV.get("st:" + rec.uid, "json");
        const bans = await readBans(env);
        if (prev && prev.d && prev.d !== did) { bans.add(prev.d); await writeBans(env, bans); } // إبطال الجهاز القديم
        await env.STUDENTS_KV.put("st:" + rec.uid, JSON.stringify({
          n: (prev && prev.n) || rec.n, g: (prev && prev.g) || rec.g || "", d: did, t: Date.now(),
          src: rec.kind === "device" ? "device" : "manual",
        }));
        await env.STUDENTS_KV.put("ok:" + did, JSON.stringify({ uid: rec.uid }), { expirationTtl: 7 * 86400 });
      }
      await env.STUDENTS_KV.delete("p:" + did);
      return json({ ok: true });
    }

    if (action === "ban" || action === "unban") {
      if (!/^[a-f0-9]{32}$/.test(uid)) return json({ ok: false, error: "bad_uid" }, 400);
      const bans = await readBans(env);
      const st = await env.STUDENTS_KV.get("st:" + uid, "json");
      if (action === "ban") { bans.add(uid); if (st && st.d) bans.add(st.d); }
      else { bans.delete(uid); if (st && st.d) bans.delete(st.d); }
      await writeBans(env, bans);
      return json({ ok: true });
    }

    if (action === "reset_device") { // يسمح للطالب بالدخول من جهاز جديد دون موافقة
      const st = await env.STUDENTS_KV.get("st:" + uid, "json");
      if (!st) return json({ ok: false, error: "not_found" }, 404);
      if (st.d) { const bans = await readBans(env); bans.add(st.d); await writeBans(env, bans); }
      st.d = ""; await env.STUDENTS_KV.put("st:" + uid, JSON.stringify(st));
      return json({ ok: true });
    }
  }
  void url;
  return json({ ok: false, error: "bad_request" }, 400);
}

const AUTH_PUBLIC_PREFIXES = ["/api/auth/"];
const AUTH_OPEN_PATHS = new Set(["/__login", "/access-admin", "/favicon.ico", "/icon.svg", "/manifest.webmanifest"]);

function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
}

/* يُحقن في الصفحة الرئيسية: إذا انتهت الجلسة أو حُظر الطالب يعود لصفحة الدخول */
const GUARD_SNIPPET = `(function(){var o=window.fetch;var go=function(){if(location.pathname!=="/__login")location.replace("/__login")};window.fetch=function(){return o.apply(this,arguments).then(function(r){if(r.status===401&&/\\/(api|data)\\//.test(r.url)){r.clone().json().then(function(j){if(j&&j.error==="auth_required")go()}).catch(function(){})}return r})}})();`;

const LOGIN_PAGE = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="#f4f7f8">
<title>تسجيل الدخول | ملحقة العربية</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#f4f7f8;--surface:#fff;--ink:#1e2935;--muted:#5d6a76;--line:#dfe6ea;--primary:#287c78;--primary-dark:#1e6562;--soft:#e8f3f1;--gold:#c18c42;--soft-gold:#fbf4e9;--err:#a33b3b;--soft-err:#fbeeee}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#141b20;--surface:#1c262d;--ink:#e6edf1;--muted:#9fb0bb;--line:#2c3a43;--primary:#5cb5ae;--primary-dark:#7fd0c9;--soft:#1f3532;--soft-gold:#352c1d;--gold:#e0b46f;--err:#ee9a9a;--soft-err:#3a2323}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Tajawal",system-ui,sans-serif;font-size:16px;display:grid;place-items:center;padding:20px;padding-top:max(20px,env(safe-area-inset-top));padding-bottom:max(20px,env(safe-area-inset-bottom))}
main{width:min(430px,100%);background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:30px 26px 24px;box-shadow:0 14px 40px rgba(27,48,60,.07)}
.mark{width:50px;height:50px;border-radius:15px;background:var(--soft);color:var(--primary);display:grid;place-items:center;margin-bottom:16px}
.mark svg{width:27px;height:27px}
h1{font-size:23px;margin:0 0 6px;font-weight:800}
.lead{margin:0 0 22px;color:var(--muted);font-size:14px;line-height:1.8}
label{display:block;font-size:13px;font-weight:700;margin:0 0 6px}
input{width:100%;font:inherit;padding:13px 14px;border:1px solid var(--line);border-radius:13px;background:var(--bg);color:var(--ink);margin-bottom:16px}
input:focus{outline:2px solid var(--primary);outline-offset:1px;border-color:transparent}
input[inputmode=numeric]{direction:ltr;text-align:right;letter-spacing:.04em}
button.go{width:100%;border:0;border-radius:13px;padding:14px;background:var(--primary);color:#fff;font:inherit;font-weight:800;font-size:16px;cursor:pointer}
button.go:hover{background:var(--primary-dark)}button.go:disabled{opacity:.6;cursor:wait}
button.go:focus-visible,.link:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
.msg{display:none;border-radius:13px;padding:12px 14px;font-size:14px;line-height:1.8;margin:0 0 16px}
.msg.show{display:block}.msg.err{background:var(--soft-err);color:var(--err)}.msg.wait{background:var(--soft-gold);color:var(--gold)}
.hint{margin:14px 0 0;color:var(--muted);font-size:12.5px;line-height:1.8}
.link{background:none;border:0;color:var(--primary);font:inherit;font-size:13px;font-weight:700;cursor:pointer;padding:6px 0;margin-top:10px}
#adm{display:none}
.wait-box{display:none;text-align:center;padding:6px 0 2px}.wait-box.show{display:block}
.pulse{width:14px;height:14px;border-radius:50%;background:var(--gold);margin:6px auto 16px}
@media(prefers-reduced-motion:no-preference){.pulse{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{transform:scale(1.5);opacity:.45}}}
</style></head><body>
<main>
<div class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5C4 4.7 4.7 4 5.5 4H11v15H5.5C4.7 19 4 18.3 4 17.5z"/><path d="M20 5.5c0-.8-.7-1.5-1.5-1.5H13v15h5.5c.8 0 1.5-.7 1.5-1.5z"/></svg></div>
<div id="formBox">
<h1>أهلاً بك في المنصة</h1>
<p class="lead">الدخول مخصّص لطلبة الملحقة. اكتب اسمك الكامل ورقم التسجيل كما في الكشف.</p>
<div class="msg err" id="err" role="alert"></div>
<form id="f" autocomplete="off" novalidate>
<label for="name">الاسم الكامل</label>
<input id="name" name="name" type="text" autocomplete="name" required>
<label for="reg">رقم التسجيل</label>
<input id="reg" name="reg" type="text" inputmode="numeric" autocomplete="off" required>
<div id="adm"><label for="admin">رمز المشرف</label><input id="admin" type="password" autocomplete="off"></div>
<button class="go" id="btn" type="submit">دخول</button>
</form>
<p class="hint">يُربط حسابك بجهازك بعد أول دخول فلا تحتاج لإعادة الكتابة. للدخول من جهاز آخر سيُطلب موافقة المشرف.</p>
<button class="link" id="tog" type="button">دخول المشرف</button>
</div>
<div class="wait-box" id="waitBox" aria-live="polite">
<div class="pulse"></div>
<h1>طلبك قيد المراجعة</h1>
<p class="lead">لم نتمكن من مطابقة بياناتك آلياً، فأُرسل طلبك إلى المشرف. ستدخل تلقائياً فور الموافقة، يمكنك ترك هذه الصفحة مفتوحة أو العودة إليها لاحقاً.</p>
<button class="link" id="back" type="button">تعديل البيانات</button>
</div>
</main>
<script>
(function(){
var $=function(i){return document.getElementById(i)};
var did;try{did=localStorage.getItem("ensd_did")}catch(e){}
if(!/^[a-f0-9]{32}$/.test(did||"")){var a=new Uint8Array(16);crypto.getRandomValues(a);did=Array.prototype.map.call(a,function(x){return("0"+x.toString(16)).slice(-2)}).join("");try{localStorage.setItem("ensd_did",did)}catch(e){}}
var ERR={bad_input:"تحقق من الاسم ورقم التسجيل ثم أعد المحاولة.",too_many_attempts:"محاولات كثيرة. انتظر بضع دقائق ثم أعد المحاولة.",banned:"تعذّر السماح بالدخول من هذا الحساب. تواصل مع المشرف.",name_mismatch:"الاسم لا يطابق رقم التسجيل. تأكد من كتابته كما في الكشف.",bad_admin:"رمز المشرف غير صحيح.",auth_not_configured:"النظام قيد الإعداد حالياً. حاول لاحقاً.",net:"تعذّر الاتصال. تحقق من الإنترنت وأعد المحاولة."};
function showErr(k){var e=$("err");e.textContent=ERR[k]||ERR.net;e.className="msg err show"}
function ok(){location.replace("/")}
var timer;
function poll(){clearTimeout(timer);timer=setTimeout(function(){fetch("/api/auth/status?did="+did,{cache:"no-store"}).then(function(r){return r.json().then(function(j){return[r.status,j]})}).then(function(x){var j=x[1];if(j.status==="in")return ok();if(j.status==="banned"){$("waitBox").classList.remove("show");$("formBox").style.display="";showErr("banned");return}if(j.status==="none"){$("waitBox").classList.remove("show");$("formBox").style.display="";return}poll()}).catch(poll)},6000)}
function waiting(){$("formBox").style.display="none";$("waitBox").classList.add("show");poll()}
$("back").onclick=function(){clearTimeout(timer);$("waitBox").classList.remove("show");$("formBox").style.display=""};
$("tog").onclick=function(){var s=$("adm").style.display==="block";$("adm").style.display=s?"none":"block";$("tog").textContent=s?"دخول المشرف":"دخول الطالب";$("name").required=s;$("reg").required=s};
$("f").onsubmit=function(ev){ev.preventDefault();$("err").className="msg err";var admin=$("adm").style.display==="block"?$("admin").value:"";var b=$("btn");b.disabled=true;
fetch("/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({did:did,name:$("name").value,reg:$("reg").value,admin:admin}),cache:"no-store"})
.then(function(r){return r.json()}).then(function(j){b.disabled=false;if(j.ok&&j.status==="in")return ok();if(j.ok&&j.status==="pending")return waiting();showErr(j.error)}).catch(function(){b.disabled=false;showErr("net")})};
fetch("/api/auth/status?did="+did,{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){if(j.status==="in")ok();else if(j.status==="pending")waiting()}).catch(function(){});
})();
</script></body></html>`;

const ACCESS_ADMIN_PAGE = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>إدارة الدخول</title>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#f4f7f8;--surface:#fff;--ink:#1e2935;--muted:#5d6a76;--line:#dfe6ea;--primary:#287c78;--soft:#e8f3f1;--gold:#9a7034;--soft-gold:#fbf4e9;--err:#a33b3b;--soft-err:#fbeeee}
@media(prefers-color-scheme:dark){:root{--bg:#141b20;--surface:#1c262d;--ink:#e6edf1;--muted:#9fb0bb;--line:#2c3a43;--primary:#5cb5ae;--soft:#1f3532;--soft-gold:#352c1d;--gold:#e0b46f;--err:#ee9a9a;--soft-err:#3a2323}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:"Tajawal",system-ui,sans-serif;padding:max(16px,env(safe-area-inset-top)) 16px 40px}
.wrap{max-width:820px;margin:0 auto}h1{font-size:22px;margin:10px 0 4px}h2{font-size:17px;margin:26px 0 10px}
.muted{color:var(--muted);font-size:13px}
input,button{font:inherit}input{padding:11px 13px;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);width:100%}
.row{display:flex;gap:8px;margin:12px 0}.row button{flex:none}
button{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:11px;padding:9px 14px;cursor:pointer;font-weight:700}
button.p{background:var(--primary);color:#fff;border-color:var(--primary)}button.d{color:var(--err)}button:focus-visible,input:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.stat{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:10px 16px;min-width:110px}.stat b{font-size:20px;display:block}
.card{background:var(--surface);border:1px solid var(--line);border-radius:15px;padding:14px;margin:8px 0;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.card .info{min-width:0;flex:1 1 220px}.card b{display:block;font-size:15px}.card small{color:var(--muted);display:block;line-height:1.7}
.tag{display:inline-block;font-size:11px;padding:2px 9px;border-radius:20px;background:var(--soft);color:var(--primary);font-weight:700}
.tag.w{background:var(--soft-gold);color:var(--gold)}.tag.b{background:var(--soft-err);color:var(--err)}
.acts{display:flex;gap:6px;flex-wrap:wrap}.empty{text-align:center;color:var(--muted);padding:22px}
#err{color:var(--err);font-size:14px;min-height:20px}
</style></head><body><div class="wrap">
<h1>إدارة دخول الطلبة</h1><p class="muted">أدخل رمز الإدارة لعرض الطلبات والمسجّلين.</p>
<div class="row"><input id="code" type="password" placeholder="رمز الإدارة" autocomplete="off"><button class="p" id="go">دخول</button></div><div id="err" role="alert"></div>
<div id="app" hidden>
<div class="stats" id="stats"></div>
<h2>طلبات بانتظار الموافقة</h2><div id="pending"></div>
<h2>الطلبة المسجّلون</h2>
<input id="q" type="search" placeholder="بحث بالاسم أو الفوج">
<div id="students"></div>
</div></div>
<script>
(function(){
var $=function(i){return document.getElementById(i)},code="",data=null;
try{code=sessionStorage.getItem("acc_code")||""}catch(e){}
function esc(t){var d=document.createElement("div");d.textContent=t==null?"":String(t);return d.innerHTML}
function api(method,body){return fetch("/api/auth/admin",{method:method,headers:{"x-admin-code":code,"content-type":"application/json"},body:body?JSON.stringify(body):undefined,cache:"no-store"}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||"err");return j})})}
function date(t){try{return new Date(t).toLocaleString("ar-DZ",{dateStyle:"medium",timeStyle:"short"})}catch(e){return""}}
var KIND={new:"طالب جديد",device:"جهاز جديد"};
function render(){
var d=data;$("app").hidden=false;
$("stats").innerHTML='<div class="stat"><b>'+d.pending.length+'</b><small>بانتظار الموافقة</small></div><div class="stat"><b>'+d.students.length+'</b><small>سجّلوا دخولهم</small></div><div class="stat"><b>'+d.rosterSize+'</b><small>في القائمة</small></div><div class="stat"><b>'+d.bannedCount+'</b><small>محظورون</small></div>';
$("pending").innerHTML=d.pending.length?d.pending.map(function(p){return'<div class="card"><div class="info"><b>'+esc(p.n)+'</b><small><span class="tag w">'+esc(KIND[p.kind]||p.kind)+'</span> '+(p.kind==="new"?"رقم التسجيل: "+esc(p.reg):"آخر 4 أرقام: "+esc(p.reg))+(p.g?" · الفوج "+esc(p.g):"")+'</small><small>'+esc(p.note||"")+' '+esc(date(p.t))+'</small></div><div class="acts"><button class="p" data-a="approve" data-did="'+esc(p.did)+'">قبول</button><button class="d" data-a="reject" data-did="'+esc(p.did)+'">رفض</button></div></div>'}).join(""):'<div class="empty">لا توجد طلبات حالياً.</div>';
var q=$("q").value.trim();var list=d.students.filter(function(s){return!q||(s.n||"").indexOf(q)>-1||String(s.g).indexOf(q)>-1});
$("students").innerHTML=list.length?list.slice(0,200).map(function(s){return'<div class="card"><div class="info"><b>'+esc(s.n)+'</b><small>'+(s.g?"الفوج "+esc(s.g)+" · ":"")+esc(date(s.t))+' '+(s.src==="manual"?'<span class="tag w">بموافقة يدوية</span>':"")+(s.banned?' <span class="tag b">محظور</span>':"")+'</small></div><div class="acts">'+(s.banned?'<button data-a="unban" data-uid="'+esc(s.uid)+'">رفع الحظر</button>':'<button data-a="reset_device" data-uid="'+esc(s.uid)+'">تهيئة الجهاز</button><button class="d" data-a="ban" data-uid="'+esc(s.uid)+'">حظر</button>')+'</div></div>'}).join(""):'<div class="empty">لا نتائج.</div>'
}
function load(){$("err").textContent="";return api("GET").then(function(j){data=j;try{sessionStorage.setItem("acc_code",code)}catch(e){}render()}).catch(function(){$("app").hidden=true;$("err").textContent="تعذّر التحقق من الرمز أو أن النظام غير مهيأ."})}
$("go").onclick=function(){code=$("code").value.trim();if(code)load()};
$("q").oninput=function(){if(data)render()};
document.addEventListener("click",function(e){var b=e.target.closest("button[data-a]");if(!b)return;var a=b.dataset.a;
if((a==="ban"||a==="reject")&&!confirm(a==="ban"?"حظر هذا الطالب؟":"رفض هذا الطلب؟"))return;
b.disabled=true;api("POST",{action:a,did:b.dataset.did,uid:b.dataset.uid}).then(load).catch(function(){b.disabled=false;$("err").textContent="تعذّر تنفيذ العملية."})});
if(code)load();
})();
</script></body></html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    /* --- مسارات الدخول (مفتوحة) --- */
    if (path === "/api/auth/login") return authLogin(request, env);
    if (path === "/api/auth/status") return authStatus(request, env);
    if (path === "/api/auth/admin") return authAdmin(request, env);
    if (path === "/__login") return htmlResponse(LOGIN_PAGE);
    if (path === "/access-admin") return htmlResponse(ACCESS_ADMIN_PAGE);

    /* --- مسارات لها فحص إدارة خاص بها --- */
    if (path === "/api/publish") return handlePublish(request, env);
    if (path === "/api/history") return handleHistory(request, env);

    /* --- البوابة: كل ما عدا ذلك يتطلب جلسة صالحة --- */
    if (!AUTH_OPEN_PATHS.has(path) && path !== "/sw.js" && !/^\/icon-\d+\.png$/.test(path)) {
      if (!authReady(env)) {
        return htmlResponse("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><body dir=rtl style='font-family:sans-serif;padding:40px;text-align:center'><h2>المنصة قيد الإعداد</h2><p>يرجى المحاولة لاحقاً.</p>", 503);
      }
      const session = await readSession(request, env);
      if (!session) {
        const wantsHtml = request.headers.get("sec-fetch-mode") === "navigate" ||
          String(request.headers.get("accept") || "").includes("text/html");
        if (wantsHtml) return htmlResponse(LOGIN_PAGE);
        return json({ error: "auth_required" }, 401);
      }
    }

    if (path === "/api/lessons" || path === "/api/file" || path === "/api/academic" || path === "/api/academic-image" || path === "/api/resources" || path === "/api/resource" || path === "/api/announcements") {
      const response = await handleApi(request, env);
      if (request.method !== "GET" && request.method !== "HEAD" && response.status >= 200 && response.status < 300 && PUBLISH_PATHS.has(path)) schedulePublish(ctx, env);
      return response;
    }
    const response = await env.ASSETS.fetch(request);
    if ((path === "/" || path === "/index.html") &&
        (response.headers.get("content-type") || "").includes("text/html")) {
      return new HTMLRewriter()
        .on("head", {
          element(element) {
            element.prepend("<script>" + GUARD_SNIPPET + "</script>", { html: true });
          }
        })
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
