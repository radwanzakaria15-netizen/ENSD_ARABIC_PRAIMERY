/* ui-native-replace.js
   يستبدل نوافذ المتصفح الأصلية بنوافذ مصممة:
   1) القوائم المنسدلة <select>  ->  ورقة اختيار سفلية (Bottom Sheet)
   2) زر «اختيار ملف»           ->  زر مصمم مع اسم الملف
   3) window.uiPrompt(...)       ->  بديل مصمم لـ prompt() (يعيد Promise)
*/
(() => {
  "use strict";
  if (window.__uxNativeReplace) return;
  window.__uxNativeReplace = true;

  /* ---------- الأنماط ---------- */
  const css = `
.ux-sel-trigger{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:42px;padding:9px 12px;border:1px solid var(--line,#e1e9e4);border-radius:12px;background:var(--surface,#fbfdfb);color:var(--ink,#26372e);font:inherit;font-size:13px;font-weight:800;text-align:start;cursor:pointer;transition:border-color .15s,box-shadow .15s}
.ux-sel-trigger:active{transform:scale(.99)}
.ux-sel-trigger:focus-visible,.ux-sel-trigger.is-open{outline:none;border-color:var(--primary,#287c78);box-shadow:0 0 0 3px rgba(40,124,120,.15)}
.ux-sel-trigger[disabled]{opacity:.55;cursor:not-allowed}
.ux-sel-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ux-sel-value.is-placeholder{color:var(--muted,#66737f);font-weight:600}
.ux-sel-arrow{flex:none;width:9px;height:9px;border-inline-end:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg) translateY(-2px);opacity:.6;transition:transform .2s}
.ux-sel-trigger.is-open .ux-sel-arrow{transform:rotate(-135deg) translateY(-2px)}
.ux-native-hidden{position:absolute!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;overflow:hidden!important;clip:rect(0 0 0 0)!important}

.ux-ov{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:flex-end;justify-content:center;background:rgba(14,24,19,.5);opacity:0;transition:opacity .2s ease;font-family:inherit;direction:rtl}
.ux-ov.is-in{opacity:1}
.ux-sheet{width:100%;max-width:520px;max-height:78dvh;display:flex;flex-direction:column;background:var(--surface,#fff);color:var(--ink,#1e2935);border-radius:24px 24px 0 0;padding:10px 0 max(14px,env(safe-area-inset-bottom));box-shadow:0 -18px 60px rgba(8,25,18,.25);transform:translateY(40px);transition:transform .25s cubic-bezier(.22,.8,.3,1)}
.ux-ov.is-in .ux-sheet{transform:none}
.ux-grab{width:42px;height:4px;border-radius:4px;background:var(--line,#d9e0dd);margin:0 auto 10px;flex:none}
.ux-sheet h3{margin:0;padding:2px 20px 10px;font-size:15px;font-weight:850;color:var(--ink,#263b32);flex:none}
.ux-list{overflow:auto;padding:0 12px;display:grid;gap:4px;overscroll-behavior:contain}
.ux-opt{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-height:48px;padding:11px 14px;border:0;border-radius:14px;background:transparent;color:inherit;font:inherit;font-size:14px;font-weight:700;text-align:start;cursor:pointer}
.ux-opt:hover,.ux-opt:focus-visible{background:var(--soft,#e8f3f1);outline:none}
.ux-opt.is-sel{background:var(--soft,#e8f3f1);color:var(--primary-dark,#1e6562);font-weight:850}
.ux-opt[disabled]{opacity:.4;cursor:not-allowed}
.ux-opt .ux-tick{flex:none;width:22px;height:22px;border-radius:50%;border:2px solid var(--line,#cfd8d4);display:grid;place-items:center;font-size:13px;color:#fff;line-height:1}
.ux-opt.is-sel .ux-tick{background:var(--primary,#287c78);border-color:var(--primary,#287c78)}
.ux-opt.is-sel .ux-tick::before{content:"✓"}
.ux-empty{padding:22px;text-align:center;color:var(--muted,#7c8982);font-size:13px}

.ux-modal{width:calc(100% - 36px);max-width:360px;margin:auto;border-radius:24px;padding:22px 18px 18px;background:var(--surface,#fff);color:var(--ink,#263b32);text-align:center;box-shadow:0 24px 75px rgba(8,25,18,.28);transform:scale(.95);transition:transform .2s ease}
.ux-ov.is-in .ux-modal{transform:none}
.ux-ov.ux-center{align-items:center}
.ux-modal-icon{width:54px;height:54px;margin:0 auto 12px;border-radius:18px;display:grid;place-items:center;background:var(--soft,#e9f5ed);color:var(--primary,#25834c);font-size:26px;font-weight:800}
.ux-modal h3{margin:0 0 6px;font-size:16px;font-weight:850}
.ux-modal p{margin:0 0 12px;color:var(--muted,#7c8982);font-size:12px;line-height:1.8}
.ux-input{width:100%;box-sizing:border-box;min-height:46px;padding:10px 14px;border:1.5px solid var(--line,#dbe4df);border-radius:14px;background:var(--bg,#f6faf8);color:var(--ink,#1e2935);font:inherit;font-size:15px;text-align:start;outline:none;transition:border-color .15s,box-shadow .15s}
.ux-input:focus{border-color:var(--primary,#287c78);box-shadow:0 0 0 3px rgba(40,124,120,.15)}
.ux-input.is-bad{border-color:#c94c45;box-shadow:0 0 0 3px rgba(201,76,69,.14)}
.ux-err{min-height:18px;margin:6px 2px 0;color:#c94c45;font-size:11.5px;font-weight:700;text-align:start}
.ux-actions{display:flex;gap:9px;margin-top:12px}
.ux-actions button{flex:1;min-height:44px;border:0;border-radius:12px;font:inherit;font-size:13px;font-weight:800;cursor:pointer}
.ux-ok{background:var(--primary,#287c55);color:#fff}
.ux-cancel{background:var(--surface-2,#f0f2f1);color:var(--muted,#647169)}

.ux-file{display:flex;align-items:center;gap:10px;flex-wrap:wrap;width:100%;box-sizing:border-box;padding:8px;border:1.5px dashed var(--line,#cfd9d4);border-radius:14px;background:var(--surface,#fbfdfb)}
.ux-file-btn{flex:none;display:inline-flex;align-items:center;gap:6px;min-height:38px;padding:8px 14px;border:0;border-radius:11px;background:var(--soft,#e8f3f1);color:var(--primary-dark,#1e6562);font:inherit;font-size:13px;font-weight:850;cursor:pointer}
.ux-file-btn::before{content:"＋";font-size:15px}
.ux-file-btn:active{transform:scale(.97)}
.ux-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted,#7c8982);font-size:12.5px}
.ux-file.has-file .ux-file-name{color:var(--ink,#26372e);font-weight:800}

html[data-theme=dark] .ux-ov{background:rgba(0,0,0,.62)}
html[data-theme=dark] .ux-sheet,html[data-theme=dark] .ux-modal{background:var(--surface,#1a1f1d);color:var(--ink,#c5d7cd)}
html[data-theme=dark] .ux-opt:hover,html[data-theme=dark] .ux-opt:focus-visible,html[data-theme=dark] .ux-opt.is-sel{background:rgba(40,124,120,.22)}
html[data-theme=dark] .ux-opt.is-sel{color:#8fe0d9}
html[data-theme=dark] .ux-input{background:var(--bg,#121614);color:var(--ink,#c5d7cd)}
html[data-theme=dark] .ux-cancel{background:#232826;color:#9ea9a3}
@media(min-width:700px){.ux-ov:not(.ux-center){align-items:center}.ux-sheet{border-radius:24px;transform:scale(.96)}}
@media(prefers-reduced-motion:reduce){.ux-ov,.ux-sheet,.ux-modal{transition:none!important}}
`;
  const st = document.createElement("style");
  st.id = "ux-native-replace-css";
  st.textContent = css;
  document.head.appendChild(st);

  /* ---------- أدوات ---------- */
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };
  let openCount = 0;
  const lockScroll = (on) => {
    openCount += on ? 1 : -1;
    document.documentElement.style.overflow = openCount > 0 ? "hidden" : "";
  };
  /* يبني طبقة عائمة ويعيد دالة إغلاق */
  function mountOverlay(content, { center = false, onClose } = {}) {
    const ov = el("div", "ux-ov" + (center ? " ux-center" : ""));
    ov.appendChild(content);
    document.body.appendChild(ov);
    lockScroll(true);
    requestAnimationFrame(() => ov.classList.add("is-in"));
    let closed = false;
    const close = (reason) => {
      if (closed) return;
      closed = true;
      ov.classList.remove("is-in");
      document.removeEventListener("keydown", onKey, true);
      lockScroll(false);
      setTimeout(() => ov.remove(), 220);
      onClose && onClose(reason);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close("cancel"); }
    };
    document.addEventListener("keydown", onKey, true);
    ov.addEventListener("pointerdown", (e) => { if (e.target === ov) close("cancel"); });
    return { ov, close };
  }

  /* ---------- 1) القوائم المنسدلة ---------- */
  const enhanced = new Set();
  const selectTitle = (sel) => {
    const aria = sel.getAttribute("aria-label");
    if (aria) return aria;
    const lab = sel.closest("label");
    if (lab) {
      let t = "";
      lab.childNodes.forEach((n) => { if (n.nodeType === 3) t += n.textContent; });
      t = t.trim();
      if (t) return t;
    }
    if (sel.id) {
      const f = document.querySelector('label[for="' + sel.id + '"]');
      if (f) return f.textContent.trim();
    }
    const prev = sel.previousElementSibling;
    if (prev && /^(LABEL|SPAN|B|STRONG|SMALL)$/.test(prev.tagName)) return prev.textContent.trim();
    return "اختر";
  };

  function openSheet(sel, trigger) {
    const sheet = el("section", "ux-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.append(el("div", "ux-grab"), el("h3", "", selectTitle(sel)));
    const list = el("div", "ux-list");
    list.setAttribute("role", "listbox");
    const opts = Array.from(sel.options);
    if (!opts.length) list.appendChild(el("div", "ux-empty", "لا توجد خيارات"));
    let selectedBtn = null;
    const { close } = mountOverlay(sheet, {
      onClose: () => { trigger.classList.remove("is-open"); trigger.setAttribute("aria-expanded", "false"); trigger.focus({ preventScroll: true }); }
    });
    opts.forEach((o) => {
      const b = el("button", "ux-opt");
      b.type = "button";
      b.setAttribute("role", "option");
      b.disabled = o.disabled;
      b.append(el("span", "", o.text), el("span", "ux-tick"));
      const yes = o.value === sel.value && o.index === sel.selectedIndex;
      b.classList.toggle("is-sel", yes);
      b.setAttribute("aria-selected", String(yes));
      if (yes) selectedBtn = b;
      b.addEventListener("click", () => {
        if (sel.selectedIndex !== o.index) {
          sel.selectedIndex = o.index;
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        syncSelect(sel);
        close("pick");
      });
      list.appendChild(b);
    });
    sheet.appendChild(list);
    trigger.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    setTimeout(() => (selectedBtn || list.querySelector(".ux-opt:not([disabled])"))?.focus({ preventScroll: false }), 60);
  }

  function syncSelect(sel) {
    const t = sel._uxTrigger;
    if (!t) return;
    const o = sel.options[sel.selectedIndex];
    const txt = o ? o.text : (sel.getAttribute("aria-label") || "اختر");
    const v = t.querySelector(".ux-sel-value");
    if (v.textContent !== txt) v.textContent = txt;
    v.classList.toggle("is-placeholder", !sel.value);
    if (t.disabled !== sel.disabled) t.disabled = sel.disabled;
    /* إخفاء الزر إن كان الـ select نفسه مخفيًا */
    const hide = sel.hidden || sel.style.display === "none";
    if (t.hidden !== hide) t.hidden = hide;
  }

  function enhanceSelect(sel) {
    if (sel._uxTrigger || sel.multiple || sel.size > 1 || sel.dataset.native === "1") return;
    if (sel.classList.contains("resource-native-select") || sel.dataset.customReady) return; /* مغلّفة بقائمة مخصصة سابقة */
    const t = el("button", "ux-sel-trigger");
    t.type = "button";
    t.setAttribute("aria-haspopup", "listbox");
    t.setAttribute("aria-expanded", "false");
    t.append(el("span", "ux-sel-value"), el("span", "ux-sel-arrow"));
    sel.parentNode.insertBefore(t, sel);
    sel.classList.add("ux-native-hidden");
    sel.tabIndex = -1;
    sel.setAttribute("aria-hidden", "true");
    sel._uxTrigger = t;
    enhanced.add(sel);
    t.addEventListener("click", () => { if (!sel.disabled) openSheet(sel, t); });
    sel.addEventListener("change", () => syncSelect(sel));
    new MutationObserver(() => syncSelect(sel)).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "hidden", "style"] });
    syncSelect(sel);
  }

  /* ---------- 2) اختيار الملفات ---------- */
  const fileState = new Set();
  function shouldSkipFile(inp) {
    if (inp._uxFile || inp.hidden || inp.dataset.native === "1") return true;
    if (inp.closest(".lesson-upload-control,.lesson-file-actions")) return true; /* أزرار مخصصة بالفعل */
    const cs = getComputedStyle(inp);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return true;
    if (inp.style.display === "none") return true;
    return false;
  }
  function fileLabel(inp) {
    const f = inp.files;
    if (!f || !f.length) return "";
    return f.length === 1 ? f[0].name : f.length + " ملفات";
  }
  function syncFile(inp) {
    const box = inp._uxFile;
    if (!box) return;
    const name = fileLabel(inp);
    const n = box.querySelector(".ux-file-name");
    const txt = name || "لم يتم اختيار أي ملف";
    if (n.textContent !== txt) n.textContent = txt;
    box.classList.toggle("has-file", !!name);
    const btn = box.querySelector(".ux-file-btn");
    btn.disabled = inp.disabled;
  }
  function enhanceFile(inp) {
    if (shouldSkipFile(inp)) return;
    const box = el("div", "ux-file");
    const btn = el("button", "ux-file-btn", inp.multiple ? "اختيار ملفات" : "اختيار ملف");
    btn.type = "button";
    const name = el("span", "ux-file-name");
    box.append(btn, name);
    inp.parentNode.insertBefore(box, inp);
    box.appendChild(inp); /* يبقى الـ input داخل الصندوق ليعمل كما هو */
    inp.classList.add("ux-native-hidden");
    inp.tabIndex = -1;
    inp._uxFile = box;
    fileState.add(inp);
    btn.addEventListener("click", () => inp.click());
    inp.addEventListener("change", () => syncFile(inp));
    syncFile(inp);
  }

  /* ---------- 3) بديل prompt() ---------- */
  /* الاستخدام: const name = await uiPrompt({title:"إضافة مقياس", label:"اسم المقياس", value:"", placeholder:"..."});
     يعيد النص أو null عند الإلغاء. */
  window.uiPrompt = function uiPrompt(opts = {}) {
    return new Promise((resolve) => {
      const box = el("section", "ux-modal");
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      box.append(
        el("div", "ux-modal-icon", opts.icon || "✎"),
        el("h3", "", opts.title || "إدخال")
      );
      if (opts.label) box.appendChild(el("p", "", opts.label));
      const input = el("input", "ux-input");
      input.type = "text";
      input.value = opts.value == null ? "" : String(opts.value);
      input.placeholder = opts.placeholder || "";
      if (opts.maxLength) input.maxLength = opts.maxLength;
      input.setAttribute("aria-label", opts.label || opts.title || "إدخال");
      input.autocomplete = "off";
      const err = el("div", "ux-err");
      const acts = el("div", "ux-actions");
      const ok = el("button", "ux-ok", opts.confirmText || "حسنًا");
      const cancel = el("button", "ux-cancel", opts.cancelText || "إلغاء");
      ok.type = cancel.type = "button";
      acts.append(ok, cancel);
      box.append(input, err, acts);
      let done = false;
      const finish = (val) => { if (done) return; done = true; resolve(val); };
      const { close } = mountOverlay(box, { center: true, onClose: () => finish(null) });
      const submit = () => {
        const v = input.value.trim();
        let msg = "";
        if (!v && !opts.allowEmpty) msg = opts.emptyMessage || "هذا الحقل مطلوب.";
        else if (typeof opts.validate === "function") msg = opts.validate(v) || "";
        if (msg) { err.textContent = msg; input.classList.add("is-bad"); input.focus(); return; }
        finish(v);
        close("ok");
      };
      ok.addEventListener("click", submit);
      cancel.addEventListener("click", () => close("cancel"));
      input.addEventListener("input", () => { err.textContent = ""; input.classList.remove("is-bad"); });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
      setTimeout(() => { input.focus(); input.select(); }, 80);
    });
  };

  /* ---------- التشغيل والمراقبة ---------- */
  function scan(root) {
    (root.querySelectorAll ? root : document).querySelectorAll("select").forEach(enhanceSelect);
    (root.querySelectorAll ? root : document).querySelectorAll('input[type="file"]').forEach(enhanceFile);
  }
  scan(document);
  new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        if (n.matches?.("select")) enhanceSelect(n);
        if (n.matches?.('input[type="file"]')) enhanceFile(n);
        if (n.querySelectorAll) scan(n);
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  /* مزامنة خفيفة للقيم التي تُغيَّر برمجيًا بدون حدث change */
  setInterval(() => {
    enhanced.forEach((s) => { if (!s.isConnected) { enhanced.delete(s); s._uxTrigger?.remove(); return; } syncSelect(s); });
    fileState.forEach((i) => { if (!i.isConnected) { fileState.delete(i); return; } syncFile(i); });
  }, 400);
})();
