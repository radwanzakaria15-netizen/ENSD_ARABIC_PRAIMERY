
const scheduleImages = {"1":"/assets/schedules/1.jpg","2":"/assets/schedules/2.jpg","3":"/assets/schedules/3.jpg","4":"/assets/schedules/4.jpg","5":"/assets/schedules/5.jpg","6":"/assets/schedules/6.jpg","7":"/assets/schedules/7.jpg","8":"/assets/schedules/8.jpg","9":"/assets/schedules/9.jpg","10":"/assets/schedules/10.jpg","11":"/assets/schedules/11.jpg","12":"/assets/schedules/12.jpg"};

const titles={home:"الرئيسية",lessons:"الدروس والمحاضرات",schedule:"التوقيت الدراسي",resources:"مكتبة الموارد",announcements:"الإعلانات والتنبيهات"};
function go(page,options={}){if(!titles[page])page="home";document.querySelectorAll(".page").forEach(x=>x.classList.remove("active"));document.getElementById("page-"+page)?.classList.add("active");document.querySelectorAll("[data-page]").forEach(x=>{const active=x.dataset.page===page;x.classList.toggle("active",active);if(active)x.setAttribute("aria-current","page");else x.removeAttribute("aria-current")});document.getElementById("pageTitle").textContent=titles[page]||"الرئيسية";if(page==="resources")resourceMarkNotificationsSeen();if(page==="announcements")window.loadAnnouncements?.();if(!options.fromHistory&&location.hash!=="#"+page){try{history.pushState({page},"","#"+page)}catch(e){}}window.scrollTo({top:0,behavior:"smooth"})}
window.addEventListener("popstate",()=>{const page=location.hash.slice(1);go(titles[page]?page:"home",{fromHistory:true});});
const initialPage=location.hash.slice(1);
if(titles[initialPage])go(initialPage,{fromHistory:true});
document.querySelectorAll("[data-page]").forEach(b=>b.addEventListener("click",()=>go(b.dataset.page)));
document.querySelectorAll("[data-go]").forEach(b=>b.addEventListener("click",()=>go(b.dataset.go)));
let currentGroup="A";
try{const savedGroup=localStorage.getItem("ensd_student_group");if(savedGroup==="A"||savedGroup==="B")currentGroup=savedGroup;}catch(e){}
function filterLessons(){const q=(document.getElementById("lessonSearch")?.value||"").trim().toLocaleLowerCase("ar");const cards=[...document.querySelectorAll("#lessonList .lesson-subject-card")];let shown=0;cards.forEach(card=>{const match=card.textContent.toLocaleLowerCase("ar").includes(q);card.hidden=!match;if(match)shown++;});let status=document.getElementById("lessonSearchStatus");if(!status){status=document.createElement("div");status.id="lessonSearchStatus";status.className="search-status";document.getElementById("lessonList").after(status);}status.textContent=q?(shown?`عدد النتائج: ${shown}`:"لا توجد نتائج مطابقة."): "";}
document.getElementById("lessonSearch")?.addEventListener("input",filterLessons);
const lessonSubjects=["علم الأحياء","الصرف العربي","قضايا النقد","الرياضيات","الذكاء الاصطناعي في التعلم","علم نفس النمو: الطفل والمراهق","التربية الإسلامية","النحو العربي","اللغة الإنجليزية","لسانيات عامة"];
const lessonVisuals=["biology","morphology","criticism","math","ai","psychology","islamic","grammar","english","linguistics"];
const lessonData={A:lessonSubjects.map(name=>({name,lessons:[]})),B:lessonSubjects.map(name=>({name,lessons:[]}))};
let PUBLISHED_LESSONS=Object.create(null);
let LESSON_ADMIN=false;
let LESSON_ADMIN_CODE="";
let LESSON_ADMIN_GROUP="";
async function checkLessonAdmin(code,group){const response=await fetch("/api/admin/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({role:"lesson-"+group,code}),cache:"no-store"});return response.ok;}
async function activateLessonAdminForGroup(group){LESSON_ADMIN=false;LESSON_ADMIN_CODE="";LESSON_ADMIN_GROUP="";try{const response=await fetch("/api/admin/session?role=lesson-"+group,{cache:"no-store"});if(currentGroup!==group)return;if(response.ok){LESSON_ADMIN=true;LESSON_ADMIN_CODE="session";LESSON_ADMIN_GROUP=group;}}catch(e){if(currentGroup===group)LESSON_ADMIN=false;}}
let ACADEMIC_YEAR_NUMBER=2;
let ACADEMIC_SEMESTER_NUMBER=1;
function lessonKey(group,subjectIndex,axisIndex,chapterIndex){
 const prefix=ACADEMIC_YEAR_NUMBER===2&&ACADEMIC_SEMESTER_NUMBER===1?group:"Y"+ACADEMIC_YEAR_NUMBER+"S"+ACADEMIC_SEMESTER_NUMBER+group;
 return prefix+"-"+String(subjectIndex+1).padStart(2,"0")+"-"+String(axisIndex+1).padStart(2,"0")+"-"+String(chapterIndex+1).padStart(2,"0");
}
async function refreshPublishedLessons(updateCards=true){
 try{
  const response=await fetch("/api/lessons",{cache:"no-store"});
  if(!response.ok)throw new Error("API unavailable");
  const entries=await response.json();
  PUBLISHED_LESSONS=Object.create(null);
  (Array.isArray(entries)?entries:[]).forEach(entry=>{
   if(typeof entry==="string"){
    if(/^[AB]-[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(entry))(PUBLISHED_LESSONS[entry]||(PUBLISHED_LESSONS[entry]=[])).push({key:entry,name:"محاضرة سابقة.pdf",type:"application/pdf",legacy:true});
   }else if(entry&&typeof entry==="object"&&entry.lessonKey&&entry.key){
    (PUBLISHED_LESSONS[entry.lessonKey]||(PUBLISHED_LESSONS[entry.lessonKey]=[])).push(entry);
   }
  });
  if(updateCards)renderLessonSubjects(currentGroup);
  return true;
 }catch(error){
  PUBLISHED_LESSONS=Object.create(null);
  return false;
 }
}
function renderLessonSubjects(g){
 const list=document.getElementById("lessonList");
 const items=lessonData[g]||[];
 list.innerHTML=items.map((item,index)=>{
  const prefix=lessonKey(g,index,0,0).replace(/-\d{2}-\d{2}$/,"-");
  const count=Object.keys(PUBLISHED_LESSONS).filter(key=>key.startsWith(prefix)).length;
  const status=count?count+" "+(count===1?"محاضرة منشورة":"محاضرات منشورة"):"قريباً";
  return '<article class="lesson-subject-card lesson-visual-'+lessonVisuals[index]+'" data-watermark="'+["BIO","ص","ق","∑","AI","ع","إ","ن","Aa","ل"][index]+'" data-search="'+item.name+'" data-fav-key="lesson-'+g+'-'+index+'"><div class="lesson-card-top"><span class="lesson-card-index">'+String(index+1).padStart(2,"0")+'</span><span class="lesson-card-status '+(count?"has-lessons":"")+'">'+status+'</span></div><div class="lesson-card-title">'+item.name+'</div><div class="lesson-card-foot"><span>مقياس دراسي</span><b>'+(count?count+" محاضرة":"لم تنشر المحاضرات")+'</b></div></article>';
 }).join("");
 filterLessons();
}
function setGroup(g){currentGroup=g;try{localStorage.setItem("ensd_student_group",g);}catch(e){}document.querySelectorAll("[data-group]").forEach(b=>b.classList.toggle("active",b.dataset.group===g));const hall=g==="A"?"مدرج أ":"مدرج د";document.getElementById("groupName").textContent="المجموعة "+g;document.getElementById("groupHall").textContent=hall;document.getElementById("lessonGroup").textContent="المجموعة "+g;document.getElementById("lessonHall").textContent=hall;renderLessonSubjects(g);activateLessonAdminForGroup(g);}
document.querySelectorAll("[data-group]").forEach(b=>b.addEventListener("click",()=>setGroup(b.dataset.group)));
setGroup(currentGroup);
refreshPublishedLessons(true).then(async()=>{
 await activateLessonAdminForGroup(currentGroup);
 if(activeLessonCard&&lessonSubjectDialog)openLessonSubjectDialog(activeLessonCard);
});

document.querySelectorAll("[data-schedule-id]").forEach(button=>{
 button.addEventListener("click",()=>{
  const number=button.dataset.scheduleId;
  const group=button.dataset.scheduleGroup;
  activeScheduleCohort=number;
  document.getElementById("personalSchedule").hidden=false;
  loadPersonalSchedule();
  const image=scheduleImages[number];
  const view=document.getElementById("scheduleView");
  document.getElementById("scheduleChooser").hidden=true;
  view.hidden=false;
  view.classList.remove("schedule-enter");void view.offsetWidth;view.classList.add("schedule-enter");
  document.getElementById("scheduleGroupName").textContent="الفوج "+String(number).padStart(2,"0");
  document.getElementById("scheduleGroupHall").textContent="المجموعة "+group+" · "+(group==="A"?"مدرج أ":"مدرج د");
  const img=document.getElementById("scheduleImage");
  if(image){img.src=image;img.alt="جدول توقيت الفوج "+String(number).padStart(2,"0");}
  else{img.removeAttribute("src");}
 });
});
document.getElementById("scheduleBack").addEventListener("click",()=>{
 document.getElementById("scheduleView").hidden=true;
 document.getElementById("scheduleChooser").hidden=false;
});

let activeScheduleCohort="";
let personalScheduleItems=[];
const weekdayNames=["الأحد","الإثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"];
const personalScheduleKey=()=> "ensd_personal_schedule_"+activeScheduleCohort;
function loadPersonalSchedule(){
 try{const data=JSON.parse(localStorage.getItem(personalScheduleKey())||"[]");personalScheduleItems=Array.isArray(data)?data:[];}catch(e){personalScheduleItems=[];}
 renderPersonalSchedule();
}
function savePersonalSchedule(){
 try{localStorage.setItem(personalScheduleKey(),JSON.stringify(personalScheduleItems));}catch(e){alert("تعذر حفظ الجدول على هذا الجهاز.");}
}
function renderPersonalSchedule(){
 const list=document.getElementById("personalScheduleList");if(!list)return;
 list.replaceChildren();
 personalScheduleItems.sort((a,b)=>a.day-b.day||a.start.localeCompare(b.start));
 personalScheduleItems.forEach((item,index)=>{
  const row=document.createElement("div");row.className="personal-schedule-row";
  const info=document.createElement("div"),title=document.createElement("strong"),meta=document.createElement("small"),remove=document.createElement("button");
  title.textContent=item.subject;meta.textContent=weekdayNames[item.day]+" · "+item.start+"–"+item.end+(item.room?" · "+item.room:"");
  info.append(title,meta);remove.type="button";remove.textContent="حذف";remove.setAttribute("aria-label","حذف حصة "+item.subject);
  remove.addEventListener("click",()=>{personalScheduleItems.splice(index,1);savePersonalSchedule();renderPersonalSchedule();updateNextClass();});
  row.append(info,remove);list.append(row);
 });
 if(!personalScheduleItems.length){const empty=document.createElement("p");empty.className="empty";empty.textContent="لم تضف حصصاً بعد.";list.append(empty);}
 updateNextClass();
}
function updateNextClass(){
 const title=document.getElementById("nextClassTitle"),count=document.getElementById("nextClassCountdown");if(!title||!count)return;
 if(!personalScheduleItems.length){title.textContent="أضف حصصك لتفعيل العدّاد";count.textContent="";return;}
 const now=new Date();let next=null;
 for(let offset=0;offset<=7;offset++){
  const day=(now.getDay()+offset)%7;
  for(const item of personalScheduleItems.filter(x=>x.day===day).sort((a,b)=>a.start.localeCompare(b.start))){
   const [hh,mm]=item.start.split(":").map(Number),start=new Date(now);start.setDate(now.getDate()+offset);start.setHours(hh,mm,0,0);
   const [eh,em]=item.end.split(":").map(Number),end=new Date(start);end.setHours(eh,em,0,0);
   if(end>now){next={item,start,end};break;}
  }
  if(next)break;
 }
 if(!next){title.textContent="لا توجد حصص قادمة";count.textContent="تحقق من الأيام والأوقات التي أدخلتها.";return;}
 title.textContent=next.item.subject+" · "+weekdayNames[next.item.day]+(next.item.room?" · "+next.item.room:"");
 const ms=next.start-now;
 if(ms<=0){count.textContent="الحصة جارية الآن · تنتهي عند "+next.item.end;return;}
 const days=Math.floor(ms/86400000),hours=Math.floor(ms%86400000/3600000),mins=Math.floor(ms%3600000/60000);
 count.textContent="تبدأ بعد "+(days?days+" يوم و":"")+(hours?hours+" ساعة و":"")+mins+" دقيقة · "+next.item.start;
}
document.getElementById("personalScheduleForm")?.addEventListener("submit",event=>{
 event.preventDefault();
 const day=Number(document.getElementById("personalDay").value),subject=document.getElementById("personalSubject").value.trim(),start=document.getElementById("personalStart").value,end=document.getElementById("personalEnd").value,room=document.getElementById("personalRoom").value.trim();
 if(!subject||!start||!end||end<=start){alert("تحقق من اسم المقياس ووقت البداية والنهاية.");return;}
 personalScheduleItems.push({day,subject,start,end,room});savePersonalSchedule();event.target.reset();renderPersonalSchedule();
});
setInterval(updateNextClass,30000);
document.getElementById("noticeBtn").addEventListener("click",()=>go("announcements"));
const subjectData=[{"name":"علم الأحياء","symbol":"ح","axes":[{"name":"مدخل إلى علم الأحياء","chapters":[["التنظيم البنيوي للأحياء",["مستويات التنظيم الحيوي","الخلية والأنسجة والأعضاء والأجهزة","تنوع الخلايا والوظائف الحيوية","المقاييس الحيوية ووسائل الملاحظة","مفهوم الطاقة"]],["تصنيف العالم الحي",["مفهوم التصنيف وأهميته","أسس ومعايير التصنيف","السلم التصنيفي والمستويات الرئيسية"]]]},{"name":"دراسة الأحياء الدقيقة","chapters":[["مدخل إلى علم الأحياء الدقيقة",["تاريخ علم الأحياء الدقيقة وأبرز الرواد","ليفينهوك وباستور وكوخ","العصر الذهبي لعلم الأحياء الدقيقة","الميكروبيوم"]],["مظهر وبنية البكتيريا",["أشكال البكتيريا والمستعمرات","البنية الخلوية للبكتيريا ووظائفها"]],["التغذية والأيض البكتيري",["الأنماط الغذائية والتنفسية","الأيض والطاقة واستقلاب الجلوكوز","التطبيقات الغذائية والدوائية والبيئية"]],["النمو ومثبطات النمو",["منحنى النمو ومراحله","التعقيم والتطهير","المضادات الحيوية والمقاومة"]],["تصنيف البكتيريا",["السلم والمعايير التصنيفية","التصنيف المظهري والوراثي","Proteobacteria و16S rRNA"]],["الفيروسات",["خصائص الفيروسات وبنيتها","اكتشاف الفيروسات ودورات تكاثرها","البريونات والفيرويدات"]],["التطبيقات الميدانية",["التطبيقات الطبية والغذائية","التطبيقات الزراعية والبيئية","التطبيقات الصناعية والتخمر"]]]}]},{"name":"الصرف العربي","symbol":"ص","axes":[{"name":"المصادر وأوزانها","chapters":[["المصادر وأوزانها",["مصدر الفعل الثلاثي وغير الثلاثي","مصدر الفعل الخماسي والسداسي","اسم المصدر","المصدر الميمي","المصدر الصناعي","مصدر المرة ومصدر الهيئة"]]]},{"name":"اسم الفاعل","chapters":[["اسم الفاعل",["صياغة اسم الفاعل من الفعل الثلاثي","اسم الفاعل من الأجوف والناقص","صياغته من غير الثلاثي"]]]},{"name":"اسم المفعول","chapters":[["اسم المفعول",["صياغة اسم المفعول من الفعل الثلاثي","اسم المفعول من الأجوف والناقص","صياغته من غير الثلاثي"]]]},{"name":"الصفة المشبهة","chapters":[["الصفة المشبهة",["مفهوم الصفة المشبهة وأوزانها وأحكامها"]]]},{"name":"صيغة المبالغة","chapters":[["صيغة المبالغة",["مفهوم صيغ المبالغة وأوزانها وأحكامها"]]]},{"name":"اسم الزمان واسم المكان","chapters":[["اسم الزمان واسم المكان",["صياغة اسم الزمان من الثلاثي وغير الثلاثي","صياغة اسم المكان من الثلاثي وغير الثلاثي"]]]},{"name":"اسم الآلة","chapters":[["اسم الآلة",["مفهوم اسم الآلة وأوزانه وصياغته"]]]},{"name":"اسم التفضيل","chapters":[["اسم التفضيل",["مفهوم اسم التفضيل","صياغته وشروطه وأحكامه"]]]}]},{"name":"قضايا النقد","symbol":"ق","axes":[{"name":"مدخل إلى فلسفة النقد وأدواته","chapters":[["ماهية النقد الأدبي",["مفهوم النقد الأدبي"]],["وظيفة النقد وغايته",["وظيفة النقد الأدبي وغاياته"]],["شروط الناقد وأدواته",["شروط الناقد","أدوات الناقد"]],["الذوق الأدبي",["مفهوم الذوق الأدبي ودوره في النقد"]]]},{"name":"تاريخ النقد العربي القديم (الجذور والتحولات)","chapters":[["النقد الفطري (الجاهلي)",["ملامح النقد الفطري في العصر الجاهلي"]],["النقد في صدر الإسلام",["خصائص النقد في صدر الإسلام"]],["تطور النقد في العصر الأموي",["تحولات النقد في العصر الأموي"]],["أثر العلوم العقلية في العصر العباسي",["أثر العلوم العقلية في تطور النقد في العصر العباسي"]]]},{"name":"قضايا النقد العربي الكبرى","chapters":[["قضية اللفظ والمعنى",["مفهوم قضية اللفظ والمعنى","اتجاهات النقاد في قضية اللفظ والمعنى"]],["الموازنة النقدية",["مفهوم الموازنة النقدية ومعاييرها"]],["نظرية النظم عند الجرجاني",["مفهوم نظرية النظم وأسسها عند عبد القاهر الجرجاني"]],["نقد أدب الطفل في التراث العربي القديم وأهميته التربوية",["ملامح نقد أدب الطفل في التراث العربي القديم","الأهمية التربوية لأدب الطفل"]]]}]},{"name":"الرياضيات","symbol":"ر","axes":[{"name":"برنامج مقياس الرياضيات","chapters":[["التشفير",["مفهوم التشفير والترميز","عناصر التشفير: الرسالة الأصلية والمفتاح والخوارزمية","تطور تقنيات التشفير: شفرة قيصر وشفرة الاستبدال والشفرة الثنائية","تطبيقات التشفير في الاتصالات والتجارة الإلكترونية والخدمات البنكية"]],["ثلاثي الحدود من الدرجة الثانية",["الشكل النموذجي","المميز والمميز المختزل","المعادلات من الدرجة الثانية","الجذور والإشارة","مجموع وجداء الجذرين","تشكيل معادلة جذراها معلومان","تحليل ثلاثي الحدود","تطبيقات في نمذجة الظواهر الفيزيائية"]],["المعادلات والمتراجحات بمجهولين حقيقيين",["حل جملة معادلتين بمجهولين: التعويض والحذف والمحدد","التفسير البياني","حل متراجحة بمجهولين بيانياً"]],["المتتاليات الحقيقية",["مفهوم المتتالية والحد العام","اتجاه التغير والرتابة والمحدودية","المتتاليات الحسابية والهندسية","جوار عدد حقيقي وجوار اللانهاية","نهاية المتتالية والتقارب والتباعد","التفسير البياني للنهاية ومبرهنات التقارب","المتتاليات المتجاورة والمتتاليات المستخرجة أو الجزئية","المتتاليات الكوشية والمتتاليات التراجعية"]],["التحويلات النقطية المألوفة في المستوى",["التناظران المحوري والمركزي","الانسحاب والتحاكي","الدوران والتشابه","التعريفات الهندسية والتحليلية","النقاط الصامدة والعناصر والخصائص المميزة","تحويلات بعض الأشكال الهندسية"]]]}]},{"name":"الذكاء الاصطناعي في التعلم","symbol":"ذ","axes":[{"name":"برنامج مقياس الذكاء الاصطناعي في التعلم","chapters":[["اكتشاف الذكاء الاصطناعي التوليدي",["المفاهيم الأساسية","القدرات والحدود","الاصطلاحات الأكاديمية"]],["فهم كيفية تعلم الذكاء الاصطناعي",["البيانات","التدريب","الانحياز"]],["التفاعل الفعال مع الذكاء الاصطناعي",["مبادئ هندسة الأوامر (Prompt Engineering)"]],["أخلاقيات استعمال الذكاء الاصطناعي والنزاهة الأكاديمية",["المسؤولية الأخلاقية","السرقة الفكرية","الإفصاح","التوثيق المنهجي"]],["البحث عن المعلومات وتحليلها وتلخيصها",["استخدام الذكاء الاصطناعي في البحث الأكاديمي","محركات البحث المدعومة بالذكاء الاصطناعي"]],["استغلال القدرات متعددة الأنماط (Multimodal)",["التعامل مع النصوص","التعامل مع الصور","التعامل مع البيانات","التعامل مع المقاطع الصوتية"]],["تصميم مساعد ذكاء اصطناعي أو وكيل ذكي أو سير عمل مبرمج (Workflow)",["تصميم مساعدين مخصصين","الوكلاء الأذكياء","أتمتة المهام","تنظيم المعرفة"]]]}]},{"name":"علم نفس النمو: الطفل والمراهق","symbol":"ن","axes":[{"name":"مفاهيم ونظريات النمو","chapters":[["علم النفس النمو: الطفل والمراهق",["مفهوم علم النفس النمو وأهدافه","نشأته وتطوره وعلاقته بالعلوم الأخرى","أهم المفاهيم والمناهج العلمية"]],["النمو ونظرياته",["مفهوم النمو وقوانينه","مراحل النمو وجوانبه","العوامل المؤثرة في النمو","نظريات فرويد وإريكسون وبياجيه وفيغوتسكي وبرونر وكولبرج"]]]},{"name":"مراحل النمو","chapters":[["المرحلة الجنينية (الحمل أو ما قبل الميلاد)",["مراحل الحمل الثلاث","العوامل المؤثرة في الجنين","الولادة الطبيعية والقيصرية"]],["مرحلة الرضاعة (المهد)",["الرضاعة الطبيعية والاصطناعية","النمو الجسمي في مرحلة الرضاعة","النمو المعرفي واللغوي والاجتماعي والنفسي"]],["الطفولة والبلوغ والمراهقة",["تعريف الطفولة والمراهقة","مراحل الطفولة والمراهقة","أشكال ونظريات المراهقة","شخصية الطفل والمراهق"]]]}]},{"name":"التربية الإسلامية","symbol":"ت","axes":[{"name":"فقه أركان الإسلام والشهادتين","chapters":[["فقه أركان الإسلام",["مفهوم أركان الإسلام لغة واصطلاحاً وأهميتها","الفرق بين الإسلام والإيمان","مدخل إلى الفقه الإسلامي: مفهومه وخصائصه وموضوعاته ومصادره","التعريف بأبرز أئمة العلم والفقه المجتهدين"]],["فقه الشهادتين",["معنى شهادة أن لا إله إلا الله","معنى شهادة أن محمداً رسول الله ﷺ","شروط الشهادتين ونواقضهما ومبطلاتهما","أحكام فقهية عامة متعلقة بالشهادتين","مقاصد الشريعة المتعلقة بالشهادتين","مسائل مستجدة: النطق بالشهادتين بغير العربية أو بغير لفظهما المعروف، وحكم صيام من أسلم في رمضان"]]]},{"name":"فقه الطهارة","chapters":[["فقه الطهارة",["تعريف الطهارة وأقسامها: الحدث والخبث","النجاسة: تعريفها وأنواعها وأحكام الاستنجاء وآداب قضاء الحاجة","المياه: مفهومها وأقسامها وأحكامها","الوضوء: تعريفه وصفته وحكمه وفرائضه وسننه ومستحباته ومكروهاته ونواقضه ومبطلاته","المسح على الخفين","الغسل والتيمم","الحيض والنفاس والاستحاضة","مقاصد الشريعة المتعلقة بالطهارة","مسألة مستجدة: حكم استعمال المياه النجسة بعد تطهيرها وتنقيتها"]]]},{"name":"فقه الصلاة","chapters":[["فقه الصلاة",["تعريف الصلاة لغة وشرعاً وفضلها وحكمها وأدلتها","شروط الصلاة وأركانها وسننها ومكروهاتها ومبطلاتها","الأذان والإقامة","صلاة الجمعة والعيدين والجنازة","صلاة الكسوف والخسوف والاستسقاء","الجمع والقصر","مقاصد الشريعة المتعلقة بالصلاة","مسائل مستجدة: الصلاة في وسائل النقل الحديثة كالطائرات، والصلاة من جهاز أو كيس طبي"]]]}]},{"name":"النحو العربي","symbol":"ن","axes":[{"name":"الجملة الاسمية","chapters":[["المبتدأ وأحكامه",["تعريف المبتدأ","أقسام المبتدأ","أحكام المبتدأ"]],["الخبر وأحكامه",["تعريف الخبر","أقسام الخبر","روابط الخبر بالمبتدأ","أحكام الخبر"]],["مبدأ الوصف",["تعريف مبدأ الوصف","شروط مبدأ الوصف"]]]},{"name":"النواسخ","chapters":[["كان وأخواتها",["معاني كان وأخواتها وشروط عملها","أقسامها وأحوال خبرها","تصريفها وخصائصها"]],["الحروف المشبهة بليس",["ما، ولا، ولات، وإن","أحكام الحروف المشبهة بليس"]],["أفعال المقاربة (كاد وأخواتها)",["أقسام أفعال المقاربة","شروط عملها","اقتران خبرها بأن","خصائصها وتصريفها"]],["الحروف المشبهة بالفعل (إن وأخواتها)",["معانيها وأحكامها","حذف الخبر وتقديمه","الحروف الكافة","العطف على أسمائها","اتصالها بنون الوقاية","كسر همزة إن وتخفيفها"]]]}]},{"name":"اللغة الإنجليزية","symbol":"EN","axes":[{"name":"Course Units","chapters":[["Unit 1: Teacher Roles and Professional Identity",["Teacher Roles","Professional Identity","أدوار المعلم والهوية المهنية"]],["Unit 2: Classroom Communication and Interaction",["Classroom Communication","Classroom Interaction","التواصل والتفاعل داخل الصف"]],["Unit 3: Classroom Life and Learner Behavior, Present Focus",["Classroom Life","Learner Behavior","Present Focus","الحياة الصفية وسلوك المتعلم، التركيز على المضارع"]],["Unit 4: Learning Strategies and Study Skills",["Learning Strategies","Study Skills","استراتيجيات التعلم ومهارات الدراسة"]],["Unit 5: Technology in Language Teaching",["Technology in Language Teaching","التكنولوجيا في تعليم اللغة"]]]}]},{"name":"لسانيات عامة","symbol":"ل","axes":[{"name":"برنامج اللسانيات العامة","chapters":[["اللسانيات: مدخل مفاهيمي",["مفهوم اللسانيات ومدخلها المفاهيمي"]],["آراء وأفكار دي سوسير",["أهم آراء وأفكار فرديناند دي سوسير"]],["اللسان: نظام من الأبنية الوضعية",["اللسان بوصفه نظاماً من الأبنية الوضعية"]],["اللسان والوسائل التبليغية",["اللسان والوسائل التبليغية"]],["دورة التخاطب ووظائف اللسان",["دورة التخاطب","وظائف اللسان"]]]}]}];
const subjectsGrid=document.getElementById("subjectsGrid"),subjectSearch=document.getElementById("subjectSearch"),subjectDetail=document.getElementById("subjectDetail");
function renderSubjects(){const q=(subjectSearch.value||"").trim().toLocaleLowerCase("ar");const list=subjectData.filter(x=>(x.name+" "+x.axes.map(a=>a.name+" "+a.chapters.map(c=>c[0]+" "+c[1].join(" ")).join(" ")).join(" ")).toLocaleLowerCase("ar").includes(q));document.getElementById("subjectCount").textContent=list.length+" من "+subjectData.length+" مقاييس";subjectsGrid.innerHTML=list.length?list.map((x,i)=>'<button class="subject-card" data-subject="'+subjectData.indexOf(x)+'"><span class="subject-symbol">'+x.symbol+'</span><b>'+x.name+'</b><small>'+x.axes.length+' محاور · '+x.axes.reduce((n,a)=>n+a.chapters.length,0)+' وحدات</small><span class="subject-open">عرض البرنامج ←</span></button>').join(""):'<div class="subject-empty">لا توجد مادة أو محور يطابق البحث.</div>';subjectsGrid.querySelectorAll("[data-subject]").forEach(b=>b.addEventListener("click",()=>openSubject(Number(b.dataset.subject))));}
function openSubject(i){const x=subjectData[i];if(!x)return;document.getElementById("detailTitle").textContent=x.name;document.getElementById("detailSymbol").textContent=x.symbol;const programImage=document.getElementById("subjectProgramImage"),programThumb=document.getElementById("subjectProgramImageThumb");if(x.programImage){programThumb.src=x.programImage;programThumb.alt="صورة برنامج "+x.name;programImage.hidden=false;}else{programThumb.removeAttribute("src");programImage.hidden=true;}document.getElementById("detailAxes").innerHTML=x.axes.map((a,ai)=>'<section class="subject-axis"><div class="subject-axis-head"><span class="subject-axis-tag">المحور '+(ai+1)+'</span><h3>'+a.name+'</h3></div><div class="subject-chapters">'+a.chapters.map((c,ci)=>'<details class="subject-chapter"><summary><span class="chapter-num">'+String(ci+1).padStart(2,"0")+'</span><span>'+c[0]+'</span></summary><ul>'+c[1].map(t=>'<li>'+t+'</li>').join("")+'</ul></details>').join("")+'</div></section>').join("");subjectsGrid.hidden=true;document.querySelector(".subjects-toolbar").hidden=true;subjectDetail.hidden=false;subjectDetail.scrollIntoView({behavior:"smooth",block:"start"});}
const programImageDialog=document.getElementById("programImageDialog");
document.getElementById("subjectProgramImage").addEventListener("click",()=>{const src=document.getElementById("subjectProgramImageThumb").src;if(!src)return;document.getElementById("programImageDialogFull").src=src;programImageDialog.showModal();});
document.getElementById("programImageDialogClose").addEventListener("click",()=>programImageDialog.close());
programImageDialog.addEventListener("click",event=>{if(event.target===programImageDialog)programImageDialog.close();});
document.getElementById("subjectBack").addEventListener("click",()=>{subjectDetail.hidden=true;subjectsGrid.hidden=false;document.querySelector(".subjects-toolbar").hidden=false;subjectDetail.scrollIntoView({behavior:"smooth",block:"start"});});
subjectSearch.addEventListener("input",renderSubjects);renderSubjects();

/* Interactive lesson subject cards: lift the selected card, then reveal its study outline */
const lessonList=document.getElementById("lessonList");
let activeLessonCard=null;
let lessonSubjectDialog=null;

lessonDialogScrollY=0;
let lessonDialogSavedStyles=null;
let lessonDialogCloseTimer=null;
function lockLessonPage(){
 const body=document.body,html=document.documentElement;
 lessonDialogScrollY=window.scrollY||window.pageYOffset||0;
 lessonDialogSavedStyles={body:{position:body.style.position,top:body.style.top,left:body.style.left,right:body.style.right,width:body.style.width,overflow:body.style.overflow,paddingRight:body.style.paddingRight},htmlOverflow:html.style.overflow,htmlScrollBehavior:html.style.scrollBehavior};
 const gap=Math.max(0,window.innerWidth-html.clientWidth);
 body.style.position="fixed";body.style.top="-"+lessonDialogScrollY+"px";body.style.left="0";body.style.right="0";body.style.width="100%";body.style.overflow="hidden";
 if(gap)body.style.paddingRight=gap+"px";
 html.style.overflow="hidden";
}
function unlockLessonPage(){
 if(!lessonDialogSavedStyles)return;
 const body=document.body,html=document.documentElement,old=lessonDialogSavedStyles;
 Object.assign(body.style,old.body);html.style.overflow=old.htmlOverflow;html.style.scrollBehavior="auto";
 window.scrollTo(0,lessonDialogScrollY);html.style.scrollBehavior=old.htmlScrollBehavior;lessonDialogSavedStyles=null;
}
function closeLessonSubjectDialog(){
 if(!lessonSubjectDialog)return;
 const old=lessonSubjectDialog,card=activeLessonCard;
 lessonSubjectDialog=null;if(card)card.classList.remove("is-selected");old.classList.remove("is-visible");
 const delay=window.matchMedia("(prefers-reduced-motion: reduce)").matches?0:220;
 window.clearTimeout(lessonDialogCloseTimer);
 lessonDialogCloseTimer=window.setTimeout(()=>{old.remove();unlockLessonPage();if(card)card.focus({preventScroll:true});if(activeLessonCard===card)activeLessonCard=null;},delay);
}
function openLessonSubjectDialog(card){
 const title=card.querySelector(".lesson-card-title")?.textContent?.trim()||card.dataset.search||"المقياس";
 if(lessonSubjectDialog){
  const old=lessonSubjectDialog;window.clearTimeout(lessonDialogCloseTimer);old.remove();lessonSubjectDialog=null;
  if(activeLessonCard)activeLessonCard.classList.remove("is-selected");unlockLessonPage();
 }
 activeLessonCard=card;card.classList.add("is-selected");card.setAttribute("tabindex","0");
 const subjectIndex=lessonSubjects.indexOf(title);
 const subject=subjectData.find(item=>item.name===title);
 const axes=subject?.axes||[];
 const escapeLessonHTML=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
 const axesMarkup=axes.length?axes.map((axis,axisIndex)=>{
  const units=axis.chapters.map((chapter,chapterIndex)=>{
   const key=lessonKey(currentGroup,subjectIndex,axisIndex,chapterIndex);
   const files=PUBLISHED_LESSONS[key]||[];
   const published=files.length>0;
   const filesMarkup=files.map(file=>{
    const fileKey=encodeURIComponent(file.key);
    const name=escapeLessonHTML(file.name||"ملف مرفق");
    const isPdf=file.type==="application/pdf"||/\.pdf$/i.test(file.name||"");
    const kind=isPdf?"PDF":"Word";
    const icon=isPdf
     ?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.8h8l4.2 4.3v14.1H6z"/><path d="M14 2.8v4.5h4.2M8.5 13h7M8.5 16h7"/></svg>'
     :'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.8h8l4.2 4.3v14.1H6z"/><path d="M14 2.8v4.5h4.2M8.5 13l2 4 2-4 2 4 2-4"/></svg>';
    const openLink=isPdf?'<a class="lesson-file-open" href="/api/file?key='+fileKey+'" target="_blank" rel="noopener">فتح</a>':'';
    return '<div class="lesson-file-row"><span class="lesson-file-type '+(isPdf?'is-pdf':'is-word')+'">'+icon+'<small>'+kind+'</small></span><span class="lesson-file-name" title="'+name+'">'+name+'</span><div class="lesson-file-actions">'+openLink+'<a class="lesson-file-download" href="/api/file?key='+fileKey+'&download=1" download>تحميل</a>'+(LESSON_ADMIN?'<button class="lesson-file-replace" type="button" data-replace-trigger="'+fileKey+'" aria-label="استبدال '+name+'">استبدال</button><input class="lesson-file-replace-input" type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" data-replace-file="'+fileKey+'" data-replace-key="'+escapeLessonHTML(file.key)+'" data-replace-lesson-key="'+escapeLessonHTML(file.lessonKey||"")+'"><button class="lesson-file-delete" type="button" data-delete-key="'+escapeLessonHTML(file.key)+'" aria-label="حذف '+name+'">حذف</button>':'')+'</div></div>';
   }).join("");
   const uploadMarkup=LESSON_ADMIN?'<div class="lesson-unit-actions"><span class="lesson-upload-control"><button class="lesson-admin-upload" type="button" data-pick-upload-key="'+key+'">＋ إضافة ملفات</button><input class="lesson-upload-input" type="file" multiple accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" aria-label="اختيار ملفات للدرس" data-upload-key="'+key+'"></span></div>':'';
   const lessonHead='<b>'+String(chapterIndex+1).padStart(2,"0")+'</b><span class="lesson-dialog-unit-name">'+chapter[0]+'</span><span class="lesson-unit-status">'+(published?files.length+" "+(files.length===1?"ملف منشور":"ملفات منشورة"):"لا توجد ملفات")+'</span>';
   return published
    ?'<details class="lesson-dialog-chapter lesson-dialog-lesson is-published"><summary>'+lessonHead+'<i aria-hidden="true">⌄</i></summary><div class="lesson-file-list">'+filesMarkup+'</div>'+uploadMarkup+'</details>'
    :'<div class="lesson-dialog-chapter lesson-dialog-lesson is-unpublished"><div class="lesson-dialog-lesson-head">'+lessonHead+'</div>'+uploadMarkup+'</div>';
  }).join("");
  const hasPublished=axis.chapters.some((chapter,chapterIndex)=>(PUBLISHED_LESSONS[lessonKey(currentGroup,subjectIndex,axisIndex,chapterIndex)]||[]).length>0);
  return '<section class="lesson-dialog-axis '+(hasPublished?'has-published':'off')+'"><div class="lesson-dialog-axis-title"><span>المحور '+String(axisIndex+1).padStart(2,"0")+'</span><h3>'+axis.name+'</h3></div><div class="lesson-dialog-chapters">'+units+'</div></section>';
 }).join(""):'<div class="lesson-dialog-empty">لا توجد محاور مسجلة لهذا المقياس حالياً.</div>';
 const dialog=document.createElement("div");dialog.className="lesson-subject-dialog";
 dialog.innerHTML='<div class="lesson-dialog-backdrop" data-dialog-close></div><section class="lesson-dialog-panel" role="dialog" aria-modal="true" aria-labelledby="lessonDialogTitle" tabindex="-1"><button class="lesson-dialog-close" type="button" aria-label="إغلاق" data-dialog-close>×</button><div class="lesson-dialog-kicker">المحاضرات والدروس · المجموعة '+currentGroup+'</div><div class="lesson-dialog-heading"><span class="lesson-dialog-symbol">'+(card.querySelector(".lesson-card-index")?.textContent||"م")+'</span><div><h2 id="lessonDialogTitle">'+title+'</h2><p>المحاور والوحدات والمحاضرات المنشورة</p></div></div><div class="lesson-dialog-content">'+axesMarkup+'</div><div class="lesson-admin-footer">'+(LESSON_ADMIN?'<div class="lesson-admin-active"><span>وضع إدارة المحاضرات مفعّل</span><button type="button" data-admin-logout>تسجيل الخروج</button></div>':'<button type="button" class="lesson-admin-lock" data-admin-toggle><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg><span>إدارة المحاضرات</span></button><div class="lesson-admin-login" data-admin-login hidden><label for="lessonAdminCode">رمز إدارة المجموعة '+currentGroup+'</label><div class="lesson-admin-login-row"><input id="lessonAdminCode" type="password" autocomplete="current-password" placeholder="أدخل الرمز"><button type="button" data-admin-submit>دخول</button></div><p class="lesson-admin-message" aria-live="polite"></p></div>')+'</div></section>';
 const cardStyle=getComputedStyle(card);
 ["--lesson-bg","--lesson-border","--lesson-accent","--lesson-chip","--lesson-ink"].forEach(name=>{const value=cardStyle.getPropertyValue(name).trim();if(value)dialog.style.setProperty(name,value);});
 document.body.appendChild(dialog);lessonSubjectDialog=dialog;lockLessonPage();
 requestAnimationFrame(()=>dialog.classList.add("is-visible"));
 dialog.querySelectorAll("[data-dialog-close]").forEach(el=>el.addEventListener("click",closeLessonSubjectDialog));
 dialog.querySelector(".lesson-dialog-panel").focus({preventScroll:true});
 const toggle=dialog.querySelector("[data-admin-toggle]");
 if(toggle)toggle.addEventListener("click",()=>{const login=dialog.querySelector("[data-admin-login]");login.hidden=!login.hidden;if(!login.hidden)dialog.querySelector("#lessonAdminCode").focus();});
 const submit=dialog.querySelector("[data-admin-submit]");
 if(submit)submit.addEventListener("click",async()=>{
  const input=dialog.querySelector("#lessonAdminCode"),message=dialog.querySelector(".lesson-admin-message"),code=input.value.trim();
  if(!code){message.textContent="أدخل رمز الإدارة أولاً.";return;}
  submit.disabled=true;submit.textContent="جارٍ التحقق…";
  try{
   const response=await fetch("/api/admin/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({role:"lesson-"+currentGroup,code}),cache:"no-store"});
   let result={};try{result=await response.json();}catch(e){}
   if(!response.ok){
    if(response.status===401)throw new Error("رمز الإدارة غير صحيح.");
    if(result.error==="admin_code_not_configured")throw new Error("رمز الإدارة غير مضبوط في إعدادات Cloudflare Worker.");
    if(result.error==="storage_not_configured"){
     const missing=Array.isArray(result.missing)?result.missing.join("، "):"إعدادات B2";
     throw new Error("إعدادات التخزين التالية غير مضبوطة في Cloudflare Worker: "+missing);
    }
    throw new Error("تعذر الاتصال بخدمة الإدارة ("+response.status+"). افتح رابط منصة Cloudflare Workers وليس GitHub Pages.");
   }
   LESSON_ADMIN=true;LESSON_ADMIN_CODE="session";LESSON_ADMIN_GROUP=currentGroup;
   openLessonSubjectDialog(card);
  }catch(error){message.textContent=error.message||"تعذر التحقق من الرمز.";submit.disabled=false;submit.textContent="دخول";}
 });
 const logout=dialog.querySelector("[data-admin-logout]");
 if(logout)logout.addEventListener("click",()=>{
  LESSON_ADMIN=false;LESSON_ADMIN_CODE="";LESSON_ADMIN_GROUP="";
  fetch("/api/admin/session",{method:"DELETE"}).catch(()=>{});
  openLessonSubjectDialog(card);
 });
 dialog.querySelectorAll("[data-pick-upload-key]").forEach(button=>button.addEventListener("click",event=>{
  event.preventDefault();event.stopPropagation();
  const input=dialog.querySelector('[data-upload-key="'+button.dataset.pickUploadKey+'"]');
  if(input)input.click();
 }));
 dialog.querySelectorAll("[data-upload-key]").forEach(input=>input.addEventListener("change",async(event)=>{
  event.preventDefault();event.stopPropagation();
  const files=Array.from(input.files||[]),key=input.dataset.uploadKey;
  if(!files.length)return;
  const allowed=/\.(pdf|doc|docx)$/i;
  for(const file of files){
   if(!allowed.test(file.name)){alert("يمكن رفع ملفات PDF أو Word فقط.");input.value="";return;}
   if(file.size>4200000){alert("حجم الملف "+file.name+" يتجاوز الحد المسموح (4.2 ميغابايت).");input.value="";return;}
  }
  const label=input.closest(".lesson-unit-actions")?.querySelector(".lesson-admin-upload");
  if(!label)return;
  label.disabled=true;input.disabled=true;label.classList.add("is-busy");
  const originalLabel=label.textContent;
  label.textContent="جارٍ رفع "+files.length+" ملف…";
  let uploaded=0;
  try{
   for(const file of files){
    const response=await fetch("/api/file?key="+encodeURIComponent(key)+"&name="+encodeURIComponent(file.name),{
     method:"POST",
     headers:{"content-type":file.type||"application/octet-stream"},
     body:file,
     cache:"no-store",
     redirect:"error"
    });
    let result={};
    try{result=await response.json();}catch(e){throw new Error("استجابة الخادم غير صالحة؛ تحقق من نشر Worker.");}
    if(!response.ok||result.ok!==true){
     if(result.error==="storage_not_configured"){
      const missing=Array.isArray(result.missing)?result.missing.join("، "):"إعدادات B2";
      throw new Error("إعدادات التخزين ناقصة في Worker: "+missing);
     }
     throw new Error([file.name,result.error,result.message].filter(Boolean).join(": ")||("HTTP "+response.status));
    }
    uploaded++;
   }
   await refreshPublishedLessons(false);
   renderLessonSubjects(currentGroup);
   openLessonSubjectDialog(card);
  }catch(error){
   console.error("Lesson files upload failed:",error);
   await refreshPublishedLessons(false);
   renderLessonSubjects(currentGroup);
   openLessonSubjectDialog(card);
   alert("تم رفع "+uploaded+" من "+files.length+" ملف. تعذر إكمال البقية: "+error.message);
  }
 }));
 dialog.querySelectorAll("[data-replace-trigger]").forEach(button=>button.addEventListener("click",()=>{
  const input=dialog.querySelector('[data-replace-file="'+button.dataset.replaceTrigger+'"]');
  if(input)input.click();
 }));
 dialog.querySelectorAll("[data-replace-file]").forEach(input=>input.addEventListener("change",async()=>{
  const file=input.files?.[0],oldKey=input.dataset.replaceKey,lessonKeyValue=input.dataset.replaceLessonKey;
  if(!file)return;
  if(!/\.(pdf|doc|docx)$/i.test(file.name)){alert("يمكن استبدال الملف بملف PDF أو Word فقط.");input.value="";return;}
  if(file.size>4200000){alert("حجم الملف يتجاوز الحد المسموح (4.2 ميغابايت).");input.value="";return;}
  const button=input.closest(".lesson-file-actions")?.querySelector(".lesson-file-replace");
  if(!button)return;
  button.disabled=true;button.textContent="جارٍ الاستبدال…";
  try{
   const response=await fetch("/api/file?key="+encodeURIComponent(lessonKeyValue)+"&name="+encodeURIComponent(file.name),{
    method:"POST",headers:{"content-type":file.type||"application/octet-stream"},body:file,cache:"no-store",redirect:"error"
   });
   let result={};try{result=await response.json();}catch(e){throw new Error("استجابة الخادم غير صالحة.");}
   if(!response.ok||result.ok!==true)throw new Error([result.error,result.message].filter(Boolean).join(": ")||("HTTP "+response.status));
   const remove=await fetch("/api/file?key="+encodeURIComponent(oldKey),{method:"DELETE",headers:{}});
   if(!remove.ok)throw new Error("تم رفع الملف الجديد، لكن تعذر حذف النسخة القديمة.");
   await refreshPublishedLessons(false);renderLessonSubjects(currentGroup);openLessonSubjectDialog(card);
  }catch(error){
   console.error("Lesson file replace failed:",error);
   await refreshPublishedLessons(false);renderLessonSubjects(currentGroup);openLessonSubjectDialog(card);
   alert("تعذر إكمال الاستبدال: "+(error.message||"خطأ غير معروف"));
  }
 }));
 dialog.querySelectorAll("[data-delete-key]").forEach(button=>button.addEventListener("click",async()=>{
  const key=button.dataset.deleteKey;
  if(!confirm("هل تريد حذف هذا الملف فقط؟"))return;
  button.disabled=true;button.textContent="جارٍ الحذف…";
  try{
   const response=await fetch("/api/file?key="+encodeURIComponent(key),{method:"DELETE",headers:{}});
   if(!response.ok){let reason="";try{const detail=await response.json();reason=[detail.error,detail.message].filter(Boolean).join(": ");}catch(e){}throw new Error(reason||("HTTP "+response.status));}
   await refreshPublishedLessons(false);
   renderLessonSubjects(currentGroup);
   openLessonSubjectDialog(card);
  }catch(error){console.error("Lecture delete failed:",error);alert("تعذر حذف المحاضرة ("+error.message+"). تحقق من صلاحية الإدارة واتصال التخزين.");button.disabled=false;button.textContent="حذف";}
 }));
}
lessonList?.addEventListener("click",event=>{
 const card=event.target.closest(".lesson-subject-card");
 if(card&&!card.hidden)openLessonSubjectDialog(card);
});
lessonList?.addEventListener("keydown",event=>{
 if((event.key==="Enter"||event.key===" ")&&event.target.classList.contains("lesson-subject-card")){
  event.preventDefault();openLessonSubjectDialog(event.target);
 }
});
document.addEventListener("keydown",event=>{
 if(event.key==="Escape"&&lessonSubjectDialog)closeLessonSubjectDialog();
});




const RESOURCE_KINDS=["كتاب","درس ومحاضرة","ملخص","تمارين محلولة","سلسلة تمارين","امتحانات سابقة","مراجع أخرى"];
const RESOURCE_YEARS=["السنة 1","السنة 2","السنة 3","السنة 4","السنة 5","السنة 6"];
const RESOURCE_SEMESTERS=["السداسي 1","السداسي 2"];
const RESOURCE_SUBJECTS=Array.isArray(lessonSubjects)?lessonSubjects.slice():["علم الأحياء","الصرف العربي","قضايا النقد","الرياضيات","الذكاء الاصطناعي في التعلم","علم نفس النمو: الطفل والمراهق","التربية الإسلامية","النحو العربي","اللغة الإنجليزية","لسانيات عامة"];
let RESOURCE_ITEMS=[],RESOURCE_ADMIN_CODE="";
const resourceEscape=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const resourceColor=(value,group)=>{const source=group==="subject"?RESOURCE_SUBJECTS:group==="semester"?RESOURCE_SEMESTERS:RESOURCE_KINDS;const index=source.indexOf(value);return index<0?1:index+1};
function resourceOptions(id,values,placeholder){const el=document.getElementById(id);if(!el)return;el.innerHTML='<option value="">'+placeholder+'</option>'+values.map(v=>'<option value="'+resourceEscape(v)+'">'+resourceEscape(v)+'</option>').join("");}
function resourceInitSelects(){
 resourceOptions("resourceFilterSubject",RESOURCE_SUBJECTS,"كل المقاييس");resourceOptions("resourceUploadSubject",RESOURCE_SUBJECTS,"اختر المقياس");
 resourceOptions("resourceFilterYear",RESOURCE_YEARS,"كل السنوات");resourceOptions("resourceUploadYear",RESOURCE_YEARS,"اختر السنة");
 resourceOptions("resourceFilterSemester",RESOURCE_SEMESTERS,"كل السداسيات");resourceOptions("resourceUploadSemester",RESOURCE_SEMESTERS,"اختر السداسي");
 resourceOptions("resourceFilterKind",RESOURCE_KINDS,"كل الأنواع");resourceOptions("resourceUploadKind",RESOURCE_KINDS,"اختر نوع المورد");
}
function resourceFileUrl(item,download=false){return "/api/resource?key="+encodeURIComponent(item.fileKey)+(download?"&download=1":"")}
function resourceMatches(item){const subject=document.getElementById("resourceFilterSubject").value,year=document.getElementById("resourceFilterYear").value,semester=document.getElementById("resourceFilterSemester").value,kind=document.getElementById("resourceFilterKind").value,q=document.getElementById("resourceSearch").value.trim().toLocaleLowerCase("ar");return(!subject||item.subject===subject)&&(!year||item.year===year)&&(!semester||item.semester===semester)&&(!kind||item.kind===kind)&&(!q||[item.title,item.subject,item.fileName].join(" ").toLocaleLowerCase("ar").includes(q))}
let RESOURCE_KNOWN_IDS=new Set(),RESOURCE_SEEN_IDS=new Set(),RESOURCE_TRACKING_READY=false;
try{RESOURCE_KNOWN_IDS=new Set(JSON.parse(localStorage.getItem("ensd_resource_known_ids")||"[]"));RESOURCE_SEEN_IDS=new Set(JSON.parse(localStorage.getItem("ensd_resource_seen_ids")||"[]"));}catch(e){}
function resourceSaveNotificationState(){try{localStorage.setItem("ensd_resource_known_ids",JSON.stringify([...RESOURCE_KNOWN_IDS]));localStorage.setItem("ensd_resource_seen_ids",JSON.stringify([...RESOURCE_SEEN_IDS]));}catch(e){}}
function resourcePaintNotification(){const badge=document.getElementById("resourceNavBadge");if(!badge)return;const count=[...RESOURCE_KNOWN_IDS].filter(id=>!RESOURCE_SEEN_IDS.has(id)).length;badge.hidden=!count;badge.textContent=count>9?"9+":String(count);const nav=document.querySelector('[data-page="resources"]');if(nav)nav.setAttribute("aria-label",count?("الموارد، "+count+" موارد جديدة"):"الموارد");}
function resourceMarkNotificationsSeen(){RESOURCE_SEEN_IDS=new Set(RESOURCE_KNOWN_IDS);resourceSaveNotificationState();resourcePaintNotification();}
function resourceTrackApprovedResources(items){const ids=items.map(item=>String(item.id)).filter(Boolean);if(!RESOURCE_TRACKING_READY){if(!RESOURCE_KNOWN_IDS.size){RESOURCE_KNOWN_IDS=new Set(ids);RESOURCE_SEEN_IDS=new Set(ids);}else ids.forEach(id=>RESOURCE_KNOWN_IDS.add(id));RESOURCE_TRACKING_READY=true;}else ids.forEach(id=>RESOURCE_KNOWN_IDS.add(id));resourceSaveNotificationState();resourcePaintNotification();}
function resourceCheckForNewApproved(){fetch("/api/resources",{cache:"no-store"}).then(r=>{if(!r.ok)throw new Error("resources unavailable");return r.json();}).then(items=>{if(Array.isArray(items))resourceTrackApprovedResources(items);}).catch(()=>{});}
setInterval(resourceCheckForNewApproved,45000);
function renderResourceItems(){
 const list=document.getElementById("resourceList"),items=RESOURCE_ITEMS.filter(resourceMatches);document.getElementById("resourceCount").textContent=RESOURCE_ITEMS.length;
 if(!items.length){list.innerHTML='<div class="resource-empty">'+(RESOURCE_ITEMS.length?"لا توجد موارد تطابق التصنيفات المختارة.":"لم تُنشر موارد بعد. يمكنك أن تكون أول من يشارك مورداً.")+'</div>';return;}
 list.innerHTML=items.map(item=>'<article class="resource-card" data-fav-key="resource-'+resourceEscape(item.id)+'"><div class="resource-card-top"><span class="resource-tag subject-tag tone-'+resourceColor(item.subject,"subject")+'">'+resourceEscape(item.subject)+'</span><span class="resource-tag semester-tag tone-'+resourceColor(item.semester,"semester")+'">'+resourceEscape(item.semester)+'</span><span class="resource-tag kind-tag tone-'+resourceColor(item.kind,"kind")+'">'+resourceEscape(item.kind)+'</span></div><div class="resource-card-body"><div class="resource-file-icon '+(item.contentType==="application/pdf"?"pdf":"word")+'">'+(item.contentType==="application/pdf"?"PDF":"DOC")+'</div><div class="resource-card-main"><h4>'+resourceEscape(item.title||item.fileName)+'</h4><small>'+resourceEscape(item.fileName)+'</small></div><div class="resource-card-actions"><a href="'+resourceFileUrl(item)+'" target="_blank" rel="noopener">فتح</a><a href="'+resourceFileUrl(item,true)+'">تحميل</a></div></div></article>').join("");
}
async function loadResources(){const list=document.getElementById("resourceList");list.innerHTML='<div class="resource-empty">جارٍ تحديث المكتبة...</div>';try{const r=await fetch("/api/resources",{cache:"no-store"});if(!r.ok)throw new Error("HTTP "+r.status);RESOURCE_ITEMS=await r.json();if(!Array.isArray(RESOURCE_ITEMS))throw new Error("invalid response");resourceTrackApprovedResources(RESOURCE_ITEMS);renderResourceItems();}catch(e){list.innerHTML='<div class="resource-empty">تعذر تحميل الموارد. تحقق من اتصال المنصة ثم حاول التحديث.</div>';}}

// Keep modal roots as direct body children so fixed overlays are viewport-relative,
// never constrained by transformed/filtered page sections.
["resourceBrowseModal","resourceUploadModal"].forEach(id=>{const modal=document.getElementById(id);if(modal&&modal.parentElement!==document.body)document.body.appendChild(modal);});
function resourceBuildCustomSelect(select){
 if(!select||select.dataset.customReady)return;
 select.dataset.customReady="1";
 const wrap=document.createElement("div");wrap.className="resource-select-wrap";
 const trigger=document.createElement("button");trigger.type="button";trigger.className="resource-select-trigger";trigger.setAttribute("aria-haspopup","listbox");trigger.setAttribute("aria-expanded","false");
 const label=document.createElement("span");label.className="resource-select-value";
 const arrow=document.createElement("span");arrow.className="resource-select-arrow";arrow.setAttribute("aria-hidden","true");arrow.textContent="⌄";
 trigger.append(label,arrow);
 const menu=document.createElement("div");menu.className="resource-select-menu";menu.setAttribute("role","listbox");menu.hidden=true;
 const sync=()=>{const opt=select.options[select.selectedIndex];label.textContent=opt?opt.text: select.getAttribute("aria-label")||"اختر";trigger.classList.toggle("has-value",!!select.value);menu.querySelectorAll("[role=option]").forEach(b=>{const yes=b.dataset.value===select.value;b.classList.toggle("selected",yes);b.setAttribute("aria-selected",String(yes));});};
 const close=()=>{menu.hidden=true;trigger.setAttribute("aria-expanded","false");trigger.classList.remove("opened");};
 const open=()=>{document.querySelectorAll(".resource-select-menu:not([hidden])").forEach(m=>{if(m!==menu){m.hidden=true;m.previousElementSibling?.setAttribute("aria-expanded","false");}});menu.innerHTML="";
  Array.from(select.options).forEach(opt=>{const b=document.createElement("button");b.type="button";b.className="resource-select-option";b.setAttribute("role","option");b.dataset.value=opt.value;b.textContent=opt.text;b.addEventListener("click",()=>{select.value=opt.value;select.dispatchEvent(new Event("change",{bubbles:true}));sync();close();trigger.focus();});menu.appendChild(b);});
  menu.hidden=false;trigger.setAttribute("aria-expanded","true");trigger.classList.add("opened");
  const r=trigger.getBoundingClientRect(),spaceBelow=innerHeight-r.bottom,spaceAbove=r.top,maxH=Math.min(300,Math.max(150,Math.max(spaceBelow,spaceAbove)-12));
  menu.style.maxHeight=maxH+"px";menu.style.left=Math.max(10,Math.min(r.left,innerWidth-r.width-10))+"px";menu.style.width=Math.min(r.width,innerWidth-20)+"px";
  if(spaceBelow>=Math.min(220,maxH)){menu.style.top=(r.bottom+7)+"px";menu.style.bottom="auto";}else{menu.style.bottom=(innerHeight-r.top+7)+"px";menu.style.top="auto";}
  sync();
 };
 wrap.append(trigger);select.parentNode.insertBefore(wrap,select);wrap.appendChild(select);document.body.appendChild(menu);
 select.classList.add("resource-native-select");select.tabIndex=-1;select.setAttribute("aria-hidden","true");
 trigger.addEventListener("click",()=>menu.hidden?open():close());
 select.addEventListener("change",sync);document.addEventListener("pointerdown",e=>{if(!wrap.contains(e.target)&&!menu.contains(e.target))close();});
 document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!menu.hidden){close();trigger.focus();}});
 sync();
}
["resourceFilterSubject","resourceUploadSubject","resourceFilterYear","resourceUploadYear","resourceFilterSemester","resourceUploadSemester","resourceFilterKind","resourceUploadKind"].forEach(id=>resourceBuildCustomSelect(document.getElementById(id)));

// Single accessible dialog API for resource success, warnings and destructive actions.
let RESOURCE_DIALOG_CALLBACKS=null,RESOURCE_DIALOG_TRIGGER=null;
function closeDialog(reason="cancel"){const overlay=document.getElementById("resourceDialogOverlay");if(!overlay||!overlay.classList.contains("is-open")||overlay.classList.contains("is-closing"))return;const callbacks=RESOURCE_DIALOG_CALLBACKS;RESOURCE_DIALOG_CALLBACKS=null;overlay.classList.add("is-closing");overlay.setAttribute("aria-hidden","true");document.body.classList.remove("resource-dialog-open");const trigger=RESOURCE_DIALOG_TRIGGER;RESOURCE_DIALOG_TRIGGER=null;const finish=()=>{overlay.classList.remove("is-open","is-closing");if(reason==="confirm")callbacks?.onConfirm?.();else callbacks?.onCancel?.();if(trigger&&trigger.isConnected)trigger.focus();};const reduced=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;if(reduced)finish();else window.setTimeout(finish,210);}
function showDialog(options={}){const overlay=document.getElementById("resourceDialogOverlay");if(!overlay)return;if(overlay.classList.contains("is-open")){overlay.classList.remove("is-closing");closeDialog("cancel");}overlay.classList.remove("is-closing");overlay.classList.add("is-open");RESOURCE_DIALOG_TRIGGER=document.activeElement;RESOURCE_DIALOG_CALLBACKS={onConfirm:options.onConfirm,onCancel:options.onCancel};const dialog=overlay.querySelector(".resource-dialog"),icon=dialog.querySelector(".resource-dialog-icon"),cancel=dialog.querySelector(".resource-dialog-cancel"),confirm=dialog.querySelector(".resource-dialog-confirm"),actions=dialog.querySelector(".resource-dialog-actions");const type=["success","warning","danger"].includes(options.type)?options.type:"warning";dialog.dataset.type=type;icon.textContent=type==="success"?"✓":type==="danger"?"✕":"!";document.getElementById("resourceDialogTitle").textContent=options.title||"تنبيه";document.getElementById("resourceDialogMessage").textContent=options.message||"";confirm.textContent=options.confirmText||"حسنًا";cancel.textContent=options.cancelText||"إلغاء";const hasCancel=!!options.cancelText||!!options.onCancel||type==="danger";actions.classList.toggle("single",!hasCancel);overlay.classList.add("is-open");overlay.setAttribute("aria-hidden","false");document.body.classList.add("resource-dialog-open");requestAnimationFrame(()=>confirm.focus());}
function initResourceDialog(){const overlay=document.getElementById("resourceDialogOverlay");if(!overlay||overlay.dataset.bound==="1")return;overlay.dataset.bound="1";overlay.addEventListener("click",e=>{if(e.target===overlay)closeDialog("cancel");});overlay.querySelector(".resource-dialog-confirm").addEventListener("click",()=>closeDialog("confirm"));overlay.querySelector(".resource-dialog-cancel").addEventListener("click",()=>closeDialog("cancel"));document.addEventListener("keydown",e=>{if(e.key==="Escape"&&overlay.classList.contains("is-open")){e.preventDefault();closeDialog("cancel");}});}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",initResourceDialog,{once:true});else initResourceDialog();

let RESOURCE_MODAL_TRIGGER=null;

// Drag or tap the top handle to expand/collapse the resource sheet.
(function(){const modal=document.getElementById("resourceBrowseModal"),panel=modal?.querySelector(".resource-browse-sheet"),handle=modal?.querySelector(".resource-sheet-handle"),openButton=document.getElementById("resourceBrowseOpen");if(!panel||!handle)return;const normalHeight="80dvh",expandedHeight="calc(100dvh - env(safe-area-inset-top, 0px) - 8px)";let startY=0,lastY=0,startHeight=0,dragging=false,oldTransition="",oldTransitionPriority="";const setHeight=value=>{panel.style.setProperty("height",value,"important");panel.style.setProperty("max-height",value,"important");panel.style.setProperty("min-height","0px","important");};const safeTop=()=>{const probe=document.createElement("div");probe.style.cssText="position:absolute;visibility:hidden;padding-top:env(safe-area-inset-top, 0px)";document.body.appendChild(probe);const n=parseFloat(getComputedStyle(probe).paddingTop)||0;probe.remove();return n;};const maxHeight=()=>Math.max(0,window.innerHeight-safeTop()-8);const reset=()=>{panel.classList.remove("is-expanded");panel.style.removeProperty("transform");setHeight(normalHeight);panel.style.setProperty("transition","height .3s ease, transform .24s cubic-bezier(.2,.75,.25,1), opacity .22s ease","important");};if(openButton)openButton.addEventListener("click",reset);handle.addEventListener("pointerdown",e=>{if(e.button!==undefined&&e.button!==0)return;dragging=true;startY=lastY=e.clientY;startHeight=panel.getBoundingClientRect().height;oldTransition=panel.style.getPropertyValue("transition");oldTransitionPriority=panel.style.getPropertyPriority("transition");panel.style.setProperty("transition","none","important");handle.setPointerCapture(e.pointerId);e.preventDefault();});handle.addEventListener("pointermove",e=>{if(!dragging)return;lastY=e.clientY;const delta=lastY-startY;if(panel.classList.contains("is-expanded")&&delta>0){setHeight(Math.max(80*window.innerHeight/100,startHeight-delta)+"px");panel.style.removeProperty("transform");}else if(!panel.classList.contains("is-expanded")&&delta<0){setHeight(Math.min(maxHeight(),startHeight-delta)+"px");panel.style.removeProperty("transform");}else if(!panel.classList.contains("is-expanded")&&delta>0){setHeight(normalHeight);panel.style.setProperty("transform","translateY("+Math.min(delta,window.innerHeight*.7)+"px)","important");}else{setHeight(normalHeight);panel.style.removeProperty("transform");}});const finish=()=>{if(!dragging)return;dragging=false;const delta=lastY-startY;panel.style.removeProperty("transform");if(oldTransition)panel.style.setProperty("transition",oldTransition,oldTransitionPriority);else panel.style.removeProperty("transition");if(Math.abs(delta)<8){if(panel.classList.contains("is-expanded")){panel.classList.remove("is-expanded");setHeight(normalHeight);}else{panel.classList.add("is-expanded");setHeight(expandedHeight);}return;}if(delta< -40&&!panel.classList.contains("is-expanded")){panel.classList.add("is-expanded");setHeight(expandedHeight);}else if(delta>40&&panel.classList.contains("is-expanded")){panel.classList.remove("is-expanded");setHeight(normalHeight);}else if(delta>95&&!panel.classList.contains("is-expanded")){setHeight(normalHeight);resourceCloseModal(modal);}else{setHeight(panel.classList.contains("is-expanded")?expandedHeight:normalHeight);}};handle.addEventListener("pointerup",finish);handle.addEventListener("pointercancel",finish);})();
function resourceOpenModal(id){const modal=document.getElementById(id);if(!modal)return;modal.classList.remove("is-closing");modal.classList.add("is-open");modal.setAttribute("aria-hidden","false");RESOURCE_MODAL_TRIGGER=document.activeElement;document.body.classList.add("resource-modal-open");requestAnimationFrame(()=>modal.querySelector(".resource-modal-panel")?.focus());}
function resourceCloseModal(modal){if(!modal||!modal.classList.contains("is-open")||modal.classList.contains("is-closing"))return;modal.classList.add("is-closing");modal.setAttribute("aria-hidden","true");const finish=()=>{modal.classList.remove("is-open","is-closing");if(!document.querySelector(".resource-modal.is-open")){document.body.classList.remove("resource-modal-open");const target=RESOURCE_MODAL_TRIGGER;RESOURCE_MODAL_TRIGGER=null;if(target&&target.isConnected)target.focus();}};const reduced=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;if(reduced)finish();else window.setTimeout(finish,250);}
document.getElementById("resourceBrowseOpen").addEventListener("click",()=>{resourceOpenModal("resourceBrowseModal");loadResources();});
document.getElementById("resourceUploadOpen").addEventListener("click",()=>resourceOpenModal("resourceUploadModal"));
document.querySelectorAll("[data-resource-close]").forEach(el=>el.addEventListener("click",()=>resourceCloseModal(el.closest(".resource-modal"))));
document.addEventListener("keydown",e=>{if(e.key==="Escape")document.querySelectorAll(".resource-modal.is-open").forEach(resourceCloseModal)});
document.getElementById("resourceChooseFile").addEventListener("click",()=>document.getElementById("resourceFileInput").click());
document.getElementById("resourceFileInput").addEventListener("change",e=>{const f=e.target.files?.[0],box=document.getElementById("resourceChosenFile");box.hidden=!f;box.textContent=f?f.name:"";});
["resourceFilterSubject","resourceFilterYear","resourceFilterSemester","resourceFilterKind","resourceSearch"].forEach(id=>document.getElementById(id).addEventListener(id==="resourceSearch"?"input":"change",renderResourceItems));
document.getElementById("resourceUploadForm").addEventListener("submit",async event=>{
 event.preventDefault();const form=event.currentTarget,fd=new FormData(form),file=fd.get("file"),button=document.getElementById("resourceUploadButton"),message=document.getElementById("resourceUploadMessage");
 if(!(file instanceof File)||!file.size){message.textContent="اختر ملفاً أولاً.";return;}if(!/\.(pdf|doc|docx)$/i.test(file.name)){message.textContent="يسمح بملفات PDF وWord فقط.";return;}if(file.size>4200000){message.textContent="حجم الملف يتجاوز 4.2 ميغابايت.";return;}
 const params=new URLSearchParams();["title","subject","year","semester","kind"].forEach(k=>params.set(k,fd.get(k)||""));params.set("name",file.name);
 button.disabled=true;button.textContent="جارٍ الإرسال...";message.textContent="يتم رفع الملف وإرساله للمراجعة...";
 try{const r=await fetch("/api/resource?"+params.toString(),{method:"POST",headers:{"content-type":file.type||"application/octet-stream"},body:file,cache:"no-store"});let data={};try{data=await r.json()}catch(e){}if(!r.ok||!data.ok)throw new Error(data.error==="file_too_large"?"حجم الملف أكبر من المسموح.":data.error==="invalid_resource_metadata"?"تحقق من اختيارات التصنيف.":data.message||data.error||"تعذر رفع الملف.");form.reset();document.getElementById("resourceChosenFile").hidden=true;message.textContent="وصلت مساهمتك بنجاح، وستظهر بعد مراجعتها والموافقة عليها.";showDialog({type:"success",title:"تم إرسال المورد",message:"وصلت مساهمتك بنجاح، وستظهر بعد مراجعتها والموافقة عليها.",confirmText:"حسنًا"});}
 catch(e){message.textContent="تعذر إرسال المورد: "+e.message;showDialog({type:"warning",title:"تعذر الاتصال",message:"لم نتمكن من إرسال المورد. تحقق من اتصال الإنترنت ثم حاول مجددًا.",confirmText:"حسنًا"});}
 finally{button.disabled=false;button.textContent="إرسال للمراجعة";}
});
async function loadPendingResources(){const area=document.getElementById("resourcePendingList");if(!RESOURCE_ADMIN_CODE){area.innerHTML="";return;}try{const r=await fetch("/api/resources?status=pending",{cache:"no-store"});if(!r.ok)throw new Error("تعذر جلب المشاركات");const items=await r.json();area.innerHTML=items.length?items.map(item=>'<article class="resource-pending-card"><div><b>'+resourceEscape(item.title||item.fileName)+'</b><p>'+resourceEscape(item.subject)+' · '+resourceEscape(item.year)+' · '+resourceEscape(item.semester)+' · '+resourceEscape(item.kind)+'</p><small>'+resourceEscape(item.fileName)+'</small><span>بانتظار المراجعة</span></div><div><button type="button" data-resource-approve="'+resourceEscape(item.id)+'">موافقة ونشر</button><button type="button" class="reject" data-resource-reject="'+resourceEscape(item.id)+'">رفض</button></div></article>').join(""):'<div class="resource-empty">لا توجد مشاركات بانتظار المراجعة.</div>';document.getElementById("resourceAdminLogin").hidden=true;document.getElementById("resourceAdminLogout").hidden=false;}catch(e){area.innerHTML='<div class="resource-empty">تعذر تحميل قائمة المراجعة. تحقق من رمز الإدارة.</div>';}}
document.getElementById("resourceAdminLogin").addEventListener("click",async()=>{const code=document.getElementById("resourceAdminCode").value.trim();if(!code)return;const b=document.getElementById("resourceAdminLogin");b.disabled=true;b.textContent="جارٍ التحقق...";try{const r=await fetch("/api/admin/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({role:"resources",code}),cache:"no-store"});if(!r.ok)throw new Error("رمز المجموعة A غير صحيح أو الخدمة غير متاحة.");RESOURCE_ADMIN_CODE="session";await loadPendingResources();}catch(e){document.getElementById("resourcePendingList").innerHTML='<div class="resource-empty">'+resourceEscape(e.message)+'</div>';}finally{b.disabled=false;b.textContent="دخول الإدارة";}});
document.getElementById("resourceAdminLogout").addEventListener("click",()=>{RESOURCE_ADMIN_CODE="";fetch("/api/admin/session",{method:"DELETE"}).catch(()=>{});document.getElementById("resourcePendingList").innerHTML="";document.getElementById("resourceAdminLogin").hidden=false;document.getElementById("resourceAdminLogout").hidden=true;});
document.getElementById("resourcePendingList").addEventListener("click",event=>{const approve=event.target.closest("[data-resource-approve]"),reject=event.target.closest("[data-resource-reject]"),button=approve||reject;if(!button)return;const id=button.dataset.resourceApprove||button.dataset.resourceReject,action=approve?"approve":"reject";const run=async()=>{button.disabled=true;button.textContent="جارٍ التنفيذ...";try{const r=await fetch("/api/resources?action="+action+"&id="+encodeURIComponent(id),{method:"POST",headers:{},cache:"no-store"});if(!r.ok)throw new Error("تعذر تنفيذ العملية.");await loadPendingResources();if(approve)await loadResources();}catch(e){button.disabled=false;button.textContent=approve?"موافقة ونشر":"رفض";showDialog({type:"warning",title:"تعذر الاتصال",message:"لم نتمكن من إتمام العملية. تحقق من الاتصال ثم حاول مجددًا.",confirmText:"حسنًا"});}};if(reject)showDialog({type:"danger",title:"تأكيد الحذف",message:"هل تريد رفض هذه المشاركة وحذف المورد نهائيًا؟",confirmText:"تأكيد الحذف",cancelText:"إلغاء",onConfirm:run});else run();});
fetch("/api/admin/session?role=resources",{cache:"no-store"}).then(r=>{if(r.ok){RESOURCE_ADMIN_CODE="session";loadPendingResources();}}).catch(()=>{});
resourceInitSelects();
 function resourcePaintSelect(el,group){
  if(!el)return;
  const value=el.value,source=group==="subject"?RESOURCE_SUBJECTS:group==="kind"?RESOURCE_KINDS:group==="semester"?RESOURCE_SEMESTERS:RESOURCE_YEARS,index=source.indexOf(value);
  const hue=group==="subject"?(index<0?158:(index*37+148)%360):group==="kind"?(index<0?38:(index*43+22)%360):group==="semester"?(index===1?263:205):group==="year"?211:158;
  el.style.setProperty("--resource-accent","hsl("+hue+" 38% 48%)");
  el.classList.toggle("has-value",!!value);
 }
 [["resourceFilterSubject","subject"],["resourceUploadSubject","subject"],["resourceFilterKind","kind"],["resourceUploadKind","kind"],["resourceFilterYear","year"],["resourceUploadYear","year"],["resourceFilterSemester","semester"],["resourceUploadSemester","semester"]].forEach(([id,group])=>{const el=document.getElementById(id);resourcePaintSelect(el,group);el.addEventListener("change",()=>resourcePaintSelect(el,group));});
 loadResources();if(RESOURCE_ADMIN_CODE)loadPendingResources();


window.__academicBridge={
 getSubjects(){return subjectData;},
 setSubjects(items){if(!subjectDetail.hidden){subjectDetail.hidden=true;subjectsGrid.hidden=false;document.querySelector('.subjects-toolbar').hidden=false;}subjectData.splice(0,subjectData.length,...items.map(item=>({...item,programImage:item.programImage||""})));renderSubjects();},
 setLessonSubjects(names){lessonSubjects.splice(0,lessonSubjects.length,...names);lessonData.A=names.map(name=>({name,lessons:[]}));lessonData.B=names.map(name=>({name,lessons:[]}));renderLessonSubjects(currentGroup);const total=document.querySelector("#page-lessons .lessons-total b");if(total)total.textContent=String(names.length);const count=document.querySelector("#page-lessons .lesson-summary-count b");if(count)count.textContent=String(names.length);},
 setContext(year,semester){ACADEMIC_YEAR_NUMBER=Number(year)||2;ACADEMIC_SEMESTER_NUMBER=Number(semester)||1;},
 refreshLessons(){renderLessonSubjects(currentGroup);}
};


(function(){
  var orig=window.go,timer;
  if(typeof orig!=="function")return;
  window.go=function(page){
    var r=orig.apply(this,arguments),pg=document.getElementById("page-subjects");
    if(page==="subjects"&&pg){
      clearTimeout(timer);pg.classList.remove("subjects-enter");void pg.offsetWidth;pg.classList.add("subjects-enter");
      timer=setTimeout(function(){pg.classList.remove("subjects-enter")},1700);
    }else if(pg){pg.classList.remove("subjects-enter")}
    return r;
  };
})();

(()=>{const root=document.documentElement,key="ensd-theme";let dark=false;try{dark=localStorage.getItem(key)==="dark"}catch(e){}root.classList.toggle("dark-mode",dark);const b=document.getElementById("themeToggle");if(b){b.setAttribute("aria-pressed",String(dark));b.addEventListener("click",()=>{dark=!root.classList.contains("dark-mode");root.classList.toggle("dark-mode",dark);b.setAttribute("aria-pressed",String(dark));b.setAttribute("aria-label",dark?"تفعيل الوضع الفاتح":"تفعيل الوضع الليلي");try{localStorage.setItem(key,dark?"dark":"light")}catch(e){}})}if("serviceWorker" in navigator&&location.protocol.startsWith("http"))navigator.serviceWorker.register("/sw.js").catch(()=>{});})();

/* Unified search, saved favourites and academic announcements */
(()=>{
 const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 const search=document.getElementById("globalSearch");
 const topbar=document.querySelector(".topbar");
 let panel=document.getElementById("globalSearchResults");
 if(!panel&&topbar){panel=document.createElement("div");panel.id="globalSearchResults";panel.className="global-search-results";panel.hidden=true;topbar.after(panel);}
 if(search&&panel){
  search.addEventListener("input",()=>{
   const q=search.value.trim().toLocaleLowerCase("ar");panel.replaceChildren();
   if(!q){panel.hidden=true;return;}
   const cards=[...document.querySelectorAll(".lesson-subject-card,.resource-card,#courseList .course,.announcement-card")];
   const matches=cards.filter(card=>card.textContent.toLocaleLowerCase("ar").includes(q)).slice(0,12);
   if(!matches.length){panel.textContent="لا توجد نتائج مطابقة.";panel.hidden=false;return;}
   matches.forEach(card=>{
    const page=card.closest(".page"),button=document.createElement("button");
    button.type="button";button.className="global-search-result";
    button.textContent=(page?.id==="page-lessons"?"درس · ":page?.id==="page-resources"?"مورد · ":page?.id==="page-announcements"?"إعلان · ":"")+card.textContent.trim().replace(/\s+/g," ").slice(0,110);
    button.addEventListener("click",()=>{if(page?.id)go(page.id.replace("page-",""));panel.hidden=true;search.value="";card.scrollIntoView({behavior:"smooth",block:"center"});});
    panel.append(button);
   });panel.hidden=false;
  });
  document.addEventListener("click",e=>{if(!panel.contains(e.target)&&e.target!==search)panel.hidden=true;});
 }
 const favKey="ensd_arabic_favorites";
 const getFavs=()=>{try{const v=JSON.parse(localStorage.getItem(favKey)||"[]");return Array.isArray(v)?v:[]}catch(e){return[]}};
 const setFavs=v=>{try{localStorage.setItem(favKey,JSON.stringify(v))}catch(e){}};
 function updateFavorites(){
  const favs=getFavs(),list=document.getElementById("favoritesList");if(!list)return;list.replaceChildren();
  const all=[...document.querySelectorAll("[data-fav-key]")];
  favs.forEach(key=>{
   const card=all.find(x=>x.dataset.favKey===key);
   const b=document.createElement("button");b.type="button";b.className="favorite-link";
   b.textContent=card?card.textContent.trim().replace(/\s+/g," ").slice(0,90):key.replace(/^(lesson|resource)-/,"");
   b.addEventListener("click",()=>{if(card){const page=card.closest(".page");if(page?.id)go(page.id.replace("page-",""));card.scrollIntoView({behavior:"smooth",block:"center"});}});
   list.append(b);
  });
  if(!favs.length)list.textContent="لم تضف عناصر إلى المفضلة بعد.";
 }
 function attachFavoriteButtons(root=document){
  root.querySelectorAll?.(".lesson-subject-card[data-fav-key],.resource-card[data-fav-key],.announcement-card[data-fav-key]").forEach(card=>{
   if(card.querySelector(".favorite-toggle"))return;
   const button=document.createElement("button");button.type="button";button.className="favorite-toggle";button.setAttribute("aria-label","إضافة إلى المفضلة");
   const refresh=()=>{const active=getFavs().includes(card.dataset.favKey);button.textContent=active?"★":"☆";button.setAttribute("aria-pressed",String(active));button.setAttribute("aria-label",active?"إزالة من المفضلة":"إضافة إلى المفضلة");};
   button.addEventListener("click",e=>{e.preventDefault();e.stopPropagation();const favs=getFavs(),key=card.dataset.favKey;setFavs(favs.includes(key)?favs.filter(x=>x!==key):[...favs,key]);refresh();updateFavorites();});
   card.append(button);refresh();
  });updateFavorites();
 }
 ["lessonList","resourceList"].forEach(id=>{const root=document.getElementById(id);if(root){attachFavoriteButtons(root);new MutationObserver(()=>attachFavoriteButtons(root)).observe(root,{childList:true,subtree:true});}});
 updateFavorites();
 async function loadAnnouncements(){
  const list=document.getElementById("announcementsList");if(!list)return;
  const admin=document.getElementById("announcementAdmin");
  try{const auth=await fetch("/api/admin/session?role=academic",{cache:"no-store"});if(admin)admin.hidden=!auth.ok;}catch(e){if(admin)admin.hidden=true;}
  try{
   const r=await fetch("/api/announcements",{cache:"no-store"});if(!r.ok)throw new Error("load_failed");
   const items=await r.json();const noticeDot=document.querySelector("#noticeBtn .dot");if(noticeDot)noticeDot.hidden=!Array.isArray(items)||!items.length||document.getElementById("page-announcements")?.classList.contains("active");if(!Array.isArray(items)||!items.length){list.innerHTML='<div class="empty">لا توجد إعلانات منشورة حالياً.</div>';return;}
   items.sort((a,b)=>(Number(b.pinned)-Number(a.pinned))||String(b.date||"").localeCompare(String(a.date||"")));
   list.innerHTML=items.map(item=>'<article class="announcement-card" data-fav-key="announcement-'+esc(item.id)+'"><div class="announcement-card-head"><span class="announcement-category">'+esc(item.category)+'</span><time>'+esc(item.date)+'</time>'+(item.pinned?'<b class="announcement-pinned">مثبّت</b>':'')+'</div><h4>'+esc(item.title)+'</h4><p>'+esc(item.content).replace(/\n/g,"<br>")+'</p></article>').join("");
  }catch(e){list.innerHTML='<div class="empty">تعذر تحميل الإعلانات. حاول تحديث الصفحة.</div>';}
  attachFavoriteButtons(list);
 }
 window.loadAnnouncements=loadAnnouncements;
 const form=document.getElementById("announcementForm");
 form?.addEventListener("submit",async e=>{
  e.preventDefault();const button=document.getElementById("announcementPublish"),status=document.getElementById("announcementStatus");
  button.disabled=true;status.textContent="جارٍ النشر...";
  try{
   const body={title:document.getElementById("announcementTitle").value,category:document.getElementById("announcementCategory").value,date:document.getElementById("announcementDate").value,content:document.getElementById("announcementContent").value,pinned:document.getElementById("announcementPinned").checked};
   const r=await fetch("/api/announcements",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
   const result=await r.json().catch(()=>({}));if(!r.ok)throw new Error(result.error||"publish_failed");
   form.reset();status.textContent="تم نشر الإعلان.";await loadAnnouncements();
  }catch(error){status.textContent=error.message==="unauthorized"?"سجّل الدخول بحساب الإدارة الأكاديمية أولاً.":"تعذر نشر الإعلان. تحقق من إعدادات التخزين.";
  }finally{button.disabled=false;}
 });
 loadAnnouncements();
})();
