(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const chooser = $("scheduleChooser");
  const view = $("scheduleView");
  if (!chooser || !view || chooser.dataset.dynamicScheduleReady) return;
  chooser.dataset.dynamicScheduleReady = "1";

  let years = [];
  let activeYearId = "";
  let activeGroup = null;
  const selectedYear = () => years.find(year => year.id === activeYearId) || years[0] || null;
  const selectedGroups = () => selectedYear()?.groups || [];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
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
      renderGroups();
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
    const frame = img?.closest(".schedule-image-frame");
    let empty = $("scheduleNoImage");
    if (!empty && frame) {
      empty = el("p", "");
      empty.id = "scheduleNoImage";
      empty.style.cssText = "margin:12px;padding:16px;text-align:center;color:#71809b;background:#f7f8fc;border-radius:12px";
      empty.textContent = "لم تُرفع صورة توقيت لهذا الفوج بعد.";
      frame.append(empty);
    }
    const imageUrl = fog.scheduleImage || legacyScheduleImage(group, fog);
    if (imageUrl) {
      img.src = imageUrl;
      img.alt = "جدول توقيت " + fog.name;
      img.hidden = false;
      if (empty) empty.hidden = true;
    } else {
      img.removeAttribute("src");
      img.hidden = true;
      if (empty) empty.hidden = false;
    }
  }

  chooser.addEventListener("click", event => {
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

  $("scheduleImage")?.addEventListener("click", event => {
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

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const response = await fetch("/api/academic?refresh=" + Date.now(), {
        cache: "no-store",
        headers: { "cache-control": "no-cache" }
      });
      if (!response.ok) {
        chooser.replaceChildren(el("p", "", "تعذر تحميل الأفواج من الخادم (رمز " + response.status + "). حاول تحديث الصفحة لاحقًا."));
        return;
      }
      const result = await response.json();
      const savedYears = result.config?.years;
      if (!Array.isArray(savedYears)) {
        years = [];
        renderGroups();
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
        const target = years.find(year => /الثانية|second|year-2/i.test(year.name + " " + year.id)) || years[0];
        target.groups = legacyGroups;
      }
      if (!years.some(year => year.id === activeYearId)) activeYearId = years.find(year => /الثانية|second|year-2/i.test(year.name + " " + year.id))?.id || years[0]?.id || "";
      const signature = JSON.stringify(years);
      if (signature !== lastLoaded) {
        lastLoaded = signature;
        renderGroups();
      }
    } catch (error) {
      console.warn("تعذر تحميل توقيت الأفواج:", error);
      chooser.replaceChildren(el("p", "", "حدث خطأ أثناء الاتصال بالخادم لتحميل الأفواج. تحقق من اتصال الإنترنت ثم أعد المحاولة."));
    } finally {
      loading = false;
    }
  }

  // أعد جلب البيانات عند الرجوع إلى قسم التوقيت أو العودة إلى الصفحة.
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
  // حدّث بيانات المجموعات عند انتقال المستخدم بين أقسام الموقع بالنقر على قائمة التنقل.
  document.addEventListener("click", scheduleRefresh, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleRefresh();
  });
  if (document.body && typeof MutationObserver !== "undefined") {
    const observer = new MutationObserver(records => {
      const relevant = records.some(record =>
        record.type === "attributes" &&
        (record.attributeName === "hidden" || record.attributeName === "class" || record.attributeName === "style")
      );
      if (relevant && !view.hidden && chooser.hidden) return;
      if (relevant && !chooser.hidden) scheduleRefresh();
    });
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "class", "style"]
    });
  }

  load();
})();