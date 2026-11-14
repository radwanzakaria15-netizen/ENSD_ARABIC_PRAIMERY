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
    if ($("academicScheduleManager")) renderScheduleEditor();
  }
  function refreshAll() {
    refreshPublicSelectors();
    refreshEditorSelectors();
    applyCurrent();
  }

  // إدارة قسم التوقيت الدراسي من لوحة البرنامج الأكاديمي.
  let scheduleGroupId = "", scheduleFogId = "";
  function ensureScheduleEditor() {
    let host = $("academicScheduleManager");
    if (host) return host;
    host = document.createElement("section");
    host.id = "academicScheduleManager";
    host.className = "academic-schedule-manager";
    host.innerHTML = `
      <style>
        #academicScheduleManager{margin:22px 0;padding:18px;border:1px solid #dce5df;border-radius:18px;background:#f7faf8;color:#24352d}
        #academicScheduleManager h3{margin:0 0 8px;font-size:1.12rem}
        #academicScheduleManager .asm-note{margin:0 0 16px;color:#66766d;font-size:.9rem;line-height:1.7}
        #academicScheduleManager .asm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
        #academicScheduleManager label{display:block;margin-bottom:6px;font-size:.88rem;font-weight:700}
        #academicScheduleManager select,#academicScheduleManager input[type=file]{width:100%;min-height:42px;padding:9px;border:1px solid #d4ded7;border-radius:10px;background:white;color:inherit}
        #academicScheduleManager .asm-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
        #academicScheduleManager button{border:0;border-radius:10px;padding:9px 13px;background:#e2eee6;color:#234b36;font:inherit;font-weight:700;cursor:pointer}
        #academicScheduleManager button.asm-danger{background:#f7e9e7;color:#8b3931}
        #academicScheduleManager button:disabled{opacity:.5;cursor:not-allowed}
        #academicScheduleManager .asm-preview{margin-top:12px;min-height:40px}
        #academicScheduleManager .asm-preview img{display:block;max-width:220px;max-height:170px;object-fit:contain;border:1px solid #dce5df;border-radius:10px;background:white}
        #academicScheduleManager .asm-status{display:block;margin-top:10px;color:#53685b;font-size:.88rem}
      </style>
      <h3>إدارة التوقيت الدراسي</h3>
      <p class="asm-note">تحكم في المجموعات والقاعات والأفواج، وارفع صورة توقيت مستقلة لكل فوج. بعد الانتهاء اضغط «حفظ التغييرات» أسفل هذا القسم لنشر التعديلات للطلاب.</p>
      <div class="asm-grid">
        <div><label for="asmGroupSelect">المجموعة</label><select id="asmGroupSelect"></select>
          <div class="asm-actions"><button type="button" id="asmAddGroup">+ إضافة مجموعة</button><button type="button" id="asmEditGroup">تعديل الاسم/القاعة</button><button type="button" class="asm-danger" id="asmDeleteGroup">حذف المجموعة</button></div>
        </div>
        <div><label for="asmFogSelect">الفوج</label><select id="asmFogSelect"></select>
          <div class="asm-actions"><button type="button" id="asmAddFog">+ إضافة فوج</button><button type="button" id="asmEditFog">تعديل اسم الفوج</button><button type="button" class="asm-danger" id="asmDeleteFog">حذف الفوج</button></div>
        </div>
      </div>
      <div style="margin-top:16px"><label for="asmScheduleFile">صورة توقيت الفوج المختار (PNG / JPG / WEBP)</label><input id="asmScheduleFile" type="file" accept="image/png,image/jpeg,image/webp"><div class="asm-preview" id="asmSchedulePreview"></div><div class="asm-actions"><button type="button" class="asm-danger" id="asmRemoveSchedule">حذف صورة التوقيت</button></div><span class="asm-status" id="asmScheduleStatus" role="status"></span></div>
    `;
    const saveRow = $("academicSave")?.closest(".academic-save-row");
    if (saveRow) saveRow.before(host);
    else $("academicEditor")?.append(host);
    $("asmGroupSelect")?.addEventListener("change", () => {
      scheduleGroupId = $("asmGroupSelect").value;
      scheduleFogId = config.groups.find(g => g.id === scheduleGroupId)?.fogs?.[0]?.id || "";
      renderScheduleEditor();
    });
    $("asmFogSelect")?.addEventListener("change", () => { scheduleFogId = $("asmFogSelect").value; renderScheduleEditor(); });
    $("asmAddGroup")?.addEventListener("click", () => {
      const name = safePrompt("اسم المجموعة أو القاعة (مثال: المجموعة A · مدرج أ)");
      if (!name) return;
      const hall = safePrompt("اسم المدرج أو القاعة (مثال: مدرج أ)", "");
      if (hall === null) return;
      const item = { id: id(), name, hall, code: String.fromCharCode(65 + config.groups.length), fogs: [] };
      config.groups.push(item); scheduleGroupId = item.id; scheduleFogId = "";
      markDirty(); renderScheduleEditor();
    });
    $("asmEditGroup")?.addEventListener("click", () => {
      const group = currentScheduleGroup(); if (!group) return;
      const name = safePrompt("اسم المجموعة (مثال: المجموعة A)", group.name);
      if (!name) return;
      const hall = safePrompt("اسم المدرج أو القاعة", group.hall || "");
      if (hall === null) return;
      group.name = name; group.hall = hall; markDirty(); renderScheduleEditor();
    });
    $("asmDeleteGroup")?.addEventListener("click", () => {
      const group = currentScheduleGroup(); if (!group) return;
      if (!confirm("حذف «" + group.name + "» وجميع الأفواج التابعة لها؟")) return;
      config.groups = config.groups.filter(g => g.id !== group.id);
      scheduleGroupId = config.groups[0]?.id || ""; scheduleFogId = config.groups[0]?.fogs?.[0]?.id || "";
      markDirty(); renderScheduleEditor();
    });
    $("asmAddFog")?.addEventListener("click", () => {
      const group = currentScheduleGroup(); if (!group) { alert("أضف مجموعة أولًا."); return; }
      const name = safePrompt("اسم الفوج (مثال: 01)");
      if (!name) return;
      const fog = { id: id(), name, scheduleImage: "" };
      group.fogs ||= []; group.fogs.push(fog); scheduleFogId = fog.id;
      markDirty(); renderScheduleEditor();
    });
    $("asmEditFog")?.addEventListener("click", () => {
      const fog = currentScheduleFog(); if (!fog) return;
      const name = safePrompt("اسم الفوج", fog.name);
      if (!name) return; fog.name = name; markDirty(); renderScheduleEditor();
    });
    $("asmDeleteFog")?.addEventListener("click", () => {
      const group = currentScheduleGroup(), fog = currentScheduleFog(); if (!group || !fog) return;
      if (!confirm("حذف الفوج «" + fog.name + "»؟")) return;
      group.fogs = group.fogs.filter(f => f.id !== fog.id);
      scheduleFogId = group.fogs[0]?.id || ""; markDirty(); renderScheduleEditor();
    });
    $("asmScheduleFile")?.addEventListener("change", uploadScheduleImage);
    $("asmRemoveSchedule")?.addEventListener("click", () => {
      const fog = currentScheduleFog(); if (!fog?.scheduleImage) return;
      if (!confirm("حذف صورة توقيت هذا الفوج؟")) return;
      fog.scheduleImage = ""; markDirty(); renderScheduleEditor();
      $("asmScheduleStatus").textContent = "حُذفت الصورة من الإعدادات؛ اضغط «حفظ التغييرات» لتطبيق الحذف.";
    });
    return host;
  }
  const currentScheduleGroup = () => config?.groups?.find(g => g.id === scheduleGroupId) || null;
  const currentScheduleFog = () => currentScheduleGroup()?.fogs?.find(f => f.id === scheduleFogId) || null;
  function renderScheduleEditor() {
    const host = ensureScheduleEditor(); if (!host || !config) return;
    config.groups ||= [];
    if (!config.groups.some(g => g.id === scheduleGroupId)) scheduleGroupId = config.groups[0]?.id || "";
    const group = currentScheduleGroup();
    const gs = $("asmGroupSelect"), fs = $("asmFogSelect");
    if (gs) {
      gs.replaceChildren();
      if (!config.groups.length) gs.add(new Option("لا توجد مجموعات", ""));
      config.groups.forEach(g => gs.add(new Option(g.name, g.id)));
      gs.value = scheduleGroupId;
    }
    if (group && !group.fogs.some(f => f.id === scheduleFogId)) scheduleFogId = group.fogs[0]?.id || "";
    if (fs) {
      fs.replaceChildren();
      if (!group || !group.fogs.length) fs.add(new Option("لا توجد أفواج", ""));
      (group?.fogs || []).forEach(f => fs.add(new Option(f.name, f.id)));
      fs.value = scheduleFogId;
    }
    const fog = currentScheduleFog(), preview = $("asmSchedulePreview");
    if ($("asmScheduleFile")) $("asmScheduleFile").disabled = !fog;
    if ($("asmRemoveSchedule")) $("asmRemoveSchedule").hidden = !fog?.scheduleImage;
    ["asmEditGroup","asmDeleteGroup"].forEach(x => { if ($(x)) $(x).disabled = !group; });
    ["asmAddFog"].forEach(x => { if ($(x)) $(x).disabled = !group; });
    ["asmEditFog","asmDeleteFog"].forEach(x => { if ($(x)) $(x).disabled = !fog; });
    if (preview) {
      preview.replaceChildren();
      if (fog?.scheduleImage) {
        const img = document.createElement("img"); img.src = fog.scheduleImage; img.alt = "معاينة توقيت " + fog.name; preview.append(img);
      } else {
        const note = document.createElement("small"); note.textContent = fog ? "لم تُرفع صورة توقيت لهذا الفوج بعد." : "اختر مجموعة وفوجًا أو أضفهما أولًا."; preview.append(note);
      }
    }
    if ($("asmScheduleStatus") && !$("asmScheduleStatus").dataset.busy) $("asmScheduleStatus").textContent = "";
  }
  async function uploadScheduleImage(event) {
    const file = event.target.files?.[0], fog = currentScheduleFog(), status = $("asmScheduleStatus");
    if (!file || !fog) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { status.textContent = "اختر صورة PNG أو JPG أو WEBP."; event.target.value = ""; return; }
    if (file.size > 8 * 1024 * 1024) { status.textContent = "الحد الأقصى لحجم الصورة 8 ميغابايت."; event.target.value = ""; return; }
    status.dataset.busy = "1"; status.textContent = "جارٍ رفع صورة التوقيت..."; event.target.disabled = true;
    try {
      const response = await fetch("/api/academic-image", { method: "POST", headers: { "content-type": file.type, "x-academic-admin-code": adminCode }, body: file });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.url) throw new Error(result.error || "upload_failed");
      fog.scheduleImage = result.url; markDirty(); renderScheduleEditor();
      status.textContent = "تم رفع الصورة. اضغط «حفظ التغييرات» لنشرها للطلاب.";
    } catch (error) {
      status.textContent = error.message === "unauthorized" ? "انتهت صلاحية الدخول؛ سجّل الدخول مجددًا." : "تعذر رفع الصورة. تحقق من إعدادات التخزين وحاول مجددًا.";
    } finally { delete status.dataset.busy; event.target.disabled = false; event.target.value = ""; }
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
      renderScheduleEditor();
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
    config.groups ||= [];
    scheduleGroupId = config.groups[0]?.id || "";
    scheduleFogId = config.groups[0]?.fogs?.[0]?.id || "";
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
          adminCode = stored; $("academicEditor").hidden = false; $("academicAdminLoginStatus").textContent = "تم التحقق من جلسة الإدارة."; refreshEditorSelectors(); renderScheduleEditor();
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