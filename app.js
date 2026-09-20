'use strict';
const TEACHER='Đậm';
// BƯỚC 3 - Kết nối Supabase. Chưa thay cơ chế localStorage ở bước này.
const SUPABASE_URL='https://ohmwphdeeldmlxuuknny.supabase.co';
const SUPABASE_PUBLISHABLE_KEY='sb_publishable_DgxnOXel9t7woqYrfInl5Q_YogcW--c';
let supabaseClient=null;
let currentAuthUser=null;
const TKB_SCHOOL_YEAR='2026-2027';
let currentSchoolYearId=null;

async function ensureSupabaseSchoolYear(){
  if(!supabaseClient||!currentAuthUser) throw new Error('Bạn chưa đăng nhập giáo viên.');
  if(currentSchoolYearId) return currentSchoolYearId;
  const {data:found,error:findError}=await supabaseClient.from('tkb_school_years').select('id').eq('user_id',currentAuthUser.id).eq('school_year',TKB_SCHOOL_YEAR).limit(1);
  if(findError) throw findError;
  if(found&&found.length){currentSchoolYearId=found[0].id;return currentSchoolYearId;}
  const {data,error}=await supabaseClient.from('tkb_school_years').insert({user_id:currentAuthUser.id,school_year:TKB_SCHOOL_YEAR,school_name:'Trường TH-THCS&THPT Lại Sơn',teacher_name:TEACHER}).select('id').single();
  if(error) throw error;
  currentSchoolYearId=data.id;return currentSchoolYearId;
}
function lessonToSupabaseRow(x,versionId){
  return {timetable_version_id:versionId,user_id:currentAuthUser.id,thu:clean(x.thu),buoi:clean(x.buoi),tiet:Number(x.tiet)||null,thoi_gian:clean(x.thoiGian),lop:clean(x.lop),mon_hoc:clean(x.monHoc),diem_truong:clean(x.diemTruong),sheet_nguon:clean(x.sheetNguon),dong_nguon:Number(x.dongNguon)||null,cot_nguon:Number(x.cotNguon)||null,source_cell:clean(x.oNguon||x.sourceCell)};
}
async function saveTimetableVersionToSupabase(version){
  if(!currentAuthUser) throw new Error('Hãy đăng nhập giáo viên trước khi lưu TKB lên Supabase.');
  const schoolYearId=await ensureSupabaseSchoolYear();
  const week=schoolCalendar.weeks.find(w=>Number(w.week)===Number(version.startWeek));
  const payload={school_year_id:schoolYearId,user_id:currentAuthUser.id,teacher_name:TEACHER,source_filename:version.file||'',effective_week:Number(version.startWeek),effective_date:week?.start||null,content_hash:version.fingerprint||scheduleFingerprint(version.lessons),lesson_count:(version.lessons||[]).length};
  const {data,error}=await supabaseClient.from('tkb_timetable_versions').insert(payload).select('id').single();
  if(error){if(error.code==='23505')throw new Error('TKB này đã tồn tại trên Supabase (trùng nội dung).');throw error;}
  const rows=(version.lessons||[]).map(x=>lessonToSupabaseRow(x,data.id));
  if(rows.length){const {error:lessonError}=await supabaseClient.from('tkb_timetable_lessons').insert(rows);if(lessonError){await supabaseClient.from('tkb_timetable_versions').delete().eq('id',data.id);throw lessonError;}}
  version.supabaseId=data.id;version.syncedToSupabase=true;return data.id;
}

function canonicalAppendix2Records(){
  return [...lessonPlanMap.values()].map(x=>({
    subject:clean(x.subject),grade:Number(x.grade),week:Number(x.week),annualPeriod:Number(x.annualPeriod||0),
    title:clean(x.title),duration:clean(x.duration)
  })).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function appendix2Fingerprint(){
  const str=JSON.stringify(canonicalAppendix2Records()); let h1=0x811c9dc5;
  for(let i=0;i<str.length;i++){h1^=str.charCodeAt(i);h1=Math.imul(h1,0x01000193)}
  return (h1>>>0).toString(16).padStart(8,'0')+':'+str.length;
}
async function saveAppendix2ToSupabase(file){
  if(!supabaseClient||!currentAuthUser)throw new Error('Hãy đăng nhập giáo viên trước khi lưu Phụ lục 2 lên Supabase.');
  const records=canonicalAppendix2Records();
  if(!records.length)throw new Error('Phụ lục 2 chưa có dòng kế hoạch hợp lệ để lưu.');
  const schoolYearId=await ensureSupabaseSchoolYear();
  const contentHash=appendix2Fingerprint();
  const subjects=new Set(records.map(x=>normKey(x.subject)));
  const payload={school_year_id:schoolYearId,user_id:currentAuthUser.id,source_filename:file?.name||lessonPlanMeta.file||'Phụ lục 2',content_hash:contentHash,subject_count:subjects.size,lesson_count:records.length};
  const {data,error}=await supabaseClient.from('tkb_appendix2_versions').insert(payload).select('id').single();
  if(error){if(error.code==='23505')throw new Error('Phụ lục 2 này đã tồn tại trên Supabase (trùng nội dung).');throw error;}
  const rows=records.map(x=>({appendix2_version_id:data.id,user_id:currentAuthUser.id,subject_name:x.subject,grade:x.grade,week_number:x.week,lesson_number:x.annualPeriod||null,lesson_title:x.title,duration_text:x.duration||null}));
  const {error:lessonError}=await supabaseClient.from('tkb_appendix2_lessons').insert(rows);
  if(lessonError){await supabaseClient.from('tkb_appendix2_versions').delete().eq('id',data.id);throw lessonError;}
  lessonPlanMeta.supabaseId=data.id;lessonPlanMeta.contentHash=contentHash;lessonPlanMeta.syncedToSupabase=true;
  return {versionId:data.id,lessons:rows.length,subjects:subjects.size,contentHash};
}

function supabaseLessonToAppRow(x){
  return {thu:clean(x.thu),buoi:clean(x.buoi),tiet:Number(x.tiet)||'',thoiGian:clean(x.thoi_gian),lop:clean(x.lop),monHoc:clean(x.mon_hoc),diemTruong:clean(x.diem_truong),sheetNguon:clean(x.sheet_nguon),dongNguon:Number(x.dong_nguon)||0,cotNguon:Number(x.cot_nguon)||0,oNguon:clean(x.source_cell)};
}
async function restoreAppendix2FromSupabase(){
  if(!supabaseClient||!currentAuthUser)return {versions:0,lessons:0,subjects:0};
  const schoolYearId=await ensureSupabaseSchoolYear();
  const {data:versions,error:vErr}=await supabaseClient.from('tkb_appendix2_versions')
    .select('id,source_filename,content_hash,subject_count,lesson_count,created_at')
    .eq('user_id',currentAuthUser.id).eq('school_year_id',schoolYearId)
    .order('created_at',{ascending:false}).limit(1);
  if(vErr)throw vErr;
  const version=versions?.[0];
  if(!version)return {versions:0,lessons:0,subjects:0};
  const {data:rows,error:lErr}=await supabaseClient.from('tkb_appendix2_lessons')
    .select('subject_name,grade,week_number,lesson_number,lesson_title,duration_text')
    .eq('user_id',currentAuthUser.id).eq('appendix2_version_id',version.id)
    .order('grade',{ascending:true}).order('week_number',{ascending:true});
  if(lErr)throw lErr;
  lessonPlanMap.clear(); planSubjectCatalog.clear();
  for(const x of (rows||[])){
    const subject=registerPlanSubject(x.subject_name), grade=Number(x.grade), week=Number(x.week_number);
    if(!subject||!grade||!week||!clean(x.lesson_title))continue;
    lessonPlanMap.set(planKey(subject,grade,week),{
      subject,grade,week,annualPeriod:Number(x.lesson_number)||week,title:clean(x.lesson_title),
      duration:clean(x.duration_text),integration:'',note:'',source:'Supabase'
    });
  }
  const subjects=new Set([...lessonPlanMap.values()].map(x=>normKey(x.subject)));
  lessonPlanMeta={file:version.source_filename||'Phụ lục 2 từ Supabase',type:'supabase',count:lessonPlanMap.size,supabaseId:version.id,contentHash:version.content_hash||'',syncedToSupabase:true};
  const info=$('pl2Info');
  if(info)info.innerHTML=`<b>${esc(lessonPlanMeta.file)}</b> · ${lessonPlanMap.size} dòng kế hoạch · ☁️ Khôi phục từ Supabase`;
  applyLessonPlan(); render();
  console.info('[TKB] Đã khôi phục Phụ lục 2 từ Supabase',{version:version.id,lessons:lessonPlanMap.size,subjects:subjects.size});
  return {versions:1,lessons:lessonPlanMap.size,subjects:subjects.size};
}
async function listAppendix2VersionsFromSupabase(){
  if(!supabaseClient||!currentAuthUser)throw new Error('Hãy đăng nhập giáo viên để quản lý Kho Phụ lục 2.');
  const schoolYearId=await ensureSupabaseSchoolYear();
  const {data,error}=await supabaseClient.from('tkb_appendix2_versions')
    .select('id,source_filename,content_hash,subject_count,lesson_count,created_at')
    .eq('user_id',currentAuthUser.id).eq('school_year_id',schoolYearId)
    .order('created_at',{ascending:false});
  if(error)throw error;
  return data||[];
}
async function loadAppendix2VersionFromSupabase(version){
  const {data:rows,error}=await supabaseClient.from('tkb_appendix2_lessons')
    .select('subject_name,grade,week_number,lesson_number,lesson_title,duration_text')
    .eq('user_id',currentAuthUser.id).eq('appendix2_version_id',version.id)
    .order('grade',{ascending:true}).order('week_number',{ascending:true});
  if(error)throw error;
  lessonPlanMap.clear(); planSubjectCatalog.clear();
  for(const x of (rows||[])){
    const subject=registerPlanSubject(x.subject_name),grade=Number(x.grade),week=Number(x.week_number);
    if(!subject||!grade||!week||!clean(x.lesson_title))continue;
    lessonPlanMap.set(planKey(subject,grade,week),{subject,grade,week,annualPeriod:Number(x.lesson_number)||week,title:clean(x.lesson_title),duration:clean(x.duration_text),integration:'',note:'',source:'Supabase'});
  }
  lessonPlanMeta={file:version.source_filename||'Phụ lục 2 từ Supabase',type:'supabase',count:lessonPlanMap.size,supabaseId:version.id,contentHash:version.content_hash||'',syncedToSupabase:true};
  const info=$('pl2Info');if(info)info.innerHTML=`<b>${esc(lessonPlanMeta.file)}</b> · ${lessonPlanMap.size} dòng kế hoạch · ☁️ Khôi phục từ Supabase`;
  applyLessonPlan();render();
}
async function openAppendix2RepoManager(){
  if(!currentAuthUser)return alert('Hãy đăng nhập giáo viên trước khi mở Kho Phụ lục 2.');
  let versions;
  try{versions=await listAppendix2VersionsFromSupabase()}catch(e){console.error(e);return alert('Không đọc được Kho Phụ lục 2: '+(e.message||e));}
  const rows=versions.map((v,i)=>`<tr><td>${i+1}</td><td class="manage-file">${esc(v.source_filename||'Phụ lục 2')}</td><td>${Number(v.subject_count)||0}</td><td>${Number(v.lesson_count)||0}</td><td>${esc(v.created_at?new Date(v.created_at).toLocaleString('vi-VN'):'')}</td><td><div class="appendix2-row-actions"><button type="button" class="secondary-action" data-pl2-use="${esc(v.id)}">SỬ DỤNG</button><button type="button" class="danger-action" data-pl2-delete="${esc(v.id)}">XÓA</button></div></td></tr>`).join('');
  const m=modalShell('KHO PHỤ LỤC 2',`<p class="manage-note">Kho Supabase của tài khoản đang đăng nhập. Có thể chọn một phiên bản để sử dụng hoặc xóa phiên bản không còn cần thiết. Xóa phiên bản sẽ xóa luôn các dòng kế hoạch thuộc phiên bản đó.</p><div class="manage-scroll"><table class="manage-table"><thead><tr><th>TT</th><th>File Phụ lục 2</th><th>Số môn</th><th>Số dòng</th><th>Thời điểm lưu</th><th>Thao tác</th></tr></thead><tbody>${rows||'<tr><td colspan="6">Kho Phụ lục 2 đang trống.</td></tr>'}</tbody></table></div>`);
  m.querySelectorAll('[data-pl2-use]').forEach(btn=>btn.onclick=async()=>{
    const v=versions.find(x=>x.id===btn.dataset.pl2Use);if(!v)return;
    btn.disabled=true;btn.textContent='ĐANG TẢI...';
    try{await loadAppendix2VersionFromSupabase(v);m.remove();alert(`Đã sử dụng Phụ lục 2: ${v.source_filename||'Phụ lục 2'} (${v.subject_count||0} môn, ${v.lesson_count||0} dòng kế hoạch).`)}
    catch(e){btn.disabled=false;btn.textContent='SỬ DỤNG';alert('Không tải được phiên bản Phụ lục 2: '+(e.message||e));}
  });
  m.querySelectorAll('[data-pl2-delete]').forEach(btn=>btn.onclick=async()=>{
    const v=versions.find(x=>x.id===btn.dataset.pl2Delete);if(!v)return;
    if(!confirm(`Xóa phiên bản Phụ lục 2 này?\n\n${v.source_filename||'Phụ lục 2'}\n${v.subject_count||0} môn · ${v.lesson_count||0} dòng kế hoạch\n\nCác dòng chi tiết của phiên bản cũng sẽ bị xóa.`))return;
    btn.disabled=true;btn.textContent='ĐANG XÓA...';
    try{
      const {error}=await supabaseClient.from('tkb_appendix2_versions').delete().eq('id',v.id).eq('user_id',currentAuthUser.id);if(error)throw error;
      const deletingCurrent=lessonPlanMeta.supabaseId===v.id;
      m.remove();
      if(deletingCurrent){lessonPlanMap.clear();planSubjectCatalog.clear();lessonPlanMeta={file:'',type:'',count:0};const r=await restoreAppendix2FromSupabase();if(!r.versions){const info=$('pl2Info');if(info)info.textContent='Chưa có Phụ lục 2 trong kho.';applyLessonPlan();render();}}
      alert('Đã xóa phiên bản Phụ lục 2 khỏi Supabase.');
      openAppendix2RepoManager();
    }catch(e){btn.disabled=false;btn.textContent='XÓA';alert('Không xóa được phiên bản Phụ lục 2: '+(e.message||e));}
  });
}

function restoredVersionMeta(version,lessons){
  const sheets=[...new Set(lessons.map(x=>x.sheetNguon).filter(Boolean))];
  const counts={}; sheets.forEach(s=>counts[s]=lessons.filter(x=>x.sheetNguon===s).length);
  return {startWeek:Number(version.effective_week)||1,uploadedAt:version.created_at||'',uploadedAtLabel:version.created_at?new Date(version.created_at).toLocaleString('vi-VN'):'',fingerprint:version.content_hash||scheduleFingerprint(lessons),file:version.source_filename||'TKB từ Supabase',sheets,counts,errors:[],lessons,supabaseId:version.id,syncedToSupabase:true,effectiveDate:version.effective_date||null};
}
async function restoreScheduleRepositoryFromSupabase(){
  if(!supabaseClient||!currentAuthUser)return {versions:0,lessons:0};
  const schoolYearId=await ensureSupabaseSchoolYear();
  const {data:versions,error:vErr}=await supabaseClient.from('tkb_timetable_versions').select('id,source_filename,effective_week,effective_date,content_hash,lesson_count,created_at').eq('user_id',currentAuthUser.id).eq('school_year_id',schoolYearId).order('effective_week',{ascending:true}).order('created_at',{ascending:true});
  if(vErr)throw vErr;
  if(!versions?.length)return {versions:0,lessons:0};
  const ids=versions.map(v=>v.id);
  const {data:rows,error:lErr}=await supabaseClient.from('tkb_timetable_lessons').select('*').eq('user_id',currentAuthUser.id).in('timetable_version_id',ids).order('created_at',{ascending:true});
  if(lErr)throw lErr;
  const byVersion=new Map(); (rows||[]).forEach(r=>{if(!byVersion.has(r.timetable_version_id))byVersion.set(r.timetable_version_id,[]);byVersion.get(r.timetable_version_id).push(supabaseLessonToAppRow(r))});
  const restored=versions.map(v=>restoredVersionMeta(v,byVersion.get(v.id)||[])).filter(v=>v.lessons.length);
  // Supabase là nguồn lâu dài sau khi đăng nhập; localStorage được cập nhật lại làm bản dự phòng.
  scheduleVersions.splice(0,scheduleVersions.length,...restored);
  scheduleVersions.sort((a,b)=>a.startWeek-b.startWeek||String(a.uploadedAt||'').localeCompare(String(b.uploadedAt||'')));
  saveScheduleRepository();
  activateSelectedWeek();
  const total=restored.reduce((n,v)=>n+v.lessons.length,0);
  const status=$('supabaseStatus'); if(status)status.textContent=`☁️ Supabase: ĐÃ KẾT NỐI • Đã đăng nhập • Đã tải ${restored.length} TKB / ${total} tiết`;
  console.info('[TKB] Đã khôi phục Kho TKB từ Supabase',{versions:restored.length,lessons:total});
  return {versions:restored.length,lessons:total};
}
async function restoreAfterLogin(showMessage=false){
  try{
    const calendarResult=await restoreSchoolCalendarFromSupabase();
    const r=await restoreScheduleRepositoryFromSupabase();
    const appendix2Result=await restoreAppendix2FromSupabase();
    if(showMessage){
      const parts=[];
      if(calendarResult.weeks)parts.push(`Lịch năm học ${calendarResult.weeks} tuần`);
      if(r.versions)parts.push(`${r.versions} phiên bản TKB (${r.lessons} tiết)`);
      if(appendix2Result.versions)parts.push(`Phụ lục 2 (${appendix2Result.subjects} môn, ${appendix2Result.lessons} dòng kế hoạch)`);
      alert(parts.length?`Đã khôi phục từ Supabase: ${parts.join(' và ')}.`:'Tài khoản này chưa có Lịch năm học, TKB hoặc Phụ lục 2 trên Supabase.');
    }
  }
  catch(e){console.error('[TKB] Không khôi phục được dữ liệu từ Supabase',e);const status=$('supabaseStatus');if(status)status.textContent='⚠️ Supabase: Đã đăng nhập nhưng chưa tải được đầy đủ dữ liệu';if(showMessage)alert('Không tải được dữ liệu từ Supabase: '+(e.message||e));}
}

function updateAuthUI(user){
  currentAuthUser=user||null;
  currentSchoolYearId=null;
  const status=$('supabaseStatus'), label=$('authUserLabel'), login=$('loginBtn'), logout=$('logoutBtn');
  if(status) status.textContent=user ? '☁️ Supabase: ĐÃ KẾT NỐI • Đã đăng nhập' : '☁️ Supabase: ĐÃ KẾT NỐI • Chưa đăng nhập (dữ liệu hiện vẫn dùng localStorage)';
  if(label) label.textContent=user ? (user.email||'Giáo viên') : '';
  if(login) login.hidden=!!user;
  if(logout) logout.hidden=!user;
}
function openAuthModal(){
  if(!supabaseClient){alert('Supabase chưa sẵn sàng. Vui lòng tải lại trang.');return;}
  const m=modalShell('ĐĂNG NHẬP GIÁO VIÊN',`<p class="manage-note">Đăng nhập để Supabase xác định đúng giáo viên và tự khôi phục Kho TKB cùng Lịch năm học.</p><div class="auth-form"><label>Email<input id="authEmail" type="email" autocomplete="username" placeholder="giaovien@example.com"></label><label>Mật khẩu<input id="authPassword" type="password" autocomplete="current-password" placeholder="Tối thiểu 6 ký tự"></label><div id="authMessage" class="auth-message"></div></div><div class="manage-actions auth-modal-actions"><button id="authSignUp" type="button" class="secondary-action">TẠO TÀI KHOẢN</button><button id="authSignIn" type="button">ĐĂNG NHẬP</button></div>`);
  const email=m.querySelector('#authEmail'), pass=m.querySelector('#authPassword'), msg=m.querySelector('#authMessage');
  const values=()=>({email:email.value.trim(),password:pass.value});
  const validate=()=>{const v=values();if(!v.email||!v.email.includes('@'))throw new Error('Vui lòng nhập email hợp lệ.');if(v.password.length<6)throw new Error('Mật khẩu phải có ít nhất 6 ký tự.');return v};
  m.querySelector('#authSignIn').onclick=async()=>{try{msg.textContent='Đang đăng nhập...';const v=validate();const {data,error}=await supabaseClient.auth.signInWithPassword(v);if(error)throw error;updateAuthUI(data.user);await restoreAfterLogin(true);m.remove()}catch(e){msg.textContent='⚠️ '+(e.message||e)}};
  m.querySelector('#authSignUp').onclick=async()=>{try{msg.textContent='Đang tạo tài khoản...';const v=validate();const {data,error}=await supabaseClient.auth.signUp(v);if(error)throw error;if(data.session){updateAuthUI(data.user);m.remove();alert('Đã tạo tài khoản và đăng nhập thành công.')}else{msg.textContent='✅ Đã tạo tài khoản. Nếu Supabase yêu cầu xác nhận email, hãy mở email xác nhận rồi quay lại đăng nhập.'}}catch(e){msg.textContent='⚠️ '+(e.message||e)}};
  setTimeout(()=>email.focus(),0);
}
async function logoutTeacher(){
  if(!supabaseClient)return;
  const {error}=await supabaseClient.auth.signOut();
  if(error){alert('Không đăng xuất được: '+error.message);return;}
  updateAuthUI(null);
}
async function initSupabaseConnection(){
  const status=$('supabaseStatus');
  try{
    if(!window.supabase?.createClient) throw new Error('Không tải được thư viện Supabase');
    supabaseClient=window.supabase.createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY);
    const {data:{session},error}=await supabaseClient.auth.getSession();
    if(error) throw error;
    updateAuthUI(session?.user||null);
    if(session?.user) await restoreAfterLogin(false);
    supabaseClient.auth.onAuthStateChange((event,session)=>{
      updateAuthUI(session?.user||null);
      // SIGNED_IN cũng có thể phát sinh khi refresh token; chỉ khôi phục khi kho hiện tại đang trống để tránh tải lặp.
      if(session?.user && event==='SIGNED_IN' && !scheduleVersions.length)setTimeout(()=>restoreAfterLogin(false),0);
    });
    console.info('[TKB] Supabase client ready', {url:SUPABASE_URL, authenticated:!!session});
  }catch(err){
    console.error('[TKB] Supabase connection error',err);
    if(status) status.textContent='⚠️ Supabase: KHÔNG KẾT NỐI ĐƯỢC • '+(err?.message||err);
  }
}

 let allLessons=[], currentView='table', meta={}, lessonPlanMap=new Map(), lessonPlanMeta={file:'',type:'',count:0};
// Kho các phiên bản TKB theo mốc hiệu lực.
// Mỗi TKB mới áp dụng từ tuần được chọn đến trước mốc TKB kế tiếp; lịch sử các tuần cũ vẫn được giữ.
const scheduleVersions=[];
const TKB_STORE_KEY='tkb_personal_schedule_repository_v1';

const SCHOOL_CALENDAR_KEY='tkb_school_calendar_v1';
let schoolCalendar={startDate:'2026-09-07',breaks:[],weeks:[]};
function isoDate(d){const z=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`}
function parseLocalDate(v){const [y,m,d]=String(v||'').split('-').map(Number);return new Date(y,m-1,d)}
function fmtDateVN(v){const d=typeof v==='string'?parseLocalDate(v):v;return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`}
function normalizeBreaks(arr){return (arr||[]).filter(x=>x&&x.start&&x.end&&x.start<=x.end).sort((a,b)=>a.start.localeCompare(b.start))}
function weekHitsBreak(start,breaks){const end=new Date(start);end.setDate(end.getDate()+4);return breaks.some(b=>{const bs=parseLocalDate(b.start),be=parseLocalDate(b.end);return start<=be&&end>=bs})}
function generateSchoolWeeks(startDate,breaks){let out=[],d=parseLocalDate(startDate),safe=0;breaks=normalizeBreaks(breaks);while(out.length<35&&safe++<500){while(weekHitsBreak(d,breaks)){d.setDate(d.getDate()+7)}const e=new Date(d);e.setDate(e.getDate()+4);out.push({week:out.length+1,start:isoDate(d),end:isoDate(e)});d.setDate(d.getDate()+7)}return out}
function loadSchoolCalendar(){try{const x=JSON.parse(localStorage.getItem(SCHOOL_CALENDAR_KEY)||'null');if(x&&Array.isArray(x.weeks)&&x.weeks.length===35)schoolCalendar=x;else schoolCalendar.weeks=generateSchoolWeeks(schoolCalendar.startDate,[])}catch(e){schoolCalendar.weeks=generateSchoolWeeks(schoolCalendar.startDate,[])}}
function saveSchoolCalendar(){localStorage.setItem(SCHOOL_CALENDAR_KEY,JSON.stringify(schoolCalendar))}
function inferBreaksFromSchoolWeeks(weeks){
  const out=[];
  for(let i=1;i<(weeks||[]).length;i++){
    const prevEnd=parseLocalDate(weeks[i-1].end), nextStart=parseLocalDate(weeks[i].start);
    const expected=new Date(prevEnd); expected.setDate(expected.getDate()+3);
    if(nextStart>expected){
      const breakEnd=new Date(nextStart); breakEnd.setDate(breakEnd.getDate()-1);
      out.push({start:isoDate(expected),end:isoDate(breakEnd),label:'Nghỉ / không tính tuần học'});
    }
  }
  return out;
}
async function saveSchoolCalendarToSupabase(){
  if(!supabaseClient||!currentAuthUser)throw new Error('Hãy đăng nhập giáo viên trước khi lưu Lịch năm học lên Supabase.');
  if(!Array.isArray(schoolCalendar.weeks)||schoolCalendar.weeks.length!==35)throw new Error('Lịch năm học phải có đủ 35 tuần trước khi lưu.');
  const schoolYearId=await ensureSupabaseSchoolYear();
  const rows=schoolCalendar.weeks.map(w=>({school_year_id:schoolYearId,user_id:currentAuthUser.id,week_number:Number(w.week),start_date:w.start,end_date:w.end,status:'study',note:null}));
  const {error}=await supabaseClient.from('tkb_academic_weeks').upsert(rows,{onConflict:'school_year_id,week_number'});
  if(error)throw error;
  return rows.length;
}
async function restoreSchoolCalendarFromSupabase(){
  if(!supabaseClient||!currentAuthUser)return {weeks:0};
  const schoolYearId=await ensureSupabaseSchoolYear();
  const {data,error}=await supabaseClient.from('tkb_academic_weeks').select('week_number,start_date,end_date,status,note').eq('user_id',currentAuthUser.id).eq('school_year_id',schoolYearId).order('week_number',{ascending:true});
  if(error)throw error;
  if(!data?.length)return {weeks:0};
  const restored=data.filter(x=>Number(x.week_number)>=1&&Number(x.week_number)<=35&&x.start_date&&x.end_date).map(x=>({week:Number(x.week_number),start:x.start_date,end:x.end_date}));
  if(restored.length!==35){console.warn('[TKB] Lịch Supabase chưa đủ 35 tuần, tiếp tục dùng lịch cục bộ.',{weeks:restored.length});return {weeks:0,incomplete:restored.length};}
  schoolCalendar={startDate:restored[0].start,breaks:inferBreaksFromSchoolWeeks(restored),weeks:restored};
  saveSchoolCalendar();
  activateSelectedWeek();
  console.info('[TKB] Đã khôi phục Lịch năm học từ Supabase',{weeks:restored.length});
  return {weeks:restored.length};
}
function selectedWeekDates(){const week=Number($('weekSelect')?.value||1),r=schoolCalendar.weeks.find(x=>Number(x.week)===week)||generateSchoolWeeks('2026-09-07',[])[week-1];const start=parseLocalDate(r.start),end=parseLocalDate(r.end),days=[];for(let i=0;i<5;i++){const d=new Date(start);d.setDate(d.getDate()+i);days.push(fmtDateVN(d))}return {week,start,end,days,fmt:d=>fmtDateVN(d)}}
function modalShell(title,body){document.getElementById('manageModal')?.remove();const m=document.createElement('div');m.id='manageModal';m.className='manage-modal';m.innerHTML=`<div class="manage-dialog"><div class="manage-head"><h3>${title}</h3><button id="manageClose">×</button></div>${body}</div>`;document.body.appendChild(m);m.querySelector('#manageClose').onclick=()=>m.remove();m.onclick=e=>{if(e.target===m)m.remove()};return m}
function openRepoManager(){const rows=scheduleVersions.map((v,i)=>`<tr><td>${i+1}</td><td>${esc(v.file)}</td><td><select data-repo-week="${i}">${Array.from({length:35},(_,j)=>`<option value="${j+1}" ${Number(v.startWeek)===j+1?'selected':''}>Tuần ${j+1}</option>`).join('')}</select></td><td>${esc(v.uploadedAtLabel||'')}</td><td>${v.lessons?.length||0}</td></tr>`).join('');const m=modalShell('QUẢN LÝ KHO THỜI KHÓA BIỂU',`<p class="manage-note">Có thể điều chỉnh thủ công tuần bắt đầu hiệu lực. Các tuần trước mốc mới vẫn dùng phiên bản TKB phù hợp trước đó.</p><div class="manage-scroll"><table class="manage-table"><thead><tr><th>TT</th><th>File TKB</th><th>Hiệu lực từ</th><th>Thời điểm lưu</th><th>Số tiết</th></tr></thead><tbody>${rows||'<tr><td colspan="5">Kho TKB đang trống.</td></tr>'}</tbody></table></div><div class="manage-actions"><button id="saveRepoEffect">LƯU HIỆU LỰC</button></div>`);m.querySelector('#saveRepoEffect').onclick=()=>{m.querySelectorAll('[data-repo-week]').forEach(el=>scheduleVersions[Number(el.dataset.repoWeek)].startWeek=Number(el.value));scheduleVersions.sort((a,b)=>a.startWeek-b.startWeek||String(a.uploadedAt||'').localeCompare(String(b.uploadedAt||'')));saveScheduleRepository();activateSelectedWeek();m.remove();alert('Đã cập nhật mốc hiệu lực TKB.')}}
function breakRowsHtml(){const b=schoolCalendar.breaks.length?schoolCalendar.breaks:[{start:'',end:'',label:'Nghỉ Tết'}];return b.map((x,i)=>`<div class="break-row"><input data-break-label="${i}" value="${esc(x.label||'Nghỉ')}" placeholder="Tên kỳ nghỉ"><input type="date" data-break-start="${i}" value="${x.start||''}"><span>đến</span><input type="date" data-break-end="${i}" value="${x.end||''}"></div>`).join('')}
function calendarWeekRows(){return schoolCalendar.weeks.map(w=>`<tr><td><b>Tuần ${w.week}</b></td><td><input type="date" data-week-start="${w.week}" value="${w.start}"></td><td><input type="date" data-week-end="${w.week}" value="${w.end}"></td><td>${fmtDateVN(w.start)} – ${fmtDateVN(w.end)}</td></tr>`).join('')}
function openCalendarManager(){const m=modalShell('LỊCH NĂM HỌC – TUẦN 1 ĐẾN 35',`<p class="manage-note">Ngày của Phụ lục 1.4 lấy từ lịch này. Kỳ nghỉ không làm tăng số tuần chuyên môn.</p><div class="calendar-config"><label>Ngày bắt đầu Tuần 1 <input id="schoolStartDate" type="date" value="${schoolCalendar.startDate}"></label><b>Kỳ nghỉ / thời gian không tính tuần học</b><div id="breakRows">${breakRowsHtml()}</div><div><button id="addBreak">+ Thêm kỳ nghỉ</button> <button id="regenCalendar">TẠO LẠI 35 TUẦN</button></div></div><div class="manage-scroll calendar-scroll"><table class="manage-table"><thead><tr><th>Tuần</th><th>Từ ngày</th><th>Đến ngày</th><th>Hiển thị</th></tr></thead><tbody>${calendarWeekRows()}</tbody></table></div><div class="manage-actions"><button id="saveCalendar">LƯU LỊCH NĂM HỌC</button></div>`);
 const collectBreaks=()=>{const a=[];m.querySelectorAll('[data-break-start]').forEach(el=>{const i=el.dataset.breakStart,start=el.value,end=m.querySelector(`[data-break-end="${i}"]`)?.value,label=m.querySelector(`[data-break-label="${i}"]`)?.value||'Nghỉ';if(start&&end)a.push({start,end,label})});return normalizeBreaks(a)};
 m.querySelector('#addBreak').onclick=()=>{const i=m.querySelectorAll('[data-break-start]').length,d=document.createElement('div');d.className='break-row';d.innerHTML=`<input data-break-label="${i}" value="Nghỉ" placeholder="Tên kỳ nghỉ"><input type="date" data-break-start="${i}"><span>đến</span><input type="date" data-break-end="${i}">`;m.querySelector('#breakRows').appendChild(d)};
 m.querySelector('#regenCalendar').onclick=()=>{schoolCalendar.startDate=m.querySelector('#schoolStartDate').value||'2026-09-07';schoolCalendar.breaks=collectBreaks();schoolCalendar.weeks=generateSchoolWeeks(schoolCalendar.startDate,schoolCalendar.breaks);m.remove();openCalendarManager()};
 m.querySelector('#saveCalendar').onclick=async()=>{
   const btn=m.querySelector('#saveCalendar');
   try{
     schoolCalendar.startDate=m.querySelector('#schoolStartDate').value||schoolCalendar.startDate;schoolCalendar.breaks=collectBreaks();m.querySelectorAll('[data-week-start]').forEach(el=>{const w=schoolCalendar.weeks[Number(el.dataset.weekStart)-1];if(w)w.start=el.value});m.querySelectorAll('[data-week-end]').forEach(el=>{const w=schoolCalendar.weeks[Number(el.dataset.weekEnd)-1];if(w)w.end=el.value});
     saveSchoolCalendar();activateSelectedWeek();
     if(!currentAuthUser)throw new Error('Bạn cần đăng nhập giáo viên để lưu Lịch năm học lên Supabase.');
     btn.disabled=true;btn.textContent='ĐANG LƯU...';
     const count=await saveSchoolCalendarToSupabase();
     m.remove();alert(`Đã lưu Lịch năm học ${count} tuần lên Supabase và bộ nhớ cục bộ. Excel/PDF/In sẽ dùng đúng ngày của tuần được chọn.`);
   }catch(e){console.error('[TKB] Không lưu được Lịch năm học lên Supabase',e);btn.disabled=false;btn.textContent='LƯU LỊCH NĂM HỌC';alert('Không lưu được Lịch năm học lên Supabase: '+(e.message||e));}
 }}

function canonicalSchedule(lessons){
  return (lessons||[]).map(x=>({thu:clean(x.thu),buoi:clean(x.buoi),tiet:clean(x.tiet),thoiGian:clean(x.thoiGian),lop:clean(x.lop),monHoc:normalizeSubjectForPlan(x.monHoc),diemTruong:clean(x.diemTruong),sheetNguon:clean(x.sheetNguon),dongNguon:Number(x.dongNguon||0),cotNguon:Number(x.cotNguon||0),oNguon:clean(x.oNguon)})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function scheduleFingerprint(lessons){
  const str=JSON.stringify(canonicalSchedule(lessons)); let h1=0x811c9dc5;
  for(let i=0;i<str.length;i++){h1^=str.charCodeAt(i);h1=Math.imul(h1,0x01000193)}
  return (h1>>>0).toString(16).padStart(8,'0')+':'+str.length;
}
function saveScheduleRepository(){
  try{localStorage.setItem(TKB_STORE_KEY,JSON.stringify(scheduleVersions))}catch(e){console.warn('Không lưu được kho TKB',e)}
}
function loadScheduleRepository(){
  try{const raw=localStorage.getItem(TKB_STORE_KEY), arr=raw?JSON.parse(raw):[]; if(Array.isArray(arr)){scheduleVersions.splice(0,scheduleVersions.length,...arr.filter(v=>v&&Array.isArray(v.lessons)&&Number(v.startWeek)>=1&&Number(v.startWeek)<=35)); scheduleVersions.sort((a,b)=>a.startWeek-b.startWeek||String(a.uploadedAt||'').localeCompare(String(b.uploadedAt||'')));}}
  catch(e){console.warn('Không đọc được kho TKB',e)}
}
function findDuplicateSchedule(fingerprint){return scheduleVersions.find(v=>v.fingerprint===fingerprint)||null}
function repositorySummary(){
  if(!scheduleVersions.length)return 'chưa có dữ liệu';
  return scheduleVersions.map(v=>`${esc(v.file)} (${versionRangeText(v)}) · lưu ${esc(v.uploadedAtLabel||'')}`).join(' · ');
}
const $=id=>document.getElementById(id); const clean=v=>String(v??'').replace(/\s+/g,' ').trim();
function normalizeTeacherName(s){return clean(s).normalize('NFC').toLocaleLowerCase('vi-VN').replace(/\s/g,'')}
function teacherCell(s){return normalizeTeacherName(s).includes(normalizeTeacherName(TEACHER)) && /\([^)]*đ\s*ậ\s*m[^)]*\)/iu.test(String(s??''))}
function extractSubject(s){return clean(String(s??'').replace(/\(\s*Đ\s*ậ\s*m\s*\)/giu,''))}
function normalizeClassName(s){let x=clean(s); x=x.replace(/\s*\([^)]*\)\s*$/,''); x=x.split(/\s*-+\s*/)[0]; x=x.replace(/\s+/g,''); return x}
function normKey(s){return clean(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d')}
function detectHeaderRow(rows){for(let r=0;r<Math.min(rows.length,15);r++){let k=rows[r].map(normKey); if(k.some(x=>x==='thu')&&k.some(x=>x==='buoi')&&k.some(x=>x==='tiet')&&k.some(x=>x.includes('thoi gian')))return r} return -1}
function detectSheets(wb){return wb.SheetNames.filter(n=>{let rows=XLSX.utils.sheet_to_json(wb.Sheets[n],{header:1,defval:'',raw:false}); return detectHeaderRow(rows)>=0})}
function detectSchoolPoint(name,rows,headerRow){let line=clean((rows[1]||[]).join(' ')); if(/điểm/i.test(line))return line.replace(/\s+/g,' ').replace(/^điểm\s+/i,'Điểm '); let k=normKey(name); if(k==='bn')return 'Điểm chính'; if(k==='tt')return 'Điểm Thiên Tuế'; if(k==='bb')return 'Điểm Bãi Bấc'; return line||name}
function detectClassHeaders(header){let fixed=new Set(['thu','buoi','tiet','thoi gian']); let out=[]; header.forEach((v,i)=>{let k=normKey(v); if(i>=4 && clean(v) && !fixed.has(k) && !k.includes('tong stt')&&!k.startsWith('tong')) out.push({col:i,label:clean(v),lop:normalizeClassName(v)})}); return out}
function inheritThu(value,state){if(clean(value))state.thu=clean(value).replace(/^thứ\s*/i,''); return state.thu}
function inheritBuoi(value,state){if(clean(value))state.buoi=clean(value); return state.buoi}
function resolveTiet(row,index,rows,headerMap,state){
  const raw=clean(row[headerMap.tiet]), time=clean(row[headerMap.time]);
  state.lastResolveInfo={rawTiet:raw||'',adjusted:false,note:''};
  if(!time||/ra\s*chơi/i.test(time)) return '';
  const ctx=`${state.thu}|${normKey(state.buoi)}`;
  // Nếu cột Tiết trống: suy luận từ hàng tiết hợp lệ gần nhất phía trên trong cùng Thứ/Buổi.
  let inferred='';
  if(!/^\d+$/.test(raw)){
    for(let r=index-1;r>=0;r--){
      const rr=rows[r], t=clean(rr[headerMap.tiet]), tm=clean(rr[headerMap.time]);
      const rThu=clean(rr[headerMap.thu]), rBuoi=clean(rr[headerMap.buoi]);
      if(rThu && clean(rThu).replace(/^thứ\s*/i,'')!==state.thu) break;
      if(rBuoi && normKey(rBuoi)!==normKey(state.buoi)) break;
      if(/ra\s*chơi/i.test(tm+' '+clean(rr[0]))) continue;
      if(/^\d+$/.test(t)){ inferred=String(Number(t)+1); break; }
    }
  }
  let resolved=/^\d+$/.test(raw)?raw:inferred;
  // Kiểm tra mâu thuẫn tuần tự trên các tiết Đậm liên tiếp trong cùng buổi.
  // Trường hợp file ghi 1, [trống=>2], 2 nhưng thời gian tiếp tục sang tiết sau: cảnh báo và dùng 3.
  const prev=state.lastResolved;
  if(prev && prev.ctx===ctx && index>prev.row && resolved && Number(resolved)<=Number(prev.tiet) && time!==prev.time){
    const corrected=String(Number(prev.tiet)+1);
    const reason=`Cột Tiết mâu thuẫn thứ tự: sau Tiết ${prev.tiet} nhưng file ghi ${raw||'trống'}`;
    state.resolveWarnings.push({row:index+1,rawTiet:raw||'(trống)',resolved:corrected,time,reason});
    state.lastResolveInfo={rawTiet:raw||'',adjusted:true,note:`${reason}. Ứng dụng xác định Tiết ${corrected} theo thứ tự dòng/thời gian.`};
    resolved=corrected;
  }
  if(resolved) state.lastResolved={ctx,row:index,tiet:resolved,time};
  state.tiet=resolved;
  return resolved;
}
function colLetter(n){let s=''; for(n++;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s; return s}
function extractTeacherLessons(sheetName,ws){let rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:'',raw:false}); let hr=detectHeaderRow(rows); if(hr<0)return {lessons:[],errors:[],point:sheetName}; let header=rows[hr]; let find=(names)=>header.findIndex(x=>names.includes(normKey(x))); let hm={thu:find(['thu']),buoi:find(['buoi']),tiet:find(['tiet']),time:header.findIndex(x=>normKey(x).includes('thoi gian'))}; let classes=detectClassHeaders(header), point=detectSchoolPoint(sheetName,rows,hr), state={thu:'',buoi:'',tiet:'',lastResolved:null,resolveWarnings:[]}, lessons=[],errors=[];
 for(let r=hr+1;r<rows.length;r++){let row=rows[r]; let thu=inheritThu(row[hm.thu],state),buoi=inheritBuoi(row[hm.buoi],state),time=clean(row[hm.time]); let breakRow=/ra\s*chơi/i.test(row.map(clean).join(' ')); for(const ch of classes){let src=clean(row[ch.col]); if(!teacherCell(src)||breakRow)continue; let tiet=resolveTiet(row,r,rows,hm,state), mon=extractSubject(src); let ri=state.lastResolveInfo||{}; let item={thu,buoi,tiet,thoiGian:time,lop:ch.lop,monHoc:mon,diemTruong:point,sheetNguon:sheetName,dongNguon:r+1,cotNguon:ch.col+1,oNguon:src,tietNguon:ri.rawTiet||'',tietDaHieuChinh:!!ri.adjusted,ghiChuTiet:ri.note||''}; lessons.push(item); let miss=[]; if(!thu)miss.push('thiếu Thứ'); if(!buoi)miss.push('thiếu Buổi'); if(!ch.lop)miss.push('không xác định lớp'); if(!time)miss.push('không có thời gian'); if(!mon)miss.push('không xác định môn'); if(!tiet)miss.push('không xác định tiết'); if(miss.length)errors.push({...item,loi:miss.join(', ')}) }} for(const w of state.resolveWarnings){errors.push({sheetNguon:sheetName,dongNguon:w.row,cotNguon:hm.tiet+1,oNguon:`Tiết=${w.rawTiet}; Thời gian=${w.time}`,loi:`${w.reason}. Ứng dụng xác định Tiết ${w.resolved} theo thứ tự dòng/thời gian; cần đối chiếu file nguồn.`})} return {lessons,errors,point,headerRow:hr+1}}
function sortSchedule(a){const days=['Hai','Ba','Tư','Năm','Sáu','Bảy','Chủ nhật']; const sess=['Sáng','Chiều']; return [...a].sort((x,y)=>(days.indexOf(x.thu)-days.indexOf(y.thu))||(sess.indexOf(clean(x.buoi))-sess.indexOf(clean(y.buoi)))||(Number(x.tiet||99)-Number(y.tiet||99))||x.thoiGian.localeCompare(y.thoiGian,'vi')||x.diemTruong.localeCompare(y.diemTruong,'vi')||x.lop.localeCompare(y.lop,'vi'))}
function filterSchedule(){return sortSchedule(allLessons.filter(x=>(!$('fThu').value||x.thu===$('fThu').value)&&(!$('fBuoi').value||clean(x.buoi)===$('fBuoi').value)&&(!$('fPoint').value||x.diemTruong===$('fPoint').value)&&(!$('fClass').value||x.lop===$('fClass').value)))}
function setOptions(id,vals,prefix){$(id).innerHTML=`<option value="">${prefix}</option>`+[...new Set(vals)].sort((a,b)=>a.localeCompare(b,'vi')).map(x=>`<option>${esc(x)}</option>`).join('')}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function pointKind(s){let k=normKey(s); if(k.includes('thien tue'))return 'tt'; if(k.includes('bai bac'))return 'bb'; if(k.includes('chinh'))return 'bn'; return 'other'}
function pointBadge(s,compact=false){const kind=pointKind(s), label=compact?clean(s).replace(/^Điểm\s+/i,''):clean(s); return `<span class="point-badge point-${kind}"><span class="point-dot"></span>${esc(label)}</span>`}
function renderStats(){let p=x=>allLessons.filter(y=>normKey(y.diemTruong).includes(x)).length; let vals=[['TỔNG TIẾT',allLessons.length],['BUỔI SÁNG',allLessons.filter(x=>normKey(x.buoi)==='sang').length],['BUỔI CHIỀU',allLessons.filter(x=>normKey(x.buoi)==='chieu').length],['ĐIỂM CHÍNH',p('chinh')],['THIÊN TUẾ',p('thien tue')],['BÃI BẤC',p('bai bac')],['SỐ LỚP',new Set(allLessons.map(x=>x.lop)).size]]; $('stats').innerHTML=vals.map(([a,b])=>`<div class="card"><small>${a}</small><b>${b}</b></div>`).join('')}
function renderTable(data){
  // Gộp Thứ và Buổi theo đúng nhóm đang hiển thị (kể cả sau khi lọc).
  let rows='';
  for(let i=0;i<data.length;){
    const thu=data[i].thu; let dayEnd=i; while(dayEnd<data.length&&data[dayEnd].thu===thu) dayEnd++;
    let j=i, firstDay=true;
    while(j<dayEnd){
      const buoi=clean(data[j].buoi); let sessionEnd=j; while(sessionEnd<dayEnd&&clean(data[sessionEnd].buoi)===buoi) sessionEnd++;
      for(let k=j;k<sessionEnd;k++){
        const x=data[k]; const cls=['lesson-row']; if(firstDay) cls.push('day-start'); if(k===j) cls.push('session-start');
        rows+=`<tr class="${cls.join(' ')} clickable-lesson" data-lesson-index="${allLessons.indexOf(x)}" title="Bấm để xem nguồn Excel">`;
        if(firstDay) rows+=`<td class="day-cell" rowspan="${dayEnd-i}"><strong>THỨ ${esc(String(thu).toUpperCase())}</strong></td>`;
        if(k===j) rows+=`<td class="session-cell" rowspan="${sessionEnd-j}"><strong>${esc(buoi.toUpperCase())}</strong></td>`;
        rows+=`<td class="tiet-cell">${esc(x.tiet)}</td><td>${esc(x.thoiGian)}</td><td class="class-cell"><b>${esc(x.lop)}</b></td><td>${esc(normalizeSubjectForPlan(x.monHoc))}</td><td class="point-cell">${pointBadge(x.diemTruong)}</td></tr>`;
        firstDay=false;
      }
      j=sessionEnd;
    }
    i=dayEnd;
  }
  $('view').innerHTML=`<div class="schedule-table-wrap"><table class="schedule-table"><thead><tr><th>Thứ</th><th>Buổi</th><th>Tiết</th><th>Thời gian</th><th>Lớp</th><th>Môn học</th><th>Điểm trường</th></tr></thead><tbody>${rows}</tbody></table></div>`
}
function renderWeek(data){
  const order=['Hai','Ba','Tư','Năm','Sáu','Bảy','Chủ nhật'];
  const days=order.filter(d=>data.some(x=>x.thu===d));
  if(!data.length){$('view').innerHTML='<div class="info">Không có tiết phù hợp với bộ lọc hiện tại.</div>';return}
  const dayTitle=d=>d==='Chủ nhật'?'CHỦ NHẬT':`THỨ ${d.toUpperCase()}`;
  const sessions=['Sáng','Chiều'].filter(s=>data.some(x=>normKey(x.buoi)===normKey(s)));
  const blocks=sessions.map(session=>{
    const sd=data.filter(x=>normKey(x.buoi)===normKey(session));
    const periods=[...new Set(sd.map(x=>Number(x.tiet)).filter(Number.isFinite))].sort((a,b)=>a-b);
    const rows=periods.map(tiet=>{
      const time=sd.find(x=>Number(x.tiet)===tiet)?.thoiGian||'';
      const cells=days.map(day=>{
        const items=sd.filter(x=>x.thu===day&&Number(x.tiet)===tiet);
        return `<td class="matrix-slot">${items.map(x=>`<div class="matrix-lesson clickable-lesson" data-lesson-index="${allLessons.indexOf(x)}" title="Bấm để xem nguồn Excel"><div class="matrix-class">${esc(x.lop)}</div><div class="matrix-subject">${esc(normalizeSubjectForPlan(x.monHoc))}</div><div class="matrix-point">${pointBadge(x.diemTruong,true)}</div><div class="matrix-time">${esc(x.thoiGian)}</div></div>`).join('')}</td>`;
      }).join('');
      return `<tr><th class="matrix-period"><b>Tiết ${tiet}</b>${time?`<small>${esc(time)}</small>`:''}</th>${cells}</tr>`;
    }).join('');
    return `<section class="matrix-section"><div class="matrix-session-title">${session.toUpperCase()}</div><div class="matrix-scroll"><table class="week-matrix"><thead><tr><th class="matrix-corner">TIẾT</th>${days.map(d=>`<th>${dayTitle(d)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }).join('');
  $('view').innerHTML=`<div class="matrix-view"><div class="matrix-heading"><div><h2>LỊCH TUẦN CÁ NHÂN</h2><p>Giáo viên: <b>ĐẬM</b> · Hiển thị theo Thứ và Tiết</p></div><div class="matrix-legend">📍 Lớp · Môn · Điểm trường</div></div>${blocks}</div>`;
}
function showSourceDetail(x){
  if(!x){alert('Không tìm thấy dữ liệu nguồn của tiết này.');return}
  const old=document.getElementById('sourceModal'); if(old) old.remove();
  const addr=`${colLetter(x.cotNguon-1)}${x.dongNguon}`;
  const sourceTiet=x.tietNguon||'(trống)';
  const adjusted=x.tietDaHieuChinh?`<div class="source-alert"><b>⚠ Tiết đã được hiệu chỉnh</b><br>Tiết ghi trong nguồn: <b>${esc(sourceTiet)}</b> → Tiết ứng dụng xác định: <b>${esc(x.tiet)}</b><br><span>${esc(x.ghiChuTiet)}</span></div>`:'';
  const html=`<div class="source-modal" id="sourceModal" role="dialog" aria-modal="true"><div class="source-dialog"><button type="button" class="source-close" aria-label="Đóng">×</button><div class="source-title"><div><small>ĐỐI CHIẾU NGUỒN EXCEL</small><h3>${esc(x.sheetNguon)}!${addr}</h3></div><span class="source-badge">Ô nguồn</span></div><div class="source-origin"><span>Sheet <b>${esc(x.sheetNguon)}</b></span><span>Dòng <b>${x.dongNguon}</b></span><span>Cột <b>${colLetter(x.cotNguon-1)} (${x.cotNguon})</b></span></div><div class="source-cell"><small>NỘI DUNG Ô EXCEL GỐC</small><strong>${esc(x.oNguon)}</strong></div>${adjusted}<div class="source-grid"><div><small>Thứ</small><b>Thứ ${esc(x.thu)}</b></div><div><small>Buổi</small><b>${esc(x.buoi)}</b></div><div><small>Tiết</small><b>${esc(x.tiet)}</b></div><div><small>Thời gian</small><b>${esc(x.thoiGian)}</b></div><div><small>Lớp</small><b>${esc(x.lop)}</b></div><div><small>Môn học</small><b>${esc(x.monHoc)}</b></div><div class="source-wide"><small>Điểm trường</small><b>📍 ${esc(x.diemTruong)}</b></div></div>${x.plan?`<div class="source-pl2"><b>📘 PHỤ LỤC 2 · TUẦN ${x.planWeek}</b><div class="plan-title">${esc(x.plan.title)}</div><div class="plan-meta">${esc(x.plan.subject)} · Lớp ${x.plan.grade}${x.plan.duration?` · ${esc(x.plan.duration)}`:''}</div></div>`:`<div class="source-pl2"><b>📘 PHỤ LỤC 2</b><div class="plan-meta">Chưa tìm thấy nội dung phù hợp cho tuần ${x.planWeek||$('weekSelect').value}.</div></div>`}<div class="source-foot">Kết quả được phân tích trực tiếp từ file Excel đang tải.</div></div></div>`;
  document.body.insertAdjacentHTML('beforeend',html);
  const m=document.getElementById('sourceModal');
  const close=()=>{const z=document.getElementById('sourceModal');if(z)z.remove()};
  m.querySelector('.source-close').addEventListener('click',close);
  m.addEventListener('click',e=>{if(e.target===m)close()});
  setTimeout(()=>m.classList.add('source-modal-open'),0);
}
function bindLessonClicks(){
  // Dùng event delegation để click vẫn hoạt động sau mọi lần render/lọc/chuyển chế độ xem.
  const view=$('view');
  if(view.dataset.sourceClickBound==='1') return;
  view.dataset.sourceClickBound='1';
  view.addEventListener('click',function(e){
    const el=e.target.closest('.clickable-lesson');
    if(!el||!view.contains(el)) return;
    e.preventDefault(); e.stopPropagation();
    const idx=Number(el.dataset.lessonIndex);
    if(Number.isInteger(idx)&&allLessons[idx]) showSourceDetail(allLessons[idx]);
    else alert('Không tìm thấy dữ liệu nguồn của tiết này. Vui lòng tải lại file TKB.');
  });
}

const planSubjectCatalog=new Map();
function subjectAliasKeys(subject){
  const raw=clean(subject), base=normKey(raw), compact=base.replace(/[^a-z0-9]+/g,'');
  const words=base.split(/[^a-z0-9]+/).filter(Boolean);
  const initials=words.map(w=>w[0]).join('');
  const noConnectors=words.filter(w=>!['va','and','mon'].includes(w)).map(w=>w[0]).join('');
  const out=new Set([base,compact,initials,noConnectors].filter(Boolean));
  // Một số viết tắt thông dụng trong TKB; danh mục môn vẫn được lấy động từ Phụ lục 2.
  if(compact==='tinhoc') out.add('th');
  if(compact==='congnghe'){out.add('cn');out.add('cnghe')}
  if(compact==='daoduc') out.add('dd');
  if(compact==='tiengviet') out.add('tv');
  if(compact==='tunhienvaxahoi'||compact==='tunhienxahoi'){out.add('tnxh');out.add('tnvxh')}
  if(compact==='lichsuvadialy'||compact==='lichsudialy'){out.add('lsdl');out.add('lsvdl')}
  if(compact==='mythuat'||compact==='mithuat') out.add('mt');
  if(compact==='amnhac') out.add('an');
  if(compact==='theduc'||compact==='giaoducthechat'){out.add('td');out.add('gdtc')}
  return out;
}
function registerPlanSubject(subject){
  const canonical=clean(subject).replace(/^môn\s+/iu,'').trim();
  if(!canonical)return canonical;
  for(const k of subjectAliasKeys(canonical)) planSubjectCatalog.set(k,canonical);
  return canonical;
}
function normalizeSubjectForPlan(s){
  const raw=clean(s), base=normKey(raw), compact=base.replace(/[^a-z0-9]+/g,'');
  for(const k of [base,compact]) if(planSubjectCatalog.has(k)) return planSubjectCatalog.get(k);
  // Tương thích ngay cả trước khi tải PL2.
  const builtins={th:'Tin học',tinhoc:'Tin học',cn:'Công nghệ',cnghe:'Công nghệ',congnghe:'Công nghệ',dd:'Đạo đức',daoduc:'Đạo đức'};
  return builtins[compact]||raw;
}
function gradeFromClass(lop){const m=clean(lop).match(/(\d+)/);return m?Number(m[1]):null}
function planKey(subject,grade,week){return `${normKey(normalizeSubjectForPlan(subject))}|${grade}|${Number(week)}`}
function parsePlanSection(text){
  const x=clean(text);
  // Nhận động mọi tiêu đề: "Môn <tên môn> – Lớp <khối>", không khóa danh sách môn.
  const m=x.match(/(?:^|\b)Môn\s+(.+?)\s*[–—-]\s*Lớp\s*(\d{1,2})(?:\b|$)/iu);
  if(!m)return null;
  const subject=registerPlanSubject(m[1]);
  return subject?{subject,grade:Number(m[2])}:null;
}
function addPlanRecord(section,cells,source){
  if(!section||!cells.length)return;
  const w=Number(clean(cells[0])); if(!(w>=1&&w<=35))return;
  // Bảng PL2 chuẩn: Tuần | Chủ điểm | Tên bài | Tiết/thời lượng | Điều chỉnh | Ghi chú
  const title=clean(cells[2]||''), duration=clean(cells[3]||''), integration=clean(cells[4]||''), note=clean(cells[5]||'');
  if(!title)return;
  const pm=duration.match(/Tiết\s*(\d+)/iu); const annualPeriod=pm?Number(pm[1]):w;
  lessonPlanMap.set(planKey(section.subject,section.grade,w),{subject:section.subject,grade:section.grade,week:w,annualPeriod,title,duration,integration,note,source});
}
function xmlNodeText(node){return clean([...node.getElementsByTagNameNS('*','t')].map(n=>n.textContent||'').join(' '))}
async function readPlanDocx(file){
  if(typeof JSZip==='undefined')throw new Error('Không tải được thư viện đọc Word (JSZip).');
  const zip=await JSZip.loadAsync(await file.arrayBuffer()), entry=zip.file('word/document.xml'); if(!entry)throw new Error('Không tìm thấy word/document.xml.');
  const xml=new DOMParser().parseFromString(await entry.async('string'),'application/xml'), body=xml.getElementsByTagNameNS('*','body')[0];
  let section=null; lessonPlanMap.clear(); planSubjectCatalog.clear();
  for(const node of [...body.children]){
    const local=node.localName;
    if(local==='p'){const sec=parsePlanSection(xmlNodeText(node)); if(sec)section=sec;}
    else if(local==='tbl'){
      for(const tr of [...node.getElementsByTagNameNS('*','tr')]){
        const cells=[...tr.getElementsByTagNameNS('*','tc')].map(xmlNodeText);
        const joined=cells.join(' '), sec=parsePlanSection(joined); if(sec){section=sec;continue}
        addPlanRecord(section,cells,`Word · ${section?section.subject+' lớp '+section.grade:''}`);
      }
    }
  }
}
async function readPlanExcel(file){
  const wb=XLSX.read(await file.arrayBuffer(),{type:'array',cellText:true}); lessonPlanMap.clear(); planSubjectCatalog.clear();
  for(const sn of wb.SheetNames){let section=null, rows=XLSX.utils.sheet_to_json(wb.Sheets[sn],{header:1,defval:'',raw:false});
    for(let r=0;r<rows.length;r++){const cells=rows[r].map(clean), joined=cells.join(' '); const sec=parsePlanSection(joined); if(sec)section=sec; addPlanRecord(section,cells,`${sn}!${r+1}`)}
  }
}
function applyLessonPlan(){
  const week=Number($('weekSelect').value||1); let matched=0, missing=[];
  for(const x of allLessons){const grade=gradeFromClass(x.lop), subject=normalizeSubjectForPlan(x.monHoc), plan=lessonPlanMap.get(planKey(subject,grade,week)); x.planWeek=week;x.planSubject=subject;x.planGrade=grade;x.plan=plan||null; if(plan)matched++; else missing.push(`${x.lop} · ${subject}`)}
  if(!lessonPlanMap.size){$('pl2Match').className='info pl2-match';$('pl2Match').innerHTML='Tải Phụ lục 2 và chọn tuần để ghép tên bài học.';return}
  const unique=[...new Set(missing)]; $('pl2Match').className=`info pl2-match ${matched===allLessons.length?'ok-match':'warn-match'}`;
  $('pl2Match').innerHTML=`<b>Tuần ${week}: ghép được ${matched}/${allLessons.length} tiết TKB</b>${unique.length?`<div class="pl2-details">Chưa ghép: ${unique.map(x=>`<span class="pl2-chip">${esc(x)}</span>`).join('')}</div>`:`<div class="pl2-details">✓ Tất cả tiết đã tìm được tên bài học trong Phụ lục 2 theo Môn + Khối + Tuần.</div>`}`;
}
async function readLessonPlan(file){
  try{
    const ext=(file.name.split('.').pop()||'').toLowerCase();
    if(ext==='docx')await readPlanDocx(file); else if(ext==='xlsx'||ext==='xls')await readPlanExcel(file); else throw new Error('Chỉ hỗ trợ .docx, .xlsx, .xls');
    lessonPlanMeta={file:file.name,type:ext,count:lessonPlanMap.size};
    $('pl2Info').innerHTML=`<b>${esc(file.name)}</b> · ${lessonPlanMap.size} dòng kế hoạch đã nhận diện`; applyLessonPlan(); render();
    if(!currentAuthUser){alert('Phụ lục 2 đã đọc thành công trên máy này. Hãy đăng nhập giáo viên để lưu Kho Phụ lục 2 lên Supabase.');return;}
    try{
      const saved=await saveAppendix2ToSupabase(file);
      $('pl2Info').innerHTML=`<b>${esc(file.name)}</b> · ${lessonPlanMap.size} dòng kế hoạch đã nhận diện · ☁️ Đã lưu Supabase`;
      alert(`Đã lưu Phụ lục 2 lên Supabase: ${saved.subjects} môn, ${saved.lessons} dòng kế hoạch.`);
    }catch(cloudErr){
      console.error('[TKB] Không lưu được Phụ lục 2 lên Supabase',cloudErr);
      const duplicate=String(cloudErr?.message||cloudErr).includes('đã tồn tại');
      alert((duplicate?'Phụ lục 2 đã được nhận diện và vẫn dùng bình thường. ':'Phụ lục 2 đã được nhận diện trên máy này nhưng chưa lưu được lên Supabase. ')+(cloudErr?.message||cloudErr));
    }
  }catch(err){lessonPlanMap.clear();lessonPlanMeta={file:'',type:'',count:0};$('pl2Info').textContent='Không đọc được Phụ lục 2.';$('pl2Match').className='info pl2-match warn-match';$('pl2Match').innerHTML=`<b>⚠ Không đọc được Phụ lục 2:</b> ${esc(err.message||err)}`;}
}
function initWeekSelect(){ const opts=Array.from({length:35},(_,i)=>`<option value="${i+1}">Tuần ${i+1}</option>`).join(''); $('weekSelect').innerHTML=opts; $('weekSelect').value='1'; if($('effectiveFromWeek')){$('effectiveFromWeek').innerHTML=opts;$('effectiveFromWeek').value='1';} }

function render(){applyLessonPlan(); let d=filterSchedule(); $('tableBtn').classList.toggle('active-view',currentView==='table'); $('weekBtn').classList.toggle('active-view',currentView==='week'); currentView==='table'?renderTable(d):renderWeek(d); bindLessonClicks()}
function parseWorkbookFile(file){return new Promise((resolve,reject)=>{let fr=new FileReader();fr.onload=e=>{try{let wb=XLSX.read(e.target.result,{type:'array',cellText:true}),sheets=detectSheets(wb),errors=[],counts={},lessons=[];for(const s of sheets){let r=extractTeacherLessons(s,wb.Sheets[s]);lessons.push(...r.lessons);errors.push(...r.errors);counts[s]=r.lessons.length}resolve({file:file.name,sheets,counts,errors,lessons:sortSchedule(lessons)})}catch(err){reject(err)}};fr.onerror=()=>reject(fr.error||new Error('Không đọc được file'));fr.readAsArrayBuffer(file)})}
function effectiveScheduleForWeek(week){
  return [...scheduleVersions].filter(v=>v.startWeek<=week).sort((a,b)=>b.startWeek-a.startWeek||String(b.uploadedAt||'').localeCompare(String(a.uploadedAt||'')))[0]||null;
}
function versionRangeText(v){
  const starts=[...new Set(scheduleVersions.map(x=>Number(x.startWeek)))].sort((a,b)=>a-b),i=starts.indexOf(Number(v.startWeek)),end=i>=0&&i<starts.length-1?starts[i+1]-1:35;
  return `Tuần ${v.startWeek}–${end}`;
}
async function readWorkbooks(files){
  const list=[...files]; if(!list.length)return;
  // Mốc hiệu lực do người dùng chọn. TKB đầu năm mặc định từ Tuần 1; khi đổi TKB chọn tuần bắt đầu áp dụng.
  const startWeek=Math.max(1,Math.min(35,Number($('effectiveFromWeek')?.value||1)));
  for(let i=0;i<list.length;i++){
    const file=list[i];
    try{
      const parsed=await parseWorkbookFile(file), sw=Math.min(35,startWeek+i), fingerprint=scheduleFingerprint(parsed.lessons), duplicate=findDuplicateSchedule(fingerprint);
      if(duplicate){
        alert(`TKB "${file.name}" trùng với bản đã lưu "${duplicate.file}" (hiệu lực từ Tuần ${duplicate.startWeek}). Hệ thống không thêm bản trùng.`);
        continue;
      }
      const now=new Date(), uploadedAt=now.toISOString(), uploadedAtLabel=now.toLocaleString('vi-VN');
      const version={startWeek:sw,uploadedAt,uploadedAtLabel,fingerprint,...parsed};
      if(!currentAuthUser){alert('Bạn cần đăng nhập giáo viên trước khi thêm TKB mới để dữ liệu được lưu đúng tài khoản trên Supabase.');continue;}
      await saveTimetableVersionToSupabase(version);
      scheduleVersions.push(version);
      scheduleVersions.sort((a,b)=>a.startWeek-b.startWeek||String(a.uploadedAt||'').localeCompare(String(b.uploadedAt||'')));
      saveScheduleRepository();
      alert(`Đã lưu TKB mới vào Supabase và bộ nhớ cục bộ. Hiệu lực từ Tuần ${sw}.`);
    }catch(err){alert(`Không đọc được ${file.name}: ${err.message||err}`)}
  }
  activateSelectedWeek();
}
function activateSelectedWeek(){
  const week=Number($('weekSelect').value||1), saved=effectiveScheduleForWeek(week);
  if(saved){
    allLessons=[...saved.lessons];meta={...saved};finishLoad();
    $('fileInfo').innerHTML+=` · <b>Tuần ${week}</b> · TKB hiệu lực từ <b>Tuần ${saved.startWeek}</b>`;
  }else{
    allLessons=[];meta={file:'',sheets:[],counts:{},errors:[]};
    $('fileInfo').innerHTML=`<b>Tuần ${week}</b> · Chưa có TKB có hiệu lực. Hãy tải TKB đầu năm (hiệu lực từ Tuần 1).`;
    renderStats();setOptions('fThu',[],'Tất cả Thứ');setOptions('fPoint',[],'Tất cả điểm trường');setOptions('fClass',[],'Tất cả lớp');
    $('scan').innerHTML=`<b>Các phiên bản TKB:</b> ${repositorySummary()}`;
    $('errors').innerHTML='';applyLessonPlan();render();
  }
}
function finishLoad(){let month=(meta.file.match(/(?:THÁNG|THANG)\s*([0-9]{1,2})[.\-\s]*(20\d{2})/i)||[]); $('fileInfo').innerHTML=`<b>${esc(meta.file)}</b>${month.length?` · TKB tháng ${month[1]}/${month[2]}`:''} · <b>${allLessons.length} tiết</b>`; renderStats(); setOptions('fThu',['Hai','Ba','Tư','Năm','Sáu','Bảy','Chủ nhật'].filter(d=>allLessons.some(x=>x.thu===d)),'Tất cả Thứ'); setOptions('fPoint',allLessons.map(x=>x.diemTruong),'Tất cả điểm trường'); setOptions('fClass',allLessons.map(x=>x.lop),'Tất cả lớp'); $('scan').innerHTML=`<b>Đã quét: ${meta.sheets.length} sheet</b> · ${meta.sheets.map(s=>`${esc(s)}: ${meta.counts[s]||0} tiết Đậm`).join(' · ')} · <b>Tổng: ${allLessons.length}</b><br><small><b>TKB có hiệu lực:</b> ${repositorySummary()}</small>`; $('errors').innerHTML=meta.errors.length?`<div class="warn"><b>⚠️ DỮ LIỆU CẦN KIỂM TRA</b><br>${meta.errors.map(x=>`${esc(x.sheetNguon)} → dòng ${x.dongNguon} → cột ${x.cotNguon} → ${esc(x.oNguon)}: <span class="bad">${esc(x.loi)}</span>`).join('<br>')}</div>`:`<div class="info ok">✓ Không phát hiện tiết Đậm thiếu Thứ, Buổi, Lớp, Thời gian, Môn hoặc Tiết.</div>`; render()}
function getConcurrentPeriods(){const n=Number($('concurrentPeriods')?.value||0);return Number.isFinite(n)&&n>0?Math.floor(n):0}
function formalSubjectGradeText(data){
  const subjects=[...new Set(data.map(x=>normalizeSubjectForPlan(x.monHoc)).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'vi'));
  const grades=[...new Set(data.map(x=>{const m=String(x.lop||'').match(/\d+/);return m?Number(m[0]):null}).filter(Number.isFinite))].sort((a,b)=>a-b);
  return `Môn: ${subjects.join(', ')} – Khối: ${grades.join(', ')}`;
}
function exportExcel(){
  const d=filterSchedule(); if(!d.length)return alert('Không có dữ liệu để xuất.');
  const wb=XLSX.utils.book_new();
  const days=['Hai','Ba','Tư','Năm','Sáu'];
  const dayLabels=['Thứ hai','Thứ ba','Thứ tư','Thứ năm','Thứ sáu'];
  const month=(meta.file?.match(/(?:THÁNG|THANG)\s*([0-9]{1,2})[.\-\s]*(20\d{2})/i)||[]);
  const m=month.length?Number(month[1]):''; const y=month.length?Number(month[2]):'';
  const yearText=y?`${y} - ${y+1}`:'2026 - 2027';
  const maxMorning=Math.max(4,...d.filter(x=>normKey(x.buoi)==='sang').map(x=>Number(x.tiet)||0));
  const maxAfternoon=Math.max(3,...d.filter(x=>normKey(x.buoi)==='chieu').map(x=>Number(x.tiet)||0));
  const rows=[];
  // Tuần xuất phải lấy trực tiếp từ bộ chọn Tuần 1–35, không suy ra từ tên file TKB.
  // File TKB chỉ quyết định phiên bản lịch có hiệu lực; tuần đang chọn quyết định ngày và Phụ lục 2.
  const wd=selectedWeekDates();
  const schoolWeek=wd.week;
  const activityTitle=`Hoạt động giáo dục tuần ${schoolWeek}`;
  const weekLine=`Tuần ${schoolWeek}: từ ngày ${wd.fmt(wd.start)} đến ${wd.fmt(wd.end)}`;
  rows.push(['PHỤ LỤC 1.4','','','','','','']);
  rows.push([activityTitle,'','','','','','']);
  rows.push([`Năm học ${yearText}. ${formalSubjectGradeText(d)}, Trường TH – THCS & THPT Lại Sơn`,'','','','','','']);
  rows.push([weekLine,'','','','','','','']);
  rows.push(['Thời gian','',...days.map((x,i)=>`Ngày ${wd.days[i]}\n${dayLabels[i]}`)]);
  rows.push(['Buổi','Tiết',...dayLabels]);
  const morningStart=7;
  for(let t=1;t<=maxMorning;t++) rows.push(['Sáng',t,...days.map(day=>excelLessonCellFormal(d,day,'Sáng',t))]);
  const afternoonStart=morningStart+maxMorning;
  for(let t=1;t<=maxAfternoon;t++) rows.push(['Chiều',t,...days.map(day=>excelLessonCellFormal(d,day,'Chiều',t))]);
  const totalRow=rows.length+1; rows.push([`Tổng số: ${d.length} tiết`,'','','','','','']);
  rows.push(['TỔNG HỢP','','','','','','']);
  rows.push(['TT','Nội dung','','','Số lượng tiết học','','Ghi chú']);
  const subjects=[...new Set(d.map(x=>normalizeSubjectForPlan(x.monHoc)).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'vi'));
  subjects.forEach((sub,i)=>rows.push([i+1,sub,'','',d.filter(x=>normalizeSubjectForPlan(x.monHoc)===sub).length,'','']));
  const concurrent=getConcurrentPeriods();
  if(concurrent>0) rows.push([subjects.length+1,'Kiêm nhiệm','','',concurrent,'','']);
  const summaryDetailRows=subjects.length+(concurrent>0?1:0);
  const sumRow=rows.length+1; rows.push(['Tổng số','','','',d.length+concurrent,'','']);
  rows.push(['','','','','','','']);
  rows.push(['PHÓ HIỆU TRƯỞNG','','TỔ TRƯỞNG','','','NGƯỜI LẬP KẾ HOẠCH','']);
  rows.push(['','','','','','','']); rows.push(['','','','','','','']);
  rows.push(['','','','','','Võ Thanh Đậm','']);

  const ws=XLSX.utils.aoa_to_sheet(rows);
  const endSchedule=morningStart+maxMorning+maxAfternoon-1;
  const merges=[
    'A1:G1','A2:G2','A3:G3','A4:G4','A5:B5',
    `A${morningStart}:A${morningStart+maxMorning-1}`,
    `A${afternoonStart}:A${afternoonStart+maxAfternoon-1}`,
    `A${totalRow}:G${totalRow}`,
    `A${totalRow+1}:G${totalRow+1}`,
    // Bảng TỔNG HỢP: TT | Nội dung | Số lượng tiết học | Ghi chú
    ...Array.from({length:summaryDetailRows+1},(_,i)=>{
      const r=totalRow+2+i; return [`B${r}:D${r}`,`E${r}:F${r}`];
    }).flat(),
    `A${sumRow}:D${sumRow}`,`E${sumRow}:F${sumRow}`,
    `A${sumRow+2}:B${sumRow+2}`,`C${sumRow+2}:D${sumRow+2}`,`F${sumRow+2}:G${sumRow+2}`,
    `F${sumRow+5}:G${sumRow+5}`
  ];
  ws['!merges']=merges.map(XLSX.utils.decode_range);
  ws['!cols']=[{wch:10},{wch:7},...days.map(()=>({wch:24}))];
  ws['!rows']=rows.map((_,i)=>({hpt:i<4?[18,20,19,21][i]: (i===4||i===5?28 : (i>=6&&i<endSchedule?58:22))}));
  ws['!freeze']={xSplit:2,ySplit:6};
  ws['!pageSetup']={orientation:'landscape',paperSize:9,fitToWidth:1,fitToHeight:1};
  ws['!margins']={left:0.2,right:0.2,top:0.25,bottom:0.25,header:0.1,footer:0.1};
  ws['!printArea']=`A1:G${rows.length}`;
  const black='000000', navy='173F73', pale='F7FBFF', light='EAF2FB';
  const thin={style:'thin',color:{rgb:black}}, med={style:'medium',color:{rgb:black}};
  const border={top:thin,bottom:thin,left:thin,right:thin};
  const center={horizontal:'center',vertical:'center',wrapText:true};
  for(let R=0;R<rows.length;R++) for(let C=0;C<7;C++){
    const a=XLSX.utils.encode_cell({r:R,c:C}); if(!ws[a])ws[a]={t:'s',v:''};
    ws[a].s={font:{name:'Times New Roman',sz:10,color:{rgb:black}},alignment:{vertical:'center',wrapText:true},border};
  }
  ['A1','A2','A3','A4'].forEach((a,i)=>ws[a].s={font:{name:'Times New Roman',sz:[10,12,10,11][i],bold:true,color:{rgb:black}},alignment:center});
  for(let C=0;C<7;C++) for(let R=4;R<=5;R++){let a=XLSX.utils.encode_cell({r:R,c:C});ws[a].s={font:{name:'Times New Roman',sz:10,bold:true},alignment:center,border:{top:med,bottom:med,left:thin,right:thin},fill:{fgColor:{rgb:'F2F2F2'}}};}
  for(let R=6;R<endSchedule;R++) for(let C=0;C<7;C++){let a=XLSX.utils.encode_cell({r:R,c:C});ws[a].s={font:{name:'Times New Roman',sz:C<2?10:9,bold:C<2},alignment:C<2?center:{horizontal:'center',vertical:'center',wrapText:true},border,fill:{fgColor:{rgb:C<2?light:(R%2?pale:'FFFFFF')}}};}
  ws[`A${morningStart}`].s.font.bold=true; ws[`A${afternoonStart}`].s.font.bold=true;
  for(let C=0;C<7;C++){let a=XLSX.utils.encode_cell({r:endSchedule-1,c:C}); if(ws[a]) ws[a].s.border.bottom=med;}
  // Tổng số tiết
  for(let C=0;C<7;C++){const a=XLSX.utils.encode_cell({r:totalRow-1,c:C});ws[a].s={font:{name:'Times New Roman',sz:10,bold:true},alignment:center,border};}
  // Tổng hợp
  ws[`A${totalRow+1}`].s={font:{name:'Times New Roman',sz:11,bold:true},alignment:center};
  for(let C=0;C<7;C++){let a=XLSX.utils.encode_cell({r:totalRow+1,c:C});ws[a].s={font:{name:'Times New Roman',sz:10,bold:true},alignment:center,border,fill:{fgColor:{rgb:'F2F2F2'}}};}
  for(let R=totalRow+2;R<sumRow;R++) for(let C=0;C<7;C++){let a=XLSX.utils.encode_cell({r:R,c:C});ws[a].s={font:{name:'Times New Roman',sz:10,bold:R===totalRow+2},alignment:center,border};}
  for(let C=0;C<7;C++){let a=XLSX.utils.encode_cell({r:sumRow-1,c:C});ws[a].s={font:{name:'Times New Roman',sz:10,bold:true},alignment:center,border};}
  [sumRow+1,sumRow+4].forEach(r=>{for(let C=0;C<7;C++){let a=XLSX.utils.encode_cell({r:r,c:C});ws[a].s={font:{name:'Times New Roman',sz:10,bold:true},alignment:center};}});
  XLSX.utils.book_append_sheet(wb,ws,'TKB tuần');

  const src=[['Sheet','Dòng','Cột','Ô nguồn','Nội dung ô gốc','Thứ','Buổi','Tiết nguồn','Tiết xác định','Thời gian','Lớp','Môn học','Điểm trường','Ghi chú'],...d.map(x=>[x.sheetNguon,x.dongNguon,`${colLetter(x.cotNguon-1)} (${x.cotNguon})`,`${x.sheetNguon}!${colLetter(x.cotNguon-1)}${x.dongNguon}`,x.oNguon,`Thứ ${x.thu}`,clean(x.buoi),x.tietNguon||'',x.tiet,x.thoiGian,x.lop,normalizeSubjectForPlan(x.monHoc),x.diemTruong,x.ghiChuTiet||''])];
  const ws2=XLSX.utils.aoa_to_sheet(src); ws2['!cols']=[9,8,9,13,22,11,10,11,12,18,10,18,22,48].map(w=>({wch:w})); ws2['!autofilter']={ref:`A1:N${src.length}`};
  for(let C=0;C<14;C++){const a=XLSX.utils.encode_cell({r:0,c:C});ws2[a].s={font:{name:'Arial',sz:10,bold:true,color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:navy}},alignment:center,border};}
  XLSX.utils.book_append_sheet(wb,ws2,'Đối chiếu nguồn');
  XLSX.writeFile(wb,`TKB_CA_NHAN_GV_DAM_TUAN_${wd.week}.xlsx`,{cellStyles:true});
}
function excelLessonCellFormal(data,day,session,tiet){
  const items=data.filter(x=>x.thu===day&&normKey(x.buoi)===normKey(session)&&Number(x.tiet)===Number(tiet));
  return items.map(x=>{const sub=normalizeSubjectForPlan(x.monHoc); const planTiet=x.plan?.annualPeriod||x.plan?.week||x.planWeek||''; const lesson=x.plan?.title?`Tiết ${planTiet} - ${x.plan.title}`:`[Chưa ghép Phụ lục 2]`; return `${sub} ${clean(x.lop)} ${lesson}`}).join('\n────────\n');
}

function excelLessonCell(data,day,session,tiet){
  const items=data.filter(x=>x.thu===day&&normKey(x.buoi)===normKey(session)&&Number(x.tiet)===Number(tiet));
  return items.map(x=>`${x.monHoc} ${x.lop}\n${clean(x.diemTruong).replace(/^Điểm\s+/i,'Điểm ')}\n${x.thoiGian}`).join('\n────────\n');
}
function selectedWeekDates(){
  const week=Number($('weekSelect').value||1), start=new Date(2026,8,7+(week-1)*7), end=new Date(start); end.setDate(start.getDate()+4);
  const pad=n=>String(n).padStart(2,'0'), fmt=x=>`${pad(x.getDate())}/${pad(x.getMonth()+1)}/${x.getFullYear()}`;
  return {week,start,end,fmt,days:Array.from({length:5},(_,i)=>{const x=new Date(start);x.setDate(start.getDate()+i);return fmt(x)})};
}
function formalLessonHtml(data,day,session,tiet){
  const items=data.filter(x=>x.thu===day&&normKey(x.buoi)===normKey(session)&&Number(x.tiet)===Number(tiet));
  return items.map(x=>{const sub=normalizeSubjectForPlan(x.monHoc), title=x.plan?.title||'[Chưa ghép Phụ lục 2]', planTiet=x.plan?.annualPeriod||x.plan?.week||x.planWeek||'';return `<div class="formal-lesson"><b>${esc(sub)} ${esc(x.lop)}</b>${x.plan?` Tiết ${esc(planTiet)} - `:' - '}${esc(title)}</div>`}).join('<hr>');
}
function buildFormalOutput(data){
  applyLessonPlan(); const wd=selectedWeekDates(), days=['Hai','Ba','Tư','Năm','Sáu'], labels=['Thứ hai','Thứ ba','Thứ tư','Thứ năm','Thứ sáu'];
  const morning=Math.max(4,...data.filter(x=>normKey(x.buoi)==='sang').map(x=>Number(x.tiet)||0)), afternoon=Math.max(3,...data.filter(x=>normKey(x.buoi)==='chieu').map(x=>Number(x.tiet)||0));
  const subjects=[...new Set(data.map(x=>normalizeSubjectForPlan(x.monHoc)))].filter(Boolean);
  let grid=`<table class="formal-grid"><thead><tr><th colspan="2">Thời gian</th>${labels.map((l,i)=>`<th>Ngày ${wd.days[i]}<br>${l}</th>`).join('')}<th>Nội dung điều chỉnh</th></tr><tr><th>Buổi</th><th>Tiết</th>${labels.map(l=>`<th>${l}</th>`).join('')}<th></th></tr></thead><tbody>`;
  for(let t=1;t<=morning;t++)grid+=`<tr>${t===1?`<th rowspan="${morning}">Sáng</th>`:''}<th>${t}</th>${days.map(day=>`<td>${formalLessonHtml(data,day,'Sáng',t)}</td>`).join('')}<td></td></tr>`;
  for(let t=1;t<=afternoon;t++)grid+=`<tr>${t===1?`<th rowspan="${afternoon}">Chiều</th>`:''}<th>${t}</th>${days.map(day=>`<td>${formalLessonHtml(data,day,'Chiều',t)}</td>`).join('')}<td></td></tr>`;
  grid+=`<tr><th colspan="8">Tổng số: ${data.length} tiết</th></tr></tbody></table>`;
  const concurrent=getConcurrentPeriods();
  const concurrentRow=concurrent>0?`<tr><td>${subjects.length+1}</td><td>Kiêm nhiệm</td><td>${concurrent}</td><td></td></tr>`:'';
  let sum=`<h3>TỔNG HỢP</h3><table class="formal-summary"><tr><th>TT</th><th>Nội dung</th><th>Số lượng tiết học</th><th>Ghi chú</th></tr>${subjects.map((sub,i)=>`<tr><td>${i+1}</td><td>${esc(sub)}</td><td>${data.filter(x=>normalizeSubjectForPlan(x.monHoc)===sub).length}</td><td></td></tr>`).join('')}${concurrentRow}<tr><th colspan="2">Tổng số</th><th>${data.length+concurrent}</th><th></th></tr></table>`;
  return `<section id="formalOutput" class="formal-output"><div class="formal-title"><b>PHỤ LỤC 1.4</b><h2>Hoạt động giáo dục tuần ${wd.week}</h2><p><b>Năm học 2026 – 2027. ${esc(formalSubjectGradeText(data))}, Trường TH – THCS & THPT Lại Sơn</b></p><p><b>Tuần ${wd.week}: từ ngày ${wd.fmt(wd.start)} đến ${wd.fmt(wd.end)}</b></p></div>${grid}${sum}<div class="formal-date">Đặc khu Kiên Hải, ngày ..... tháng ..... năm 2026</div><div class="formal-sign"><div><b>P.HIỆU TRƯỞNG</b></div><div><b>TỔ TRƯỞNG</b></div><div><b>NGƯỜI LẬP KẾ HOẠCH</b><br><br><br><b>Võ Thanh Đậm</b></div></div></section>`;
}
function ensureWeekForOutput(){const previous=currentView; if(currentView!=='week'){currentView='week';render()} return previous}
async function exportPDF(){
  const d=filterSchedule(); if(!d.length)return alert('Không có dữ liệu để xuất.');
  if(!lessonPlanMap.size)return alert('Hãy tải Phụ lục 2 trước khi xuất PDF để có đầy đủ tên bài học.');
  if(typeof html2canvas==='undefined')return alert('Không tải được thư viện xuất PDF.');
  const holder=document.createElement('div');holder.className='formal-holder';holder.innerHTML=buildFormalOutput(d);document.body.appendChild(holder);
  try{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const target=holder.querySelector('.formal-output'),canvas=await html2canvas(target,{scale:2,backgroundColor:'#ffffff',useCORS:true,logging:false});const {jsPDF}=window.jspdf,pdf=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'}),pw=297,ph=210,margin=5,maxW=pw-margin*2,maxH=ph-margin*2,ratio=Math.min(maxW/canvas.width,maxH/canvas.height),w=canvas.width*ratio,h=canvas.height*ratio;pdf.addImage(canvas.toDataURL('image/jpeg',0.95),'JPEG',(pw-w)/2,margin,w,h,undefined,'FAST');pdf.save(`PHU_LUC_1_4_TUAN_${$('weekSelect').value}.pdf`)}finally{holder.remove()}
}
function printSchedule(){
  const d=filterSchedule(); if(!d.length)return alert('Không có dữ liệu để in.');
  if(!lessonPlanMap.size)return alert('Hãy tải Phụ lục 2 trước khi in để có đầy đủ tên bài học.');
  const holder=document.createElement('div');holder.className='formal-holder print-formal';holder.innerHTML=buildFormalOutput(d);document.body.appendChild(holder);document.body.classList.add('printing-formal');
  const restore=()=>{document.body.classList.remove('printing-formal');holder.remove();window.removeEventListener('afterprint',restore)};window.addEventListener('afterprint',restore);setTimeout(()=>window.print(),80)
}
$('loginBtn')&&($('loginBtn').onclick=openAuthModal); $('logoutBtn')&&($('logoutBtn').onclick=logoutTeacher); initWeekSelect(); initSupabaseConnection(); loadScheduleRepository(); loadSchoolCalendar(); activateSelectedWeek(); $('fileInput').addEventListener('change',e=>e.target.files.length&&readWorkbooks(e.target.files)); $('pl2Input').addEventListener('change',e=>e.target.files[0]&&readLessonPlan(e.target.files[0])); $('weekSelect').addEventListener('change',activateSelectedWeek); $('calendarBtn')&&($('calendarBtn').onclick=openCalendarManager); $('repoBtn')&&($('repoBtn').onclick=openRepoManager); $('appendix2RepoBtn')&&($('appendix2RepoBtn').onclick=openAppendix2RepoManager); $('concurrentPeriods').addEventListener('change',()=>{if(Number($('concurrentPeriods').value)<0)$('concurrentPeriods').value=0}); ['fThu','fBuoi','fPoint','fClass'].forEach(id=>$(id).addEventListener('change',render)); $('tableBtn').onclick=()=>{currentView='table';render()}; $('weekBtn').onclick=()=>{currentView='week';render()}; $('excelBtn').onclick=exportExcel; $('pdfBtn').onclick=exportPDF; $('printBtn').onclick=printSchedule;
