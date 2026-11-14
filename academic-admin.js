(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const clean = (value) => String(value || "").trim().replace(/[<>"'`]/g, "").slice(0, 180);
  const id = () => "a-" + crypto.randomUUID();
  const option = (select, items, selected, label) => {
    if (!select) return;
    select.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = label || "لا توجد عناصر";
      select.append(empty);
      return;
    }
    items.forEach((item, index) => {
      const el = document.createElement("option");
      el.value = item.id;
      el.textContent = item.name;
      select.append(el);
    });
    if (items.some(item => item.id === selected)) select.value = selected;
  };
  const safePrompt = (message, value = "") => {
    const result = window.prompt(message, value);
    return result === null ? null : clean(result);
  };
  const defaultConfig = () => ({
    version: 1,
    groups: [],
    years: [{
      id: "year-2", name: "السنة الثانية",
      semesters: [{
        id: "semester-1", name: "السداسي الأول",
        subjects: (window.__academicBridge?.getSubjects?.() || []).map((subject, si) => ({
          id: "subject-" + (si + 1), name: subject.name, symbol: subject.symbol || "م", programImage: subject.programImage || "",
          axes: (subject.axes || []).map((axis, ai) => ({
            id: "axis-" + (si + 1) + "-" + (ai + 1), name: axis.name,
            chapters: (axis.chapters || []).map((chapter, ci) => ({
              id: "chapter-" + (si + 1) + "-" + (ai + 1) + "-" + (ci + 1),
              name: chapter[0], topics: Array.isArray(chapter[1]) ? chapter[1].slice() : []
            }))
          }))
        }))
      }]
    }]
  });
  let config = null, dirty = false, adminCode = "";
  let activeYearId = "year-2", activeSemesterId = "semester-1";
  const year = () => config?.years.find(item => item.id === $("academicEditYear")?.value || item.id === activeYearId);
  const selectedYear = () => config?.years.find(item => item.id === activeYearId) || config?.years[0];
  const selectedSemester = () => selectedYear()?.semesters.find(item => item.id === activeSemesterId) || selectedYear()?.semesters[0];
  const editYear = () => config?.years.find(item => item.id === $("academicEditYear")?.value);
  const editSemester = () => editYear()?.semesters.find(item => item.id === $("academicEditSemester")?.value);
  const editSubject = () => editSemester()?.subjects.find(item => item.id === $("academicEditSubject")?.value);
  const editAxis = () => editSubject()?.axes.find(item => item.id === $("academicEditAxis")?.value);
  const editChapter = () => editAxis()?.chapters.find(item => item.id === $("academicEditChapter")?.value);
  const topicIndex = () => Number($("academicEditTopic")?.value ?? -1);
  function markDirty() {
    dirty = true;
    if ($("academicSaveStatus")) $("academicSaveStatus").textContent = "توجد تغييرات غير محفوظة.";
  }
  function applyCurrent() {
    const sem = selectedSemester(), yr = selectedYear();
    if (!sem || !yr) return;
    const ordinal = (value, words, fallback) => {
      const digit = String(value).match(/[1-6]/);
      if (digit) return Number(digit[0]);
      const text = String(value);
      const index = words.findIndex(word => text.includes(word));
      return index >= 0 ? index + 1 : fallback;
    };
    const yearNumber = ordinal(yr.name, ["الأولى","الثانية","الثالثة","الرابعة","الخامسة","السادسة"], 2);
    const semesterNumber = ordinal(sem.name, ["الأول","الثاني","الثالث","الرابع"], 1);
    window.__academicBridge?.setContext(yearNumber, semesterNumber);
    const subjects = sem.subjects || [];
    window.__academicBridge?.setSubjects(subjects.map(subject => ({
      name: subject.name, symbol: subject.symbol || "م", programImage: subject.programImage || "",
      axes: (subject.axes || []).map(axis => ({
        name: axis.name,
        chapters: (axis.chapters || []).map(chapter => [chapter.name, (chapter.topics || []).slice()])
      }))
    })));
    window.__academicBridge?.setLessonSubjects(subjects.map(subject => subject.name));
    const code = $("academicSemesterSelect");
    if (code) option(code, yr.semesters, activeSemesterId, "لا توجد سداسيات");
  }
  function refreshPublicSelectors() {
    const yr = selectedYear();
    option($("academicYearSelect"), config.years, activeYearId);
    if (!yr) return;
    if (!yr.semesters.some(item => item.id === activeSemesterId)) activeSemesterId = yr.semesters[0]?.id || "";
    option($("academicSemesterSelect"), yr.semesters, activeSemesterId);
  }
  function ensureProgramImageEditor() {
    let host = $("academicProgramImageEditor");
    if (host) return host;
    host = document.createElement("section");
    host.id = "academicProgramImageEditor";
    host.className = "academic-program-image-editor";
    host.innerHTML = '<div class="academic-program-image-copy"><b>صورة برنامج المقياس</b><small>ارفع صورة البرنامج للمقياس المختار. تظهر للطلبة قبل المحور الأول.</small></div><input id="academicProgramImageFile" type="file" accept="image/png,image/jpeg,image/webp"><div class="academic-program-image-preview" id="academicProgramImagePreview"></div><button type="button" id="academicProgramImageRemove" class="academic-program-image-remove">إزالة الصورة</button><span id="academicProgramImageStatus" role="status"></span>';
    $("academicEditSubject")?.closest(".academic-select-grid")?.insertAdjacentElement("afterend", host);
    $("academicProgramImageFile")?.addEventListener("change", uploadProgramImage);
    $("academicProgramImageRemove")?.addEventListener("click", () => {
      const subject = editSubject();
      if (!subject?.programImage) return;
      subject.programImage = "";
      markDirty();
      renderProgramImageEditor();
    });
    return host;
  }
  function renderProgramImageEditor() {
    const host = ensureProgramImageEditor();
    if (!host) return;
    const subject = editSubject();
    const preview = $("academicProgramImagePreview");
    const remove = $("academicProgramImageRemove");
    const input = $("academicProgramImageFile");
    const status = $("academicProgramImageStatus");
    if (input) input.disabled = !subject;
    if (remove) remove.hidden = !subject?.programImage;
    if (status && !status.dataset.busy) status.textContent = subject ? "" : "اختر مقياسًا أولًا.";
    if (preview) {
      preview.replaceChildren();
      if (subject?.programImage) {
        const img = document.createElement("img");
        img.src = subject.programImage;
        img.alt = "معاينة صورة برنامج " + subject.name;
        preview.append(img);
      } else {
        const empty = document.createElement("span");
        empty.textContent = "لم تُرفع صورة لهذا المقياس بعد.";
        preview.append(empty);
      }
    }
  }
  async function uploadProgramImage(event) {
    const file = event.target.files?.[0];
    const subject = editSubject();
    const status = $("academicProgramImageStatus");
    if (!file || !subject) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      status.textContent = "اختر صورة بصيغة PNG أو JPG أو WEBP.";
      event.target.value = "";
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      status.textContent = "حجم الصورة كبير؛ الحد الأقصى 8 ميغابايت.";
      event.target.value = "";
      return;
    }
    status.dataset.busy = "1";
    status.textContent = "جارٍ رفع الصورة...";
    event.target.disabled = true;
    try {
      const response = await fetch("/api/academic-image", {
        method: "POST",
        headers: { "content-type": file.type, "x-academic-admin-code": adminCode },
        body: file
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.url) throw new Error(result.error || "upload_failed");
      subject.programImage = result.url;
      markDirty();
      status.textContent = "تم رفع الصورة. اضغط «حفظ التغييرات» لنشرها.";
      renderProgramImageEditor();
      status.textContent = "تم رفع الصورة. اضغط «حفظ التغييرات» لنشرها.";
    } catch (error) {
      status.textContent = error.message === "unauthorized" ? "انتهت صلاحية الدخول؛ سجّل الدخول مجددًا." : "تعذر رفع الصورة. تحقق من التخزين وحاول مجددًا.";
    } finally {
      delete status.dataset.busy;
      event.target.disabled = false;
      event.target.value = "";
    }
  }
  function refreshEditorSelectors() {
    const y = editYear() || config.years[0];
    if (!y) return;
    option($("academicEditYear"), config.years, y.id);
    option($("academicEditSemester"), y.semesters, editSemester()?.id);
    const s = editSemester();
    option($("academicEditSubject"), s?.subjects || [], editSubject()?.id, "أضف مقياسًا أولًا");
    const sub = editSubject();
    option($("academicEditAxis"), sub?.axes || [], editAxis()?.id, "أضف محورًا أولًا");
    const ax = editAxis();
    option($("academicEditChapter"), ax?.chapters || [], editChapter()?.id, "أضف درسًا أولًا");
    const ch = editChapter();
    const topics = (ch?.topics || []).map((name, index) => ({ id: String(index), name }));
    option($("academicEditTopic"), topics, String(topicIndex()), "لا توجد موضوعات");
    renderProgramImageEditor();
  }
  function refreshAll() {
    refreshPublicSelectors();
    refreshEditorSelectors();
    applyCurrent();
  }
  async function checkAdmin(code) {
    const response = await fetch("/api/academic", {
      method: "POST", headers: { "x-academic-admin-code": code },
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, error: result.error || "" };
  }
  async function login(code) {
    const status = $("academicAdminLoginStatus");
    if (!code) { status.textContent = "أدخل رمز الإدارة."; return; }
    status.textContent = "جارٍ التحقق...";
    try {
      const result = await checkAdmin(code);
      if (!result.ok) {
        const messages = {
          401: "الرمز غير مطابق للرمز المحفوظ في Worker (ADMIN_CODE_MOD).",
          503: "إعدادات التخزين أو إعداد Worker غير مكتملة؛ تحقق من نشر Worker وإعداداته.",
          404: "مسار التحقق غير موجود في نسخة Worker المنشورة. أعد نشر آخر نسخة.",
        };
        status.textContent = messages[result.status] || ("فشل التحقق (HTTP " + result.status + "). " + (result.error || "تحقق من نشر Worker."));
        try { sessionStorage.removeItem("ensd_arabic_admin_mod_code"); } catch {}
        return;
      }
      adminCode = code;
      try { sessionStorage.setItem("ensd_arabic_admin_mod_code", code); } catch {}
      $("academicEditor").hidden = false;
      status.textContent = "تم تسجيل الدخول.";
      refreshEditorSelectors();
    } catch {
      status.textContent = "تعذر الاتصال. تحقق من اتصال الإنترنت وحاول مجددًا.";
    }
  }
  function addOrEdit(kind, editing) {
    const names = {
      year: ["السنة الجامعية", editYear()?.name],
      semester: ["السداسي", editSemester()?.name],
      subject: ["اسم المقياس", editSubject()?.name],
      axis: ["اسم المحور", editAxis()?.name],
      chapter: ["اسم الدرس أو الوحدة", editChapter()?.name],
      topic: ["اسم الموضوع", editChapter()?.topics?.[topicIndex()]]
    };
    const [label, current] = names[kind];
    if (editing && (kind !== "year" || !editYear()) && !({
      semester: editSemester(), subject: editSubject(), axis: editAxis(), chapter: editChapter(), topic: editChapter()?.topics?.[topicIndex()] !== undefined
    })[kind]) return;
    const value = safePrompt(label, editing ? current : "");
    if (!value) return;
    if (kind === "year") {
      if (editing) editYear().name = value;
      else { const item = { id: id(), name: value, semesters: [] }; config.years.push(item); $("academicEditYear").value = item.id; activeYearId = item.id; }
    } else if (kind === "semester") {
      const y = editYear(); if (!y) return;
      if (editing) editSemester().name = value;
      else { const item = { id: id(), name: value, subjects: [] }; y.semesters.push(item); $("academicEditSemester").value = item.id; activeSemesterId = item.id; }
    } else if (kind === "subject") {
      const s = editSemester(); if (!s) return;
      if (editing) {
        const sub = editSubject(); sub.name = value;
        const symbol = safePrompt("رمز مختصر للمقياس", sub.symbol || "م");
        if (symbol) sub.symbol = symbol.slice(0, 8);
      } else {
        const symbol = safePrompt("رمز مختصر للمقياس", value.slice(0, 1)) || value.slice(0, 1);
        const item = { id: id(), name: value, symbol: symbol.slice(0, 8), axes: [] };
        s.subjects.push(item); $("academicEditSubject").value = item.id;
      }
    } else if (kind === "axis") {
      const sub = editSubject(); if (!sub) return;
      if (editing) editAxis().name = value;
      else { const item = { id: id(), name: value, chapters: [] }; sub.axes.push(item); $("academicEditAxis").value = item.id; }
    } else if (kind === "chapter") {
      const ax = editAxis(); if (!ax) return;
      if (editing) editChapter().name = value;
      else { const item = { id: id(), name: value, topics: [] }; ax.chapters.push(item); $("academicEditChapter").value = item.id; }
    } else if (kind === "topic") {
      const ch = editChapter(); if (!ch) return;
      if (editing) ch.topics[topicIndex()] = value;
      else { ch.topics.push(value); $("academicEditTopic").value = String(ch.topics.length - 1); }
    }
    markDirty(); refreshAll();
  }
  function remove(kind) {
    const map = {
      year: [config.years, editYear()],
      semester: [editYear()?.semesters, editSemester()],
      subject: [editSemester()?.subjects, editSubject()],
      axis: [editSubject()?.axes, editAxis()],
      chapter: [editAxis()?.chapters, editChapter()],
      topic: [editChapter()?.topics, editChapter()?.topics?.[topicIndex()]]
    };
    const [list, item] = map[kind] || [];
    if (!list || item === undefined || item === null) return;
    if (kind === "year" && list.length <= 1) { alert("يجب الاحتفاظ بسنة واحدة على الأقل."); return; }
    const label = typeof item === "string" ? item : item.name;
    if (!confirm("هل تريد حذف «" + label + "»؟")) return;
    const index = typeof item === "string" ? topicIndex() : list.indexOf(item);
    list.splice(index, 1);
    if (kind === "year") { activeYearId = config.years[0]?.id || ""; activeSemesterId = config.years[0]?.semesters[0]?.id || ""; }
    markDirty(); refreshAll();
  }
  async function save() {
    const button = $("academicSave"), status = $("academicSaveStatus");
    if (!adminCode) { status.textContent = "سجّل الدخول أولًا."; return; }
    if (!config.years.length) { status.textContent = "أضف سنة جامعية أولًا."; return; }
    button.disabled = true; status.textContent = "جارٍ حفظ البرنامج...";
    try {
      const response = await fetch("/api/academic", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-academic-admin-code": adminCode },
        body: JSON.stringify(config)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "save_failed");
      dirty = false; status.textContent = "تم حفظ البرنامج الأكاديمي بنجاح.";
    } catch (error) {
      status.textContent = error.message === "unauthorized" ? "انتهت صلاحية الدخول؛ سجّل الدخول مجددًا." : "تعذر الحفظ. تحقق من إعداد التخزين ثم حاول مجددًا.";
    } finally { button.disabled = false; }
  }
  async function init() {
    try {
      config = defaultConfig();
      const response = await fetch("/api/academic", { cache: "no-store" });
      if (response.ok) {
        const result = await response.json();
        if (result.config?.years?.length) config = result.config;
      }
    } catch {}
    refreshAll();
    ensureProgramImageEditor();
    renderProgramImageEditor();
    $("academicYearSelect")?.addEventListener("change", event => {
      activeYearId = event.target.value; activeSemesterId = selectedYear()?.semesters[0]?.id || ""; refreshAll();
    });
    $("academicSemesterSelect")?.addEventListener("change", event => {
      activeSemesterId = event.target.value; refreshAll();
    });
    $("academicEditYear")?.addEventListener("change", refreshEditorSelectors);
    $("academicEditSemester")?.addEventListener("change", refreshEditorSelectors);
    $("academicEditSubject")?.addEventListener("change", refreshEditorSelectors);
    $("academicEditAxis")?.addEventListener("change", refreshEditorSelectors);
    $("academicEditChapter")?.addEventListener("change", refreshEditorSelectors);
    $("academicAdminEnter")?.addEventListener("click", () => login($("academicAdminCode").value.trim()));
    $("academicAdminCode")?.addEventListener("keydown", event => { if (event.key === "Enter") login(event.target.value.trim()); });
    $("academicSave")?.addEventListener("click", save);
    $("academicAdmin")?.addEventListener("toggle", async () => {
      if (!$("academicAdmin").open || adminCode) return;
      try {
        const stored = sessionStorage.getItem("ensd_arabic_admin_mod_code") || "";
        if (stored && await checkAdmin(stored)) {
          adminCode = stored; $("academicEditor").hidden = false; $("academicAdminLoginStatus").textContent = "تم التحقق من جلسة الإدارة."; refreshEditorSelectors();
        }
      } catch {}
    });
    $("academicAdmin")?.querySelectorAll("[data-academic-action]").forEach(button => {
      button.addEventListener("click", () => {
        if (!adminCode) { $("academicAdminLoginStatus").textContent = "سجّل الدخول أولًا."; return; }
        const [action, kind] = button.dataset.academicAction.split("-");
        if (action === "add") addOrEdit(kind, false);
        else if (action === "edit") addOrEdit(kind, true);
        else if (action === "delete") remove(kind);
      });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();