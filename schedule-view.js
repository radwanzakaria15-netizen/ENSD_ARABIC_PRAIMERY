(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const chooser = $("scheduleChooser");
  const view = $("scheduleView");
  if (!chooser || !view || chooser.dataset.dynamicScheduleReady) return;
  chooser.dataset.dynamicScheduleReady = "1";

  let groups = [];
  let activeGroup = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderGroups() {
    chooser.replaceChildren();
    if (!groups.length) {
      chooser.append(el("p", "", "لم تُضف مجموعات أو أفواج بعد."));
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
    if (fog.scheduleImage) {
      img.src = fog.scheduleImage;
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
    const group = groups.find(item => item.id === button.dataset.dynamicGroupId);
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
      const savedGroups = result.config?.groups;
      if (!Array.isArray(savedGroups)) {
        groups = [];
        renderGroups();
        if (result.config) chooser.append(el("p", "schedule-load-note", "لم يعثر الموقع على بيانات المجموعات والأفواج المحفوظة في البرنامج الأكاديمي."));
        return;
      }
      const validGroups = savedGroups.filter(group =>
        group && typeof group.id === "string" &&
        typeof group.name === "string" && Array.isArray(group.fogs)
      );
      const signature = JSON.stringify(validGroups);
      if (signature !== lastLoaded) {
        groups = validGroups;
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