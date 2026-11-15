(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const chooser = $("scheduleChooser");
  const view = $("scheduleView");
  if (!chooser || !view || chooser.dataset.dynamicScheduleReady) return;
  chooser.dataset.dynamicScheduleReady = "1";

  /* الواجهة الثابتة الأصلية (المجموعتان A وB والأفواج 01–12): نحتفظ بعقدها لإرجاعها عند فشل الخادم دون وجود نسخة محفوظة */
  const originalNodes = Array.from(chooser.childNodes);

  const CACHE_KEY = "ensd_schedule_years_v1";
  const REFRESH_GAP = 5 * 60 * 1000; /* أقل مدة بين جلبين ناجحين من الخادم */
  const RETRY_GAP = 2 * 60 * 1000;   /* أقل مدة بين محاولتين بعد فشل */
  const MSG_NO_IMAGE = "لم تُرفع صورة توقيت لهذا الفوج بعد.";
  const MSG_IMG_FAIL = "تعذر تحميل صورة الجدول الآن. حاول مجددًا لاحقًا.";

  /* الرسائل التقنية (رموز الخطأ، فشل الصورة) تظهر للمشرف فقط: من سجّل الدخول إلى إدارة البرنامج الأكاديمي */
  const isAdmin = () => {
    try { if (localStorage.getItem("ensd_persist_academic_code")) return true; } catch {}
    const editor = $("academicEditor");
    return !!(editor && !editor.hidden);
  };
  const imageFrame = () => $("scheduleImage")?.closest(".schedule-image-frame");

  let years = [];
  let activeYearId = "";
  let activeGroup = null;
  let noteText = "";
  const selectedYear = () => years.find(year => year.id === activeYearId) || years[0] || null;
  const selectedGroups = () => selectedYear()?.groups || [];
  const isSecondYear = (year) => /الثانية|second|year-2/i.test(year.name + " " + year.id);
  const pickActiveYear = () => {
    if (!years.some(year => year.id === activeYearId)) {
      activeYearId = years.find(isSecondYear)?.id || years[0]?.id || "";
    }
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ===== نسخة محفوظة على جهاز الطالب ===== */
  function readCache() {
    try {
      const data = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (!data || !Array.isArray(data.years)) return null;
      const list = data.years.filter(year => year && typeof year.id === "string" && typeof year.name === "string" && Array.isArray(year.groups));
      return list.length ? list : null;
    } catch { return null; }
  }
  function writeCache(list) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), years: list })); } catch {}
  }

  /* ===== ملاحظة صغيرة أعلى القائمة (لا تستبدل التصميم) ===== */
  function applyNote() {
    $("scheduleStatusNote")?.remove();
    if (!noteText || !isAdmin()) return;
    const note = el("p", "schedule-load-note", noteText);
    note.id = "scheduleStatusNote";
    note.style.cssText = "margin:0 0 14px;padding:10px 14px;border-radius:12px;background:rgba(217,168,92,.16);border:1px solid rgba(217,168,92,.35);color:inherit;font-size:13px;line-height:1.7";
    chooser.prepend(note);
  }

  function renderGroups() {
    chooser.replaceChildren();
    if (!years.length) {
      chooser.append(el("p", "", "لا توجد سنوات جامعية مهيأة للتوقيت الدراسي."));
      return;
    }
    const yearBar = el("div", "schedule-year-picker");
    yearBar.style.cssText = "display:flex;align-items:center;gap:10px;margin:0 0 18px;flex-wrap:wrap";
    const yearLabel = el("label", "", "السنة الجامعية");
    yearLabel.htmlFor = "studentScheduleYear";
    yearLabel.style.cssText = "font-weight:700";
    const yearSelect = el("select");
    yearSelect.id = "studentScheduleYear";
    yearSelect.style.cssText = "min-width:190px;min-height:42px;padding:8px 12px;border:1px solid #d5e0d8;border-radius:10px;background:#fff;color:inherit;font:inherit";
    years.forEach(year => yearSelect.add(new Option(year.name, year.id)));
    yearSelect.value = activeYearId;
    yearSelect.addEventListener("change", () => {
      activeYearId = yearSelect.value;
      render();
    });
    yearBar.append(yearLabel, yearSelect);
    chooser.append(yearBar);
    const groups = selectedGroups();
    if (!groups.length) {
      chooser.append(el("p", "", "لم تُضف مجموعات أو أفواج لهذه السنة بعد."));
      return;
    }
    const grid = el("div", "schedule-groups");
    groups.forEach((group, index) => {
      const card = el("section", "schedule-group-card");
      const head = el("div", "schedule-group-head");
      const copy = el("div");
      copy.append(el("span", "schedule-overline", "GROUP " + String(group.code || String.fromCharCode(65 + index))));
      copy.append(el("h4", "", group.name));
      const fogs = group.fogs || [];
      const range = fogs.length ? "الأفواج " + fogs[0].name + " إلى " + fogs[fogs.length - 1].name : "لا توجد أفواج";
      copy.append(el("p", "", (group.hall ? group.hall + " · " : "") + range));
      head.append(copy, el("span", "schedule-group-number", String((index + 1)).padStart(2, "0")));
      card.append(head);
      const fogGrid = el("div", "schedule-cohort-grid");
      (group.fogs || []).forEach(fog => {
        const button = el("button", "schedule-cohort");
        button.type = "button";
        button.dataset.dynamicGroupId = group.id;
        button.dataset.dynamicFogId = fog.id;
        button.append(el("span", "", "فوج"), el("b", "", fog.name), el("small", "", "عرض التوقيت"));
        fogGrid.append(button);
      });
      if (!(group.fogs || []).length) card.append(el("p", "", "لا توجد أفواج مضافة لهذه المجموعة."));
      else card.append(fogGrid);
      grid.append(card);
    });
    chooser.append(grid);
  }

  function render() {
    renderGroups();
    applyNote();
  }

  /* عند فشل الخادم: نبقي آخر نسخة محفوظة إن وُجدت، وإلا نعيد الواجهة الثابتة الأصلية بدل رسالة الخطأ */
  function showOffline(message) {
    noteText = message;
    if (years.length) { render(); return; }
    years = [];
    lastLoaded = "";
    chooser.replaceChildren(...originalNodes);
    applyNote();
  }

  function legacyScheduleImage(group, fog) {
    try {
      if (typeof scheduleImages === "undefined" || !scheduleImages) return "";
      const number = Number(fog?.name);
      const code = String(group?.code || "").toUpperCase();
      if (!Number.isInteger(number) || number < 1 || number > 12) return "";
      if (code === "A" && number >= 1 && number <= 6) return scheduleImages[String(number)] || "";
      if (code === "B" && number >= 7 && number <= 12) return scheduleImages[String(number)] || "";
      return "";
    } catch { return ""; }
  }

  function ensureEmpty() {
    let empty = $("scheduleNoImage");
    const frame = $("scheduleImage")?.closest(".schedule-image-frame");
    if (!empty && frame) {
      empty = el("p", "");
      empty.id = "scheduleNoImage";
      empty.style.cssText = "margin:12px;padding:16px;text-align:center;color:#71809b;background:#f7f8fc;border-radius:12px";
      empty.textContent = MSG_NO_IMAGE;
      frame.append(empty);
    }
    return empty;
  }

  function showImageMessage(text, technical = false) {
    const img = $("scheduleImage");
    if (img) { img.hidden = true; img.style.display = "none"; }
    /* الطالب العادي لا يرى رسالة فشل تقنية: نخفي الإطار كله بدل ذلك */
    if (technical && !isAdmin()) {
      const frame = imageFrame();
      if (frame) frame.style.display = "none";
      return;
    }
    const frame = imageFrame();
    if (frame) frame.style.display = "";
    const empty = ensureEmpty();
    if (empty) { empty.textContent = text; empty.hidden = false; }
  }

  function openFog(group, fog) {
    activeGroup = group;
    chooser.hidden = true;
    view.hidden = false;
    view.classList.remove("schedule-enter");
    void view.offsetWidth;
    view.classList.add("schedule-enter");
    $("scheduleGroupName").textContent = fog.name;
    $("scheduleGroupHall").textContent = group.hall || group.name;
    const img = $("scheduleImage");
    const frame0 = imageFrame();
    if (frame0) frame0.style.display = "";
    const empty = ensureEmpty();
    const imageUrl = fog.scheduleImage || legacyScheduleImage(group, fog);
    if (imageUrl) {
      img.style.display = "";
      img.src = imageUrl;
      img.alt = "جدول توقيت " + fog.name;
      img.hidden = false;
      if (empty) empty.hidden = true;
    } else {
      img.removeAttribute("src");
      showImageMessage(MSG_NO_IMAGE);
    }
  }

  chooser.addEventListener("click", event => {
    /* أزرار الواجهة الثابتة (تعمل بمعالجها الأصلي في الصفحة)؛ إن لم تتوفر صورة نوضح ذلك بدل إطار فارغ */
    const staticButton = event.target.closest("[data-schedule-id]");
    if (staticButton) {
      const img = $("scheduleImage");
      if (img && !img.getAttribute("src")) showImageMessage(MSG_IMG_FAIL, true);
      return;
    }
    const button = event.target.closest("[data-dynamic-group-id]");
    if (!button) return;
    const group = selectedGroups().find(item => item.id === button.dataset.dynamicGroupId);
    const fog = group?.fogs?.find(item => item.id === button.dataset.dynamicFogId);
    if (group && fog) openFog(group, fog);
  });

  $("scheduleBack")?.addEventListener("click", () => {
    view.hidden = true;
    chooser.hidden = false;
    activeGroup = null;
  });

  const scheduleImg = $("scheduleImage");
  scheduleImg?.addEventListener("error", () => {
    if (!scheduleImg.getAttribute("src")) return;
    showImageMessage(MSG_IMG_FAIL, true);
  });
  scheduleImg?.addEventListener("load", () => {
    const fr = imageFrame();
    if (fr) fr.style.display = "";
    scheduleImg.style.display = "";
    scheduleImg.hidden = false;
    const empty = $("scheduleNoImage");
    if (empty) empty.hidden = true;
  });

  scheduleImg?.addEventListener("click", event => {
    if (!event.currentTarget.src || event.currentTarget.hidden) return;
    let overlay = $("scheduleImageLightbox");
    if (!overlay) {
      overlay = el("div");
      overlay.id = "scheduleImageLightbox";
      overlay.style.cssText = "position:fixed;inset:0;z-index:999999;background:rgba(10,15,25,.92);display:none;align-items:center;justify-content:center;padding:18px;cursor:zoom-out";
      const large = el("img");
      large.style.cssText = "max-width:96%;max-height:94%;object-fit:contain";
      overlay.append(large);
      overlay.addEventListener("click", () => { overlay.style.display = "none"; });
      document.body.append(overlay);
    }
    overlay.querySelector("img").src = event.currentTarget.src;
    overlay.style.display = "flex";
  });

  let loading = false;
  let lastLoaded = "";
  let nextAllowedAt = 0;
  const isShown = () => !!(chooser.offsetParent || view.offsetParent);

  /* force=true للتحميل الأول فقط. باقي المحفّزات (نقرات، عودة للصفحة) لا تطلب من الخادم إلا إذا كان قسم التوقيت ظاهراً ومرّت مدة كافية */
  async function load(force = false) {
    if (loading) return;
    if (!force && (Date.now() < nextAllowedAt || !isShown())) return;
    loading = true;
    try {
      const response = await fetch("/api/academic", { cache: "no-store" });
      if (!response.ok) {
        nextAllowedAt = Date.now() + RETRY_GAP;
        showOffline(years.length
          ? "تعذر تحديث التوقيت من الخادم (رمز " + response.status + ")، وتُعرض آخر نسخة محفوظة."
          : "تعذر الاتصال بالخادم حاليًا (رمز " + response.status + ")، وقد لا تظهر صور الجداول. حاول لاحقًا.");
        return;
      }
      const result = await response.json();
      nextAllowedAt = Date.now() + REFRESH_GAP;
      const savedYears = result.config?.years;
      if (!Array.isArray(savedYears)) {
        years = [];
        lastLoaded = "";
        noteText = "";
        render();
        if (result.config) chooser.append(el("p", "schedule-load-note", "لم يعثر الموقع على بيانات السنوات الجامعية."));
        return;
      }
      const hasYearGroups = savedYears.some(year => Array.isArray(year.groups));
      const legacyGroups = Array.isArray(result.config?.groups) ? result.config.groups : [];
      years = savedYears.filter(year => year && typeof year.id === "string" && typeof year.name === "string")
        .map(year => ({
          id: year.id,
          name: year.name,
          groups: Array.isArray(year.groups) ? year.groups.filter(group =>
            group && typeof group.id === "string" &&
            typeof group.name === "string" && Array.isArray(group.fogs)
          ) : []
        }));
      // عرض مؤقت متوافق مع البيانات القديمة قبل أن يحفظ المدير عملية الترحيل.
      if (!hasYearGroups && legacyGroups.length && years.length) {
        const target = years.find(isSecondYear) || years[0];
        target.groups = legacyGroups;
      }
      pickActiveYear();
      writeCache(years);
      noteText = "";
      const signature = JSON.stringify(years);
      if (signature !== lastLoaded) {
        lastLoaded = signature;
        render();
      } else {
        applyNote();
      }
    } catch (error) {
      console.warn("تعذر تحميل توقيت الأفواج:", error);
      nextAllowedAt = Date.now() + RETRY_GAP;
      showOffline(years.length
        ? "تعذر الاتصال بالخادم، وتُعرض آخر نسخة محفوظة."
        : "تعذر الاتصال بالخادم حاليًا، وقد لا تظهر صور الجداول. تحقق من الإنترنت ثم حاول لاحقًا.");
    } finally {
      loading = false;
    }
  }

  // أعد المحاولة عند الرجوع إلى قسم التوقيت أو العودة إلى الصفحة (مع حدّ أدنى بين الطلبات).
  let refreshQueued = false;
  const scheduleRefresh = () => {
    if (refreshQueued) return;
    refreshQueued = true;
    setTimeout(() => {
      refreshQueued = false;
      if (!view.hidden) return;
      load();
    }, 180);
  };
  window.addEventListener("pageshow", scheduleRefresh);
  document.addEventListener("click", scheduleRefresh, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleRefresh();
  });

  /* اعرض آخر نسخة محفوظة فورًا (دون انتظار الشبكة) ثم حدّثها من الخادم */
  const cached = readCache();
  if (cached) {
    years = cached;
    pickActiveYear();
    lastLoaded = JSON.stringify(years);
    render();
  }
  load(true);
})();
