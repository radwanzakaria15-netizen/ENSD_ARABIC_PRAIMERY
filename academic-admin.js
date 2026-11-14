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
  function ensureScheduleEditor() {
    if ($("academicScheduleEditor")) return $("academicScheduleEditor");
    const host = document.createElement("section");
    host.id = "academicScheduleEditor";
    host.style.cssText = "margin:22px 0;padding:18px;border:1px solid #d9e2dc;border-radius:16px;background:#f7faf8;color:#26352d";
    host.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><div><b style="font-size:17px">إدارة المجموعات والتوقيت</b><div style="font-size:13px;color:#66756b;margin-top:5px">أضف المجموعات والأفواج وارفع صورة توقيت مستقلة لكل فوج.</div></div><button type="button" id="academicAddGroup" class="academic-action-button">إضافة مجموعة</button></div><div id="academicGroupsList" style="display:grid;gap:12px;margin-top:15px"></div><div id="academicGroupsStatus" role="status" style="font-size:13px;margin-top:10px;color:#66756b"></div>';
    const editor = $("academicEditor");
    if (editor) editor.insertAdjacentElement("afterbegin", host);
    $("academicAddGroup")?.addEventListener("click", () => {
      const name = safePrompt("اسم المجموعة الجديدة (مثال: المجموعة A)");
      if (!name) return;
      config.groups ||= [];
      const group = { id: id(), name, fogs: [] };
      config.groups.push(group);
      markDirty(); renderScheduleEditor();
    });
    host.addEventListener("click", event => {
      const button = event.target.closest("[data-schedule-action]");
      if (!button) return;
      const [action, groupId, fogId] = button.dataset.scheduleAction.split("|");
      const group = (config.groups || []).find(item => item.id === groupId);
      const fog = group?.fogs.find(item => item.id === fogId);
      if (action === "add-fog" && group) {
        const name = safePrompt("اسم الفوج الجديد (مثال: الفوج 01)");
        if (!name) return;
        group.fogs.push({ id: id(), name, scheduleImage: "" });
      } else if (action === "rename-group" && group) {
        const name = safePrompt("اسم المجموعة", group.name); if (!name) return; group.name = name;
      } else if (action === "delete-group" && group) {
        if (!confirm("حذف المجموعة «" + group.name + "» وكل أفواجها؟")) return;
        config.groups = config.groups.filter(item => item.id !== groupId);
      } else if (action === "rename-fog" && fog) {
        const name = safePrompt("اسم الفوج", fog.name); if (!name) return; fog.name = name;
      } else if (action === "delete-fog" && fog) {
        if (!confirm("حذف «" + fog.name + "»؟")) return;
        group.fogs = group.fogs.filter(item => item.id !== fogId);
      } else return;
      markDirty(); renderScheduleEditor();
    });
    host.addEventListener("change", event => {
      const input = event.target.closest("[data-schedule-upload]");
      if (input) uploadScheduleImage(input);
    });
    return host;
  }
  function renderScheduleEditor() {
    const host = ensureScheduleEditor();
    const list = $("academicGroupsList");
    if (!host || !list) return;
    list.replaceChildren();
    const groups = config.groups || [];
    if (!groups.length) {
      const empty = document.createElement("p");
      empty.textContent = "لم تُضف أي مجموعة بعد. اضغط «إضافة مجموعة» للبدء.";
      empty.style.cssText = "margin:0;padding:14px;background:white;border-radius:10px;color:#66756b;font-size:14px";
      list.append(empty); return;
    }
    groups.forEach(group => {
      const card = document.createElement("div");
      card.style.cssText = "padding:14px;background:white;border:1px solid #e1e8e3;border-radius:12px";
      const header = document.createElement("div");
      header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap";
      const heading = document.createElement("b"); heading.textContent = group.name;
      const actions = document.createElement("div");
      actions.innerHTML = '<button type="button" data-schedule-action="add-fog|' + group.id + '" class="academic-action-button">إضافة فوج</button> <button type="button" data-schedule-action="rename-group|' + group.id + '" class="academic-action-button">تعديل الاسم</button> <button type="button" data-schedule-action="delete-group|' + group.id + '" class="academic-action-button">حذف المجموعة</button>';
      header.append(heading, actions); card.append(header);
      const fogList = document.createElement("div");
      fogList.style.cssText = "display:grid;gap:10px;margin-top:12px";
      (group.fogs || []).forEach(fog => {
        const row = document.createElement("div");
        row.style.cssText = "padding:12px;border-radius:10px;background:#f7faf8;display:grid;gap:9px";
        const top = document.createElement("div");
        top.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap";
        const name = document.createElement("b"); name.textContent = fog.name;
        const tools = document.createElement("div");
        tools.innerHTML = '<button type="button" data-schedule-action="rename-fog|' + group.id + '|' + fog.id + '" class="academic-action-button">تعديل</button> <button type="button" data-schedule-action="delete-fog|' + group.id + '|' + fog.id + '" class="academic-action-button">حذف</button>';
        top.append(name, tools); row.append(top);
        const label = document.createElement("label");
        label.textContent = fog.scheduleImage ? "استبدال صورة التوقيت" : "رفع صورة التوقيت";
        label.style.cssText = "font-size:13px;color:#53665a";
        const file = document.createElement("input");
        file.type = "file"; file.accept = "image/png,image/jpeg,image/webp";
        file.dataset.scheduleUpload = group.id + "|" + fog.id;
        label.append(file); row.append(label);
        if (fog.scheduleImage) {
          const img = document.createElement("img");
          img.src = fog.scheduleImage; img.alt = "توقيت " + fog.name;
          img.style.cssText = "max-width:220px;width:100%;height:auto;object-fit:contain;border:1px solid #e1e8e3;border-radius:8px;background:white";
          row.append(img);
          const remove = document.createElement("button");
          remove.type = "button"; remove.textContent = "إزالة صورة التوقيت";
          remove.className = "academic-action-button";
          remove.addEventListener("click", () => { fog.scheduleImage = ""; markDirty(); renderScheduleEditor(); });
          row.append(remove);
        } else {
          const hint = document.createElement("small"); hint.textContent = "لم تُرفع صورة لهذا الفوج.";
          hint.style.color = "#77847b"; row.append(hint);
        }
        fogList.append(row);
      });
      if (!(group.fogs || []).length) {
        const hint = document.createElement("small"); hint.textContent = "لا توجد أفواج في هذه المجموعة بعد."; hint.style.color = "#77847b"; fogList.append(hint);
      }
      card.append(fogList); list.append(card);
    });
  }
  async function uploadScheduleImage(input) {
    const [groupId, fogId] = input.dataset.scheduleUpload.split("|");
    const group = (config.groups || []).find(item => item.id === groupId);
    const fog = group?.fogs.find(item => item.id === fogId);
    const file = input.files?.[0];
    if (!file || !fog) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { alert("اختر صورة PNG أو JPG أو WEBP."); input.value = ""; return; }
    if (file.size > 8 * 1024 * 1024) { alert("حجم الصورة كبير؛ الحد الأقصى 8 ميغابايت."); input.value = ""; return; }
    const status = $("academicGroupsStatus"); if (status) status.textContent = "جارٍ رفع صورة توقيت " + fog.name + "...";
    input.disabled = true;
    try {
      const response = await fetch("/api/academic-image", { method: "POST", headers: { "content-type": file.type, "x-academic-admin-code": adminCode }, body: file });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.url) throw new Error(result.error || "upload_failed");
      fog.scheduleImage = result.url; markDirty(); renderScheduleEditor();
      if ($("academicGroupsStatus")) $("academicGroupsStatus").textContent = "تم رفع الصورة. اضغط «حفظ التغييرات» لحفظ التوقيت.";
    } catch (error) {
      if ($("academicGroupsStatus")) $("academicGroupsStatus").textContent = error.message === "unauthorized" ? "انتهت صلاحية الدخول؛ سجّل الدخول مجددًا." : "تعذر رفع الصورة. تحقق من التخزين وحاول مجددًا.";
    } finally { input.value = ""; }
  }
  function refreshAll() {
    refreshPublicSelectors();
    refreshEditorSelectors();
    renderScheduleEditor();
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
      ensureScheduleEditor();
      renderScheduleEditor();
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
    ensureScheduleEditor();
    renderScheduleEditor();
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