'use strict';
const TEACHER='Đậm';
// BƯỚC 3.3 - Kho TKB + Phụ lục 2 + Lịch năm học: Supabase là nguồn dữ liệu chính; cache cục bộ được tách theo tài khoản.
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
async function updateTimetableEffectiveWeekSupabase(version){
  if(!currentAuthUser)throw new Error('Hãy đăng nhập giáo viên trước khi thay đổi hiệu lực TKB.');
  if(!version?.supabaseId)throw new Error('Phiên bản TKB này chưa có mã Supabase. Hãy đăng nhập lại để tải Kho TKB từ Supabase.');
  const week=schoolCalendar.weeks.find(w=>Number(w.week)===Number(version.startWeek));
  const {error}=await supabaseClient.from('tkb_timetable_versions')
    .update({effective_week:Number(version.startWeek),effective_date:week?.start||null})
    .eq('id',version.supabaseId).eq('user_id',currentAuthUser.id);
  if(error)throw error;
  version.effectiveDate=week?.start||null;
  version.syncedToSupabase=true;
}
async function deleteTimetableVersionSupabase(version){
  if(!currentAuthUser)throw new Error('Hãy đăng nhập giáo viên trước khi xóa TKB.');
  if(!version?.supabaseId)throw new Error('Phiên bản TKB này chưa có mã Supabase. Hãy đăng nhập lại để tải Kho TKB từ Supabase.');
  const {error:lessonError}=await supabaseClient.from('tkb_timetable_lessons').delete().eq('timetable_version_id',version.supabaseId).eq('user_id',currentAuthUser.id);
  if(lessonError)throw lessonError;
  const {error}=await supabaseClient.from('tkb_timetable_versions').delete().eq('id',version.supabaseId).eq('user_id',currentAuthUser.id);
  if(error)throw error;
}
async function removeScheduleVersion(version){
  await deleteTimetableVersionSupabase(version);
  const i=scheduleVersions.indexOf(version);if(i>=0)scheduleVersions.splice(i,1);
  saveScheduleRepository();
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
  if(!version){
    // Đã đăng nhập thì Supabase là nguồn chính: tài khoản không có Phụ lục 2 phải hiển thị kho trống,
    // không được giữ dữ liệu Phụ lục 2 đã đọc/khôi phục từ tài khoản hoặc phiên trước.
    lessonPlanMap.clear(); planSubjectCatalog.clear();
    lessonPlanMeta={file:'',type:'',count:0};
    const info=$('pl2Info'); if(info)info.textContent='Chưa có Phụ lục 2 trong kho Supabase của tài khoản này.';
    applyLessonPlan(); render();
    return {versions:0,lessons:0,subjects:0};
  }
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
  if(!versions?.length){
    // Khi đã đăng nhập, Supabase là nguồn chính. Tài khoản không có TKB thì phải hiển thị kho trống,
    // không được giữ/khôi phục dữ liệu localStorage của máy hoặc tài khoản trước.
    scheduleVersions.splice(0,scheduleVersions.length);
    saveScheduleRepository();
    activateSelectedWeek();
    const status=$('supabaseStatus'); if(status)status.textContent='☁️ Supabase: ĐÃ KẾT NỐI • Đã đăng nhập • Kho TKB đang trống';
    return {versions:0,lessons:0};
  }
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
    restoreOutputSettings();
    activateSelectedWeek();
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
  // Không để TKB của tài khoản vừa đăng xuất còn hiển thị cho người dùng kế tiếp.
  scheduleVersions.splice(0,scheduleVersions.length);
  allLessons=[];meta={file:'',sheets:[],counts:{},errors:[]};
  // Không để Phụ lục 2 của tài khoản vừa đăng xuất còn hiển thị cho giáo viên kế tiếp.
  lessonPlanMap.clear(); planSubjectCatalog.clear();
  lessonPlanMeta={file:'',type:'',count:0};
  const pl2Info=$('pl2Info'); if(pl2Info)pl2Info.textContent='Chưa có Phụ lục 2 trong kho.';
  resetSchoolCalendar();
  if($('weekSelect'))$('weekSelect').value='1';
  if($('concurrentPeriods'))$('concurrentPeriods').value='0';
  activateSelectedWeek();
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
function schoolCalendarCacheKey(){return currentAuthUser?.id?`${SCHOOL_CALENDAR_KEY}:${currentAuthUser.id}`:null}
function resetSchoolCalendar(){schoolCalendar={startDate:'2026-09-07',breaks:[],weeks:generateSchoolWeeks('2026-09-07',[])}}
function loadSchoolCalendar(){const key=schoolCalendarCacheKey();if(!key){resetSchoolCalendar();return}try{const x=JSON.parse(localStorage.getItem(key)||'null');if(x&&Array.isArray(x.weeks)&&x.weeks.length===35)schoolCalendar=x;else resetSchoolCalendar()}catch(e){resetSchoolCalendar()}}
function saveSchoolCalendar(){const key=schoolCalendarCacheKey();if(key)localStorage.setItem(key,JSON.stringify(schoolCalendar))}
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
  if(!data?.length){resetSchoolCalendar();saveSchoolCalendar();activateSelectedWeek();return {weeks:0};}
  const restored=data.filter(x=>Number(x.week_number)>=1&&Number(x.week_number)<=35&&x.start_date&&x.end_date).map(x=>({week:Number(x.week_number),start:x.start_date,end:x.end_date}));
  if(restored.length!==35){console.warn('[TKB] Lịch Supabase chưa đủ 35 tuần; không dùng dữ liệu cục bộ để ghi đè.',{weeks:restored.length});resetSchoolCalendar();saveSchoolCalendar();activateSelectedWeek();return {weeks:0,incomplete:restored.length};}
  schoolCalendar={startDate:restored[0].start,breaks:inferBreaksFromSchoolWeeks(restored),weeks:restored};
  saveSchoolCalendar();
  activateSelectedWeek();
  console.info('[TKB] Đã khôi phục Lịch năm học từ Supabase',{weeks:restored.length});
  return {weeks:restored.length};
}
function selectedWeekDates(){const week=Number($('weekSelect')?.value||1),r=schoolCalendar.weeks.find(x=>Number(x.week)===week)||generateSchoolWeeks('2026-09-07',[])[week-1];const start=parseLocalDate(r.start),end=parseLocalDate(r.end),days=[];for(let i=0;i<5;i++){const d=new Date(start);d.setDate(d.getDate()+i);days.push(fmtDateVN(d))}return {week,start,end,days,fmt:d=>fmtDateVN(d)}}
function modalShell(title,body){document.getElementById('manageModal')?.remove();const m=document.createElement('div');m.id='manageModal';m.className='manage-modal';m.innerHTML=`<div class="manage-dialog"><div class="manage-head"><h3>${title}</h3><button id="manageClose">×</button></div>${body}</div>`;document.body.appendChild(m);m.querySelector('#manageClose').onclick=()=>m.remove();m.onclick=e=>{if(e.target===m)m.remove()};return m}
function openRepoManager(){
  const rows=scheduleVersions.map((v,i)=>`<tr><td>${i+1}</td><td>${esc(v.file)}</td><td><select data-repo-week="${i}">${Array.from({length:35},(_,j)=>`<option value="${j+1}" ${Number(v.startWeek)===j+1?'selected':''}>Tuần ${j+1}</option>`).join('')}</select></td><td>${esc(v.uploadedAtLabel||'')}</td><td>${v.lessons?.length||0}</td><td><button type="button" data-delete-repo="${i}">XÓA</button></td></tr>`).join('');
  const m=modalShell('QUẢN LÝ KHO THỜI KHÓA BIỂU',`<p class="manage-note">Có thể điều chỉnh thủ công tuần bắt đầu hiệu lực. Chỉ xóa phiên bản TKB khi chắc chắn không còn cần dùng.</p><div class="manage-scroll"><table class="manage-table"><thead><tr><th>TT</th><th>File TKB</th><th>Hiệu lực từ</th><th>Thời điểm lưu</th><th>Số tiết</th><th>Thao tác</th></tr></thead><tbody>${rows||'<tr><td colspan="6">Kho TKB đang trống.</td></tr>'}</tbody></table></div><div class="manage-actions"><button id="saveRepoEffect">LƯU HIỆU LỰC</button></div>`);
  m.querySelectorAll('[data-delete-repo]').forEach(btn=>btn.onclick=async()=>{
    const v=scheduleVersions[Number(btn.dataset.deleteRepo)];if(!v)return;
    if(!confirm(`Xóa phiên bản TKB "${v.file}" hiệu lực từ Tuần ${v.startWeek}?\n\nDữ liệu TKB này sẽ bị xóa khỏi Supabase. Các phiên bản khác không bị ảnh hưởng.`))return;
    try{btn.disabled=true;btn.textContent='ĐANG XÓA...';await removeScheduleVersion(v);activateSelectedWeek();m.remove();openRepoManager();}
    catch(e){console.error('[TKB] Không xóa được phiên bản TKB',e);btn.disabled=false;btn.textContent='XÓA';alert('Không xóa được phiên bản TKB: '+(e.message||e));}
  });
  m.querySelector('#saveRepoEffect').onclick=async()=>{
    const btn=m.querySelector('#saveRepoEffect');
    try{
      if(!currentAuthUser)throw new Error('Hãy đăng nhập giáo viên trước khi thay đổi hiệu lực TKB.');
      const changed=[];
      m.querySelectorAll('[data-repo-week]').forEach(el=>{
        const v=scheduleVersions[Number(el.dataset.repoWeek)], next=Number(el.value);
        if(v&&Number(v.startWeek)!==next){v.startWeek=next;changed.push(v)}
      });
      btn.disabled=true;btn.textContent='ĐANG LƯU...';
      for(const v of changed)await updateTimetableEffectiveWeekSupabase(v);
      scheduleVersions.sort((a,b)=>a.startWeek-b.startWeek||String(a.uploadedAt||'').localeCompare(String(b.uploadedAt||'')));
      saveScheduleRepository();activateSelectedWeek();m.remove();
      alert(changed.length?'Đã cập nhật mốc hiệu lực TKB trên Supabase.':'Không có thay đổi mốc hiệu lực TKB.');
    }catch(e){console.error('[TKB] Không cập nhật được hiệu lực TKB',e);btn.disabled=false;btn.textContent='LƯU HIỆU LỰC';alert('Không cập nhật được hiệu lực TKB trên Supabase: '+(e.message||e));}
  };
}
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
function scheduleCacheKey(){
  return currentAuthUser?.id ? `${TKB_STORE_KEY}:${currentAuthUser.id}` : `${TKB_STORE_KEY}:guest`;
}
function saveScheduleRepository(){
  // Cache chỉ hỗ trợ hiển thị nhanh trên cùng máy; sau đăng nhập Supabase luôn ghi đè cache này.
  try{localStorage.setItem(scheduleCacheKey(),JSON.stringify(scheduleVersions))}catch(e){console.warn('Không lưu được cache Kho TKB',e)}
}
function loadScheduleRepository(){
  // Trước khi xác định tài khoản chỉ đọc cache khách; dữ liệu tài khoản thật sẽ được tải từ Supabase sau đăng nhập.
  try{const raw=localStorage.getItem(scheduleCacheKey()), arr=raw?JSON.parse(raw):[]; if(Array.isArray(arr)){scheduleVersions.splice(0,scheduleVersions.length,...arr.filter(v=>v&&Array.isArray(v.lessons)&&Number(v.startWeek)>=1&&Number(v.startWeek)<=35)); scheduleVersions.sort((a,b)=>a.startWeek-b.startWeek||String(a.uploadedAt||'').localeCompare(String(b.uploadedAt||'')));}}
  catch(e){console.warn('Không đọc được cache Kho TKB',e)}
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
      const sameWeek=scheduleVersions.filter(v=>Number(v.startWeek)===sw);
      let replaceSameWeek=false;
      if(sameWeek.length){
        replaceSameWeek=confirm(`Tuần ${sw} hiện đã có ${sameWeek.length} phiên bản TKB.\n\nOK = lưu bản mới và THAY THẾ các phiên bản cũ cùng mốc Tuần ${sw}.\nCancel = giữ các bản cũ và thêm bản mới song song.`);
      }
      await saveTimetableVersionToSupabase(version);
      scheduleVersions.push(version);
      if(replaceSameWeek){
        try{for(const oldVersion of sameWeek)await removeScheduleVersion(oldVersion)}
        catch(cleanErr){console.error('[TKB] Bản mới đã lưu nhưng chưa dọn hết bản cũ cùng tuần',cleanErr);alert('Bản TKB mới đã được lưu và đang được ưu tiên, nhưng chưa xóa hết bản cũ cùng tuần. Bạn có thể xóa thủ công trong Kho TKB.');}
      }
      scheduleVersions.sort((a,b)=>a.startWeek-b.startWeek||String(a.uploadedAt||'').localeCompare(String(b.uploadedAt||'')));
      saveScheduleRepository();
      alert(`Đã lưu TKB mới vào Supabase. Hiệu lực từ Tuần ${sw}.${replaceSameWeek?' Các phiên bản cũ cùng tuần đã được thay thế.':''}`);
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
// BƯỚC 4.3.1: lưu lựa chọn xuất cuối cùng theo đúng tài khoản giáo viên.
function outputSettingsKey(){return currentAuthUser?.id?`tkb_output_settings_${currentAuthUser.id}`:null}
function saveOutputSettings(){
  const key=outputSettingsKey(); if(!key)return;
  const settings={week:Math.max(1,Math.min(35,Number($('weekSelect')?.value||1))),concurrentPeriods:getConcurrentPeriods()};
  try{localStorage.setItem(key,JSON.stringify(settings))}catch(e){console.warn('[TKB] Không lưu được cài đặt xuất cuối cùng',e)}
}
function restoreOutputSettings(){
  const key=outputSettingsKey(); if(!key)return;
  try{
    const x=JSON.parse(localStorage.getItem(key)||'null'); if(!x)return;
    const week=Math.max(1,Math.min(35,Number(x.week)||1));
    if($('weekSelect'))$('weekSelect').value=String(week);
    if($('concurrentPeriods'))$('concurrentPeriods').value=String(Math.max(0,Math.floor(Number(x.concurrentPeriods)||0)));
  }catch(e){console.warn('[TKB] Không khôi phục được cài đặt xuất cuối cùng',e)}
}
// BƯỚC 4.3.3: điều chỉnh riêng bản kế hoạch xuất, không sửa TKB/Phụ lục 2 gốc.
function outputEditsKey(){
  if(!currentAuthUser?.id)return null;
  return `tkb_output_edits_${currentAuthUser.id}_week_${Math.max(1,Math.min(35,Number($('weekSelect')?.value||1)))}`;
}
function outputLessonId(x){
  return [clean(x.sheetNguon),Number(x.dongNguon)||0,Number(x.cotNguon)||0,clean(x.thu),clean(x.buoi),Number(x.tiet)||0,clean(x.lop),normalizeSubjectForPlan(x.monHoc)].join('|');
}
function loadOutputEdits(){
  const key=outputEditsKey(); if(!key)return {};
  try{const x=JSON.parse(localStorage.getItem(key)||'{}');return x&&typeof x==='object'&&!Array.isArray(x)?x:{}}catch(e){return {}}
}
function saveOutputEdits(edits){
  const key=outputEditsKey(); if(!key)return;
  try{localStorage.setItem(key,JSON.stringify(edits||{}))}catch(e){console.warn('[TKB] Không lưu được điều chỉnh bản kế hoạch tuần',e)}
}
function outputScheduleData(){
  applyLessonPlan();
  const edits=loadOutputEdits();
  return filterSchedule().map(x=>{
    const e=edits[outputLessonId(x)]; if(e?.deleted)return null;
    if(!e)return x;
    const y={...x};
    if(e.monHoc!==undefined)y.monHoc=e.monHoc;
    if(e.lop!==undefined)y.lop=e.lop;
    if(e.title!==undefined)y.plan={...(x.plan||{}),title:e.title,annualPeriod:e.annualPeriod!==undefined?e.annualPeriod:(x.plan?.annualPeriod||x.planWeek||''),week:x.plan?.week||x.planWeek,subject:normalizeSubjectForPlan(e.monHoc!==undefined?e.monHoc:x.monHoc),grade:gradeFromClass(e.lop!==undefined?e.lop:x.lop)};
    return y;
  }).filter(Boolean);
}
function outputEditRowsHtml(){
  applyLessonPlan(); const edits=loadOutputEdits();
  const source=filterSchedule();
  if(!source.length)return '<div class="preview-edit-empty">Không có tiết học để điều chỉnh.</div>';
  return source.map((x,i)=>{
    const id=outputLessonId(x),e=edits[id]||{},deleted=!!e.deleted;
    const mon=e.monHoc!==undefined?e.monHoc:normalizeSubjectForPlan(x.monHoc), lop=e.lop!==undefined?e.lop:clean(x.lop);
    const title=e.title!==undefined?e.title:(x.plan?.title||'[Chưa ghép Phụ lục 2]');
    return `<div class="preview-edit-row ${deleted?'is-deleted':''}" data-output-id="${esc(id)}"><div class="preview-edit-pos"><b>${i+1}. Thứ ${esc(x.thu)} · ${esc(x.buoi)} · Tiết ${esc(x.tiet)}</b><small>${esc(x.diemTruong||'')}</small></div><label>Môn<input data-edit-field="monHoc" value="${esc(mon)}" ${deleted?'disabled':''}></label><label>Lớp<input data-edit-field="lop" value="${esc(lop)}" ${deleted?'disabled':''}></label><label class="preview-edit-title">Tên bài / Nội dung<textarea data-edit-field="title" rows="2" ${deleted?'disabled':''}>${esc(title)}</textarea></label><button type="button" class="preview-delete-row">${deleted?'Khôi phục':'Xóa'}</button></div>`;
  }).join('');
}
function formalSubjectGradeText(data){
  const subjects=[...new Set(data.map(x=>normalizeSubjectForPlan(x.monHoc)).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'vi'));
  const grades=[...new Set(data.map(x=>{const m=String(x.lop||'').match(/\d+/);return m?Number(m[0]):null}).filter(Number.isFinite))].sort((a,b)=>a-b);
  return `Môn: ${subjects.join(', ')} – Khối: ${grades.join(', ')}`;
}
function exportExcel(){
  const d=outputScheduleData(); if(!d.length)return alert('Không có dữ liệu để xuất.');
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
  const sumRow=rows.length+1; rows.push(['','Tổng số','','',d.length+concurrent,'','']);
  rows.push(['','','','','','','']);
  const signatureDateRow=rows.length+1;
  rows.push(['','','','',formalSignatureDate(wd),'','']);
  const signatureTitleRow=rows.length+1;
  rows.push(['P. HIỆU TRƯỞNG','','TỔ TRƯỞNG','','','NGƯỜI LẬP KẾ HOẠCH','']);
  rows.push(['','','','','','','']); rows.push(['','','','','','','']);
  const signatureNameRow=rows.length+1;
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
    `B${sumRow}:D${sumRow}`,`E${sumRow}:F${sumRow}`,
    `E${signatureDateRow}:G${signatureDateRow}`,
    `A${signatureTitleRow}:B${signatureTitleRow}`,`C${signatureTitleRow}:D${signatureTitleRow}`,`F${signatureTitleRow}:G${signatureTitleRow}`,
    `F${signatureNameRow}:G${signatureNameRow}`
  ];
  ws['!merges']=merges.map(XLSX.utils.decode_range);
  ws['!cols']=[{wch:10},{wch:7},...days.map(()=>({wch:24}))];
  ws['!rows']=rows.map((_,i)=>({hpt:i<4?[22,26,24,24][i]:(i===4||i===5?34:(i>=6&&i<endSchedule?78:26))}));
  ws['!freeze']={xSplit:2,ySplit:6};
  ws['!pageSetup']={orientation:'landscape',paperSize:9,fitToWidth:1,fitToHeight:0,horizontalCentered:true};
  ws['!margins']={left:0.25,right:0.25,top:0.3,bottom:0.3,header:0.1,footer:0.1};
  ws['!printArea']=`A1:G${rows.length}`;
  const black='000000', navy='173F73', pale='F7FBFF', light='EAF2FB';
  const thin={style:'thin',color:{rgb:black}}, med={style:'medium',color:{rgb:black}};
  const border={top:thin,bottom:thin,left:thin,right:thin};
  const center={horizontal:'center',vertical:'center',wrapText:true};
  for(let R=0;R<rows.length;R++) for(let C=0;C<7;C++){
    const a=XLSX.utils.encode_cell({r:R,c:C}); if(!ws[a])ws[a]={t:'s',v:''};
    ws[a].s={font:{name:'Times New Roman',sz:12,color:{rgb:black}},alignment:{vertical:'center',wrapText:true},border};
  }
  // Khối tiêu đề là văn bản hành chính: không kẻ khung/đường viền.
  for(let R=0;R<4;R++) for(let C=0;C<7;C++){
    const a=XLSX.utils.encode_cell({r:R,c:C}); if(!ws[a])ws[a]={t:'s',v:''};
    ws[a].s={font:{name:'Times New Roman',sz:12,bold:true,color:{rgb:black}},alignment:center,border:{}};
  }
  for(let C=0;C<7;C++) for(let R=4;R<=5;R++){let a=XLSX.utils.encode_cell({r:R,c:C});ws[a].s={font:{name:'Times New Roman',sz:12,bold:true},alignment:center,border:{top:med,bottom:med,left:thin,right:thin},fill:{fgColor:{rgb:'F2F2F2'}}};}
  for(let R=6;R<endSchedule;R++) for(let C=0;C<7;C++){let a=XLSX.utils.encode_cell({r:R,c:C});ws[a].s={font:{name:'Times New Roman',sz:12,bold:C<2},alignment:C<2?center:{horizontal:'left',vertical:'center',wrapText:true},border,fill:{fgColor:{rgb:C<2?light:(R%2?pale:'FFFFFF')}}};}
  ws[`A${morningStart}`].s.font.bold=true; ws[`A${afternoonStart}`].s.font.bold=true;
  for(let C=0;C<7;C++){let a=XLSX.utils.encode_cell({r:endSchedule-1,c:C}); if(ws[a]) ws[a].s.border.bottom=med;}
  // Tổng số tiết
  for(let C=0;C<7;C++){const a=XLSX.utils.encode_cell({r:totalRow-1,c:C});ws[a].s={font:{name:'Times New Roman',sz:12,bold:true},alignment:center,border};}
  // Tổng hợp
  ws[`A${totalRow+1}`].s={font:{name:'Times New Roman',sz:12,bold:true},alignment:center};
  for(let C=0;C<7;C++){let a=XLSX.utils.encode_cell({r:totalRow+1,c:C});ws[a].s={font:{name:'Times New Roman',sz:12,bold:true},alignment:center,border,fill:{fgColor:{rgb:'F2F2F2'}}};}
  for(let R=totalRow+2;R<sumRow;R++) for(let C=0;C<7;C++){let a=XLSX.utils.encode_cell({r:R,c:C});ws[a].s={font:{name:'Times New Roman',sz:12,bold:R===totalRow+2},alignment:center,border};}
  for(let C=0;C<7;C++){let a=XLSX.utils.encode_cell({r:sumRow-1,c:C});ws[a].s={font:{name:'Times New Roman',sz:12,bold:true},alignment:center,border};}
  // Khu vực ngày ký/chữ ký là phần văn bản, không có bất kỳ khung ô nào.
  for(let R=sumRow;R<rows.length;R++) for(let C=0;C<7;C++){
    const a=XLSX.utils.encode_cell({r:R,c:C}); if(!ws[a])ws[a]={t:'s',v:''};
    ws[a].s={font:{name:'Times New Roman',sz:12,color:{rgb:black}},alignment:{vertical:'center',wrapText:true},border:{}};
  }
  for(let C=0;C<7;C++){let a=XLSX.utils.encode_cell({r:signatureDateRow-1,c:C});ws[a].s={font:{name:'Times New Roman',sz:12,italic:true},alignment:{horizontal:'right',vertical:'center',wrapText:true},border:{}};}
  [signatureTitleRow-1,signatureNameRow-1].forEach(r=>{for(let C=0;C<7;C++){let a=XLSX.utils.encode_cell({r,c:C});ws[a].s={font:{name:'Times New Roman',sz:12,bold:true},alignment:center,border:{}};}});
  XLSX.utils.book_append_sheet(wb,ws,'TKB tuần');

  const src=[['Sheet','Dòng','Cột','Ô nguồn','Nội dung ô gốc','Thứ','Buổi','Tiết nguồn','Tiết xác định','Thời gian','Lớp','Môn học','Điểm trường','Ghi chú'],...d.map(x=>[x.sheetNguon,x.dongNguon,`${colLetter(x.cotNguon-1)} (${x.cotNguon})`,`${x.sheetNguon}!${colLetter(x.cotNguon-1)}${x.dongNguon}`,x.oNguon,`Thứ ${x.thu}`,clean(x.buoi),x.tietNguon||'',x.tiet,x.thoiGian,x.lop,normalizeSubjectForPlan(x.monHoc),x.diemTruong,x.ghiChuTiet||''])];
  const ws2=XLSX.utils.aoa_to_sheet(src); ws2['!cols']=[9,8,9,13,22,11,10,11,12,18,10,18,22,48].map(w=>({wch:w})); ws2['!autofilter']={ref:`A1:N${src.length}`};
  ws2['!pageSetup']={orientation:'landscape',paperSize:9,fitToWidth:1,fitToHeight:0,horizontalCentered:true};
  ws2['!margins']={left:0.25,right:0.25,top:0.3,bottom:0.3,header:0.1,footer:0.1};
  for(let R=0;R<src.length;R++)for(let C=0;C<14;C++){const a=XLSX.utils.encode_cell({r:R,c:C});if(!ws2[a])continue;ws2[a].s={font:{name:'Times New Roman',sz:12,bold:R===0,color:{rgb:R===0?'FFFFFF':'000000'}},fill:R===0?{fgColor:{rgb:navy}}:undefined,alignment:{horizontal:R===0?'center':'left',vertical:'center',wrapText:true},border};}
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
  const week=Number($('weekSelect')?.value||1),r=schoolCalendar.weeks.find(x=>Number(x.week)===week)||generateSchoolWeeks('2026-09-07',[])[week-1];
  const start=parseLocalDate(r.start),end=parseLocalDate(r.end),days=[];
  for(let i=0;i<5;i++){const d=new Date(start);d.setDate(d.getDate()+i);days.push(fmtDateVN(d))}
  return {week,start,end,days,fmt:d=>fmtDateVN(d)};
}
function formalSignatureDate(wd){
  const d=new Date(wd.start);d.setDate(d.getDate()-1);
  const pad=n=>String(n).padStart(2,'0');
  return `Đặc khu Kiên Hải, ngày ${pad(d.getDate())} tháng ${pad(d.getMonth()+1)} năm ${d.getFullYear()}`;
}
function formalLessonHtml(data,day,session,tiet){
  const items=data.filter(x=>x.thu===day&&normKey(x.buoi)===normKey(session)&&Number(x.tiet)===Number(tiet));
  return items.map(x=>{const sub=normalizeSubjectForPlan(x.monHoc), title=x.plan?.title||'[Chưa ghép Phụ lục 2]', planTiet=x.plan?.annualPeriod||x.plan?.week||x.planWeek||'';return `<div class="formal-lesson"><b>${esc(sub)} ${esc(x.lop)}</b>${x.plan?` Tiết ${esc(planTiet)} - `:' - '}${esc(title)}</div>`}).join('<hr>');
}
function buildFormalOutput(data){
  applyLessonPlan(); const wd=selectedWeekDates(), days=['Hai','Ba','Tư','Năm','Sáu'], labels=['Thứ hai','Thứ ba','Thứ tư','Thứ năm','Thứ sáu'];
  const morning=Math.max(4,...data.filter(x=>normKey(x.buoi)==='sang').map(x=>Number(x.tiet)||0)), afternoon=Math.max(3,...data.filter(x=>normKey(x.buoi)==='chieu').map(x=>Number(x.tiet)||0));
  const subjects=[...new Set(data.map(x=>normalizeSubjectForPlan(x.monHoc)))].filter(Boolean);
  let grid=`<table class="formal-grid"><colgroup><col class="col-session"><col class="col-period">${days.map(()=>'<col class="col-day">').join('')}<col class="col-adjust"></colgroup><thead><tr><th colspan="2">Thời gian</th>${labels.map((l,i)=>`<th>Ngày ${wd.days[i]}<br>${l}</th>`).join('')}<th>Nội dung điều chỉnh</th></tr><tr><th>Buổi</th><th>Tiết</th>${labels.map(l=>`<th>${l}</th>`).join('')}<th></th></tr></thead><tbody>`;
  for(let t=1;t<=morning;t++)grid+=`<tr>${t===1?`<th rowspan="${morning}">Sáng</th>`:''}<th>${t}</th>${days.map(day=>`<td>${formalLessonHtml(data,day,'Sáng',t)}</td>`).join('')}<td></td></tr>`;
  for(let t=1;t<=afternoon;t++)grid+=`<tr>${t===1?`<th rowspan="${afternoon}">Chiều</th>`:''}<th>${t}</th>${days.map(day=>`<td>${formalLessonHtml(data,day,'Chiều',t)}</td>`).join('')}<td></td></tr>`;
  grid+=`<tr><th colspan="8">Tổng số: ${data.length} tiết</th></tr></tbody></table>`;
  const concurrent=getConcurrentPeriods();
  const concurrentRow=concurrent>0?`<tr><td>${subjects.length+1}</td><td>Kiêm nhiệm</td><td>${concurrent}</td><td></td></tr>`:'';
  let sum=`<h3>TỔNG HỢP</h3><table class="formal-summary"><tr><th>TT</th><th>Nội dung</th><th>Số lượng tiết học</th><th>Ghi chú</th></tr>${subjects.map((sub,i)=>`<tr><td>${i+1}</td><td>${esc(sub)}</td><td>${data.filter(x=>normalizeSubjectForPlan(x.monHoc)===sub).length}</td><td></td></tr>`).join('')}${concurrentRow}<tr class="formal-summary-total"><th></th><th>Tổng số</th><th>${data.length+concurrent}</th><th></th></tr></table>`;
  return `<section id="formalOutput" class="formal-output"><div class="formal-title"><b>PHỤ LỤC 1.4</b><h2>Hoạt động giáo dục tuần ${wd.week}</h2><p><b>Năm học 2026 – 2027. ${esc(formalSubjectGradeText(data))}, Trường TH – THCS & THPT Lại Sơn</b></p><p><b>Tuần ${wd.week}: từ ngày ${wd.fmt(wd.start)} đến ${wd.fmt(wd.end)}</b></p></div>${grid}${sum}<div class="formal-date">${esc(formalSignatureDate(wd))}</div><div class="formal-sign"><div><b>P.HIỆU TRƯỞNG</b></div><div><b>TỔ TRƯỞNG</b></div><div><b>NGƯỜI LẬP KẾ HOẠCH</b><br><br><br><b>Võ Thanh Đậm</b></div></div></section>`;
}
function ensureFormalOutputStyles(){
  if(document.getElementById('formalOutputStylesV42'))return;
  const style=document.createElement('style'); style.id='formalOutputStylesV42';
  style.textContent=`
    .formal-holder{position:fixed;left:-10000px;top:0;width:283mm;background:#fff;z-index:-1}
    .formal-output{box-sizing:border-box;width:283mm;padding:2mm;background:#fff;color:#000;font-family:"Times New Roman",serif;font-size:12pt;line-height:1.08}
    .formal-title{text-align:center;margin:0 0 1.5mm}.formal-title>b{display:block;font-size:12pt}.formal-title h2{font-size:12pt;margin:.5mm 0;font-weight:700}.formal-title p{font-size:12pt;margin:.35mm 0}
    .formal-grid,.formal-summary{width:100%;border-collapse:collapse;table-layout:fixed}
    .formal-grid th,.formal-grid td,.formal-summary th,.formal-summary td{border:1px solid #000;padding:.7mm .9mm;vertical-align:middle;text-align:center;font-size:12pt;overflow-wrap:break-word;word-break:normal}
    .formal-grid thead{display:table-header-group}.formal-grid tr,.formal-summary tr{break-inside:avoid;page-break-inside:avoid}
    .formal-grid .col-session{width:13mm}.formal-grid .col-period{width:10mm}.formal-grid .col-adjust{width:24mm}
    .formal-grid .col-day{width:auto}
    .formal-grid thead th{padding:.7mm .6mm;line-height:1.05}
    .formal-lesson{font-size:12pt;line-height:1.08;text-align:left}.formal-lesson b{font-size:12pt}.formal-lesson+hr{border:0;border-top:.3px solid #777;margin:.5mm 0}
    .formal-output h3{text-align:center;font-size:12pt;margin:1.5mm 0 .7mm}.formal-summary{width:82%;margin:0 auto}.formal-summary th,.formal-summary td{padding:.55mm 1mm;line-height:1.05}
    .formal-date{text-align:right;font-style:italic;margin:1.5mm 4mm .5mm 0}.formal-sign{display:grid;grid-template-columns:1fr 1fr 1fr;text-align:center;gap:8mm;margin-top:.5mm;min-height:20mm}
    @media print{
      @page{size:A4 landscape;margin:5mm}
      html,body{margin:0!important;padding:0!important}
      body.printing-formal>*:not(.print-formal){display:none!important}
      body.printing-formal .print-formal{position:static!important;left:auto!important;top:auto!important;width:287mm!important;margin:0!important;z-index:auto!important}
      body.printing-formal .formal-output{width:287mm!important;padding:0!important;margin:0 auto!important}
      body.printing-formal .formal-grid th,body.printing-formal .formal-grid td{padding:.45mm .65mm!important}
      body.printing-formal .formal-grid{table-layout:fixed!important}
      body.printing-formal .formal-title{margin-bottom:1mm!important}
      .formal-grid tr,.formal-summary tr,.formal-sign{break-inside:avoid;page-break-inside:avoid}
      .formal-summary,.formal-date,.formal-sign{break-inside:avoid;page-break-inside:avoid}
    }`;
  document.head.appendChild(style);
}
function ensureWeekForOutput(){const previous=currentView; if(currentView!=='week'){currentView='week';render()} return previous}
async function exportPDF(){
  const d=outputScheduleData(); if(!d.length)return alert('Không có dữ liệu để xuất.');
  if(!lessonPlanMap.size)return alert('Hãy tải Phụ lục 2 trước khi xuất PDF để có đầy đủ tên bài học.');
  if(typeof html2canvas==='undefined')return alert('Không tải được thư viện xuất PDF.');
  ensureFormalOutputStyles();
  const holder=document.createElement('div');holder.className='formal-holder';holder.innerHTML=buildFormalOutput(d);document.body.appendChild(holder);
  try{
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const target=holder.querySelector('.formal-output'),canvas=await html2canvas(target,{scale:2,backgroundColor:'#ffffff',useCORS:true,logging:false,windowWidth:target.scrollWidth});
    const {jsPDF}=window.jspdf,pdf=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'}),pw=297,ph=210,margin=5,maxW=pw-margin*2,maxH=ph-margin*2;
    // Giữ cỡ chữ theo chiều rộng A4 ngang và chỉ ngắt PDF tại ranh giới hàng/khối.
    const drawW=maxW, pxPerMm=canvas.width/drawW, maxSlicePx=Math.floor(maxH*pxPerMm);
    const scaleY=canvas.height/target.scrollHeight, top0=target.getBoundingClientRect().top;
    const cuts=[0,...[...target.querySelectorAll('.formal-grid tr,.formal-summary tr,.formal-date,.formal-sign')].map(el=>Math.round((el.getBoundingClientRect().bottom-top0)*scaleY)),canvas.height]
      .filter((v,i,a)=>v>=0&&v<=canvas.height&&a.indexOf(v)===i).sort((a,b)=>a-b);
    let y0=0,page=0;
    while(y0<canvas.height-2){
      const limit=Math.min(canvas.height,y0+maxSlicePx);
      let y1=cuts.filter(v=>v>y0+20&&v<=limit).pop()||limit;
      if(y1<=y0)y1=limit;
      const slice=document.createElement('canvas');slice.width=canvas.width;slice.height=y1-y0;
      slice.getContext('2d').drawImage(canvas,0,y0,canvas.width,y1-y0,0,0,canvas.width,y1-y0);
      if(page++)pdf.addPage('a4','landscape');
      const drawH=(y1-y0)/pxPerMm;
      pdf.addImage(slice.toDataURL('image/jpeg',0.96),'JPEG',margin,margin,drawW,drawH,undefined,'FAST');
      y0=y1;
    }
    pdf.save(`PHU_LUC_1_4_TUAN_${$('weekSelect').value}.pdf`);
  }finally{holder.remove()}
}
function openOutputPreview(){
  let d=outputScheduleData(); if(!d.length&&!filterSchedule().length)return alert('Không có dữ liệu để xem trước.');
  if(!lessonPlanMap.size)return alert('Hãy tải Phụ lục 2 trước khi xem trước để có đầy đủ tên bài học.');
  ensureFormalOutputStyles();
  document.getElementById('outputPreviewModal')?.remove();
  const modal=document.createElement('div'); modal.id='outputPreviewModal'; modal.className='output-preview-modal';
  const renderPreview=()=>{
    d=outputScheduleData();
    const body=modal.querySelector('.output-preview-scroll'); if(body)body.innerHTML=d.length?buildFormalOutput(d):'<div class="preview-no-lessons">Bản xuất hiện không còn tiết nào. Có thể vào Sửa để khôi phục.</div>';
    const editBody=modal.querySelector('.output-edit-body'); if(editBody)editBody.innerHTML=outputEditRowsHtml();
    bindEditRows();
  };
  modal.innerHTML=`<div class="output-preview-dialog"><div class="output-preview-bar"><b>XEM TRƯỚC PHỤ LỤC 1.4 · TUẦN ${esc($('weekSelect').value)}</b><div><button type="button" class="preview-edit">Sửa</button><button type="button" class="preview-export-excel">Xuất Excel</button><button type="button" class="preview-export-pdf">Xuất PDF</button><button type="button" class="preview-print">In</button><button type="button" class="preview-close">Đóng</button></div></div><div class="output-edit-panel" hidden><div class="output-edit-head"><b>ĐIỀU CHỈNH BẢN KẾ HOẠCH TUẦN</b><span>Chỉ ảnh hưởng bản xuất, không sửa TKB hoặc Phụ lục 2 gốc.</span><div><button type="button" class="preview-update">Cập nhật</button><button type="button" class="preview-reset">Xóa điều chỉnh tuần</button></div></div><div class="output-edit-body">${outputEditRowsHtml()}</div></div><div class="output-preview-scroll">${d.length?buildFormalOutput(d):''}</div></div>`;
  document.body.appendChild(modal);
  if(!document.getElementById('outputPreviewStylesV433')){
    const st=document.createElement('style'); st.id='outputPreviewStylesV433'; st.textContent=`
      .output-preview-modal{position:fixed;inset:0;background:rgba(15,23,42,.72);z-index:100000;display:flex;align-items:center;justify-content:center;padding:18px}
      .output-preview-dialog{width:min(97vw,1550px);height:95vh;background:#e9edf2;border-radius:10px;box-shadow:0 24px 70px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden}
      .output-preview-bar{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 14px;background:#fff;border-bottom:1px solid #cbd5e1;font-family:Arial,sans-serif}
      .output-preview-bar>div,.output-edit-head>div{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.output-preview-bar button,.output-edit-panel button{height:36px;border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:8px;padding:0 14px;cursor:pointer;font:600 13px Arial,sans-serif;box-shadow:0 1px 2px rgba(15,23,42,.06);transition:.15s ease}.output-preview-bar button:hover,.output-edit-panel button:hover{background:#f8fafc;border-color:#94a3b8;transform:translateY(-1px)}.output-preview-bar .preview-export-pdf,.output-preview-bar .preview-export-excel,.output-preview-bar .preview-print{background:#0f4c81;color:#fff;border-color:#0f4c81}.output-preview-bar .preview-export-pdf:hover,.output-preview-bar .preview-export-excel:hover,.output-preview-bar .preview-print:hover{background:#123f68;border-color:#123f68}.output-preview-bar .preview-edit{background:#eef6ff;color:#0f4c81;border-color:#b8d6f2}.output-preview-bar .preview-close{background:#f8fafc}.output-edit-panel .preview-update{background:#0f4c81;color:#fff;border-color:#0f4c81}.output-edit-panel .preview-reset,.preview-delete-row{background:#fff7f7!important;color:#b42318!important;border-color:#f3b7b2!important}
      .output-preview-scroll{flex:1;overflow:auto;padding:18px}.output-preview-scroll .formal-output{margin:0 auto;box-shadow:0 3px 18px rgba(0,0,0,.16)}
      .output-edit-panel{flex:1;overflow:auto;background:#fff;padding:14px 16px;font-family:Arial,sans-serif}.output-edit-head{position:sticky;top:-14px;z-index:2;background:#fff;padding:10px 0;border-bottom:1px solid #dbe3ec;display:grid;grid-template-columns:1fr auto;gap:4px 12px;align-items:center}.output-edit-head>span{font-size:12px;color:#64748b}.output-edit-head>div{grid-row:1/3;grid-column:2}
      .preview-edit-row{display:grid;grid-template-columns:190px 150px 110px minmax(360px,1fr) 76px;gap:10px;align-items:end;padding:10px 0;border-bottom:1px solid #e2e8f0}.preview-edit-row label{font-size:12px;font-weight:700;color:#475569}.preview-edit-row input,.preview-edit-row textarea{box-sizing:border-box;width:100%;margin-top:4px;border:1px solid #cbd5e1;border-radius:5px;padding:7px 8px;font:14px Arial,sans-serif;background:#fff}.preview-edit-row textarea{resize:vertical}.preview-edit-pos{align-self:center}.preview-edit-pos small{display:block;color:#64748b;margin-top:4px}.preview-edit-row.is-deleted{opacity:.55;background:#f8fafc}.preview-delete-row{align-self:center}.preview-no-lessons,.preview-edit-empty{padding:28px;text-align:center;color:#64748b}
    `; document.head.appendChild(st);
  }
  const bindEditRows=()=>{
    modal.querySelectorAll('.preview-delete-row').forEach(btn=>btn.onclick=()=>{
      const row=btn.closest('[data-output-id]'),id=row.dataset.outputId,edits=loadOutputEdits(),old=edits[id]||{};
      edits[id]={...old,deleted:!old.deleted}; saveOutputEdits(edits); renderPreview();
    });
  };
  bindEditRows();
  const close=()=>modal.remove();
  modal.querySelector('.preview-close').onclick=close;
  modal.addEventListener('click',e=>{if(e.target===modal)close()});
  modal.querySelector('.preview-edit').onclick=()=>{const p=modal.querySelector('.output-edit-panel'),v=modal.querySelector('.output-preview-scroll'),show=p.hidden;p.hidden=!show;v.style.display=show?'none':'';modal.querySelector('.preview-edit').textContent=show?'Xem bản kế hoạch':'Sửa'};
  modal.querySelector('.preview-update').onclick=()=>{
    const edits=loadOutputEdits();
    modal.querySelectorAll('.preview-edit-row[data-output-id]').forEach(row=>{
      const id=row.dataset.outputId,old=edits[id]||{}; if(old.deleted)return;
      const val=f=>row.querySelector(`[data-edit-field="${f}"]`)?.value??'';
      edits[id]={...old,monHoc:clean(val('monHoc')),lop:clean(val('lop')),title:clean(val('title'))};
    });
    saveOutputEdits(edits); renderPreview();
    const p=modal.querySelector('.output-edit-panel'),v=modal.querySelector('.output-preview-scroll');p.hidden=true;v.style.display='';modal.querySelector('.preview-edit').textContent='Sửa';
  };
  modal.querySelector('.preview-reset').onclick=()=>{if(!confirm('Xóa toàn bộ điều chỉnh riêng của tuần này và trở về dữ liệu gốc?'))return;const key=outputEditsKey();if(key)localStorage.removeItem(key);renderPreview()};
  modal.querySelector('.preview-export-excel').onclick=()=>exportExcel();
  modal.querySelector('.preview-export-pdf').onclick=()=>exportPDF();
  modal.querySelector('.preview-print').onclick=()=>{close();printSchedule()};
}
function ensurePreviewButton(){
  // BƯỚC 4.3.5: giao diện chính chỉ giữ Xem trước; các lệnh xuất vẫn dùng trong cửa sổ xem trước.
  const exportButtons=['excelBtn','pdfBtn','printBtn'].map(id=>$(id)).filter(Boolean);
  const anchor=exportButtons[0]; if(!anchor)return;
  exportButtons.forEach(btn=>{btn.style.display='none';btn.setAttribute('aria-hidden','true')});
  if(document.getElementById('previewBtn'))return;
  const b=document.createElement('button'); b.type='button'; b.id='previewBtn'; b.className=anchor.className; b.textContent='Xem trước'; b.title='Xem trước Phụ lục 1.4 trước khi xuất'; b.onclick=openOutputPreview;
  anchor.parentNode.insertBefore(b,anchor);
}
function printSchedule(){
  const d=outputScheduleData(); if(!d.length)return alert('Không có dữ liệu để in.');
  if(!lessonPlanMap.size)return alert('Hãy tải Phụ lục 2 trước khi in để có đầy đủ tên bài học.');
  ensureFormalOutputStyles();
  const holder=document.createElement('div');holder.className='formal-holder print-formal';holder.innerHTML=buildFormalOutput(d);
  // BƯỚC 4.2-R5: riêng bản In, giữ dòng Tổng số đúng 4 cột của bảng tổng hợp.
  const printTotalRow=holder.querySelector('.formal-summary tr:last-child');
  if(printTotalRow){
    const totalValue=printTotalRow.querySelectorAll('th')[1]?.textContent||String(d.length+getConcurrentPeriods());
    printTotalRow.innerHTML=`<th></th><th>Tổng số</th><th>${esc(totalValue)}</th><th></th>`;
  }
  document.body.appendChild(holder);document.body.classList.add('printing-formal');
  const restore=()=>{document.body.classList.remove('printing-formal');holder.remove();window.removeEventListener('afterprint',restore)};window.addEventListener('afterprint',restore);setTimeout(()=>window.print(),80)
}
$('loginBtn')&&($('loginBtn').onclick=openAuthModal); $('logoutBtn')&&($('logoutBtn').onclick=logoutTeacher); initWeekSelect(); initSupabaseConnection(); loadScheduleRepository(); loadSchoolCalendar(); activateSelectedWeek(); $('fileInput').addEventListener('change',e=>e.target.files.length&&readWorkbooks(e.target.files)); $('pl2Input').addEventListener('change',e=>e.target.files[0]&&readLessonPlan(e.target.files[0])); $('weekSelect').addEventListener('change',()=>{saveOutputSettings();activateSelectedWeek()}); $('calendarBtn')&&($('calendarBtn').onclick=openCalendarManager); $('repoBtn')&&($('repoBtn').onclick=openRepoManager); $('appendix2RepoBtn')&&($('appendix2RepoBtn').onclick=openAppendix2RepoManager); $('concurrentPeriods').addEventListener('change',()=>{if(Number($('concurrentPeriods').value)<0)$('concurrentPeriods').value=0;saveOutputSettings()}); ['fThu','fBuoi','fPoint','fClass'].forEach(id=>$(id).addEventListener('change',render)); $('tableBtn').onclick=()=>{currentView='table';render()}; $('weekBtn').onclick=()=>{currentView='week';render()}; $('excelBtn').onclick=exportExcel; $('pdfBtn').onclick=exportPDF; $('printBtn').onclick=printSchedule; ensurePreviewButton();

// BƯỚC 5.1.1O-R1 - Google Sheets: xác minh đúng mã mới đang chạy; vẫn CHỈ ĐỌC.
const GOOGLE_SHEETS_CLIENT_ID='671858456606-0st6517jnk78bovre7mp3er2u6v3guhs.apps.googleusercontent.com';
const GOOGLE_SHEETS_SPREADSHEET_ID='1EFMtbEFnPKbVH5TFsJdV9FUCSricWkiCBdbOQn0FwDo';
const GOOGLE_SHEETS_LINK_GID=162218494;
const GOOGLE_SHEETS_TEACHER_NAME='Võ Thanh Đậm';
const GOOGLE_SHEETS_SCOPE='https://www.googleapis.com/auth/spreadsheets';
let googleSheetsTokenClient=null;
function loadGoogleIdentityServices(){
  if(window.google?.accounts?.oauth2)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const old=document.getElementById('googleIdentityServicesScript');
    if(old){old.addEventListener('load',resolve,{once:true});old.addEventListener('error',()=>reject(new Error('Không tải được Google Identity Services.')),{once:true});return;}
    const s=document.createElement('script');s.id='googleIdentityServicesScript';s.src='https://accounts.google.com/gsi/client';s.async=true;s.defer=true;s.onload=resolve;s.onerror=()=>reject(new Error('Không tải được Google Identity Services.'));document.head.appendChild(s);
  });
}
async function getGoogleSheetsReadOnlyToken(){
  await loadGoogleIdentityServices();
  return new Promise((resolve,reject)=>{
    googleSheetsTokenClient=google.accounts.oauth2.initTokenClient({client_id:GOOGLE_SHEETS_CLIENT_ID,scope:GOOGLE_SHEETS_SCOPE,callback:r=>{if(r?.error)return reject(new Error(r.error_description||r.error));if(!r?.access_token)return reject(new Error('Google không trả về access token.'));resolve(r.access_token);}});
    googleSheetsTokenClient.requestAccessToken({prompt:'consent'});
  });
}
function googleSheetNameKey(v){return String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function googleSheetWeekFromLine(line){
  const text=String(line||'').replace(/\s+/g,' ').trim();
  const m=text.match(/Hoạt\s*động\s*giáo\s*dục\s*tuần\s*((?:\d\s*){1,2})/i);
  if(!m)return null;
  const week=Number(m[1].replace(/\s/g,''));
  return Number.isInteger(week)&&week>=1&&week<=35?week:null;
}
async function checkGoogleSheetReadOnly(){
  const btn=document.querySelector('#outputPreviewModal .preview-google-readonly');
  const oldText=btn?.textContent;
  try{
    if(btn){btn.disabled=true;btn.textContent='Đang kiểm tra...';}
    const token=await getGoogleSheetsReadOnlyToken();
    const headers={Authorization:`Bearer ${token}`};
    const metaUrl=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(GOOGLE_SHEETS_SPREADSHEET_ID)}?fields=properties.title,sheets.properties(sheetId,title,index)`;
    const metaRes=await fetch(metaUrl,{headers});
    const meta=await metaRes.json();
    if(!metaRes.ok)throw new Error(meta?.error?.message||'Không đọc được thông tin Google Sheet.');
    const sheets=meta.sheets||[];
    const teacherKey=googleSheetNameKey(GOOGLE_SHEETS_TEACHER_NAME);
    const teacherSheet=sheets.find(s=>googleSheetNameKey(s?.properties?.title)===teacherKey)||sheets.find(s=>googleSheetNameKey(s?.properties?.title).includes(teacherKey));
    const linkSheet=sheets.find(s=>Number(s?.properties?.sheetId)===GOOGLE_SHEETS_LINK_GID);
    if(!teacherSheet){
      const names=sheets.map(s=>s?.properties?.title).filter(Boolean).join(', ');
      throw new Error(`Chưa tìm thấy tab mang tên "${GOOGLE_SHEETS_TEACHER_NAME}".\n\nTab gid=${GOOGLE_SHEETS_LINK_GID} hiện là: ${linkSheet?.properties?.title||'không tìm thấy'}.\n\nCác tab đọc được: ${names}`);
    }
    const title=teacherSheet.properties.title;
    const targetGid=teacherSheet.properties.sheetId;
    const range=`'${String(title).replace(/'/g,"''")}'!A:K`;
    const valuesUrl=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(GOOGLE_SHEETS_SPREADSHEET_ID)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
    const valuesRes=await fetch(valuesUrl,{headers});
    const valuesJson=await valuesRes.json();
    if(!valuesRes.ok)throw new Error(valuesJson?.error?.message||'Không đọc được dữ liệu của sheet giáo viên.');
    const rows=valuesJson.values||[];
    const weeks=[];
    rows.forEach((row,i)=>{const week=googleSheetWeekFromLine((row||[]).join(' '));if(week!==null)weeks.push({week,row:i+1});});
    const uniqueWeeks=[];const seen=new Set();
    weeks.forEach(x=>{if(!seen.has(x.week)){seen.add(x.week);uniqueWeeks.push(x);}});
    uniqueWeeks.sort((a,b)=>a.week-b.week);
    const weekText=uniqueWeeks.length?uniqueWeeks.map(x=>`Tuần ${x.week} (dòng ${x.row})`).join(', '):'chưa nhận diện được tiêu đề tuần 1–35 trong cột A:K';
    const missing=Array.from({length:35},(_,i)=>i+1).filter(w=>!seen.has(w));
    alert(`KẾT NỐI GOOGLE SHEETS CHỈ ĐỌC THÀNH CÔNG – O-R1\n\nTệp: ${meta.properties?.title||GOOGLE_SHEETS_SPREADSHEET_ID}\nTab giáo viên: ${title}\nGID thực tế: ${targetGid}\nTab của link gid=${GOOGLE_SHEETS_LINK_GID}: ${linkSheet?.properties?.title||'không tìm thấy'}\nSố dòng đã đọc: ${rows.length}\n\nNhận diện tuần: ${weekText}\n\nTuần chưa thấy: ${missing.length?missing.join(', '):'Không có – đã thấy đủ Tuần 1–35'}\n\nBước này vẫn chỉ đọc; app chưa có quyền và chưa có lệnh ghi/sửa/xóa Google Sheet.`);
  }catch(err){console.error('Google Sheets read-only check:',err);alert(`Chưa xác định được đúng Google Sheet của giáo viên.\n\n${err?.message||err}`);}
  finally{if(btn){btn.disabled=false;btn.textContent=oldText||'Kiểm tra Google Sheet O-R1';}}
}
function ensureGoogleSheetsReadOnlyPreviewButton(){
  const bar=document.querySelector('#outputPreviewModal .output-preview-bar>div');
  if(!bar||bar.querySelector('.preview-google-readonly'))return;
  const close=bar.querySelector('.preview-close');
  const b=document.createElement('button');b.type='button';b.className='preview-google-readonly';b.textContent='Kiểm tra Google Sheet O-R1';b.title='BƯỚC 5.1.1O-R1 – chỉ đọc; tự tìm tab Võ Thanh Đậm và tuần 1–35';b.onclick=checkGoogleSheetReadOnly;
  bar.insertBefore(b,close||null);
}
const openOutputPreviewBeforeGoogleReadOnly=openOutputPreview;
openOutputPreview=function(){openOutputPreviewBeforeGoogleReadOnly();ensureGoogleSheetsReadOnlyPreviewButton();};
const previewBtnGoogleReadOnly=document.getElementById('previewBtn');
if(previewBtnGoogleReadOnly)previewBtnGoogleReadOnly.onclick=openOutputPreview;


// BƯỚC 5.1.3Q - Tuần 4: giữ nguyên nội dung 5.1.3P đã Đạt; bật xuống dòng tự động cho ô bài dạy trên Google Sheet.
// Chỉ ghi khi: đúng Spreadsheet, đúng tab/GID, đang chọn Tuần 4, Google Sheet chưa có Tuần 4.
const GOOGLE_SHEETS_TEACHER_GID=1908030276;
function gsA1Title(title){return `'${String(title).replace(/'/g,"''")}'`;}
async function gsJson(url,options={}){
  const res=await fetch(url,options); let body={}; try{body=await res.json()}catch(e){}
  if(!res.ok)throw new Error(body?.error?.message||`Google Sheets API lỗi ${res.status}`); return body;
}
function gsWeek4Rows(data){
  const wd=selectedWeekDates();
  const days=['Hai','Ba','Tư','Năm','Sáu'], labels=['Thứ hai','Thứ ba','Thứ tư','Thứ năm','Thứ sáu'];
  const concurrent=getConcurrentPeriods();

  // BƯỚC 5.1.3J: lấy chính dữ liệu bài dạy đã ghép đang dùng trong bản Xem trước.
  // Không dựng lại tên bài bằng một đường dữ liệu khác.
  const lessonText=x=>{
    const subject=normalizeSubjectForPlan(x?.monHoc||x?.plan?.subject||'');
    const grade=gradeFromClass(x?.lop||'');
    // outputScheduleData() vừa gọi applyLessonPlan(), vì vậy x.plan chính là dữ liệu
    // đang tạo tên bài trong Xem trước. Chỉ fallback sang map nếu thật sự cần.
    const plan=(x?.plan?.title ? x.plan : lessonPlanMap.get(planKey(subject,grade,4)))||null;
    const period=plan?.annualPeriod||plan?.week||4;
    const title=clean(plan?.title||'');
    if(!title) throw new Error(`Thiếu tên bài Phụ lục 2: ${subject} ${clean(x?.lop)} - Tuần 4.`);
    return `${subject} ${clean(x?.lop)} Tiết ${period} - ${title}`;
  };
  const cell=(day,session,tiet)=>data
    .filter(x=>x.thu===day&&normKey(x.buoi)===normKey(session)&&Number(x.tiet)===Number(tiet))
    .map(lessonText).join('\n────────\n');

  // Đếm trực tiếp 20 tiết đang dùng để tạo bảng Tuần 4.
  // Phân loại bằng khóa không dấu để không phụ thuộc cách viết hoa/thường.
  const classify=x=>{
    const raw=normKey(normalizeSubjectForPlan(x?.monHoc||x?.plan?.subject||''));
    const k=raw.replace(/[^a-z0-9]+/g,'');
    if(k==='cn'||k==='cnghe'||k.includes('congnghe'))return 'Công nghệ';
    if(k==='th'||k.includes('tinhoc'))return 'Tin học';
    if(k==='dd'||k.includes('daoduc'))return 'Đạo đức';
    return '';
  };
  const counts={'Công nghệ':0,'Tin học':0,'Đạo đức':0};
  data.forEach(x=>{const k=classify(x);if(k)counts[k]++;});
  const teachingTotal=counts['Công nghệ']+counts['Tin học']+counts['Đạo đức'];
  if(teachingTotal!==data.length){
    const unknown=data.filter(x=>!classify(x)).map(x=>`${x.monHoc||''} ${x.lop||''}`).join(', ');
    throw new Error(`Không thể tổng hợp đủ ${data.length} tiết Tuần 4. Đã nhận diện ${teachingTotal} tiết. Chưa nhận diện: ${unknown||'không rõ'}.`);
  }
  const details=[
    ['Phòng máy',concurrent],
    ['Công nghệ',counts['Công nghệ']],
    ['Tin học',counts['Tin học']],
    ['Đạo đức',counts['Đạo đức']]
  ];
  const values=[];
  values.push({range:'A74',values:[[`Hoạt động giáo dục tuần 04`]]});
  // Mẫu Tuần 3 có ô A75 riêng chứa nhãn 'Năm học', còn tiêu đề chính nằm từ B75.
  // Ghi đúng vào B75 để không tạo chữ thừa ở mép trái; đồng thời bổ sung môn Đạo đức.
  values.push({range:'A75',values:[['']]});
  values.push({range:'B75',values:[[`Năm học 2026 – 2027. Môn: Tin học, Công nghệ, Đạo đức – Khối: 3, 4, 5 – Trường TH – THCS & THPT Lại Sơn`]]});
  values.push({range:'A76',values:[[`Tuần 4: từ ngày ${wd.fmt(wd.start)} đến ${wd.fmt(wd.end)}`]]});
  values.push({range:'C77:G77',values:[[...wd.days.map(d=>`Ngày ${d}`)]]});
  values.push({range:'C78:G78',values:[[...labels]]});
  const schedule=[];
  for(let t=1;t<=4;t++)schedule.push(days.map(day=>cell(day,'Sáng',t)));
  for(let t=1;t<=3;t++)schedule.push(days.map(day=>cell(day,'Chiều',t)));
  values.push({range:'C79:G85',values:schedule});
  // Không ghi Tổng số vào A86: mẫu sao chép đã có dòng Tổng số đúng ở giữa bảng.
  // Chỉ xóa giá trị thừa ở mép trái để tránh xuất hiện 'Tổng số: 20...' ngoài khung.
  values.push({range:'A86',values:[['']]});
  details.forEach((x,i)=>{
    const row=89+i;
    values.push({range:`B${row}`,values:[[i+1]]});
    values.push({range:`C${row}`,values:[[x[0]]]});
    values.push({range:`E${row}`,values:[[x[1]]]});
  });
  values.push({range:'C93',values:[['Tổng số']]});
  values.push({range:'E93',values:[[data.length+concurrent]]});
  return values;
}
async function exportWeek4ToGoogleSheet(){
  const btn=document.querySelector('#outputPreviewModal .preview-google-write-week4'), old=btn?.textContent;
  try{
    if(Number($('weekSelect')?.value)!==4)throw new Error('BƯỚC 5.1.3P chỉ cho phép ghi Tuần 4. Hãy chọn Tuần 4 trước.');
    // BƯỚC 5.1.3O: dùng CHÍNH dữ liệu đã ghép đang tạo bản Xem trước.
    // Nhờ đó Môn + Lớp + Tên bài + Tiết bài ghi sang Google Sheet phải trùng với bản giáo viên vừa kiểm tra.
    // outputScheduleData() tự applyLessonPlan() và áp dụng lớp điều chỉnh xuất (nếu giáo viên đã sửa trong Xem trước).
    const data=outputScheduleData().map(x=>({...x}));

    // BƯỚC 5.1.3N: tuyệt đối dùng môn đã đọc từ TKB nguồn, không hard-code đổi môn.
    // File TKB chuẩn mới phải cho: Thứ Tư - Chiều - Tiết 2 - lớp 3B2 = Tin học.
    // Nếu app vẫn đang giữ TKB cũ (3B2 = Công nghệ), dừng và yêu cầu nhập lại TKB đã sửa.
    const lesson3B2=data.find(x=>
      normKey(x?.thu)==='tu' && normKey(x?.buoi)==='chieu' &&
      Number(x?.tiet)===2 && normKey(x?.lop)==='3b2'
    );
    if(!lesson3B2)throw new Error('DỪNG GHI: TKB nguồn không có lớp 3B2 tại Thứ Tư - Chiều - Tiết 2.');
    const source3B2=normKey(normalizeSubjectForPlan(lesson3B2.monHoc)).replace(/[^a-z0-9]+/g,'');
    if(!(source3B2.includes('tinhoc')||source3B2==='th'))
      throw new Error(`DỪNG GHI: TKB đang nạp vẫn ghi 3B2 Thứ Tư - Chiều - Tiết 2 = ${normalizeSubjectForPlan(lesson3B2.monHoc)||lesson3B2.monHoc}. Hãy nhập lại file TKB đã sửa, trong đó ô này là Tin học.`);

    if(!data.length)throw new Error('Tuần 4 hiện không có dữ liệu TKB nguồn để ghi.');
    if(data.length!==20)throw new Error(`DỪNG GHI: TKB nguồn Tuần 4 phải có đúng 20 tiết, hiện đọc được ${data.length} tiết.`);

    // Một giáo viên không thể có hai lớp ở cùng Thứ + Buổi + Tiết. Nếu parser/source tạo trùng,
    // dừng để không âm thầm ghi sai sang Google Sheet.
    const slotMap=new Map();
    for(const x of data){
      const slot=`${clean(x.thu)}|${normKey(x.buoi)}|${Number(x.tiet)||0}`;
      if(slotMap.has(slot)){
        const a=slotMap.get(slot);
        throw new Error(`DỪNG GHI: trùng vị trí Thứ ${x.thu} - ${x.buoi} - Tiết ${x.tiet}: ${normalizeSubjectForPlan(a.monHoc)} ${a.lop} và ${normalizeSubjectForPlan(x.monHoc)} ${x.lop}.`);
      }
      slotMap.set(slot,x);
    }

    // Chốt theo TKB thật đã đối chiếu của GV Đậm: 20 tiết = Tin học 7 + Công nghệ 12 + Đạo đức 1.
    const subjectCount={tin:0,cn:0,dd:0};
    for(const x of data){
      const k=normKey(normalizeSubjectForPlan(x.monHoc)).replace(/[^a-z0-9]+/g,'');
      if(k.includes('tinhoc')||k==='th')subjectCount.tin++;
      else if(k.includes('congnghe')||k==='cn'||k==='cnghe')subjectCount.cn++;
      else if(k.includes('daoduc')||k==='dd')subjectCount.dd++;
    }
    if(subjectCount.tin!==7||subjectCount.cn!==12||subjectCount.dd!==1)
      throw new Error(`DỪNG GHI: cơ cấu môn Tuần 4 chưa đúng TKB thật. Hiện có Tin học ${subjectCount.tin}, Công nghệ ${subjectCount.cn}, Đạo đức ${subjectCount.dd}; yêu cầu 7 / 12 / 1.`);

    // 20/20 tiết phải ghép được tên bài trước khi cho phép ghi.
    const noTitle=data.filter(x=>!clean(x.plan?.title));
    if(noTitle.length)throw new Error(`DỪNG GHI: còn ${noTitle.length} tiết chưa ghép tên bài Phụ lục 2: ${noTitle.slice(0,4).map(x=>`${normalizeSubjectForPlan(x.monHoc)} ${x.lop}`).join(', ')}.`);
    if(btn){btn.disabled=true;btn.textContent='Đang kiểm tra...';}
    const token=await getGoogleSheetsReadOnlyToken(), headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
    const base=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(GOOGLE_SHEETS_SPREADSHEET_ID)}`;
    const meta=await gsJson(`${base}?fields=properties.title,sheets.properties(sheetId,title,gridProperties)`,{headers});
    const teacher=(meta.sheets||[]).find(s=>Number(s?.properties?.sheetId)===GOOGLE_SHEETS_TEACHER_GID);
    if(!teacher||googleSheetNameKey(teacher.properties.title)!==googleSheetNameKey(GOOGLE_SHEETS_TEACHER_NAME))throw new Error(`DỪNG GHI: không khớp tab ${GOOGLE_SHEETS_TEACHER_NAME} / GID ${GOOGLE_SHEETS_TEACHER_GID}.`);
    const title=teacher.properties.title, q=gsA1Title(title);
    const scan=await gsJson(`${base}/values/${encodeURIComponent(q+'!A1:H824')}?majorDimension=ROWS`,{headers});
    const found=[];(scan.values||[]).forEach((r,i)=>{const w=googleSheetWeekFromLine((r||[]).join(' '));if(w!==null)found.push({week:w,row:i+1});});
    if(found.some(x=>x.week===4))throw new Error(`Google Sheet đã có Tuần 4 ở dòng ${found.find(x=>x.week===4).row}. App không ghi chồng.`);
    const w3=found.find(x=>x.week===3); if(!w3||w3.row!==51)throw new Error(`DỪNG GHI: vị trí Tuần 3 không còn đúng mẫu (mong đợi dòng 51, thực tế ${w3?.row||'không tìm thấy'}).`);
    if(!confirm('GHI THẬT TUẦN 4 vào tab Võ Thanh Đậm?\n\nTuần 1–3 sẽ không bị sửa. App sẽ sao chép nguyên mẫu Tuần 3 (merge, định dạng, chiều cao hàng) sang dòng 74–95 rồi thay dữ liệu Tuần 4.'))return;
    if(btn)btn.textContent='Đang tạo mẫu Tuần 4...';
    // 5.1.3B: lấy CHÍNH Tuần 3 làm template 1:1. copyPaste giữ format/giá trị,
    // còn merge và chiều cao hàng phải sao chép riêng vì Google Sheets không tạo merge mới bằng copyPaste.
    const tpl=await gsJson(`${base}?ranges=${encodeURIComponent(title+'!A51:H72')}&includeGridData=true&fields=sheets(merges,data(rowMetadata(pixelSize)))`,{headers});
    const srcMerges=(tpl.sheets?.[0]?.merges||[]).filter(m=>m.startRowIndex>=50&&m.endRowIndex<=72&&m.startColumnIndex>=0&&m.endColumnIndex<=8);
    const srcRowMeta=tpl.sheets?.[0]?.data?.[0]?.rowMetadata||[];
    const requests=[
      {unmergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:73,endRowIndex:95,startColumnIndex:0,endColumnIndex:8}}},
      {copyPaste:{source:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:50,endRowIndex:72,startColumnIndex:0,endColumnIndex:8},destination:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:73,endRowIndex:95,startColumnIndex:0,endColumnIndex:8},pasteType:'PASTE_NORMAL',pasteOrientation:'NORMAL'}}
    ];
    srcMerges.forEach(m=>requests.push({mergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:m.startRowIndex+23,endRowIndex:m.endRowIndex+23,startColumnIndex:m.startColumnIndex,endColumnIndex:m.endColumnIndex},mergeType:'MERGE_ALL'}}));
    srcRowMeta.forEach((rm,i)=>{if(rm?.pixelSize)requests.push({updateDimensionProperties:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,dimension:'ROWS',startIndex:73+i,endIndex:74+i},properties:{pixelSize:rm.pixelSize},fields:'pixelSize'}});});
    // 5.1.3Q: tên bài dài phải tự xuống hàng trong đúng vùng tiết C79:G85.
    // Chỉ đổi wrapStrategy, không đụng font/viền/màu/căn lề đã sao chép từ mẫu Tuần 3.
    requests.push({repeatCell:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:78,endRowIndex:85,startColumnIndex:2,endColumnIndex:7},cell:{userEnteredFormat:{wrapStrategy:'WRAP'}},fields:'userEnteredFormat.wrapStrategy'}});
    // Cho 7 hàng tiết tự tăng chiều cao theo số dòng sau khi wrap, thay vì ép cố định 62 px.
    requests.push({autoResizeDimensions:{dimensions:{sheetId:GOOGLE_SHEETS_TEACHER_GID,dimension:'ROWS',startIndex:78,endIndex:85}}});
    await gsJson(`${base}:batchUpdate`,{method:'POST',headers,body:JSON.stringify({requests})});
    // 5.1.3G: xóa CHỈ GIÁ TRỊ vùng dữ liệu Tổng hợp, giữ nguyên merge/viền/font/căn chỉnh vừa sao chép.
    // Xóa cả cột A để loại sạch các số/chữ rơi ngoài bảng do dữ liệu cũ của template.
    await gsJson(`${base}/values/${encodeURIComponent(q+'!A89:H93')}:clear`,{method:'POST',headers,body:'{}'});
    if(btn)btn.textContent='Đang ghi Tuần 4...';
    const payload=gsWeek4Rows(data).map(x=>({range:`${q}!${x.range}`,majorDimension:'ROWS',values:x.values}));
    await gsJson(`${base}/values:batchUpdate`,{method:'POST',headers,body:JSON.stringify({valueInputOption:'USER_ENTERED',data:payload})});
    const verify=await gsJson(`${base}/values/${encodeURIComponent(q+'!A74:H95')}?majorDimension=ROWS`,{headers});
    const rows=verify.values||[], detected=[]; rows.forEach((r,i)=>{const w=googleSheetWeekFromLine((r||[]).join(' '));if(w!==null)detected.push({week:w,row:74+i});});
    if(!detected.some(x=>x.week===4))throw new Error('Đã gửi lệnh ghi nhưng chưa đọc lại được tiêu đề Tuần 4. Hãy kiểm tra Google Sheet trước khi thao tác tiếp.');
    const writtenSchedule=(rows.slice(5,12)||[]).flat().map(clean).filter(Boolean).join('\n');
    const expectedTitles=[...new Set(data.map(x=>clean((x.plan||lessonPlanMap.get(planKey(normalizeSubjectForPlan(x.monHoc),gradeFromClass(x.lop),4)))?.title||'')).filter(Boolean))];
    const missingTitles=expectedTitles.filter(t=>!writtenSchedule.includes(t));
    if(missingTitles.length)throw new Error(`BƯỚC 5.1.3K đã đọc lại Google Sheet nhưng còn thiếu tên bài: ${missingTitles.slice(0,3).join(' | ')}. Dừng tại Tuần 4.`);
    alert(`GHI TUẦN 4 THÀNH CÔNG\n\nTệp: ${meta.properties?.title||''}\nTab: ${title}\nGID: ${GOOGLE_SHEETS_TEACHER_GID}\nVùng ghi: dòng 74–95\nSố tiết: ${data.length}\nTổng kể cả kiêm nhiệm: ${data.length+getConcurrentPeriods()}\n\nTuần 1–3 không bị sửa. Hãy mở Google Sheet kiểm tra trực tiếp trước khi làm Tuần 5.`);
  }catch(err){console.error('[TKB] Ghi thật Tuần 4:',err);alert(`CHƯA GHI ĐƯỢC TUẦN 4\n\n${err?.message||err}\n\nKhông tiếp tục Tuần 5 cho đến khi Tuần 4 được kiểm tra.`)}
  finally{if(btn){btn.disabled=false;btn.textContent=old||'Ghi Tuần 4 vào Google Sheet';}}
}
function ensureGoogleSheetsWeek4WriteButton(){
  const bar=document.querySelector('#outputPreviewModal .output-preview-bar>div'); if(!bar||bar.querySelector('.preview-google-write-week4'))return;
  const close=bar.querySelector('.preview-close'); const b=document.createElement('button'); b.type='button';b.className='preview-google-write-week4';b.textContent='Ghi Tuần 4 vào Google Sheet';b.title='BƯỚC 5.1.3Q – ghi Tuần 4 và tự xuống hàng tên bài trên Google Sheet; giữ nguyên dữ liệu đã kiểm tra';b.onclick=exportWeek4ToGoogleSheet;bar.insertBefore(b,close||null);
}
const openOutputPreviewBeforeWeek4Write=openOutputPreview;
openOutputPreview=function(){openOutputPreviewBeforeWeek4Write();ensureGoogleSheetsWeek4WriteButton();};
const previewBtnWeek4Write=document.getElementById('previewBtn'); if(previewBtnWeek4Write)previewBtnWeek4Write.onclick=openOutputPreview;

// BƯỚC 5.1.4 - Ghi Tuần 5 bằng cơ chế tổng quát theo tuần.
// Từ đây không dựng riêng dữ liệu từng tuần: hàm dưới nhận week/startRow và dùng chính outputScheduleData() của Xem trước.
function gsWeekRows(data,week,startRow){
  const wd=selectedWeekDates();
  const days=['Hai','Ba','Tư','Năm','Sáu'], labels=['Thứ hai','Thứ ba','Thứ tư','Thứ năm','Thứ sáu'];
  const concurrent=getConcurrentPeriods();
  const lessonText=x=>{
    const subject=normalizeSubjectForPlan(x?.monHoc||x?.plan?.subject||'');
    const grade=gradeFromClass(x?.lop||'');
    const plan=(x?.plan?.title ? x.plan : lessonPlanMap.get(planKey(subject,grade,week)))||null;
    const period=plan?.annualPeriod||plan?.week||week;
    const title=clean(plan?.title||'');
    if(!title)throw new Error(`Thiếu tên bài Phụ lục 2: ${subject} ${clean(x?.lop)} - Tuần ${week}.`);
    return `${subject} ${clean(x?.lop)} Tiết ${period} - ${title}`;
  };
  const cell=(day,session,tiet)=>data.filter(x=>x.thu===day&&normKey(x.buoi)===normKey(session)&&Number(x.tiet)===Number(tiet)).map(lessonText).join('\n────────\n');
  const classify=x=>{
    const k=normKey(normalizeSubjectForPlan(x?.monHoc||x?.plan?.subject||'')).replace(/[^a-z0-9]+/g,'');
    if(k==='cn'||k==='cnghe'||k.includes('congnghe'))return 'Công nghệ';
    if(k==='th'||k.includes('tinhoc'))return 'Tin học';
    if(k==='dd'||k.includes('daoduc'))return 'Đạo đức';
    return '';
  };
  const counts={'Công nghệ':0,'Tin học':0,'Đạo đức':0}; data.forEach(x=>{const k=classify(x);if(k)counts[k]++;});
  const teachingTotal=counts['Công nghệ']+counts['Tin học']+counts['Đạo đức'];
  if(teachingTotal!==data.length)throw new Error(`Không thể tổng hợp đủ ${data.length} tiết Tuần ${week}. Đã nhận diện ${teachingTotal} tiết.`);
  const details=[['Phòng máy',concurrent],['Công nghệ',counts['Công nghệ']],['Tin học',counts['Tin học']],['Đạo đức',counts['Đạo đức']]];
  const r=n=>startRow+n, values=[];
  values.push({range:`A${r(0)}`,values:[[`Hoạt động giáo dục tuần ${String(week).padStart(2,'0')}`]]});
  values.push({range:`A${r(1)}`,values:[['']]});
  values.push({range:`B${r(1)}`,values:[['Năm học 2026 – 2027. Môn: Tin học, Công nghệ, Đạo đức – Khối: 3, 4, 5 – Trường TH – THCS & THPT Lại Sơn']]});
  values.push({range:`A${r(2)}`,values:[[`Tuần ${week}: từ ngày ${wd.fmt(wd.start)} đến ${wd.fmt(wd.end)}`]]});
  values.push({range:`C${r(3)}:G${r(3)}`,values:[[...wd.days.map(d=>`Ngày ${d}`)]]});
  values.push({range:`C${r(4)}:G${r(4)}`,values:[[...labels]]});
  const schedule=[]; for(let t=1;t<=4;t++)schedule.push(days.map(day=>cell(day,'Sáng',t))); for(let t=1;t<=3;t++)schedule.push(days.map(day=>cell(day,'Chiều',t)));
  values.push({range:`C${r(5)}:G${r(11)}`,values:schedule});
  values.push({range:`A${r(12)}`,values:[['']]});
  details.forEach((x,i)=>{const row=r(15+i);values.push({range:`B${row}`,values:[[i+1]]},{range:`C${row}`,values:[[x[0]]]},{range:`E${row}`,values:[[x[1]]]});});
  values.push({range:`C${r(19)}`,values:[['Tổng số']]},{range:`E${r(19)}`,values:[[data.length+concurrent]]});
  return values;
}
async function exportWeek5ToGoogleSheet(){
  const week=5,startRow=96,endRow=117,templateStart=74,templateEnd=95,offset=startRow-templateStart;
  const btn=document.querySelector('#outputPreviewModal .preview-google-write-week5'),old=btn?.textContent;
  try{
    if(Number($('weekSelect')?.value)!==week)throw new Error(`BƯỚC 5.1.4 chỉ ghi Tuần ${week}. Hãy chọn Tuần ${week} trước.`);
    const data=outputScheduleData().map(x=>({...x}));
    if(data.length!==20)throw new Error(`DỪNG GHI: TKB nguồn Tuần ${week} phải có đúng 20 tiết, hiện đọc được ${data.length} tiết.`);
    const slotMap=new Map(); for(const x of data){const slot=`${clean(x.thu)}|${normKey(x.buoi)}|${Number(x.tiet)||0}`;if(slotMap.has(slot)){const a=slotMap.get(slot);throw new Error(`DỪNG GHI: trùng vị trí Thứ ${x.thu} - ${x.buoi} - Tiết ${x.tiet}: ${normalizeSubjectForPlan(a.monHoc)} ${a.lop} và ${normalizeSubjectForPlan(x.monHoc)} ${x.lop}.`);}slotMap.set(slot,x);}
    const subjectCount={tin:0,cn:0,dd:0}; for(const x of data){const k=normKey(normalizeSubjectForPlan(x.monHoc)).replace(/[^a-z0-9]+/g,'');if(k.includes('tinhoc')||k==='th')subjectCount.tin++;else if(k.includes('congnghe')||k==='cn'||k==='cnghe')subjectCount.cn++;else if(k.includes('daoduc')||k==='dd')subjectCount.dd++;}
    if(subjectCount.tin!==7||subjectCount.cn!==12||subjectCount.dd!==1)throw new Error(`DỪNG GHI: cơ cấu môn Tuần ${week} chưa đúng TKB thật. Hiện có Tin học ${subjectCount.tin}, Công nghệ ${subjectCount.cn}, Đạo đức ${subjectCount.dd}; yêu cầu 7 / 12 / 1.`);
    const noTitle=data.filter(x=>!clean(x.plan?.title)); if(noTitle.length)throw new Error(`DỪNG GHI: còn ${noTitle.length} tiết chưa ghép tên bài Phụ lục 2.`);
    if(btn){btn.disabled=true;btn.textContent='Đang kiểm tra...';}
    const token=await getGoogleSheetsReadOnlyToken(),headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'},base=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(GOOGLE_SHEETS_SPREADSHEET_ID)}`;
    const meta=await gsJson(`${base}?fields=properties.title,sheets.properties(sheetId,title,gridProperties)`,{headers});
    const teacher=(meta.sheets||[]).find(s=>Number(s?.properties?.sheetId)===GOOGLE_SHEETS_TEACHER_GID); if(!teacher||googleSheetNameKey(teacher.properties.title)!==googleSheetNameKey(GOOGLE_SHEETS_TEACHER_NAME))throw new Error(`DỪNG GHI: không khớp tab ${GOOGLE_SHEETS_TEACHER_NAME} / GID ${GOOGLE_SHEETS_TEACHER_GID}.`);
    const title=teacher.properties.title,q=gsA1Title(title),maxRows=Number(teacher.properties?.gridProperties?.rowCount)||1000;
    if(maxRows<endRow)throw new Error(`Google Sheet chỉ có ${maxRows} dòng, chưa đủ để tạo Tuần ${week} đến dòng ${endRow}.`);
    const scan=await gsJson(`${base}/values/${encodeURIComponent(q+`!A1:H${maxRows}`)}?majorDimension=ROWS`,{headers}); const found=[];(scan.values||[]).forEach((r,i)=>{const w=googleSheetWeekFromLine((r||[]).join(' '));if(w!==null)found.push({week:w,row:i+1});});
    if(found.some(x=>x.week===week))throw new Error(`Google Sheet đã có Tuần ${week} ở dòng ${found.find(x=>x.week===week).row}. App không ghi chồng.`);
    const w4=found.find(x=>x.week===4); if(!w4||w4.row!==74)throw new Error(`DỪNG GHI: Tuần 4 phải ở dòng 74 để làm mẫu, thực tế ${w4?.row||'không tìm thấy'}.`);
    if(!confirm(`GHI THẬT TUẦN ${week} vào tab Võ Thanh Đậm?\n\nTuần 1–4 sẽ không bị sửa. App dùng nguyên mẫu Tuần 4 đã Đạt và thay bằng dữ liệu Xem trước Tuần ${week}.`))return;
    if(btn)btn.textContent=`Đang tạo mẫu Tuần ${week}...`;
    const tpl=await gsJson(`${base}?ranges=${encodeURIComponent(title+`!A${templateStart}:H${templateEnd}`)}&includeGridData=true&fields=sheets(merges,data(rowMetadata(pixelSize)))`,{headers});
    const s0=templateStart-1,s1=templateEnd, d0=startRow-1,d1=endRow;
    const srcMerges=(tpl.sheets?.[0]?.merges||[]).filter(m=>m.startRowIndex>=s0&&m.endRowIndex<=s1&&m.startColumnIndex>=0&&m.endColumnIndex<=8),srcRowMeta=tpl.sheets?.[0]?.data?.[0]?.rowMetadata||[];
    const requests=[{unmergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:d0,endRowIndex:d1,startColumnIndex:0,endColumnIndex:8}}},{copyPaste:{source:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:s0,endRowIndex:s1,startColumnIndex:0,endColumnIndex:8},destination:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:d0,endRowIndex:d1,startColumnIndex:0,endColumnIndex:8},pasteType:'PASTE_NORMAL',pasteOrientation:'NORMAL'}}];
    srcMerges.forEach(m=>requests.push({mergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:m.startRowIndex+offset,endRowIndex:m.endRowIndex+offset,startColumnIndex:m.startColumnIndex,endColumnIndex:m.endColumnIndex},mergeType:'MERGE_ALL'}}));
    srcRowMeta.forEach((rm,i)=>{if(rm?.pixelSize)requests.push({updateDimensionProperties:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,dimension:'ROWS',startIndex:d0+i,endIndex:d0+i+1},properties:{pixelSize:rm.pixelSize},fields:'pixelSize'}});});
    requests.push({repeatCell:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:d0+5,endRowIndex:d0+12,startColumnIndex:2,endColumnIndex:7},cell:{userEnteredFormat:{wrapStrategy:'WRAP'}},fields:'userEnteredFormat.wrapStrategy'}});
    requests.push({autoResizeDimensions:{dimensions:{sheetId:GOOGLE_SHEETS_TEACHER_GID,dimension:'ROWS',startIndex:d0+5,endIndex:d0+12}}});
    await gsJson(`${base}:batchUpdate`,{method:'POST',headers,body:JSON.stringify({requests})});
    await gsJson(`${base}/values/${encodeURIComponent(q+`!A${startRow+15}:H${startRow+19}`)}:clear`,{method:'POST',headers,body:'{}'});
    if(btn)btn.textContent=`Đang ghi Tuần ${week}...`;
    const payload=gsWeekRows(data,week,startRow).map(x=>({range:`${q}!${x.range}`,majorDimension:'ROWS',values:x.values})); await gsJson(`${base}/values:batchUpdate`,{method:'POST',headers,body:JSON.stringify({valueInputOption:'USER_ENTERED',data:payload})});
    const verify=await gsJson(`${base}/values/${encodeURIComponent(q+`!A${startRow}:H${endRow}`)}?majorDimension=ROWS`,{headers}),rows=verify.values||[],detected=[];rows.forEach((r,i)=>{const w=googleSheetWeekFromLine((r||[]).join(' '));if(w!==null)detected.push({week:w,row:startRow+i});}); if(!detected.some(x=>x.week===week))throw new Error(`Đã gửi lệnh ghi nhưng chưa đọc lại được tiêu đề Tuần ${week}.`);
    const writtenSchedule=(rows.slice(5,12)||[]).flat().map(clean).filter(Boolean).join('\n'); const expectedTitles=[...new Set(data.map(x=>clean(x.plan?.title||'')).filter(Boolean))],missingTitles=expectedTitles.filter(t=>!writtenSchedule.includes(t)); if(missingTitles.length)throw new Error(`Google Sheet còn thiếu tên bài: ${missingTitles.slice(0,3).join(' | ')}.`);
    alert(`GHI TUẦN ${week} THÀNH CÔNG\n\nTệp: ${meta.properties?.title||''}\nTab: ${title}\nVùng ghi: dòng ${startRow}–${endRow}\nSố tiết: ${data.length}\nTổng kể cả kiêm nhiệm: ${data.length+getConcurrentPeriods()}\n\nTuần 1–4 không bị sửa. Hãy kiểm tra Google Sheet trước khi mở rộng Tuần 6–35.`);
  }catch(err){console.error('[TKB] Ghi thật Tuần 5:',err);alert(`CHƯA GHI ĐƯỢC TUẦN 5\n\n${err?.message||err}\n\nKhông mở rộng Tuần 6–35 cho đến khi Tuần 5 được kiểm tra.`);}finally{if(btn){btn.disabled=false;btn.textContent=old||'Ghi Tuần 5 vào Google Sheet';}}
}
function ensureGoogleSheetsWeek5WriteButton(){
  const bar=document.querySelector('#outputPreviewModal .output-preview-bar>div'); if(!bar||bar.querySelector('.preview-google-write-week5'))return;
  const close=bar.querySelector('.preview-close'),b=document.createElement('button');b.type='button';b.className='preview-google-write-week5';b.textContent='Ghi Tuần 5 vào Google Sheet';b.title='BƯỚC 5.1.4 – dùng cơ chế tổng quát theo tuần, lấy Tuần 4 đã Đạt làm mẫu';b.onclick=exportWeek5ToGoogleSheet;bar.insertBefore(b,close||null);
}
const openOutputPreviewBeforeWeek5Write=openOutputPreview;
openOutputPreview=function(){openOutputPreviewBeforeWeek5Write();ensureGoogleSheetsWeek5WriteButton();};
const previewBtnWeek5Write=document.getElementById('previewBtn');if(previewBtnWeek5Write)previewBtnWeek5Write.onclick=openOutputPreview;

// BƯỚC 5.1.5 - Ghi Google Sheet tổng quát cho Tuần 6–35.
// Mỗi tuần chiếm 22 dòng. BƯỚC 5.1.6: dùng tuần chuẩn gần nhất đã tồn tại
// trên Google Sheet làm mẫu định dạng; không bắt buộc phải có tuần liền trước.
// Dữ liệu Môn + Lớp + Tên bài vẫn lấy trực tiếp từ Xem trước của tuần đang chọn.
async function exportSelectedWeek6To35ToGoogleSheet(){
  const week=Number($('weekSelect')?.value||0);
  const btn=document.querySelector('#outputPreviewModal .preview-google-write-week6-35'),old=btn?.textContent;
  try{
    if(!Number.isInteger(week)||week<6||week>35)throw new Error('BƯỚC 5.1.5 chỉ ghi Tuần 6–35. Hãy chọn tuần cần ghi trước.');
    const startRow=74+(week-4)*22,endRow=startRow+21;
    let templateWeek=0,templateStart=0,templateEnd=0,offset=0;
    const data=outputScheduleData().map(x=>({...x}));
    if(data.length!==20)throw new Error(`DỪNG GHI: TKB nguồn Tuần ${week} phải có đúng 20 tiết, hiện đọc được ${data.length} tiết.`);
    const slotMap=new Map();
    for(const x of data){const slot=`${clean(x.thu)}|${normKey(x.buoi)}|${Number(x.tiet)||0}`;if(slotMap.has(slot)){const a=slotMap.get(slot);throw new Error(`DỪNG GHI: trùng vị trí Thứ ${x.thu} - ${x.buoi} - Tiết ${x.tiet}: ${normalizeSubjectForPlan(a.monHoc)} ${a.lop} và ${normalizeSubjectForPlan(x.monHoc)} ${x.lop}.`);}slotMap.set(slot,x);}
    const subjectCount={tin:0,cn:0,dd:0};
    for(const x of data){const k=normKey(normalizeSubjectForPlan(x.monHoc)).replace(/[^a-z0-9]+/g,'');if(k.includes('tinhoc')||k==='th')subjectCount.tin++;else if(k.includes('congnghe')||k==='cn'||k==='cnghe')subjectCount.cn++;else if(k.includes('daoduc')||k==='dd')subjectCount.dd++;}
    if(subjectCount.tin!==7||subjectCount.cn!==12||subjectCount.dd!==1)throw new Error(`DỪNG GHI: cơ cấu môn Tuần ${week} chưa đúng TKB thật. Hiện có Tin học ${subjectCount.tin}, Công nghệ ${subjectCount.cn}, Đạo đức ${subjectCount.dd}; yêu cầu 7 / 12 / 1.`);
    const noTitle=data.filter(x=>!clean(x.plan?.title));if(noTitle.length)throw new Error(`DỪNG GHI: còn ${noTitle.length} tiết chưa ghép tên bài Phụ lục 2.`);
    if(btn){btn.disabled=true;btn.textContent='Đang kiểm tra...';}
    const token=await getGoogleSheetsReadOnlyToken(),headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'},base=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(GOOGLE_SHEETS_SPREADSHEET_ID)}`;
    const meta=await gsJson(`${base}?fields=properties.title,sheets.properties(sheetId,title,gridProperties)`,{headers});
    const teacher=(meta.sheets||[]).find(s=>Number(s?.properties?.sheetId)===GOOGLE_SHEETS_TEACHER_GID);if(!teacher||googleSheetNameKey(teacher.properties.title)!==googleSheetNameKey(GOOGLE_SHEETS_TEACHER_NAME))throw new Error(`DỪNG GHI: không khớp tab ${GOOGLE_SHEETS_TEACHER_NAME} / GID ${GOOGLE_SHEETS_TEACHER_GID}.`);
    const title=teacher.properties.title,q=gsA1Title(title),maxRows=Number(teacher.properties?.gridProperties?.rowCount)||1000;
    if(maxRows<endRow)throw new Error(`Google Sheet chỉ có ${maxRows} dòng, chưa đủ để tạo Tuần ${week} đến dòng ${endRow}.`);
    const scan=await gsJson(`${base}/values/${encodeURIComponent(q+`!A1:H${maxRows}`)}?majorDimension=ROWS`,{headers}),found=[];(scan.values||[]).forEach((r,i)=>{const w=googleSheetWeekFromLine((r||[]).join(' '));if(w!==null)found.push({week:w,row:i+1});});
    if(found.some(x=>x.week===week))throw new Error(`Google Sheet đã có Tuần ${week} ở dòng ${found.find(x=>x.week===week).row}. App không ghi chồng.`);
    const candidates=found.filter(x=>x.week>=4&&x.week<week&&x.row===74+(x.week-4)*22).sort((a,b)=>b.week-a.week);
    const template=candidates[0];
    if(!template)throw new Error(`DỪNG GHI: chưa tìm thấy tuần chuẩn nào từ Tuần 4 đến Tuần ${week-1} để làm mẫu định dạng.`);
    templateWeek=template.week;templateStart=template.row;templateEnd=templateStart+21;offset=startRow-templateStart;
    if(!confirm(`GHI THẬT TUẦN ${week} vào tab Võ Thanh Đậm?\n\nApp sẽ dùng Tuần ${templateWeek} (dòng ${templateStart}–${templateEnd}) làm mẫu định dạng và tạo Tuần ${week} tại dòng ${startRow}–${endRow}.\nCác tuần đã có sẽ không bị sửa.`))return;
    if(btn)btn.textContent=`Đang lấy mẫu Tuần ${templateWeek}...`;
    const tpl=await gsJson(`${base}?ranges=${encodeURIComponent(title+`!A${templateStart}:H${templateEnd}`)}&includeGridData=true&fields=sheets(merges,data(rowMetadata(pixelSize)))`,{headers});
    const s0=templateStart-1,s1=templateEnd,d0=startRow-1,d1=endRow;
    const srcMerges=(tpl.sheets?.[0]?.merges||[]).filter(m=>m.startRowIndex>=s0&&m.endRowIndex<=s1&&m.startColumnIndex>=0&&m.endColumnIndex<=8),srcRowMeta=tpl.sheets?.[0]?.data?.[0]?.rowMetadata||[];
    const requests=[{unmergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:d0,endRowIndex:d1,startColumnIndex:0,endColumnIndex:8}}},{copyPaste:{source:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:s0,endRowIndex:s1,startColumnIndex:0,endColumnIndex:8},destination:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:d0,endRowIndex:d1,startColumnIndex:0,endColumnIndex:8},pasteType:'PASTE_NORMAL',pasteOrientation:'NORMAL'}}];
    srcMerges.forEach(m=>requests.push({mergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:m.startRowIndex+offset,endRowIndex:m.endRowIndex+offset,startColumnIndex:m.startColumnIndex,endColumnIndex:m.endColumnIndex},mergeType:'MERGE_ALL'}}));
    srcRowMeta.forEach((rm,i)=>{if(rm?.pixelSize)requests.push({updateDimensionProperties:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,dimension:'ROWS',startIndex:d0+i,endIndex:d0+i+1},properties:{pixelSize:rm.pixelSize},fields:'pixelSize'}});});
    requests.push({repeatCell:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:d0+5,endRowIndex:d0+12,startColumnIndex:2,endColumnIndex:7},cell:{userEnteredFormat:{wrapStrategy:'WRAP'}},fields:'userEnteredFormat.wrapStrategy'}});
    requests.push({autoResizeDimensions:{dimensions:{sheetId:GOOGLE_SHEETS_TEACHER_GID,dimension:'ROWS',startIndex:d0+5,endIndex:d0+12}}});
    await gsJson(`${base}:batchUpdate`,{method:'POST',headers,body:JSON.stringify({requests})});
    await gsJson(`${base}/values/${encodeURIComponent(q+`!A${startRow+15}:H${startRow+19}`)}:clear`,{method:'POST',headers,body:'{}'});
    if(btn)btn.textContent=`Đang ghi Tuần ${week}...`;
    const payload=gsWeekRows(data,week,startRow).map(x=>({range:`${q}!${x.range}`,majorDimension:'ROWS',values:x.values}));await gsJson(`${base}/values:batchUpdate`,{method:'POST',headers,body:JSON.stringify({valueInputOption:'USER_ENTERED',data:payload})});
    const verify=await gsJson(`${base}/values/${encodeURIComponent(q+`!A${startRow}:H${endRow}`)}?majorDimension=ROWS`,{headers}),rows=verify.values||[],detected=[];rows.forEach((r,i)=>{const w=googleSheetWeekFromLine((r||[]).join(' '));if(w!==null)detected.push({week:w,row:startRow+i});});if(!detected.some(x=>x.week===week))throw new Error(`Đã gửi lệnh ghi nhưng chưa đọc lại được tiêu đề Tuần ${week}.`);
    const scheduleSlice=specialWeek1?rows.slice(2,9):rows.slice(5,12);
    const writtenSchedule=(scheduleSlice||[]).flat().map(clean).filter(Boolean).join('\n'),expectedTitles=[...new Set(data.map(x=>clean(x.plan?.title||'')).filter(Boolean))],missingTitles=expectedTitles.filter(t=>!writtenSchedule.includes(t));if(missingTitles.length)throw new Error(`Google Sheet còn thiếu tên bài: ${missingTitles.slice(0,3).join(' | ')}.`);
    alert(`GHI TUẦN ${week} THÀNH CÔNG\n\nTệp: ${meta.properties?.title||''}\nTab: ${title}\nVùng ghi: dòng ${startRow}–${endRow}\nSố tiết: ${data.length}\nTổng kể cả kiêm nhiệm: ${data.length+getConcurrentPeriods()}\n\nTuần 1–${week-1} không bị sửa. Hãy kiểm tra Google Sheet trước khi ghi tuần tiếp theo.`);
  }catch(err){console.error(`[TKB] Ghi thật Tuần ${week}:`,err);alert(`CHƯA GHI ĐƯỢC TUẦN ${week||''}\n\n${err?.message||err}\n\nKhông ghi tuần tiếp theo cho đến khi tuần này được kiểm tra.`);}finally{if(btn){btn.disabled=false;btn.textContent=old||`Ghi Tuần ${week||6} vào Google Sheet`;}}
}
function ensureGoogleSheetsWeek6To35WriteButton(){
  const bar=document.querySelector('#outputPreviewModal .output-preview-bar>div');if(!bar)return;
  const week=Number($('weekSelect')?.value||0);
  const old4=bar.querySelector('.preview-google-write-week4'),old5=bar.querySelector('.preview-google-write-week5');
  if(old4)old4.style.display=week===4?'':'none';if(old5)old5.style.display=week===5?'':'none';
  let b=bar.querySelector('.preview-google-write-week6-35');
  if(week<6||week>35){if(b)b.remove();return;}
  if(!b){const close=bar.querySelector('.preview-close');b=document.createElement('button');b.type='button';b.className='preview-google-write-week6-35';b.onclick=exportSelectedWeek6To35ToGoogleSheet;bar.insertBefore(b,close||null);}
  b.textContent=`Ghi Tuần ${week} vào Google Sheet`;b.title=`BƯỚC 5.1.6 – ghi Tuần ${week} bằng cơ chế tổng quát, dùng tuần chuẩn gần nhất đã tồn tại làm mẫu`;
}
const openOutputPreviewBeforeWeek6To35Write=openOutputPreview;
openOutputPreview=function(){openOutputPreviewBeforeWeek6To35Write();ensureGoogleSheetsWeek6To35WriteButton();};
const previewBtnWeek6To35Write=document.getElementById('previewBtn');if(previewBtnWeek6To35Write)previewBtnWeek6To35Write.onclick=openOutputPreview;

// BƯỚC 5.2.2A - Mẫu định dạng độc lập + ghi/cập nhật Tuần 1–35.
// Tạo một tab mẫu ẩn từ bản giáo viên hiện tại (chỉ một lần), sau đó mọi tuần đều dùng
// khối Tuần 3 của tab mẫu ẩn. Vì vậy có thể làm sạch Tuần 1–35 ở tab giáo viên mà không mất mẫu.
const GOOGLE_SHEETS_TEMPLATE_NAME='_TKB_TEMPLATE_VO_THANH_DAM';
const GOOGLE_SHEETS_TEMPLATE_START_ROW=51;
async function ensureIndependentGoogleSheetTemplate(base,headers,meta){
  let tpl=(meta.sheets||[]).find(s=>googleSheetNameKey(s?.properties?.title)===googleSheetNameKey(GOOGLE_SHEETS_TEMPLATE_NAME));
  if(tpl)return tpl.properties;
  const teacher=(meta.sheets||[]).find(s=>Number(s?.properties?.sheetId)===GOOGLE_SHEETS_TEACHER_GID);
  if(!teacher)throw new Error('Không tìm thấy tab giáo viên để tạo mẫu định dạng độc lập.');
  const duplicate=await gsJson(`${base}:batchUpdate`,{method:'POST',headers,body:JSON.stringify({requests:[{duplicateSheet:{sourceSheetId:GOOGLE_SHEETS_TEACHER_GID,newSheetName:GOOGLE_SHEETS_TEMPLATE_NAME}}]})});
  const p=duplicate?.replies?.[0]?.duplicateSheet?.properties;
  if(!p?.sheetId)throw new Error('Không tạo được tab mẫu định dạng độc lập.');
  await gsJson(`${base}:batchUpdate`,{method:'POST',headers,body:JSON.stringify({requests:[{updateSheetProperties:{properties:{sheetId:p.sheetId,hidden:true},fields:'hidden'}}]})});
  return {...p,hidden:true};
}
async function exportSelectedWeek1To35ToGoogleSheet(){
  const week=Number($('weekSelect')?.value||0);
  const btn=document.querySelector('#outputPreviewModal .preview-google-write-week1-35'),old=btn?.textContent;
  try{
    if(!Number.isInteger(week)||week<1||week>35)throw new Error('Chỉ hỗ trợ Tuần 1–35.');
    const startRow=8+(week-1)*22,endRow=startRow+21;
    const data=outputScheduleData().map(x=>({...x}));
    if(!data.length)throw new Error(`Tuần ${week} không có tiết dạy để ghi.`);
    const slotMap=new Map();
    for(const x of data){const slot=`${clean(x.thu)}|${normKey(x.buoi)}|${Number(x.tiet)||0}`;if(slotMap.has(slot)){const a=slotMap.get(slot);throw new Error(`DỪNG GHI: trùng vị trí Thứ ${x.thu} - ${x.buoi} - Tiết ${x.tiet}: ${normalizeSubjectForPlan(a.monHoc)} ${a.lop} và ${normalizeSubjectForPlan(x.monHoc)} ${x.lop}.`);}slotMap.set(slot,x);}
    const noTitle=data.filter(x=>!clean(x.plan?.title));if(noTitle.length)throw new Error(`DỪNG GHI: còn ${noTitle.length} tiết chưa ghép tên bài Phụ lục 2.`);
    if(btn){btn.disabled=true;btn.textContent='Đang kiểm tra...';}
    const token=await getGoogleSheetsReadOnlyToken(),headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'},base=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(GOOGLE_SHEETS_SPREADSHEET_ID)}`;
    let meta=await gsJson(`${base}?fields=properties.title,sheets.properties(sheetId,title,hidden,gridProperties)`,{headers});
    const teacher=(meta.sheets||[]).find(s=>Number(s?.properties?.sheetId)===GOOGLE_SHEETS_TEACHER_GID);if(!teacher||googleSheetNameKey(teacher.properties.title)!==googleSheetNameKey(GOOGLE_SHEETS_TEACHER_NAME))throw new Error(`DỪNG GHI: không khớp tab ${GOOGLE_SHEETS_TEACHER_NAME} / GID ${GOOGLE_SHEETS_TEACHER_GID}.`);
    const title=teacher.properties.title,q=gsA1Title(title),maxRows=Number(teacher.properties?.gridProperties?.rowCount)||1000;
    if(maxRows<endRow)throw new Error(`Google Sheet chỉ có ${maxRows} dòng, chưa đủ để ghi Tuần ${week} đến dòng ${endRow}.`);
    const tpl=await ensureIndependentGoogleSheetTemplate(base,headers,meta);
    // BƯỚC 5.2.6: Tuần 1 là khối đặc biệt vì tiêu đề PHỤ LỤC 1.4 + 3 dòng tiêu đề tuần
    // đã nằm cố định ở hàng 4–7. Chỉ sao chép phần bảng từ mẫu (bỏ 3 dòng tiêu đề tuần)
    // vào hàng 8–26. Tuần 2–35 vẫn giữ nguyên cơ chế khối 22 dòng đã Đạt.
    const templateSheetId=Number(tpl.sheetId);
    const specialWeek1=week===1;
    const s0=(GOOGLE_SHEETS_TEMPLATE_START_ROW-1)+(specialWeek1?3:0);
    const s1=(GOOGLE_SHEETS_TEMPLATE_START_ROW-1)+22;
    const d0=startRow-1,d1=specialWeek1?26:endRow;
    const templateReadStart=GOOGLE_SHEETS_TEMPLATE_START_ROW+(specialWeek1?3:0);
    const templateReadEnd=GOOGLE_SHEETS_TEMPLATE_START_ROW+21;
    const tplData=await gsJson(`${base}?ranges=${encodeURIComponent(GOOGLE_SHEETS_TEMPLATE_NAME+`!A${templateReadStart}:H${templateReadEnd}`)}&includeGridData=true&fields=sheets(merges,data(rowMetadata(pixelSize)))`,{headers});
    const srcMerges=(tplData.sheets?.[0]?.merges||[]).filter(m=>m.startRowIndex>=s0&&m.endRowIndex<=s1&&m.startColumnIndex>=0&&m.endColumnIndex<=8),srcRowMeta=tplData.sheets?.[0]?.data?.[0]?.rowMetadata||[],offset=d0-s0;
    const scan=await gsJson(`${base}/values/${encodeURIComponent(q+`!A${startRow}:H${endRow}`)}?majorDimension=ROWS`,{headers});
    const exists=(scan.values||[]).some(r=>googleSheetWeekFromLine((r||[]).join(' '))===week);
    const action=exists?'CẬP NHẬT':'GHI';
    if(!confirm(`${action} TUẦN ${week} vào tab Võ Thanh Đậm?\n\nVùng dòng ${startRow}–${endRow}. Mẫu định dạng lấy từ tab mẫu ẩn, không phụ thuộc các tuần đang tồn tại.\nTKB tuần này hiện có ${data.length} tiết; tổng kể cả kiêm nhiệm: ${data.length+getConcurrentPeriods()}.`))return;
    if(btn)btn.textContent=`Đang ${action.toLowerCase()} Tuần ${week}...`;
    const requests=[{unmergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:d0,endRowIndex:d1,startColumnIndex:0,endColumnIndex:8}}},{copyPaste:{source:{sheetId:templateSheetId,startRowIndex:s0,endRowIndex:s1,startColumnIndex:0,endColumnIndex:8},destination:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:d0,endRowIndex:d1,startColumnIndex:0,endColumnIndex:8},pasteType:'PASTE_NORMAL',pasteOrientation:'NORMAL'}}];
    srcMerges.forEach(m=>requests.push({mergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:m.startRowIndex+offset,endRowIndex:m.endRowIndex+offset,startColumnIndex:m.startColumnIndex,endColumnIndex:m.endColumnIndex},mergeType:'MERGE_ALL'}}));
    srcRowMeta.forEach((rm,i)=>{if(rm?.pixelSize)requests.push({updateDimensionProperties:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,dimension:'ROWS',startIndex:d0+i,endIndex:d0+i+1},properties:{pixelSize:rm.pixelSize},fields:'pixelSize'}});});
    const scheduleStartIndex=specialWeek1?9:d0+5;
    const scheduleEndIndex=scheduleStartIndex+7;
    requests.push({repeatCell:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:scheduleStartIndex,endRowIndex:scheduleEndIndex,startColumnIndex:2,endColumnIndex:7},cell:{userEnteredFormat:{wrapStrategy:'WRAP'}},fields:'userEnteredFormat.wrapStrategy'}});
    requests.push({autoResizeDimensions:{dimensions:{sheetId:GOOGLE_SHEETS_TEACHER_GID,dimension:'ROWS',startIndex:scheduleStartIndex,endIndex:scheduleEndIndex}}});
    await gsJson(`${base}:batchUpdate`,{method:'POST',headers,body:JSON.stringify({requests})});
    // BƯỚC 5.2.11: khôi phục đúng hai cột bên trái của Phụ lục 1.4 cho mọi tuần.
    // Cột A = Buổi (Sáng/Chiều), cột B = Tiết; hàng trên cùng của hai cột là "Thời gian".
    // Chỉ tác động A:B trong phần lịch, không thay đổi dữ liệu bài học C:G hay phần Tổng hợp.
    const leftHeaderRow=specialWeek1?8:startRow+3;
    const leftSubHeaderRow=leftHeaderRow+1;
    const leftScheduleStart=leftHeaderRow+2;
    const leftScheduleEnd=leftScheduleStart+7;
    const leftReq=[
      {unmergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:leftHeaderRow-1,endRowIndex:leftScheduleEnd-1,startColumnIndex:0,endColumnIndex:2}}},
      {mergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:leftHeaderRow-1,endRowIndex:leftHeaderRow,startColumnIndex:0,endColumnIndex:2},mergeType:'MERGE_ALL'}},
      {mergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:leftScheduleStart-1,endRowIndex:leftScheduleStart+3,startColumnIndex:0,endColumnIndex:1},mergeType:'MERGE_ALL'}},
      {mergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:leftScheduleStart+3,endRowIndex:leftScheduleEnd-1,startColumnIndex:0,endColumnIndex:1},mergeType:'MERGE_ALL'}},
      {repeatCell:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:leftHeaderRow-1,endRowIndex:leftScheduleEnd-1,startColumnIndex:0,endColumnIndex:2},cell:{userEnteredFormat:{horizontalAlignment:'CENTER',verticalAlignment:'MIDDLE',wrapStrategy:'WRAP',textFormat:{fontFamily:'Times New Roman',fontSize:12}}},fields:'userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy,textFormat)'}},
      {repeatCell:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:leftHeaderRow-1,endRowIndex:leftSubHeaderRow,startColumnIndex:0,endColumnIndex:2},cell:{userEnteredFormat:{textFormat:{bold:true,fontFamily:'Times New Roman',fontSize:12}}},fields:'userEnteredFormat.textFormat'}},
      {repeatCell:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:leftScheduleStart-1,endRowIndex:leftScheduleEnd-1,startColumnIndex:0,endColumnIndex:2},cell:{userEnteredFormat:{borders:{top:{style:'SOLID'},bottom:{style:'SOLID'},left:{style:'SOLID'},right:{style:'SOLID'}}}},fields:'userEnteredFormat.borders'}}
    ];
    await gsJson(`${base}:batchUpdate`,{method:'POST',headers,body:JSON.stringify({requests:leftReq})});
    if(specialWeek1){
      // BƯỚC 5.2.8: dựng đúng khối cuối Tuần 1 như Xem trước.
      const sumReq=[
        {unmergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:17,endRowIndex:25,startColumnIndex:1,endColumnIndex:8}}},
        {mergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:17,endRowIndex:18,startColumnIndex:1,endColumnIndex:8},mergeType:'MERGE_ALL'}},
        {mergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:18,endRowIndex:19,startColumnIndex:1,endColumnIndex:8},mergeType:'MERGE_ALL'}}
      ];
      for(let rr=19;rr<25;rr++){
        sumReq.push({mergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:rr,endRowIndex:rr+1,startColumnIndex:2,endColumnIndex:4},mergeType:'MERGE_ALL'}});
        sumReq.push({mergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:rr,endRowIndex:rr+1,startColumnIndex:5,endColumnIndex:8},mergeType:'MERGE_ALL'}});
      }
      sumReq.push({repeatCell:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:17,endRowIndex:25,startColumnIndex:1,endColumnIndex:8},cell:{userEnteredFormat:{horizontalAlignment:'CENTER',verticalAlignment:'MIDDLE',wrapStrategy:'WRAP',textFormat:{fontFamily:'Times New Roman',fontSize:12}}},fields:'userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy,textFormat)'}});
      sumReq.push({repeatCell:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:19,endRowIndex:25,startColumnIndex:1,endColumnIndex:8},cell:{userEnteredFormat:{borders:{top:{style:'SOLID'},bottom:{style:'SOLID'},left:{style:'SOLID'},right:{style:'SOLID'}}}},fields:'userEnteredFormat.borders'}});
      sumReq.push({repeatCell:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:17,endRowIndex:20,startColumnIndex:1,endColumnIndex:8},cell:{userEnteredFormat:{textFormat:{bold:true,fontFamily:'Times New Roman',fontSize:12}}},fields:'userEnteredFormat.textFormat'}});
      sumReq.push({repeatCell:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:24,endRowIndex:25,startColumnIndex:1,endColumnIndex:8},cell:{userEnteredFormat:{textFormat:{bold:true,fontFamily:'Times New Roman',fontSize:12}}},fields:'userEnteredFormat.textFormat'}});
      await gsJson(`${base}:batchUpdate`,{method:'POST',headers,body:JSON.stringify({requests:sumReq})});
    } else {
      // BƯỚC 5.2.10: chuẩn hóa phần cuối cho Tuần 2–35 theo đúng mẫu Tổng hợp đã Đạt của Tuần 1.
      // Mỗi khối tuần 22 dòng: r12 = Tổng số tiết dạy, r13 = TỔNG HỢP, r14 = tiêu đề, r15–r18 = chi tiết, r19 = Tổng số.
      const sr=startRow;
      const sumReq=[
        {unmergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:sr+11,endRowIndex:sr+20,startColumnIndex:1,endColumnIndex:8}}},
        {mergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:sr+11,endRowIndex:sr+12,startColumnIndex:1,endColumnIndex:8},mergeType:'MERGE_ALL'}},
        {mergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:sr+12,endRowIndex:sr+13,startColumnIndex:1,endColumnIndex:8},mergeType:'MERGE_ALL'}}
      ];
      for(let rr=sr+13;rr<sr+20;rr++){
        sumReq.push({mergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:rr,endRowIndex:rr+1,startColumnIndex:2,endColumnIndex:4},mergeType:'MERGE_ALL'}});
        sumReq.push({mergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:rr,endRowIndex:rr+1,startColumnIndex:5,endColumnIndex:8},mergeType:'MERGE_ALL'}});
      }
      sumReq.push({repeatCell:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:sr+11,endRowIndex:sr+20,startColumnIndex:1,endColumnIndex:8},cell:{userEnteredFormat:{horizontalAlignment:'CENTER',verticalAlignment:'MIDDLE',wrapStrategy:'WRAP',textFormat:{fontFamily:'Times New Roman',fontSize:12}}},fields:'userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy,textFormat)'}});
      sumReq.push({repeatCell:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:sr+13,endRowIndex:sr+20,startColumnIndex:1,endColumnIndex:8},cell:{userEnteredFormat:{borders:{top:{style:'SOLID'},bottom:{style:'SOLID'},left:{style:'SOLID'},right:{style:'SOLID'}}}},fields:'userEnteredFormat.borders'}});
      sumReq.push({repeatCell:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:sr+11,endRowIndex:sr+14,startColumnIndex:1,endColumnIndex:8},cell:{userEnteredFormat:{textFormat:{bold:true,fontFamily:'Times New Roman',fontSize:12}}},fields:'userEnteredFormat.textFormat'}});
      sumReq.push({repeatCell:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:sr+19,endRowIndex:sr+20,startColumnIndex:1,endColumnIndex:8},cell:{userEnteredFormat:{textFormat:{bold:true,fontFamily:'Times New Roman',fontSize:12}}},fields:'userEnteredFormat.textFormat'}});
      await gsJson(`${base}:batchUpdate`,{method:'POST',headers,body:JSON.stringify({requests:sumReq})});
    }
    // Tuần 1: giữ nguyên PHỤ LỤC 1.4 ở hàng 4 và ghi lại đúng 3 dòng tiêu đề hàng 5–7;
    // chỉ làm sạch bảng hàng 8–26. Tuần 2–35 giữ nguyên vùng 22 dòng.
    await gsJson(`${base}/values/${encodeURIComponent(q+`!A${specialWeek1?8:startRow}:H${specialWeek1?26:endRow}`)}:clear`,{method:'POST',headers,body:'{}'});
    // BƯỚC 5.2.7: Tuần 1 có tiêu đề cố định ở hàng 5–7 do mẫu đã sao chép.
    // Xóa riêng các ô mép trái từng bị ghi dư và dòng Tổng số dư bên dưới bảng tổng hợp.
    if(specialWeek1){
      await gsJson(`${base}/values/${encodeURIComponent(q+'!A5:A7')}:clear`,{method:'POST',headers,body:'{}'});
      await gsJson(`${base}/values/${encodeURIComponent(q+'!A27:H27')}:clear`,{method:'POST',headers,body:'{}'});
    }
    let weekRows=gsWeekRows(data,week,startRow);
    if(specialWeek1){
      const wd=selectedWeekDates();
      weekRows=weekRows.map(x=>{
        const m=String(x.range).match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);if(!m)return x;
        const row=Number(m[2]);
        // Các dòng bảng của mẫu chuẩn dịch lên 3 hàng; ba dòng tiêu đề được ghi riêng ở 5–7.
        if(row>=startRow+3)return {...x,range:String(x.range).replace(/(\d+)/g,n=>String(Number(n)-3))};
        return null;
      }).filter(Boolean);
      // BƯỚC 5.2.8: Tuần 1 có phần cuối riêng. Chỉ giữ dữ liệu lịch ở hàng 8–16;
      // phần Tổng số/TỔNG HỢP sẽ dựng chuẩn riêng ở hàng 18–25 bên dưới.
      weekRows=weekRows.filter(x=>{
        const m=String(x.range).match(/^[A-Z]+(\d+)/);
        return !m || Number(m[1])<18;
      });
      weekRows.unshift(
        {range:'B6',values:[['Năm học 2026 – 2027. Môn: Tin học, Công nghệ, Đạo đức – Khối: 3, 4, 5 – Trường TH – THCS & THPT Lại Sơn']]}
      );
      const counts={'Công nghệ':0,'Tin học':0,'Đạo đức':0};
      data.forEach(x=>{
        const k=normKey(normalizeSubjectForPlan(x?.monHoc||x?.plan?.subject||'')).replace(/[^a-z0-9]+/g,'');
        if(k.includes('congnghe')||k==='cn'||k==='cnghe')counts['Công nghệ']++;
        else if(k.includes('tinhoc')||k==='th')counts['Tin học']++;
        else if(k.includes('daoduc')||k==='dd')counts['Đạo đức']++;
      });
      const concurrent=getConcurrentPeriods();
      weekRows.push(
        {range:'B18',values:[[`Tổng số: ${data.length} tiết`]]},
        {range:'B19',values:[['TỔNG HỢP']]},
        {range:'B20:H20',values:[['TT','Nội dung','','Số lượng tiết học','Ghi chú','','']]},
        {range:'B21:H24',values:[
          [1,'Tin học','',counts['Tin học'],'','',''],
          [2,'Công nghệ','',counts['Công nghệ'],'','',''],
          [3,'Kiêm nhiệm','',concurrent,'','',''],
          [4,'Đạo đức','',counts['Đạo đức'],'','','']
        ]},
        {range:'B25:H25',values:[['','Tổng số','',data.length+concurrent,'','','']]}
      );
    }
    if(!specialWeek1){
      const counts={'Công nghệ':0,'Tin học':0,'Đạo đức':0};
      data.forEach(x=>{
        const k=normKey(normalizeSubjectForPlan(x?.monHoc||x?.plan?.subject||'')).replace(/[^a-z0-9]+/g,'');
        if(k.includes('congnghe')||k==='cn'||k==='cnghe')counts['Công nghệ']++;
        else if(k.includes('tinhoc')||k==='th')counts['Tin học']++;
        else if(k.includes('daoduc')||k==='dd')counts['Đạo đức']++;
      });
      const concurrent=getConcurrentPeriods(),r=n=>startRow+n;
      // Loại các dòng tổng hợp cũ do gsWeekRows tạo, rồi ghi lại một cấu trúc thống nhất cho Tuần 2–35.
      weekRows=weekRows.filter(x=>{const m=String(x.range).match(/^[A-Z]+(\d+)/);return !m||Number(m[1])<r(12);});
      weekRows.push(
        {range:`B${r(12)}`,values:[[`Tổng số: ${data.length} tiết`]]},
        {range:`B${r(13)}`,values:[['TỔNG HỢP']]},
        {range:`B${r(14)}:H${r(14)}`,values:[['TT','Nội dung','','Số lượng tiết học','Ghi chú','','']]},
        {range:`B${r(15)}:H${r(18)}`,values:[
          [1,'Tin học','',counts['Tin học'],'','',''],
          [2,'Công nghệ','',counts['Công nghệ'],'','',''],
          [3,'Kiêm nhiệm','',concurrent,'','',''],
          [4,'Đạo đức','',counts['Đạo đức'],'','','']
        ]},
        {range:`B${r(19)}:H${r(19)}`,values:[['','Tổng số','',data.length+concurrent,'','','']]}
      );
    }
    // BƯỚC 5.2.11: ghi lại nhãn Thời gian/Buổi, Sáng/Chiều và số Tiết sau mọi phép dịch hàng của Tuần 1.
    weekRows.push(
      {range:`A${leftHeaderRow}:B${leftHeaderRow}`,values:[['Thời gian','']]},
      {range:`A${leftSubHeaderRow}:B${leftSubHeaderRow}`,values:[['Buổi','Tiết']]},
      {range:`A${leftScheduleStart}`,values:[['Sáng']]},
      {range:`B${leftScheduleStart}:B${leftScheduleStart+3}`,values:[[1],[2],[3],[4]]},
      {range:`A${leftScheduleStart+4}`,values:[['Chiều']]},
      {range:`B${leftScheduleStart+4}:B${leftScheduleStart+6}`,values:[[1],[2],[3]]}
    );
    const payload=weekRows.map(x=>({range:`${q}!${x.range}`,majorDimension:'ROWS',values:x.values}));await gsJson(`${base}/values:batchUpdate`,{method:'POST',headers,body:JSON.stringify({valueInputOption:'USER_ENTERED',data:payload})});
    // BƯỚC 5.2.7: với Tuần 1, tiêu đề tuần nằm ở hàng 5–7, ngoài vùng A8:H29.
    // Đọc đúng vùng tiêu đề để xác minh, tránh báo thất bại giả sau khi Google Sheet đã ghi thành công.
    const verifyRange=specialWeek1?'A4:H27':`A${startRow}:H${endRow}`;
    const verify=await gsJson(`${base}/values/${encodeURIComponent(q+'!'+verifyRange)}?majorDimension=ROWS`,{headers}),rows=verify.values||[];
    if(!rows.some(r=>googleSheetWeekFromLine((r||[]).join(' '))===week))throw new Error(`Đã gửi lệnh nhưng chưa đọc lại được tiêu đề Tuần ${week}.`);
    const writtenSchedule=(specialWeek1?(rows.slice(6,13)||[]):(rows.slice(5,12)||[])).flat().map(clean).filter(Boolean).join('\n'),expectedTitles=[...new Set(data.map(x=>clean(x.plan?.title||'')).filter(Boolean))],missingTitles=expectedTitles.filter(t=>!writtenSchedule.includes(t));if(missingTitles.length)throw new Error(`Google Sheet còn thiếu tên bài: ${missingTitles.slice(0,3).join(' | ')}.`);
    alert(`${action} TUẦN ${week} THÀNH CÔNG\n\nVùng: dòng ${startRow}–${endRow}\nSố tiết theo TKB có hiệu lực: ${data.length}\nTổng kể cả kiêm nhiệm: ${data.length+getConcurrentPeriods()}\n\nMẫu định dạng đã độc lập với Tuần 1–35.`);
  }catch(err){console.error(`[TKB] 5.2.2A Tuần ${week}:`,err);alert(`CHƯA GHI ĐƯỢC TUẦN ${week||''}\n\n${err?.message||err}`);}finally{if(btn){btn.disabled=false;btn.textContent=old||`Ghi/Cập nhật Tuần ${week||1} vào Google Sheet`;}}
}
function ensureGoogleSheetsWeek1To35WriteButton(){
  const bar=document.querySelector('#outputPreviewModal .output-preview-bar>div');if(!bar)return;
  bar.querySelectorAll('.preview-google-write-week4,.preview-google-write-week5,.preview-google-write-week6-35').forEach(x=>x.remove());
  let b=bar.querySelector('.preview-google-write-week1-35'),week=Number($('weekSelect')?.value||1);
  if(!b){const close=bar.querySelector('.preview-close');b=document.createElement('button');b.type='button';b.className='preview-google-write-week1-35';b.onclick=exportSelectedWeek1To35ToGoogleSheet;bar.insertBefore(b,close||null);}
  b.textContent=`Ghi/Cập nhật Tuần ${week} vào Google Sheet`;b.title='BƯỚC 5.2.2A – ghi/cập nhật Tuần 1–35 bằng mẫu định dạng ẩn độc lập';
}
const openOutputPreviewBeforeWeek1To35Write=openOutputPreview;
openOutputPreview=function(){openOutputPreviewBeforeWeek1To35Write();ensureGoogleSheetsWeek1To35WriteButton();};
const previewBtnWeek1To35Write=document.getElementById('previewBtn');if(previewBtnWeek1To35Write)previewBtnWeek1To35Write.onclick=openOutputPreview;

// BƯỚC 5.2.9 - Làm mới sạch Tuần 1–35 trên Google Sheet.
// Xóa dữ liệu + merge + định dạng bảng trong A8:H777 của đúng tab giáo viên đã xác minh.
// Giữ nguyên phần đầu A1:H7, kích thước cột và tab mẫu ẩn; tuần nào ghi lại sẽ được dựng từ mẫu ẩn.
async function resetGoogleSheetWeeks1To35(){
  const btn=document.querySelector('#outputPreviewModal .preview-google-reset-weeks'),old=btn?.textContent;
  try{
    if(btn){btn.disabled=true;btn.textContent='Đang kiểm tra...';}
    const token=await getGoogleSheetsReadOnlyToken(),headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'},base=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(GOOGLE_SHEETS_SPREADSHEET_ID)}`;
    let meta=await gsJson(`${base}?fields=properties.title,sheets.properties(sheetId,title,hidden,gridProperties)`,{headers});
    const teacher=(meta.sheets||[]).find(s=>Number(s?.properties?.sheetId)===GOOGLE_SHEETS_TEACHER_GID);
    if(!teacher||googleSheetNameKey(teacher.properties.title)!==googleSheetNameKey(GOOGLE_SHEETS_TEACHER_NAME))throw new Error(`DỪNG LÀM MỚI: không khớp tab ${GOOGLE_SHEETS_TEACHER_NAME} / GID ${GOOGLE_SHEETS_TEACHER_GID}.`);
    const title=teacher.properties.title,q=gsA1Title(title),maxRows=Number(teacher.properties?.gridProperties?.rowCount)||0;
    if(maxRows<777)throw new Error(`Google Sheet hiện chỉ có ${maxRows} dòng. Cần ít nhất 777 dòng để quản lý đủ Tuần 1–35.`);
    const tpl=await ensureIndependentGoogleSheetTemplate(base,headers,meta);
    if(!tpl?.sheetId)throw new Error('Chưa bảo đảm được tab mẫu ẩn. App dừng trước khi xóa dữ liệu.');
    const ok1=confirm(`LÀM MỚI SẠCH TUẦN 1–35 trên tab ${title}?\n\nApp sẽ xóa dữ liệu, đường viền, màu nền và ô gộp của các bảng trong vùng A8:H777 trên CHÍNH tab này.\nPhần đầu A1:H7, kích thước cột và tab mẫu ẩn vẫn được giữ nguyên.\nCác tab giáo viên khác không bị tác động.`);
    if(!ok1)return;
    const ok2=confirm(`XÁC NHẬN LẦN CUỐI\n\nToàn bộ dữ liệu Tuần 1–35 hiện có trên tab ${title} sẽ bị xóa để ghi lại từ Tuần 1.\n\nChọn OK để thực hiện.`);
    if(!ok2)return;
    if(btn)btn.textContent='Đang làm mới sạch Tuần 1–35...';
    // Xóa giá trị trước, sau đó bỏ toàn bộ merge và định dạng bảng trong vùng tuần.
    // Không đụng A1:H7 và không đổi chiều rộng cột; tab mẫu ẩn vẫn là nguồn dựng lại từng tuần.
    await gsJson(`${base}/values/${encodeURIComponent(q+'!A8:H777')}:clear`,{method:'POST',headers,body:'{}'});
    await gsJson(`${base}:batchUpdate`,{method:'POST',headers,body:JSON.stringify({requests:[
      {unmergeCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:7,endRowIndex:777,startColumnIndex:0,endColumnIndex:8}}},
      {repeatCell:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:7,endRowIndex:777,startColumnIndex:0,endColumnIndex:8},cell:{userEnteredFormat:{}},fields:'userEnteredFormat'}},
      {updateCells:{range:{sheetId:GOOGLE_SHEETS_TEACHER_GID,startRowIndex:7,endRowIndex:777,startColumnIndex:0,endColumnIndex:8},rows:[],fields:'note,dataValidation'}}
    ]})});
    const verify=await gsJson(`${base}/values/${encodeURIComponent(q+'!A8:H777')}?majorDimension=ROWS`,{headers});
    const remain=[];(verify.values||[]).forEach((r,i)=>{const w=googleSheetWeekFromLine((r||[]).join(' '));if(w!==null)remain.push({week:w,row:8+i});});
    if(remain.length)throw new Error(`Đã gửi lệnh làm mới nhưng vẫn còn nhận diện tuần tại dòng ${remain.slice(0,3).map(x=>x.row).join(', ')}.`);
    alert(`LÀM MỚI SẠCH TUẦN 1–35 THÀNH CÔNG\n\nTab: ${title}\nVùng đã làm sạch hoàn toàn: A8:H777\nĐã xóa các bảng/đường viền/merge thừa.\nPhần đầu A1:H7 và tab mẫu ẩn vẫn được giữ nguyên.\n\nBây giờ hãy chọn Tuần 1 → Xem trước → Ghi/Cập nhật Tuần 1 vào Google Sheet.`);
  }catch(err){console.error('[TKB] 5.2.4 Làm mới Tuần 1–35:',err);alert(`CHƯA LÀM MỚI GOOGLE SHEET\n\n${err?.message||err}\n\nKhông có lệnh ghi tuần nào được thực hiện.`);}finally{if(btn){btn.disabled=false;btn.textContent=old||'Làm mới Tuần 1–35';}}
}
function ensureGoogleSheetsResetWeeksButton(){
  const bar=document.querySelector('#outputPreviewModal .output-preview-bar>div');if(!bar)return;
  let b=bar.querySelector('.preview-google-reset-weeks');
  if(!b){const write=bar.querySelector('.preview-google-write-week1-35'),close=bar.querySelector('.preview-close');b=document.createElement('button');b.type='button';b.className='preview-google-reset-weeks';b.textContent='Làm mới Tuần 1–35';b.title='BƯỚC 5.2.9 – làm mới sạch Tuần 1–35: xóa dữ liệu và các bảng thừa, giữ phần đầu và mẫu ẩn';b.onclick=resetGoogleSheetWeeks1To35;bar.insertBefore(b,write||close||null);}
}
const openOutputPreviewBeforeResetWeeks=openOutputPreview;
openOutputPreview=function(){openOutputPreviewBeforeResetWeeks();ensureGoogleSheetsResetWeeksButton();};
const previewBtnResetWeeks=document.getElementById('previewBtn');if(previewBtnResetWeeks)previewBtnResetWeeks.onclick=openOutputPreview;
