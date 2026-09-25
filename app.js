"use strict";
const TEACHER = "Đậm";
// BƯỚC 5.6.1: giáo viên đang xem có thể đổi động theo TKB toàn trường.
let selectedTeacher = TEACHER;
let teacherCatalog = [TEACHER];
// BƯỚC 3.3 - Kho TKB + Phụ lục 2 + Lịch năm học: Supabase là nguồn dữ liệu chính; cache cục bộ được tách theo tài khoản.
const SUPABASE_URL = "https://ohmwphdeeldmlxuuknny.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_DgxnOXel9t7woqYrfInl5Q_YogcW--c";
let supabaseClient = null;
let currentAuthUser = null;
const TKB_SCHOOL_YEAR = "2026-2027";
let currentSchoolYearId = null;

async function ensureSupabaseSchoolYear() {
  if (!supabaseClient || !currentAuthUser)
    throw new Error("Bạn chưa đăng nhập giáo viên.");
  if (currentSchoolYearId) return currentSchoolYearId;
  const { data: found, error: findError } = await supabaseClient
    .from("tkb_school_years")
    .select("id")
    .eq("user_id", currentAuthUser.id)
    .eq("school_year", TKB_SCHOOL_YEAR)
    .limit(1);
  if (findError) throw findError;
  if (found && found.length) {
    currentSchoolYearId = found[0].id;
    return currentSchoolYearId;
  }
  const { data, error } = await supabaseClient
    .from("tkb_school_years")
    .insert({
      user_id: currentAuthUser.id,
      school_year: TKB_SCHOOL_YEAR,
      school_name: "Trường TH-THCS&THPT Lại Sơn",
      teacher_name: TEACHER,
    })
    .select("id")
    .single();
  if (error) throw error;
  currentSchoolYearId = data.id;
  return currentSchoolYearId;
}
function lessonToSupabaseRow(x, versionId, teacherName = TEACHER) {
  return {
    timetable_version_id: versionId,
    user_id: currentAuthUser.id,
    teacher_name: clean(teacherName) || TEACHER,
    thu: clean(x.thu),
    buoi: clean(x.buoi),
    tiet: Number(x.tiet) || null,
    thoi_gian: clean(x.thoiGian),
    lop: clean(x.lop),
    mon_hoc: clean(x.monHoc),
    diem_truong: clean(x.diemTruong),
    sheet_nguon: clean(x.sheetNguon),
    dong_nguon: Number(x.dongNguon) || null,
    cot_nguon: Number(x.cotNguon) || null,
    source_cell: clean(x.oNguon || x.sourceCell),
  };
}
async function saveTimetableVersionToSupabase(version) {
  if (!currentAuthUser)
    throw new Error("Hãy đăng nhập giáo viên trước khi lưu TKB lên Supabase.");
  const schoolYearId = await ensureSupabaseSchoolYear();
  const week = schoolCalendar.weeks.find(
    (w) => Number(w.week) === Number(version.startWeek),
  );
  const teacherEntries = Object.entries(version.lessonsByTeacher || {}).filter(
    ([teacherName, teacherLessons]) => clean(teacherName) && Array.isArray(teacherLessons),
  );
  const allTeacherRows = teacherEntries.length
    ? teacherEntries.flatMap(([teacherName, teacherLessons]) =>
        teacherLessons.map((x) => lessonToSupabaseRow(x, null, teacherName)),
      )
    : (version.lessons || []).map((x) => lessonToSupabaseRow(x, null, TEACHER));
  const payload = {
    school_year_id: schoolYearId,
    user_id: currentAuthUser.id,
    teacher_name: TEACHER,
    source_filename: version.file || "",
    effective_week: Number(version.startWeek),
    effective_date: week?.start || null,
    content_hash: version.fingerprint || scheduleFingerprint(version.lessons),
    lesson_count: allTeacherRows.length,
  };
  const { data, error } = await supabaseClient
    .from("tkb_timetable_versions")
    .insert(payload)
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505")
      throw new Error("TKB này đã tồn tại trên Supabase (trùng nội dung).");
    throw error;
  }
  const rows = allTeacherRows.map((x) => ({ ...x, timetable_version_id: data.id }));
  if (rows.length) {
    const { error: lessonError } = await supabaseClient
      .from("tkb_timetable_lessons")
      .insert(rows);
    if (lessonError) {
      await supabaseClient
        .from("tkb_timetable_versions")
        .delete()
        .eq("id", data.id);
      throw lessonError;
    }
  }
  version.supabaseId = data.id;
  version.syncedToSupabase = true;
  return data.id;
}
async function syncTimetableTeacherRowsToSupabase(version) {
  // BƯỚC 5.6.2B.9A.1: lưu THỰC SỰ toàn bộ lessonsByTeacher vào Supabase.
  // Không phụ thuộc việc phiên bản trong cache đã có supabaseId hay chưa.
  if (!currentAuthUser || !version?.lessonsByTeacher) return { rows: 0, teachers: 0 };

  let versionId = version.supabaseId || null;
  if (!versionId) {
    let q = supabaseClient
      .from("tkb_timetable_versions")
      .select("id")
      .eq("user_id", currentAuthUser.id);
    if (version.fingerprint) q = q.eq("content_hash", version.fingerprint);
    else {
      q = q.eq("source_filename", version.file || "")
        .eq("effective_week", Number(version.startWeek) || 1);
    }
    const { data: found, error: findError } = await q.order("created_at", { ascending: false }).limit(1);
    if (findError) throw findError;
    versionId = found?.[0]?.id || null;
    if (!versionId)
      throw new Error("Không tìm thấy phiên bản TKB trên Supabase để cập nhật dữ liệu đa giáo viên.");
    version.supabaseId = versionId;
  }

  const teacherEntries = Object.entries(version.lessonsByTeacher || {}).filter(
    ([teacherName, teacherLessons]) => clean(teacherName) && Array.isArray(teacherLessons) && teacherLessons.length,
  );
  const rows = teacherEntries.flatMap(([teacherName, teacherLessons]) =>
    teacherLessons.map((x) => lessonToSupabaseRow(x, versionId, teacherName)),
  );
  if (!rows.length) throw new Error("Không có tiết đa giáo viên để lưu lên Supabase.");

  const { error: deleteError } = await supabaseClient
    .from("tkb_timetable_lessons")
    .delete()
    .eq("timetable_version_id", versionId)
    .eq("user_id", currentAuthUser.id);
  if (deleteError) throw deleteError;

  // Chia lô để tránh một request quá lớn khi TKB toàn trường có nhiều giáo viên.
  const CHUNK = 300;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error: insertError } = await supabaseClient
      .from("tkb_timetable_lessons")
      .insert(rows.slice(i, i + CHUNK));
    if (insertError) throw insertError;
  }

  // Xác minh ngay sau khi ghi: không báo thành công nếu teacher_name chưa thực sự vào DB.
  const { data: verifyRows, error: verifyError } = await supabaseClient
    .from("tkb_timetable_lessons")
    .select("teacher_name")
    .eq("timetable_version_id", versionId)
    .eq("user_id", currentAuthUser.id)
    .not("teacher_name", "is", null);
  if (verifyError) throw verifyError;
  const savedTeachers = [...new Set((verifyRows || []).map((r) => clean(r.teacher_name)).filter(Boolean))];
  if (!savedTeachers.length)
    throw new Error("Supabase chưa ghi được teacher_name. Dữ liệu đa giáo viên chưa được lưu.");

  const { error: versionError } = await supabaseClient
    .from("tkb_timetable_versions")
    .update({ lesson_count: rows.length })
    .eq("id", versionId)
    .eq("user_id", currentAuthUser.id);
  if (versionError) throw versionError;

  version.syncedToSupabase = true;
  return { rows: rows.length, teachers: savedTeachers.length };
}

async function updateTimetableEffectiveWeekSupabase(version) {
  if (!currentAuthUser)
    throw new Error("Hãy đăng nhập giáo viên trước khi thay đổi hiệu lực TKB.");
  if (!version?.supabaseId)
    throw new Error(
      "Phiên bản TKB này chưa có mã Supabase. Hãy đăng nhập lại để tải Kho TKB từ Supabase.",
    );
  const week = schoolCalendar.weeks.find(
    (w) => Number(w.week) === Number(version.startWeek),
  );
  const { error } = await supabaseClient
    .from("tkb_timetable_versions")
    .update({
      effective_week: Number(version.startWeek),
      effective_date: week?.start || null,
    })
    .eq("id", version.supabaseId)
    .eq("user_id", currentAuthUser.id);
  if (error) throw error;
  version.effectiveDate = week?.start || null;
  version.syncedToSupabase = true;
}
async function deleteTimetableVersionSupabase(version) {
  if (!currentAuthUser)
    throw new Error("Hãy đăng nhập giáo viên trước khi xóa TKB.");
  if (!version?.supabaseId)
    throw new Error(
      "Phiên bản TKB này chưa có mã Supabase. Hãy đăng nhập lại để tải Kho TKB từ Supabase.",
    );
  const { error: lessonError } = await supabaseClient
    .from("tkb_timetable_lessons")
    .delete()
    .eq("timetable_version_id", version.supabaseId)
    .eq("user_id", currentAuthUser.id);
  if (lessonError) throw lessonError;
  const { error } = await supabaseClient
    .from("tkb_timetable_versions")
    .delete()
    .eq("id", version.supabaseId)
    .eq("user_id", currentAuthUser.id);
  if (error) throw error;
}
async function removeScheduleVersion(version) {
  await deleteTimetableVersionSupabase(version);
  const i = scheduleVersions.indexOf(version);
  if (i >= 0) scheduleVersions.splice(i, 1);
  saveScheduleRepository();
}

function canonicalAppendix2Records() {
  return [...lessonPlanMap.values()]
    .map((x) => ({
      subject: clean(x.subject),
      grade: Number(x.grade),
      week: Number(x.week),
      annualPeriod: Number(x.annualPeriod || 0),
      title: clean(x.title),
      duration: clean(x.duration),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function appendix2Fingerprint() {
  const str = JSON.stringify(canonicalAppendix2Records());
  let h1 = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h1 ^= str.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + ":" + str.length;
}
async function saveAppendix2ToSupabase(file) {
  if (!supabaseClient || !currentAuthUser)
    throw new Error(
      "Hãy đăng nhập giáo viên trước khi lưu Phụ lục 2 lên Supabase.",
    );
  const records = canonicalAppendix2Records();
  if (!records.length)
    throw new Error("Phụ lục 2 chưa có dòng kế hoạch hợp lệ để lưu.");
  const schoolYearId = await ensureSupabaseSchoolYear();
  const contentHash = appendix2Fingerprint();
  const subjects = new Set(records.map((x) => normKey(x.subject)));
  const payload = {
    school_year_id: schoolYearId,
    user_id: currentAuthUser.id,
    source_filename: file?.name || lessonPlanMeta.file || "Phụ lục 2",
    content_hash: contentHash,
    subject_count: subjects.size,
    lesson_count: records.length,
  };
  const { data, error } = await supabaseClient
    .from("tkb_appendix2_versions")
    .insert(payload)
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505")
      throw new Error(
        "Phụ lục 2 này đã tồn tại trên Supabase (trùng nội dung).",
      );
    throw error;
  }
  const rows = records.map((x) => ({
    appendix2_version_id: data.id,
    user_id: currentAuthUser.id,
    subject_name: x.subject,
    grade: x.grade,
    week_number: x.week,
    lesson_number: x.annualPeriod || null,
    lesson_title: x.title,
    duration_text: x.duration || null,
  }));
  const { error: lessonError } = await supabaseClient
    .from("tkb_appendix2_lessons")
    .insert(rows);
  if (lessonError) {
    await supabaseClient
      .from("tkb_appendix2_versions")
      .delete()
      .eq("id", data.id);
    throw lessonError;
  }
  lessonPlanMeta.supabaseId = data.id;
  lessonPlanMeta.contentHash = contentHash;
  lessonPlanMeta.syncedToSupabase = true;
  return {
    versionId: data.id,
    lessons: rows.length,
    subjects: subjects.size,
    contentHash,
  };
}

function supabaseLessonToAppRow(x) {
  return {
    thu: clean(x.thu),
    buoi: clean(x.buoi),
    tiet: Number(x.tiet) || "",
    thoiGian: clean(x.thoi_gian),
    lop: clean(x.lop),
    monHoc: clean(x.mon_hoc),
    diemTruong: clean(x.diem_truong),
    sheetNguon: clean(x.sheet_nguon),
    dongNguon: Number(x.dong_nguon) || 0,
    cotNguon: Number(x.cot_nguon) || 0,
    oNguon: clean(x.source_cell),
  };
}
async function restoreAppendix2FromSupabase() {
  if (!supabaseClient || !currentAuthUser)
    return { versions: 0, lessons: 0, subjects: 0 };
  const schoolYearId = await ensureSupabaseSchoolYear();
  const { data: versions, error: vErr } = await supabaseClient
    .from("tkb_appendix2_versions")
    .select(
      "id,source_filename,content_hash,subject_count,lesson_count,created_at",
    )
    .eq("user_id", currentAuthUser.id)
    .eq("school_year_id", schoolYearId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (vErr) throw vErr;
  const version = versions?.[0];
  if (!version) {
    // Đã đăng nhập thì Supabase là nguồn chính: tài khoản không có Phụ lục 2 phải hiển thị kho trống,
    // không được giữ dữ liệu Phụ lục 2 đã đọc/khôi phục từ tài khoản hoặc phiên trước.
    lessonPlanMap.clear();
    planSubjectCatalog.clear();
    lessonPlanMeta = { file: "", type: "", count: 0 };
    const info = $("pl2Info");
    if (info)
      info.textContent =
        "Chưa có Phụ lục 2 trong kho Supabase của tài khoản này.";
    applyLessonPlan();
    render();
    return { versions: 0, lessons: 0, subjects: 0 };
  }
  const { data: rows, error: lErr } = await supabaseClient
    .from("tkb_appendix2_lessons")
    .select(
      "subject_name,grade,week_number,lesson_number,lesson_title,duration_text",
    )
    .eq("user_id", currentAuthUser.id)
    .eq("appendix2_version_id", version.id)
    .order("grade", { ascending: true })
    .order("week_number", { ascending: true });
  if (lErr) throw lErr;
  lessonPlanMap.clear();
  planSubjectCatalog.clear();
  for (const x of rows || []) {
    const subject = registerPlanSubject(x.subject_name),
      grade = Number(x.grade),
      week = Number(x.week_number);
    if (!subject || !grade || !week || !clean(x.lesson_title)) continue;
    lessonPlanMap.set(planKey(subject, grade, week), {
      subject,
      grade,
      week,
      annualPeriod: Number(x.lesson_number) || week,
      title: clean(x.lesson_title),
      duration: clean(x.duration_text),
      integration: "",
      note: "",
      source: "Supabase",
    });
  }
  const subjects = new Set(
    [...lessonPlanMap.values()].map((x) => normKey(x.subject)),
  );
  lessonPlanMeta = {
    file: version.source_filename || "Phụ lục 2 từ Supabase",
    type: "supabase",
    count: lessonPlanMap.size,
    supabaseId: version.id,
    contentHash: version.content_hash || "",
    syncedToSupabase: true,
  };
  const info = $("pl2Info");
  if (info)
    info.innerHTML = `<b>${esc(lessonPlanMeta.file)}</b> · ${lessonPlanMap.size} dòng kế hoạch · ☁️ Khôi phục từ Supabase`;
  applyLessonPlan();
  render();
  console.info("[TKB] Đã khôi phục Phụ lục 2 từ Supabase", {
    version: version.id,
    lessons: lessonPlanMap.size,
    subjects: subjects.size,
  });
  return { versions: 1, lessons: lessonPlanMap.size, subjects: subjects.size };
}
async function listAppendix2VersionsFromSupabase() {
  if (!supabaseClient || !currentAuthUser)
    throw new Error("Hãy đăng nhập giáo viên để quản lý Kho Phụ lục 2.");
  const schoolYearId = await ensureSupabaseSchoolYear();
  const { data, error } = await supabaseClient
    .from("tkb_appendix2_versions")
    .select(
      "id,source_filename,content_hash,subject_count,lesson_count,created_at",
    )
    .eq("user_id", currentAuthUser.id)
    .eq("school_year_id", schoolYearId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}
async function loadAppendix2VersionFromSupabase(version) {
  const { data: rows, error } = await supabaseClient
    .from("tkb_appendix2_lessons")
    .select(
      "subject_name,grade,week_number,lesson_number,lesson_title,duration_text",
    )
    .eq("user_id", currentAuthUser.id)
    .eq("appendix2_version_id", version.id)
    .order("grade", { ascending: true })
    .order("week_number", { ascending: true });
  if (error) throw error;
  lessonPlanMap.clear();
  planSubjectCatalog.clear();
  for (const x of rows || []) {
    const subject = registerPlanSubject(x.subject_name),
      grade = Number(x.grade),
      week = Number(x.week_number);
    if (!subject || !grade || !week || !clean(x.lesson_title)) continue;
    lessonPlanMap.set(planKey(subject, grade, week), {
      subject,
      grade,
      week,
      annualPeriod: Number(x.lesson_number) || week,
      title: clean(x.lesson_title),
      duration: clean(x.duration_text),
      integration: "",
      note: "",
      source: "Supabase",
    });
  }
  lessonPlanMeta = {
    file: version.source_filename || "Phụ lục 2 từ Supabase",
    type: "supabase",
    count: lessonPlanMap.size,
    supabaseId: version.id,
    contentHash: version.content_hash || "",
    syncedToSupabase: true,
  };
  const info = $("pl2Info");
  if (info)
    info.innerHTML = `<b>${esc(lessonPlanMeta.file)}</b> · ${lessonPlanMap.size} dòng kế hoạch · ☁️ Khôi phục từ Supabase`;
  applyLessonPlan();
  render();
}
// BƯỚC 5.6.2 - Phụ lục 2 động theo giáo viên đang xem.
// Không gắn cứng tên giáo viên vào Phụ lục 2. Mỗi khi đổi giáo viên, ứng dụng
// lấy Môn + Khối từ TKB thực tế rồi chọn phiên bản PL2 trong kho có độ phủ cao nhất.
function teacherTeachingScope() {
  const out = [];
  const seen = new Set();
  for (const x of allLessons || []) {
    const subject = clean(x?.monHoc);
    const grade = gradeFromClass(x?.lop);
    if (!subject || !grade) continue;
    const aliases = [...subjectAliasKeys(subject)];
    const id = `${aliases.sort().join("|")}::${grade}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ subject, grade, aliases: new Set(aliases) });
  }
  return out;
}
function appendixSubjectMatchesScope(subject, grade, scope) {
  const g = Number(grade);
  const aliases = subjectAliasKeys(subject);
  return scope.some(
    (item) =>
      Number(item.grade) === g && [...aliases].some((k) => item.aliases.has(k)),
  );
}
async function autoLoadAppendix2ForSelectedTeacher() {
  if (!supabaseClient || !currentAuthUser) {
    applyLessonPlan();
    render();
    return;
  }
  const scope = teacherTeachingScope();
  if (!scope.length) {
    lessonPlanMap.clear();
    planSubjectCatalog.clear();
    lessonPlanMeta = { file: "", type: "", count: 0 };
    const info = $("pl2Info");
    if (info)
      info.textContent = `Giáo viên ${selectedTeacher} chưa có tiết dạy trong TKB đang chọn.`;
    render();
    return;
  }
  try {
    const versions = await listAppendix2VersionsFromSupabase();
    let best = null;
    for (const version of versions) {
      const { data: rows, error } = await supabaseClient
        .from("tkb_appendix2_lessons")
        .select("subject_name,grade")
        .eq("user_id", currentAuthUser.id)
        .eq("appendix2_version_id", version.id);
      if (error) throw error;
      const covered = new Set();
      for (const row of rows || []) {
        scope.forEach((item, i) => {
          if (Number(item.grade) !== Number(row.grade)) return;
          const aliases = subjectAliasKeys(row.subject_name);
          if ([...aliases].some((k) => item.aliases.has(k))) covered.add(i);
        });
      }
      const score = covered.size;
      if (!best || score > best.score) best = { version, score };
    }
    if (!best || best.score <= 0) {
      lessonPlanMap.clear();
      planSubjectCatalog.clear();
      lessonPlanMeta = { file: "", type: "", count: 0 };
      const subjects = scope.map((x) => `${x.subject} K${x.grade}`).join(", ");
      const info = $("pl2Info");
      if (info)
        info.innerHTML = `<b>${esc(selectedTeacher)}</b> · Chưa có Phụ lục 2 phù hợp trong kho cho: ${esc(subjects)}`;
      render();
      return;
    }
    await loadAppendix2VersionFromSupabase(best.version);
    const info = $("pl2Info");
    if (info)
      info.innerHTML += ` · <b>GV: ${esc(selectedTeacher)}</b> · khớp ${best.score}/${scope.length} nhóm Môn + Khối`;
  } catch (err) {
    console.error("[TKB] Không tự chọn được Phụ lục 2 theo giáo viên", err);
    const info = $("pl2Info");
    if (info)
      info.innerHTML += ` · ⚠ Chưa tự chọn được PL2 cho ${esc(selectedTeacher)}`;
  }
}

// BƯỚC 5.6.2B.2 - CHỈ ĐỌC THỬ kho PPCT chung tKB_curriculum.
// Không ghi/xóa dữ liệu, không thay lessonPlanMap và không thay cơ chế Phụ lục 2 hiện tại.
function curriculumBaseSubject(code) {
  return clean(code).replace(/\s+(?:\d+|[A-Z])$/iu, "").trim();
}
// BƯỚC 5.6.2B.3A - So khớp môn CHẶT cho kho PPCT chung.
// Không dùng initials/noConnectors của subjectAliasKeys vì các khóa 1 ký tự
// (ví dụ "t", "c") có thể làm nhiều môn khác nhau khớp giả.
function curriculumSubjectKey(value) {
  const compact = normKey(clean(value)).replace(/[^a-z0-9]+/g, "");
  const aliases = {
    th: "tinhoc", tinhoc: "tinhoc",
    cn: "congnghe", cnghe: "congnghe", congnghe: "congnghe",
    dd: "daoduc", daoduc: "daoduc",
    tv: "tiengviet", tviet: "tiengviet", tiengviet: "tiengviet",
    tnxh: "tnxh", tnvxh: "tnxh", tunhienxahoi: "tnxh", tunhienvaxahoi: "tnxh",
    lsdl: "lsdl", lsvdl: "lsdl", lichsudialy: "lsdl", lichsuvadialy: "lsdl",
    mt: "mythuat", mythuat: "mythuat", mithuat: "mythuat",
    an: "amnhac", amnhac: "amnhac",
    td: "gdtc", gdtc: "gdtc", theduc: "gdtc", giaoducthechat: "gdtc",
    toan: "toan", khoahoc: "khoahoc",
    tienganh: "tienganh", av: "tienganh",
    ltt: "ltt", lttv: "lttv",
    // Hoạt động trải nghiệm trong kho PPCT được tách thành 3 mạch:
    // HĐGDCĐ (Hoạt động giáo dục theo chủ đề), SHDC, SHL.
    // TKB ghi chung HĐTN được hiểu là tiết HĐGDCĐ; các nhãn sinh hoạt được giữ riêng.
    hdtn: "hdgdcd", hoatdongtrainghiem: "hdgdcd", hdgdcd: "hdgdcd",
    shdc: "shdc", sinhhoatduoico: "shdc",
    shl: "shl", shlop: "shl", sinhhoatlop: "shl",
  };
  return aliases[compact] || compact;
}
function curriculumSubjectMatches(subject, subjectCode) {
  const a = curriculumSubjectKey(subject);
  const b = curriculumSubjectKey(curriculumBaseSubject(subjectCode));
  return !!a && !!b && a === b;
}
// BƯỚC 5.6.2B.4 - Kho PPCT chung chỉ cấp tên bài cho cửa sổ Xem trước.
// Không ghi đè lessonPlanMap/Phụ lục 2 và chưa thay dữ liệu của Excel/PDF/In/Google Sheet.
async function sharedCurriculumPreviewData() {
  const week = Number($("weekSelect")?.value || 1);
  const source = filterSchedule();
  if (!source.length) return [];
  if (!supabaseClient) throw new Error("Supabase chưa sẵn sàng.");
  const grades = [...new Set(source.map((x) => gradeFromClass(x.lop)).filter(Boolean))];
  let q = supabaseClient
    .from("tkb_curriculum")
    .select("week,ppct,subject_code,grade,lesson_name,stem")
    .eq("week", week)
    .order("grade", { ascending: true })
    .order("subject_code", { ascending: true })
    .order("ppct", { ascending: true });
  if (grades.length) q = q.in("grade", grades);
  const { data, error } = await q;
  if (error) throw error;
  const rows = data || [];
  const edits = loadOutputEdits();
  return source.map((x) => {
    const e = edits[outputLessonId(x)];
    if (e?.deleted) return null;
    const y = { ...x };
    if (e?.monHoc !== undefined) y.monHoc = e.monHoc;
    if (e?.lop !== undefined) y.lop = e.lop;
    const grade = gradeFromClass(y.lop);
    const hit = rows.find(
      (r) => Number(r.grade) === Number(grade) && curriculumSubjectMatches(y.monHoc, r.subject_code),
    );
    const curriculumPlan = hit
      ? {
          subject: curriculumBaseSubject(hit.subject_code),
          grade,
          week,
          annualPeriod: hit.ppct ?? "",
          title: clean(hit.lesson_name),
          duration: "",
          integration: clean(hit.stem),
          note: "",
          source: "Kho PPCT chung",
        }
      : null;
    // Điều chỉnh thủ công trong Xem trước vẫn có quyền ưu tiên cao nhất.
    if (e?.title !== undefined) {
      y.plan = {
        ...(curriculumPlan || {}),
        title: e.title,
        annualPeriod: e.annualPeriod !== undefined ? e.annualPeriod : curriculumPlan?.annualPeriod || "",
        week,
        subject: normalizeSubjectForPlan(y.monHoc),
        grade,
      };
    } else y.plan = curriculumPlan;
    y.planWeek = week;
    y.planSubject = normalizeSubjectForPlan(y.monHoc);
    y.planGrade = grade;
    return y;
  }).filter(Boolean);
}

async function probeSharedCurriculum() {
  const status = $("curriculumProbeStatus");
  const btn = $("curriculumProbeBtn");
  if (!status || !btn) return;
  if (!supabaseClient) {
    status.textContent = "Supabase chưa sẵn sàng. Hãy chờ kết nối rồi thử lại.";
    return;
  }
  const week = Number($("weekSelect")?.value || 1);
  const scope = teacherTeachingScope();
  if (!scope.length) {
    status.textContent = `Giáo viên ${selectedTeacher} chưa có tiết trong TKB Tuần ${week}.`;
    return;
  }
  const grades = [...new Set(scope.map((x) => Number(x.grade)).filter(Boolean))];
  btn.disabled = true;
  status.textContent = `Đang đọc thử tKB_curriculum · ${selectedTeacher} · Tuần ${week}...`;
  try {
    let q = supabaseClient
      .from("tkb_curriculum")
      .select("week,ppct,subject_code,grade,lesson_name,stem")
      .eq("week", week)
      .order("grade", { ascending: true })
      .order("subject_code", { ascending: true })
      .order("ppct", { ascending: true });
    if (grades.length) q = q.in("grade", grades);
    const { data, error } = await q;
    if (error) throw error;
    const rows = data || [];
    const results = scope.map((item) => {
      const hits = rows.filter(
        (r) => Number(r.grade) === Number(item.grade) && curriculumSubjectMatches(item.subject, r.subject_code),
      );
      return { item, hits };
    });
    const matched = results.filter((x) => x.hits.length).length;
    const chips = results
      .map(({ item, hits }) => {
        const sample = hits[0]?.lesson_name ? ` · ${hits[0].lesson_name}` : "";
        return `<span class="pl2-chip ${hits.length ? "" : "curriculum-miss"}">${esc(item.subject)} K${item.grade}: <b>${hits.length}</b>${hits.length ? esc(sample) : " · chưa khớp mã môn"}</span>`;
      })
      .join("");
    status.innerHTML = `<b>PPCT chung · ${esc(selectedTeacher)} · Tuần ${week}: khớp ${matched}/${results.length} nhóm Môn + Khối</b><div class="pl2-details">${chips}</div><small>Chỉ kiểm tra đọc dữ liệu; Phụ lục 2 hiện tại chưa bị thay đổi.</small>`;
  } catch (err) {
    console.error("[TKB] Lỗi đọc thử tKB_curriculum", err);
    status.innerHTML = `<b>⚠ Chưa đọc được tKB_curriculum.</b> ${esc(err?.message || err)}<div><small>Không có thay đổi nào đối với TKB hoặc Phụ lục 2 hiện tại.</small></div>`;
  } finally {
    btn.disabled = false;
  }
}

async function openAppendix2RepoManager() {
  if (!currentAuthUser)
    return alert("Hãy đăng nhập giáo viên trước khi mở Kho Phụ lục 2.");
  let versions;
  try {
    versions = await listAppendix2VersionsFromSupabase();
  } catch (e) {
    console.error(e);
    return alert("Không đọc được Kho Phụ lục 2: " + (e.message || e));
  }
  const rows = versions
    .map(
      (v, i) =>
        `<tr><td>${i + 1}</td><td class="manage-file">${esc(v.source_filename || "Phụ lục 2")}</td><td>${Number(v.subject_count) || 0}</td><td>${Number(v.lesson_count) || 0}</td><td>${esc(v.created_at ? new Date(v.created_at).toLocaleString("vi-VN") : "")}</td><td><div class="appendix2-row-actions"><button type="button" class="secondary-action" data-pl2-use="${esc(v.id)}">SỬ DỤNG</button><button type="button" class="danger-action" data-pl2-delete="${esc(v.id)}">XÓA</button></div></td></tr>`,
    )
    .join("");
  const m = modalShell(
    "KHO PHỤ LỤC 2",
    `<p class="manage-note">Kho Supabase của tài khoản đang đăng nhập. Có thể chọn một phiên bản để sử dụng hoặc xóa phiên bản không còn cần thiết. Xóa phiên bản sẽ xóa luôn các dòng kế hoạch thuộc phiên bản đó.</p><div class="manage-scroll"><table class="manage-table"><thead><tr><th>TT</th><th>File Phụ lục 2</th><th>Số môn</th><th>Số dòng</th><th>Thời điểm lưu</th><th>Thao tác</th></tr></thead><tbody>${rows || '<tr><td colspan="6">Kho Phụ lục 2 đang trống.</td></tr>'}</tbody></table></div>`,
  );
  m.querySelectorAll("[data-pl2-use]").forEach(
    (btn) =>
      (btn.onclick = async () => {
        const v = versions.find((x) => x.id === btn.dataset.pl2Use);
        if (!v) return;
        btn.disabled = true;
        btn.textContent = "ĐANG TẢI...";
        try {
          await loadAppendix2VersionFromSupabase(v);
          m.remove();
          alert(
            `Đã sử dụng Phụ lục 2: ${v.source_filename || "Phụ lục 2"} (${v.subject_count || 0} môn, ${v.lesson_count || 0} dòng kế hoạch).`,
          );
        } catch (e) {
          btn.disabled = false;
          btn.textContent = "SỬ DỤNG";
          alert("Không tải được phiên bản Phụ lục 2: " + (e.message || e));
        }
      }),
  );
  m.querySelectorAll("[data-pl2-delete]").forEach(
    (btn) =>
      (btn.onclick = async () => {
        const v = versions.find((x) => x.id === btn.dataset.pl2Delete);
        if (!v) return;
        if (
          !confirm(
            `Xóa phiên bản Phụ lục 2 này?\n\n${v.source_filename || "Phụ lục 2"}\n${v.subject_count || 0} môn · ${v.lesson_count || 0} dòng kế hoạch\n\nCác dòng chi tiết của phiên bản cũng sẽ bị xóa.`,
          )
        )
          return;
        btn.disabled = true;
        btn.textContent = "ĐANG XÓA...";
        try {
          const { error } = await supabaseClient
            .from("tkb_appendix2_versions")
            .delete()
            .eq("id", v.id)
            .eq("user_id", currentAuthUser.id);
          if (error) throw error;
          const deletingCurrent = lessonPlanMeta.supabaseId === v.id;
          m.remove();
          if (deletingCurrent) {
            lessonPlanMap.clear();
            planSubjectCatalog.clear();
            lessonPlanMeta = { file: "", type: "", count: 0 };
            const r = await restoreAppendix2FromSupabase();
            if (!r.versions) {
              const info = $("pl2Info");
              if (info) info.textContent = "Chưa có Phụ lục 2 trong kho.";
              applyLessonPlan();
              render();
            }
          }
          alert("Đã xóa phiên bản Phụ lục 2 khỏi Supabase.");
          openAppendix2RepoManager();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = "XÓA";
          alert("Không xóa được phiên bản Phụ lục 2: " + (e.message || e));
        }
      }),
  );
}

function restoredVersionMeta(version, lessons) {
  const sheets = [...new Set(lessons.map((x) => x.sheetNguon).filter(Boolean))];
  const counts = {};
  sheets.forEach(
    (s) => (counts[s] = lessons.filter((x) => x.sheetNguon === s).length),
  );
  return {
    startWeek: Number(version.effective_week) || 1,
    uploadedAt: version.created_at || "",
    uploadedAtLabel: version.created_at
      ? new Date(version.created_at).toLocaleString("vi-VN")
      : "",
    fingerprint: version.content_hash || scheduleFingerprint(lessons),
    file: version.source_filename || "TKB từ Supabase",
    sheets,
    counts,
    errors: [],
    lessons,
    supabaseId: version.id,
    syncedToSupabase: true,
    effectiveDate: version.effective_date || null,
  };
}
async function restoreScheduleRepositoryFromSupabase() {
  if (!supabaseClient || !currentAuthUser) return { versions: 0, lessons: 0 };
  const schoolYearId = await ensureSupabaseSchoolYear();
  const { data: versions, error: vErr } = await supabaseClient
    .from("tkb_timetable_versions")
    .select(
      "id,source_filename,effective_week,effective_date,content_hash,lesson_count,created_at",
    )
    .eq("user_id", currentAuthUser.id)
    .eq("school_year_id", schoolYearId)
    .order("effective_week", { ascending: true })
    .order("created_at", { ascending: true });
  if (vErr) throw vErr;
  if (!versions?.length) {
    // Khi đã đăng nhập, Supabase là nguồn chính. Tài khoản không có TKB thì phải hiển thị kho trống,
    // không được giữ/khôi phục dữ liệu localStorage của máy hoặc tài khoản trước.
    scheduleVersions.splice(0, scheduleVersions.length);
    saveScheduleRepository();
    activateSelectedWeek();
    const status = $("supabaseStatus");
    if (status)
      status.textContent =
        "☁️ Supabase: ĐÃ KẾT NỐI • Đã đăng nhập • Kho TKB đang trống";
    return { versions: 0, lessons: 0 };
  }
  const ids = versions.map((v) => v.id);
  const { data: rows, error: lErr } = await supabaseClient
    .from("tkb_timetable_lessons")
    .select("*")
    .eq("user_id", currentAuthUser.id)
    .in("timetable_version_id", ids)
    .order("created_at", { ascending: true });
  if (lErr) throw lErr;
  const byVersion = new Map();
  const byVersionTeacher = new Map();
  (rows || []).forEach((r) => {
    if (!byVersion.has(r.timetable_version_id)) byVersion.set(r.timetable_version_id, []);
    const appRow = supabaseLessonToAppRow(r);
    const teacherName = clean(r.teacher_name) || TEACHER;
    if (normalizeTeacherName(teacherName) === normalizeTeacherName(TEACHER))
      byVersion.get(r.timetable_version_id).push(appRow);
    if (!byVersionTeacher.has(r.timetable_version_id)) byVersionTeacher.set(r.timetable_version_id, {});
    const teacherMap = byVersionTeacher.get(r.timetable_version_id);
    if (!teacherMap[teacherName]) teacherMap[teacherName] = [];
    teacherMap[teacherName].push(appRow);
  });
  const restored = versions
    .map((v) => {
      const teacherMap = byVersionTeacher.get(v.id) || {};
      const fallback = byVersion.get(v.id) || Object.values(teacherMap)[0] || [];
      const item = restoredVersionMeta(v, fallback);
      item.lessonsByTeacher = teacherMap;
      item.teachers = Object.keys(teacherMap);
      return item;
    })
    .filter((v) => v.lessons.length || Object.keys(v.lessonsByTeacher || {}).length);
  const restoredTeachers = [...new Set(restored.flatMap((v) => v.teachers || []))];
  if (restoredTeachers.length) updateTeacherSelector(restoredTeachers);
  // Supabase là nguồn lâu dài sau khi đăng nhập; localStorage được cập nhật lại làm bản dự phòng.
  scheduleVersions.splice(0, scheduleVersions.length, ...restored);
  loadHomeroomTeacherMap();
  enrichAllScheduleVersionsWithHomeroom();
  scheduleVersions.sort(
    (a, b) =>
      a.startWeek - b.startWeek ||
      String(a.uploadedAt || "").localeCompare(String(b.uploadedAt || "")),
  );
  saveScheduleRepository();
  activateSelectedWeek();
  const total = restored.reduce((n, v) => n + v.lessons.length, 0);
  const status = $("supabaseStatus");
  if (status)
    status.textContent = `☁️ Supabase: ĐÃ KẾT NỐI • Đã đăng nhập • Đã tải ${restored.length} TKB / ${total} tiết`;
  console.info("[TKB] Đã khôi phục Kho TKB từ Supabase", {
    versions: restored.length,
    lessons: total,
  });
  return { versions: restored.length, lessons: total };
}
async function restoreAfterLogin(showMessage = false) {
  try {
    const calendarResult = await restoreSchoolCalendarFromSupabase();
    const r = await restoreScheduleRepositoryFromSupabase();
    const appendix2Result = await restoreAppendix2FromSupabase();
    restoreOutputSettings();
    activateSelectedWeek();
    if (showMessage) {
      const parts = [];
      if (calendarResult.weeks)
        parts.push(`Lịch năm học ${calendarResult.weeks} tuần`);
      if (r.versions)
        parts.push(`${r.versions} phiên bản TKB (${r.lessons} tiết)`);
      if (appendix2Result.versions)
        parts.push(
          `Phụ lục 2 (${appendix2Result.subjects} môn, ${appendix2Result.lessons} dòng kế hoạch)`,
        );
      alert(
        parts.length
          ? `Đã khôi phục từ Supabase: ${parts.join(" và ")}.`
          : "Tài khoản này chưa có Lịch năm học, TKB hoặc Phụ lục 2 trên Supabase.",
      );
    }
  } catch (e) {
    console.error("[TKB] Không khôi phục được dữ liệu từ Supabase", e);
    const status = $("supabaseStatus");
    if (status)
      status.textContent =
        "⚠️ Supabase: Đã đăng nhập nhưng chưa tải được đầy đủ dữ liệu";
    if (showMessage)
      alert("Không tải được dữ liệu từ Supabase: " + (e.message || e));
  }
}

function updateAuthUI(user) {
  if (
    currentAuthUser?.id !== (user?.id || null) &&
    typeof clearGoogleSheetsTeacherMapping === "function"
  )
    clearGoogleSheetsTeacherMapping();
  currentAuthUser = user || null;
  currentSchoolYearId = null;
  const status = $("supabaseStatus"),
    label = $("authUserLabel"),
    login = $("loginBtn"),
    logout = $("logoutBtn");
  if (status)
    status.textContent = user
      ? "☁️ Supabase: ĐÃ KẾT NỐI • Đã đăng nhập"
      : "☁️ Supabase: ĐÃ KẾT NỐI • Chưa đăng nhập (dữ liệu hiện vẫn dùng localStorage)";
  if (label) label.textContent = user ? user.email || "Giáo viên" : "";
  if (login) login.hidden = !!user;
  if (logout) logout.hidden = !user;
}
function openAuthModal() {
  if (!supabaseClient) {
    alert("Supabase chưa sẵn sàng. Vui lòng tải lại trang.");
    return;
  }
  const m = modalShell(
    "ĐĂNG NHẬP GIÁO VIÊN",
    `<p class="manage-note">Đăng nhập để Supabase xác định đúng giáo viên và tự khôi phục Kho TKB cùng Lịch năm học.</p><div class="auth-form"><label>Email<input id="authEmail" type="email" autocomplete="username" placeholder="giaovien@example.com"></label><label>Mật khẩu<input id="authPassword" type="password" autocomplete="current-password" placeholder="Tối thiểu 6 ký tự"></label><div id="authMessage" class="auth-message"></div></div><div class="manage-actions auth-modal-actions"><button id="authSignUp" type="button" class="secondary-action">TẠO TÀI KHOẢN</button><button id="authSignIn" type="button">ĐĂNG NHẬP</button></div>`,
  );
  const email = m.querySelector("#authEmail"),
    pass = m.querySelector("#authPassword"),
    msg = m.querySelector("#authMessage");
  const values = () => ({ email: email.value.trim(), password: pass.value });
  const validate = () => {
    const v = values();
    if (!v.email || !v.email.includes("@"))
      throw new Error("Vui lòng nhập email hợp lệ.");
    if (v.password.length < 6)
      throw new Error("Mật khẩu phải có ít nhất 6 ký tự.");
    return v;
  };
  m.querySelector("#authSignIn").onclick = async () => {
    try {
      msg.textContent = "Đang đăng nhập...";
      const v = validate();
      const { data, error } = await supabaseClient.auth.signInWithPassword(v);
      if (error) throw error;
      updateAuthUI(data.user);
      await restoreAfterLogin(true);
      m.remove();
    } catch (e) {
      msg.textContent = "⚠️ " + (e.message || e);
    }
  };
  m.querySelector("#authSignUp").onclick = async () => {
    try {
      msg.textContent = "Đang tạo tài khoản...";
      const v = validate();
      const { data, error } = await supabaseClient.auth.signUp(v);
      if (error) throw error;
      if (data.session) {
        updateAuthUI(data.user);
        m.remove();
        alert("Đã tạo tài khoản và đăng nhập thành công.");
      } else {
        msg.textContent =
          "✅ Đã tạo tài khoản. Nếu Supabase yêu cầu xác nhận email, hãy mở email xác nhận rồi quay lại đăng nhập.";
      }
    } catch (e) {
      msg.textContent = "⚠️ " + (e.message || e);
    }
  };
  setTimeout(() => email.focus(), 0);
}
async function logoutTeacher() {
  if (!supabaseClient) return;
  const { error } = await supabaseClient.auth.signOut();
  if (error) {
    alert("Không đăng xuất được: " + error.message);
    return;
  }
  updateAuthUI(null);
  // Không để TKB của tài khoản vừa đăng xuất còn hiển thị cho người dùng kế tiếp.
  scheduleVersions.splice(0, scheduleVersions.length);
  allLessons = [];
  meta = { file: "", sheets: [], counts: {}, errors: [] };
  // Không để Phụ lục 2 của tài khoản vừa đăng xuất còn hiển thị cho giáo viên kế tiếp.
  lessonPlanMap.clear();
  planSubjectCatalog.clear();
  lessonPlanMeta = { file: "", type: "", count: 0 };
  const pl2Info = $("pl2Info");
  if (pl2Info) pl2Info.textContent = "Chưa có Phụ lục 2 trong kho.";
  resetSchoolCalendar();
  if ($("weekSelect")) $("weekSelect").value = "1";
  if ($("concurrentPeriods")) $("concurrentPeriods").value = "0";
  activateSelectedWeek();
}
async function initSupabaseConnection() {
  const status = $("supabaseStatus");
  try {
    if (!window.supabase?.createClient)
      throw new Error("Không tải được thư viện Supabase");
    supabaseClient = window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY,
    );
    const {
      data: { session },
      error,
    } = await supabaseClient.auth.getSession();
    if (error) throw error;
    updateAuthUI(session?.user || null);
    if (session?.user) await restoreAfterLogin(false);
    supabaseClient.auth.onAuthStateChange((event, session) => {
      updateAuthUI(session?.user || null);
      // SIGNED_IN cũng có thể phát sinh khi refresh token; chỉ khôi phục khi kho hiện tại đang trống để tránh tải lặp.
      if (session?.user && event === "SIGNED_IN" && !scheduleVersions.length)
        setTimeout(() => restoreAfterLogin(false), 0);
    });
    console.info("[TKB] Supabase client ready", {
      url: SUPABASE_URL,
      authenticated: !!session,
    });
  } catch (err) {
    console.error("[TKB] Supabase connection error", err);
    if (status)
      status.textContent =
        "⚠️ Supabase: KHÔNG KẾT NỐI ĐƯỢC • " + (err?.message || err);
  }
}

let allLessons = [],
  currentView = "table",
  meta = {},
  lessonPlanMap = new Map(),
  lessonPlanMeta = { file: "", type: "", count: 0 };
// Kho các phiên bản TKB theo mốc hiệu lực.
// Mỗi TKB mới áp dụng từ tuần được chọn đến trước mốc TKB kế tiếp; lịch sử các tuần cũ vẫn được giữ.
const scheduleVersions = [];
const TKB_STORE_KEY = "tkb_personal_schedule_repository_v1";

const SCHOOL_CALENDAR_KEY = "tkb_school_calendar_v1";
let schoolCalendar = { startDate: "2026-09-07", breaks: [], weeks: [] };
function isoDate(d) {
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function parseLocalDate(v) {
  const [y, m, d] = String(v || "")
    .split("-")
    .map(Number);
  return new Date(y, m - 1, d);
}
function fmtDateVN(v) {
  const d = typeof v === "string" ? parseLocalDate(v) : v;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}
function normalizeBreaks(arr) {
  return (arr || [])
    .filter((x) => x && x.start && x.end && x.start <= x.end)
    .sort((a, b) => a.start.localeCompare(b.start));
}
function weekHitsBreak(start, breaks) {
  const end = new Date(start);
  end.setDate(end.getDate() + 4);
  return breaks.some((b) => {
    const bs = parseLocalDate(b.start),
      be = parseLocalDate(b.end);
    return start <= be && end >= bs;
  });
}
function generateSchoolWeeks(startDate, breaks) {
  let out = [],
    d = parseLocalDate(startDate),
    safe = 0;
  breaks = normalizeBreaks(breaks);
  while (out.length < 35 && safe++ < 500) {
    while (weekHitsBreak(d, breaks)) {
      d.setDate(d.getDate() + 7);
    }
    const e = new Date(d);
    e.setDate(e.getDate() + 4);
    out.push({ week: out.length + 1, start: isoDate(d), end: isoDate(e) });
    d.setDate(d.getDate() + 7);
  }
  return out;
}
function schoolCalendarCacheKey() {
  return currentAuthUser?.id
    ? `${SCHOOL_CALENDAR_KEY}:${currentAuthUser.id}`
    : null;
}
function resetSchoolCalendar() {
  schoolCalendar = {
    startDate: "2026-09-07",
    breaks: [],
    weeks: generateSchoolWeeks("2026-09-07", []),
  };
}
function loadSchoolCalendar() {
  const key = schoolCalendarCacheKey();
  if (!key) {
    resetSchoolCalendar();
    return;
  }
  try {
    const x = JSON.parse(localStorage.getItem(key) || "null");
    if (x && Array.isArray(x.weeks) && x.weeks.length === 35)
      schoolCalendar = x;
    else resetSchoolCalendar();
  } catch (e) {
    resetSchoolCalendar();
  }
}
function saveSchoolCalendar() {
  const key = schoolCalendarCacheKey();
  if (key) localStorage.setItem(key, JSON.stringify(schoolCalendar));
}
function inferBreaksFromSchoolWeeks(weeks) {
  const out = [];
  for (let i = 1; i < (weeks || []).length; i++) {
    const prevEnd = parseLocalDate(weeks[i - 1].end),
      nextStart = parseLocalDate(weeks[i].start);
    const expected = new Date(prevEnd);
    expected.setDate(expected.getDate() + 3);
    if (nextStart > expected) {
      const breakEnd = new Date(nextStart);
      breakEnd.setDate(breakEnd.getDate() - 1);
      out.push({
        start: isoDate(expected),
        end: isoDate(breakEnd),
        label: "Nghỉ / không tính tuần học",
      });
    }
  }
  return out;
}
async function saveSchoolCalendarToSupabase() {
  if (!supabaseClient || !currentAuthUser)
    throw new Error(
      "Hãy đăng nhập giáo viên trước khi lưu Lịch năm học lên Supabase.",
    );
  if (
    !Array.isArray(schoolCalendar.weeks) ||
    schoolCalendar.weeks.length !== 35
  )
    throw new Error("Lịch năm học phải có đủ 35 tuần trước khi lưu.");
  const schoolYearId = await ensureSupabaseSchoolYear();
  const rows = schoolCalendar.weeks.map((w) => ({
    school_year_id: schoolYearId,
    user_id: currentAuthUser.id,
    week_number: Number(w.week),
    start_date: w.start,
    end_date: w.end,
    status: "study",
    note: null,
  }));
  const { error } = await supabaseClient
    .from("tkb_academic_weeks")
    .upsert(rows, { onConflict: "school_year_id,week_number" });
  if (error) throw error;
  return rows.length;
}
async function restoreSchoolCalendarFromSupabase() {
  if (!supabaseClient || !currentAuthUser) return { weeks: 0 };
  const schoolYearId = await ensureSupabaseSchoolYear();
  const { data, error } = await supabaseClient
    .from("tkb_academic_weeks")
    .select("week_number,start_date,end_date,status,note")
    .eq("user_id", currentAuthUser.id)
    .eq("school_year_id", schoolYearId)
    .order("week_number", { ascending: true });
  if (error) throw error;
  if (!data?.length) {
    resetSchoolCalendar();
    saveSchoolCalendar();
    activateSelectedWeek();
    return { weeks: 0 };
  }
  const restored = data
    .filter(
      (x) =>
        Number(x.week_number) >= 1 &&
        Number(x.week_number) <= 35 &&
        x.start_date &&
        x.end_date,
    )
    .map((x) => ({
      week: Number(x.week_number),
      start: x.start_date,
      end: x.end_date,
    }));
  if (restored.length !== 35) {
    console.warn(
      "[TKB] Lịch Supabase chưa đủ 35 tuần; không dùng dữ liệu cục bộ để ghi đè.",
      { weeks: restored.length },
    );
    resetSchoolCalendar();
    saveSchoolCalendar();
    activateSelectedWeek();
    return { weeks: 0, incomplete: restored.length };
  }
  schoolCalendar = {
    startDate: restored[0].start,
    breaks: inferBreaksFromSchoolWeeks(restored),
    weeks: restored,
  };
  saveSchoolCalendar();
  activateSelectedWeek();
  console.info("[TKB] Đã khôi phục Lịch năm học từ Supabase", {
    weeks: restored.length,
  });
  return { weeks: restored.length };
}
function selectedWeekDates() {
  const week = Number($("weekSelect")?.value || 1),
    r =
      schoolCalendar.weeks.find((x) => Number(x.week) === week) ||
      generateSchoolWeeks("2026-09-07", [])[week - 1];
  const start = parseLocalDate(r.start),
    end = parseLocalDate(r.end),
    days = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    days.push(fmtDateVN(d));
  }
  return { week, start, end, days, fmt: (d) => fmtDateVN(d) };
}
function modalShell(title, body) {
  document.getElementById("manageModal")?.remove();
  const m = document.createElement("div");
  m.id = "manageModal";
  m.className = "manage-modal";
  m.innerHTML = `<div class="manage-dialog"><div class="manage-head"><h3>${title}</h3><button id="manageClose">×</button></div>${body}</div>`;
  document.body.appendChild(m);
  m.querySelector("#manageClose").onclick = () => m.remove();
  m.onclick = (e) => {
    if (e.target === m) m.remove();
  };
  return m;
}
function openRepoManager() {
  const rows = scheduleVersions
    .map(
      (v, i) =>
        `<tr><td>${i + 1}</td><td>${esc(v.file)}</td><td><select data-repo-week="${i}">${Array.from({ length: 35 }, (_, j) => `<option value="${j + 1}" ${Number(v.startWeek) === j + 1 ? "selected" : ""}>Tuần ${j + 1}</option>`).join("")}</select></td><td>${esc(v.uploadedAtLabel || "")}</td><td>${v.lessons?.length || 0}</td><td><button type="button" data-delete-repo="${i}">XÓA</button></td></tr>`,
    )
    .join("");
  const m = modalShell(
    "QUẢN LÝ KHO THỜI KHÓA BIỂU",
    `<p class="manage-note">Có thể điều chỉnh thủ công tuần bắt đầu hiệu lực. Chỉ xóa phiên bản TKB khi chắc chắn không còn cần dùng.</p><div class="manage-scroll"><table class="manage-table"><thead><tr><th>TT</th><th>File TKB</th><th>Hiệu lực từ</th><th>Thời điểm lưu</th><th>Số tiết</th><th>Thao tác</th></tr></thead><tbody>${rows || '<tr><td colspan="6">Kho TKB đang trống.</td></tr>'}</tbody></table></div><div class="manage-actions"><button id="saveRepoEffect">LƯU HIỆU LỰC</button></div>`,
  );
  m.querySelectorAll("[data-delete-repo]").forEach(
    (btn) =>
      (btn.onclick = async () => {
        const v = scheduleVersions[Number(btn.dataset.deleteRepo)];
        if (!v) return;
        if (
          !confirm(
            `Xóa phiên bản TKB "${v.file}" hiệu lực từ Tuần ${v.startWeek}?\n\nDữ liệu TKB này sẽ bị xóa khỏi Supabase. Các phiên bản khác không bị ảnh hưởng.`,
          )
        )
          return;
        try {
          btn.disabled = true;
          btn.textContent = "ĐANG XÓA...";
          await removeScheduleVersion(v);
          activateSelectedWeek();
          m.remove();
          openRepoManager();
        } catch (e) {
          console.error("[TKB] Không xóa được phiên bản TKB", e);
          btn.disabled = false;
          btn.textContent = "XÓA";
          alert("Không xóa được phiên bản TKB: " + (e.message || e));
        }
      }),
  );
  m.querySelector("#saveRepoEffect").onclick = async () => {
    const btn = m.querySelector("#saveRepoEffect");
    try {
      if (!currentAuthUser)
        throw new Error(
          "Hãy đăng nhập giáo viên trước khi thay đổi hiệu lực TKB.",
        );
      const changed = [];
      m.querySelectorAll("[data-repo-week]").forEach((el) => {
        const v = scheduleVersions[Number(el.dataset.repoWeek)],
          next = Number(el.value);
        if (v && Number(v.startWeek) !== next) {
          v.startWeek = next;
          changed.push(v);
        }
      });
      btn.disabled = true;
      btn.textContent = "ĐANG LƯU...";
      for (const v of changed) await updateTimetableEffectiveWeekSupabase(v);
      scheduleVersions.sort(
        (a, b) =>
          a.startWeek - b.startWeek ||
          String(a.uploadedAt || "").localeCompare(String(b.uploadedAt || "")),
      );
      saveScheduleRepository();
      activateSelectedWeek();
      m.remove();
      alert(
        changed.length
          ? "Đã cập nhật mốc hiệu lực TKB trên Supabase."
          : "Không có thay đổi mốc hiệu lực TKB.",
      );
    } catch (e) {
      console.error("[TKB] Không cập nhật được hiệu lực TKB", e);
      btn.disabled = false;
      btn.textContent = "LƯU HIỆU LỰC";
      alert(
        "Không cập nhật được hiệu lực TKB trên Supabase: " + (e.message || e),
      );
    }
  };
}
function breakRowsHtml() {
  const b = schoolCalendar.breaks.length
    ? schoolCalendar.breaks
    : [{ start: "", end: "", label: "Nghỉ Tết" }];
  return b
    .map(
      (x, i) =>
        `<div class="break-row"><input data-break-label="${i}" value="${esc(x.label || "Nghỉ")}" placeholder="Tên kỳ nghỉ"><input type="date" data-break-start="${i}" value="${x.start || ""}"><span>đến</span><input type="date" data-break-end="${i}" value="${x.end || ""}"></div>`,
    )
    .join("");
}
function calendarWeekRows() {
  return schoolCalendar.weeks
    .map(
      (w) =>
        `<tr><td><b>Tuần ${w.week}</b></td><td><input type="date" data-week-start="${w.week}" value="${w.start}"></td><td><input type="date" data-week-end="${w.week}" value="${w.end}"></td><td>${fmtDateVN(w.start)} – ${fmtDateVN(w.end)}</td></tr>`,
    )
    .join("");
}
function openCalendarManager() {
  const m = modalShell(
    "LỊCH NĂM HỌC – TUẦN 1 ĐẾN 35",
    `<p class="manage-note">Ngày của Phụ lục 1.4 lấy từ lịch này. Kỳ nghỉ không làm tăng số tuần chuyên môn.</p><div class="calendar-config"><label>Ngày bắt đầu Tuần 1 <input id="schoolStartDate" type="date" value="${schoolCalendar.startDate}"></label><b>Kỳ nghỉ / thời gian không tính tuần học</b><div id="breakRows">${breakRowsHtml()}</div><div><button id="addBreak">+ Thêm kỳ nghỉ</button> <button id="regenCalendar">TẠO LẠI 35 TUẦN</button></div></div><div class="manage-scroll calendar-scroll"><table class="manage-table"><thead><tr><th>Tuần</th><th>Từ ngày</th><th>Đến ngày</th><th>Hiển thị</th></tr></thead><tbody>${calendarWeekRows()}</tbody></table></div><div class="manage-actions"><button id="saveCalendar">LƯU LỊCH NĂM HỌC</button></div>`,
  );
  const collectBreaks = () => {
    const a = [];
    m.querySelectorAll("[data-break-start]").forEach((el) => {
      const i = el.dataset.breakStart,
        start = el.value,
        end = m.querySelector(`[data-break-end="${i}"]`)?.value,
        label = m.querySelector(`[data-break-label="${i}"]`)?.value || "Nghỉ";
      if (start && end) a.push({ start, end, label });
    });
    return normalizeBreaks(a);
  };
  m.querySelector("#addBreak").onclick = () => {
    const i = m.querySelectorAll("[data-break-start]").length,
      d = document.createElement("div");
    d.className = "break-row";
    d.innerHTML = `<input data-break-label="${i}" value="Nghỉ" placeholder="Tên kỳ nghỉ"><input type="date" data-break-start="${i}"><span>đến</span><input type="date" data-break-end="${i}">`;
    m.querySelector("#breakRows").appendChild(d);
  };
  m.querySelector("#regenCalendar").onclick = () => {
    schoolCalendar.startDate =
      m.querySelector("#schoolStartDate").value || "2026-09-07";
    schoolCalendar.breaks = collectBreaks();
    schoolCalendar.weeks = generateSchoolWeeks(
      schoolCalendar.startDate,
      schoolCalendar.breaks,
    );
    m.remove();
    openCalendarManager();
  };
  m.querySelector("#saveCalendar").onclick = async () => {
    const btn = m.querySelector("#saveCalendar");
    try {
      schoolCalendar.startDate =
        m.querySelector("#schoolStartDate").value || schoolCalendar.startDate;
      schoolCalendar.breaks = collectBreaks();
      m.querySelectorAll("[data-week-start]").forEach((el) => {
        const w = schoolCalendar.weeks[Number(el.dataset.weekStart) - 1];
        if (w) w.start = el.value;
      });
      m.querySelectorAll("[data-week-end]").forEach((el) => {
        const w = schoolCalendar.weeks[Number(el.dataset.weekEnd) - 1];
        if (w) w.end = el.value;
      });
      saveSchoolCalendar();
      activateSelectedWeek();
      if (!currentAuthUser)
        throw new Error(
          "Bạn cần đăng nhập giáo viên để lưu Lịch năm học lên Supabase.",
        );
      btn.disabled = true;
      btn.textContent = "ĐANG LƯU...";
      const count = await saveSchoolCalendarToSupabase();
      m.remove();
      alert(
        `Đã lưu Lịch năm học ${count} tuần lên Supabase và bộ nhớ cục bộ. Excel/PDF/In sẽ dùng đúng ngày của tuần được chọn.`,
      );
    } catch (e) {
      console.error("[TKB] Không lưu được Lịch năm học lên Supabase", e);
      btn.disabled = false;
      btn.textContent = "LƯU LỊCH NĂM HỌC";
      alert("Không lưu được Lịch năm học lên Supabase: " + (e.message || e));
    }
  };
}

function canonicalSchedule(lessons) {
  return (lessons || [])
    .map((x) => ({
      thu: clean(x.thu),
      buoi: clean(x.buoi),
      tiet: clean(x.tiet),
      thoiGian: clean(x.thoiGian),
      lop: clean(x.lop),
      monHoc: normalizeSubjectForPlan(x.monHoc),
      diemTruong: clean(x.diemTruong),
      sheetNguon: clean(x.sheetNguon),
      dongNguon: Number(x.dongNguon || 0),
      cotNguon: Number(x.cotNguon || 0),
      oNguon: clean(x.oNguon),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function scheduleFingerprint(lessons) {
  const str = JSON.stringify(canonicalSchedule(lessons));
  let h1 = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h1 ^= str.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + ":" + str.length;
}
function scheduleCacheKey() {
  return currentAuthUser?.id
    ? `${TKB_STORE_KEY}:${currentAuthUser.id}`
    : `${TKB_STORE_KEY}:guest`;
}
function saveScheduleRepository() {
  // Cache chỉ hỗ trợ hiển thị nhanh trên cùng máy; sau đăng nhập Supabase luôn ghi đè cache này.
  try {
    localStorage.setItem(scheduleCacheKey(), JSON.stringify(scheduleVersions));
  } catch (e) {
    console.warn("Không lưu được cache Kho TKB", e);
  }
}
function loadScheduleRepository() {
  // Trước khi xác định tài khoản chỉ đọc cache khách; dữ liệu tài khoản thật sẽ được tải từ Supabase sau đăng nhập.
  try {
    const raw = localStorage.getItem(scheduleCacheKey()),
      arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) {
      scheduleVersions.splice(
        0,
        scheduleVersions.length,
        ...arr.filter(
          (v) =>
            v &&
            Array.isArray(v.lessons) &&
            Number(v.startWeek) >= 1 &&
            Number(v.startWeek) <= 35,
        ),
      );
      scheduleVersions.sort(
        (a, b) =>
          a.startWeek - b.startWeek ||
          String(a.uploadedAt || "").localeCompare(String(b.uploadedAt || "")),
      );
    }
  } catch (e) {
    console.warn("Không đọc được cache Kho TKB", e);
  }
}
function findDuplicateSchedule(fingerprint) {
  return scheduleVersions.find((v) => v.fingerprint === fingerprint) || null;
}
function repositorySummary() {
  if (!scheduleVersions.length) return "chưa có dữ liệu";
  return scheduleVersions
    .map(
      (v) =>
        `${esc(v.file)} (${versionRangeText(v)}) · lưu ${esc(v.uploadedAtLabel || "")}`,
    )
    .join(" · ");
}
const $ = (id) => document.getElementById(id);
const clean = (v) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
function normalizeTeacherName(s) {
  return clean(s)
    .normalize("NFC")
    .toLocaleLowerCase("vi-VN")
    .replace(/\s/g, "");
}
function teacherNamesFromCell(s, knownTeachers = []) {
  const raw = String(s ?? "");
  const out = [];
  const add = (value) => {
    const name = clean(value);
    const k = normKey(name);
    if (!name || !/[A-Za-zÀ-ỹĐđ]/u.test(name)) return;
    if (/^tiet\s*\d+$/u.test(k) || /^(on|tiet|buoi|lan)\b/u.test(k)) return;
    if (!out.some((x) => normalizeTeacherName(x) === normalizeTeacherName(name)))
      out.push(name);
  };

  // Dạng chuẩn: "Môn (Tên GV)".
  // BƯỚC 5.6.1B.2A: trong file thật, GV T.Hiếu được ghi rút gọn thành
  // "M.T (Hiếu)" / "MT (Hiếu)". Chỉ ánh xạ riêng trong ô môn M.T/MT để
  // không nhầm với giáo viên/GVCN tên Hiếu hoặc "C Hiếu".
  const rawSubjectKey = normKey(raw).replace(/\s+/g, "");
  const shortHieuIsTHieu = /^(m\.?t)/u.test(rawSubjectKey);
  for (const m of raw.matchAll(/\(([^)]+)\)/gu)) {
    const inside = clean(m[1]);
    if (shortHieuIsTHieu && normKey(inside) === "hieu") {
      const canonicalTHieu = (knownTeachers || []).find(
        (x) => normKey(x).replace(/\s+/g, "") === "t.hieu",
      );
      add(canonicalTHieu || "T.Hiếu");
    } else add(inside);
  }

  // BƯỚC 5.6.1B: file TKB thực tế có các ô nhập thiếu dấu ')' như "T D (Vũ".
  // Chỉ nhận phần ngoặc mở ở CUỐI ô để không nuốt nhầm chú thích chuyên môn ở giữa chuỗi.
  const openTail = raw.match(/\(([^()]*)$/u);
  if (openTail) {
    const inside = clean(openTail[1]);
    if (shortHieuIsTHieu && normKey(inside) === "hieu") {
      const canonicalTHieu = (knownTeachers || []).find(
        (x) => normKey(x).replace(/\s+/g, "") === "t.hieu",
      );
      add(canonicalTHieu || "T.Hiếu");
    } else add(inside);
  }

  // Lỗi gõ xác định được trong TKB 28.9: "LTT VNgọc)". Chỉ sửa đúng
  // mẫu VNgọc ở CUỐI ô; không dùng quy tắc suffix chung để tránh nhận nhầm tên.
  if (/v\s*ngoc\s*\)?\s*$/u.test(normKey(raw))) {
    const canonicalNgoc = (knownTeachers || []).find(
      (x) => normKey(x) === "ngoc",
    );
    add(canonicalNgoc || "Ngọc");
  }

  // Một số ô còn thiếu cả dấu '(' hoặc chỉ có dấu ')' (VD: "AV Nghĩa", "TNXH Băng)").
  // Khi đã có danh sách GV chuẩn từ bảng Cộng cuối sheet, dùng chính danh sách đó để nhận diện chịu lỗi.
  const rawKey = normKey(raw);
  for (const teacher of knownTeachers || []) {
    const tk = normKey(teacher);
    if (!tk) continue;
    const escaped = tk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|\\s|\\()${escaped}(?:$|\\s|\\))`, "u");
    if (re.test(rawKey)) add(teacher);
  }
  return out;
}

function extractTeacherExpectedCounts(wb, sheets) {
  // BƯỚC 5.6.1B.1: đọc đúng cột "Cộng" của từng sheet rồi cộng BN + TT + BB
  // theo tên giáo viên đã chuẩn hóa. Không lấy "số cuối cùng" của cả dòng vì mỗi
  // điểm trường có số lớp/cột khác nhau và dễ làm sai tổng chuẩn.
  const byTeacher = {};
  const bySheet = {};
  const canonicalNameByKey = {};

  for (const sn of sheets) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], {
      header: 1, defval: "", raw: false,
    });
    const marker = rows.findIndex((row) => normKey(row?.[0]) === "gvcn");
    if (marker < 0) continue;

    const markerRow = rows[marker] || [];
    const totalCol = markerRow.findIndex((v, i) => i > 0 && normKey(v) === "cong");
    if (totalCol < 0) continue;

    bySheet[sn] = {};
    let started = false;
    for (let r = marker + 1; r < rows.length; r++) {
      const name = clean(rows[r]?.[0]);
      if (!name) {
        if (started) break;
        continue;
      }
      if (!/[A-Za-zÀ-ỹĐđ]/u.test(name)) {
        if (started) break;
        continue;
      }

      const rawTotal = clean(rows[r]?.[totalCol]);
      const total = Number(rawTotal.replace(/,/g, "."));
      if (!Number.isFinite(total)) continue;
      started = true;

      const key = normalizeTeacherName(name);
      if (!key) continue;
      const canonical = canonicalNameByKey[key] || name;
      canonicalNameByKey[key] = canonical;
      bySheet[sn][canonical] = total;
      byTeacher[canonical] = Number(byTeacher[canonical] || 0) + total;
    }
  }
  return { byTeacher, bySheet };
}
function teacherCellFor(s, teacherName = selectedTeacher) {
  const target = normalizeTeacherName(teacherName);
  return teacherNamesFromCell(s).some(
    (name) => normalizeTeacherName(name) === target,
  );
}
function teacherCell(s) {
  return teacherCellFor(s, selectedTeacher);
}
function extractSubject(s, assignedTeachers = []) {
  let out = String(s ?? "")
    .replace(/\([^)]*\)/gu, "")
    .replace(/\([^()]*$/u, "")
    .trim();
  // Chịu lỗi các ô như "AV Nghĩa" hoặc "TNXH Băng)": nếu cuối ô là tên GV đã nhận diện, bỏ tên đó khỏi môn.
  for (const teacher of assignedTeachers || []) {
    const parts = clean(teacher).split(/\s+/u).filter(Boolean);
    const variants = [clean(teacher), parts[parts.length - 1] || ""].filter(Boolean);
    for (const v of variants) {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`\\s*\\(?\\s*${escaped}\\s*\\)?\\s*$`, "iu"), "").trim();
    }
  }
  return clean(out);
}
function updateTeacherSelector(names = teacherCatalog) {
  const sel = $("teacherSelect");
  if (!sel) return;
  const unique = [...new Set((names || []).map(clean).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b, "vi"),
  );
  if (
    !unique.some(
      (x) => normalizeTeacherName(x) === normalizeTeacherName(selectedTeacher),
    )
  )
    unique.unshift(selectedTeacher);
  teacherCatalog = unique;
  sel.innerHTML = unique
    .map((x) => `<option value="${esc(x)}">${esc(x)}</option>`)
    .join("");
  const matched = unique.find(
    (x) => normalizeTeacherName(x) === normalizeTeacherName(selectedTeacher),
  );
  sel.value = matched || unique[0] || TEACHER;
}
function lessonsForSelectedTeacher(version) {
  if (!version) return [];
  const map = version.lessonsByTeacher || {};
  const key = Object.keys(map).find(
    (k) => normalizeTeacherName(k) === normalizeTeacherName(selectedTeacher),
  );
  if (key && Array.isArray(map[key])) return map[key];
  // Dữ liệu kho cũ chỉ có TKB của Đậm: vẫn giữ tương thích hoàn toàn.
  if (normalizeTeacherName(selectedTeacher) === normalizeTeacherName(TEACHER))
    return version.lessons || [];
  return [];
}
async function switchViewedTeacher(name) {
  selectedTeacher = clean(name) || TEACHER;
  const week = Number($("weekSelect")?.value || 1);
  const saved = effectiveScheduleForWeek(week);
  if (saved) {
    allLessons = sortSchedule(
      applyHomeroomTeachers([...lessonsForSelectedTeacher(saved)]),
    );
    meta = { ...saved, lessons: allLessons };
    finishLoad();
    $("fileInfo").innerHTML += ` · <b>Giáo viên: ${esc(selectedTeacher)}</b>`;
  } else activateSelectedWeek();
  // BƯỚC 5.6.2: sau khi TKB đã đổi theo giáo viên, tự chọn Phụ lục 2
  // có Môn + Khối khớp nhiều nhất với chính TKB của giáo viên đó.
  await autoLoadAppendix2ForSelectedTeacher();
}
// BƯỚC 5.5.2: đọc Lớp + Giáo viên chủ nhiệm trực tiếp từ tiêu đề cột của TKB toàn trường.
// File thực tế đang dùng có các dạng như:
// "1A1- Hà", "2A1( Tú)", "4A 2- N Dung", "2B.Thủy", "5B-- Hương", "1C - C Liễu".
function parseClassHeader(classHeader) {
  const raw = String(classHeader ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return { lop: "", gvcn: "" };

  // Mã lớp luôn nằm ở đầu tiêu đề: 1A1, 3B2, 5C, 4A 2...
  const m = raw.match(/^\s*(\d+\s*[A-Za-z]\s*\d*)/u);
  if (!m) return { lop: clean(raw), gvcn: "" };

  const lop = m[1].replace(/\s+/g, "").toUpperCase();
  let rest = raw.slice(m[0].length).trim();

  // Bỏ các ký tự phân cách giữa mã lớp và tên GVCN: -, --, ., :, ngoặc...
  rest = rest.replace(/^[\s.\-–—:;_/]+/u, "").trim();
  if (/^\([^)]*\)\s*$/u.test(rest)) rest = rest.slice(1, -1).trim();
  else
    rest = rest
      .replace(/^\(\s*/u, "")
      .replace(/\s*\)\s*$/u, "")
      .trim();

  return { lop, gvcn: clean(rest) };
}
function normalizeClassName(s) {
  return parseClassHeader(s).lop;
}
function extractHomeroomTeacher(classHeader) {
  return parseClassHeader(classHeader).gvcn;
}
function normKey(s) {
  return clean(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}
function detectHeaderRow(rows) {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    let k = rows[r].map(normKey);
    if (
      k.some((x) => x === "thu") &&
      k.some((x) => x === "buoi") &&
      k.some((x) => x === "tiet") &&
      k.some((x) => x.includes("thoi gian"))
    )
      return r;
  }
  return -1;
}
function detectSheets(wb) {
  return wb.SheetNames.filter((n) => {
    let rows = XLSX.utils.sheet_to_json(wb.Sheets[n], {
      header: 1,
      defval: "",
      raw: false,
    });
    return detectHeaderRow(rows) >= 0;
  });
}
function detectSchoolPoint(name, rows, headerRow) {
  let line = clean((rows[1] || []).join(" "));
  if (/điểm/i.test(line))
    return line.replace(/\s+/g, " ").replace(/^điểm\s+/i, "Điểm ");
  let k = normKey(name);
  if (k === "bn") return "Điểm chính";
  if (k === "tt") return "Điểm Thiên Tuế";
  if (k === "bb") return "Điểm Bãi Bấc";
  return line || name;
}
function detectClassHeaders(header) {
  let fixed = new Set(["thu", "buoi", "tiet", "thoi gian"]);
  let out = [];
  header.forEach((v, i) => {
    let k = normKey(v);
    if (
      i >= 4 &&
      clean(v) &&
      !fixed.has(k) &&
      !k.includes("tong stt") &&
      !k.startsWith("tong")
    )
      out.push({
        col: i,
        label: clean(v),
        lop: normalizeClassName(v),
        gvcn: extractHomeroomTeacher(v),
      });
  });
  return out;
}
function inheritThu(value, state) {
  if (clean(value)) state.thu = clean(value).replace(/^thứ\s*/i, "");
  return state.thu;
}
function inheritBuoi(value, state) {
  if (clean(value)) state.buoi = clean(value);
  return state.buoi;
}
function resolveTiet(row, index, rows, headerMap, state) {
  const raw = clean(row[headerMap.tiet]),
    time = clean(row[headerMap.time]);
  state.lastResolveInfo = { rawTiet: raw || "", adjusted: false, note: "" };
  if (!time || /ra\s*chơi/i.test(time)) return "";
  const ctx = `${state.thu}|${normKey(state.buoi)}`;
  // Nếu cột Tiết trống: suy luận từ hàng tiết hợp lệ gần nhất phía trên trong cùng Thứ/Buổi.
  let inferred = "";
  if (!/^\d+$/.test(raw)) {
    for (let r = index - 1; r >= 0; r--) {
      const rr = rows[r],
        t = clean(rr[headerMap.tiet]),
        tm = clean(rr[headerMap.time]);
      const rThu = clean(rr[headerMap.thu]),
        rBuoi = clean(rr[headerMap.buoi]);
      if (rThu && clean(rThu).replace(/^thứ\s*/i, "") !== state.thu) break;
      if (rBuoi && normKey(rBuoi) !== normKey(state.buoi)) break;
      if (/ra\s*chơi/i.test(tm + " " + clean(rr[0]))) continue;
      if (/^\d+$/.test(t)) {
        inferred = String(Number(t) + 1);
        break;
      }
    }
  }
  let resolved = /^\d+$/.test(raw) ? raw : inferred;
  // Kiểm tra mâu thuẫn tuần tự trên các tiết Đậm liên tiếp trong cùng buổi.
  // Trường hợp file ghi 1, [trống=>2], 2 nhưng thời gian tiếp tục sang tiết sau: cảnh báo và dùng 3.
  const prev = state.lastResolved;
  if (
    prev &&
    prev.ctx === ctx &&
    index > prev.row &&
    resolved &&
    Number(resolved) <= Number(prev.tiet) &&
    time !== prev.time
  ) {
    const corrected = String(Number(prev.tiet) + 1);
    const reason = `Cột Tiết mâu thuẫn thứ tự: sau Tiết ${prev.tiet} nhưng file ghi ${raw || "trống"}`;
    state.resolveWarnings.push({
      row: index + 1,
      rawTiet: raw || "(trống)",
      resolved: corrected,
      time,
      reason,
    });
    state.lastResolveInfo = {
      rawTiet: raw || "",
      adjusted: true,
      note: `${reason}. Ứng dụng xác định Tiết ${corrected} theo thứ tự dòng/thời gian.`,
    };
    resolved = corrected;
  }
  if (resolved) state.lastResolved = { ctx, row: index, tiet: resolved, time };
  state.tiet = resolved;
  return resolved;
}
function colLetter(n) {
  let s = "";
  for (n++; n; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
function extractTeacherLessons(sheetName, ws, teacherName = selectedTeacher, knownTeachers = []) {
  let rows = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: "",
    raw: false,
  });
  let hr = detectHeaderRow(rows);
  if (hr < 0) return { lessons: [], errors: [], point: sheetName };
  let header = rows[hr];
  let find = (names) => header.findIndex((x) => names.includes(normKey(x)));
  let hm = {
    thu: find(["thu"]),
    buoi: find(["buoi"]),
    tiet: find(["tiet"]),
    time: header.findIndex((x) => normKey(x).includes("thoi gian")),
  };
  let classes = detectClassHeaders(header),
    point = detectSchoolPoint(sheetName, rows, hr),
    state = {
      thu: "",
      buoi: "",
      tiet: "",
      lastResolved: null,
      resolveWarnings: [],
    },
    lessons = [],
    errors = [];
  for (let r = hr + 1; r < rows.length; r++) {
    let row = rows[r];
    let thu = inheritThu(row[hm.thu], state),
      buoi = inheritBuoi(row[hm.buoi], state),
      time = clean(row[hm.time]);
    let breakRow = /ra\s*chơi/i.test(row.map(clean).join(" "));
    for (const ch of classes) {
      let src = clean(row[ch.col]);
      // Quy tắc TKB toàn trường:
      // - Có tên GV trong ngoặc => GV trong ngoặc là người dạy tiết đó.
      // - Không ghi GV trong ngoặc => GVCN của lớp là người dạy.
      // Nhờ vậy các GVCN (Hà, Tú, Hạnh...) cũng có TKB đầy đủ, không chỉ GV bộ môn.
      const explicitTeachers = teacherNamesFromCell(src, knownTeachers);
      const assignedTeachers = explicitTeachers.length
        ? explicitTeachers
        : ch.gvcn
          ? [ch.gvcn]
          : [];
      const targetTeacher = normalizeTeacherName(teacherName);
      const belongsToTeacher = assignedTeachers.some(
        (n) => normalizeTeacherName(n) === targetTeacher,
      );
      if (!belongsToTeacher || breakRow) continue;
      let tiet = resolveTiet(row, r, rows, hm, state),
        mon = extractSubject(src, assignedTeachers);
      let ri = state.lastResolveInfo || {};
      let item = {
        thu,
        buoi,
        tiet,
        thoiGian: time,
        lop: ch.lop,
        monHoc: mon,
        gvcn: ch.gvcn || "",
        diemTruong: point,
        sheetNguon: sheetName,
        dongNguon: r + 1,
        cotNguon: ch.col + 1,
        oNguon: src,
        tietNguon: ri.rawTiet || "",
        tietDaHieuChinh: !!ri.adjusted,
        ghiChuTiet: ri.note || "",
      };
      lessons.push(item);
      let miss = [];
      if (!thu) miss.push("thiếu Thứ");
      if (!buoi) miss.push("thiếu Buổi");
      if (!ch.lop) miss.push("không xác định lớp");
      if (!time) miss.push("không có thời gian");
      if (!mon) miss.push("không xác định môn");
      if (!tiet) miss.push("không xác định tiết");
      if (miss.length) errors.push({ ...item, loi: miss.join(", ") });
    }
  }
  for (const w of state.resolveWarnings) {
    errors.push({
      sheetNguon: sheetName,
      dongNguon: w.row,
      cotNguon: hm.tiet + 1,
      oNguon: `Tiết=${w.rawTiet}; Thời gian=${w.time}`,
      loi: `${w.reason}. Ứng dụng xác định Tiết ${w.resolved} theo thứ tự dòng/thời gian; cần đối chiếu file nguồn.`,
    });
  }
  return { lessons, errors, point, headerRow: hr + 1 };
}
function sortSchedule(a) {
  const days = ["Hai", "Ba", "Tư", "Năm", "Sáu", "Bảy", "Chủ nhật"];
  const sess = ["Sáng", "Chiều"];
  return [...a].sort(
    (x, y) =>
      days.indexOf(x.thu) - days.indexOf(y.thu) ||
      sess.indexOf(clean(x.buoi)) - sess.indexOf(clean(y.buoi)) ||
      Number(x.tiet || 99) - Number(y.tiet || 99) ||
      x.thoiGian.localeCompare(y.thoiGian, "vi") ||
      x.diemTruong.localeCompare(y.diemTruong, "vi") ||
      x.lop.localeCompare(y.lop, "vi"),
  );
}
function filterSchedule() {
  return sortSchedule(
    allLessons.filter((x) => isValidOutputSubject(x?.monHoc)).filter(
      (x) =>
        (!$("fThu").value || x.thu === $("fThu").value) &&
        (!$("fBuoi").value || clean(x.buoi) === $("fBuoi").value) &&
        (!$("fPoint").value || x.diemTruong === $("fPoint").value) &&
        (!$("fClass").value || x.lop === $("fClass").value),
    ),
  );
}
function setOptions(id, vals, prefix) {
  $(id).innerHTML =
    `<option value="">${prefix}</option>` +
    [...new Set(vals)]
      .sort((a, b) => a.localeCompare(b, "vi"))
      .map((x) => `<option>${esc(x)}</option>`)
      .join("");
}
function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function pointKind(s) {
  let k = normKey(s);
  if (k.includes("thien tue")) return "tt";
  if (k.includes("bai bac")) return "bb";
  if (k.includes("chinh")) return "bn";
  return "other";
}
function pointBadge(s, compact = false) {
  const kind = pointKind(s),
    label = compact ? clean(s).replace(/^Điểm\s+/i, "") : clean(s);
  return `<span class="point-badge point-${kind}"><span class="point-dot"></span>${esc(label)}</span>`;
}
function renderStats() {
  // BƯỚC 5.6.2B.8A: giao diện chính dùng cùng bộ lọc môn hợp lệ
  // với Xem trước/Excel/PDF/In; không tính các ô rác của bảng Cộng.
  const dashboardLessons = allLessons.filter((x) => isValidOutputSubject(x?.monHoc));
  let p = (x) =>
    dashboardLessons.filter((y) => normKey(y.diemTruong).includes(x)).length;
  let vals = [
    ["TỔNG TIẾT", dashboardLessons.length],
    ["BUỔI SÁNG", dashboardLessons.filter((x) => normKey(x.buoi) === "sang").length],
    [
      "BUỔI CHIỀU",
      dashboardLessons.filter((x) => normKey(x.buoi) === "chieu").length,
    ],
    ["ĐIỂM CHÍNH", p("chinh")],
    ["THIÊN TUẾ", p("thien tue")],
    ["BÃI BẤC", p("bai bac")],
    ["SỐ LỚP", new Set(dashboardLessons.map((x) => x.lop).filter(Boolean)).size],
  ];
  $("stats").innerHTML = vals
    .map(([a, b]) => `<div class="card"><small>${a}</small><b>${b}</b></div>`)
    .join("");
}
function renderTable(data) {
  // Gộp Thứ và Buổi theo đúng nhóm đang hiển thị (kể cả sau khi lọc).
  let rows = "";
  for (let i = 0; i < data.length; ) {
    const thu = data[i].thu;
    let dayEnd = i;
    while (dayEnd < data.length && data[dayEnd].thu === thu) dayEnd++;
    let j = i,
      firstDay = true;
    while (j < dayEnd) {
      const buoi = clean(data[j].buoi);
      let sessionEnd = j;
      while (sessionEnd < dayEnd && clean(data[sessionEnd].buoi) === buoi)
        sessionEnd++;
      for (let k = j; k < sessionEnd; k++) {
        const x = data[k];
        const cls = ["lesson-row"];
        if (firstDay) cls.push("day-start");
        if (k === j) cls.push("session-start");
        rows += `<tr class="${cls.join(" ")} clickable-lesson" data-lesson-index="${allLessons.indexOf(x)}" title="Bấm để xem nguồn Excel">`;
        if (firstDay)
          rows += `<td class="day-cell" rowspan="${dayEnd - i}"><strong>THỨ ${esc(String(thu).toUpperCase())}</strong></td>`;
        if (k === j)
          rows += `<td class="session-cell" rowspan="${sessionEnd - j}"><strong>${esc(buoi.toUpperCase())}</strong></td>`;
        rows += `<td class="tiet-cell">${esc(x.tiet)}</td><td>${esc(x.thoiGian)}</td><td class="class-cell"><b>${esc(x.lop)}</b></td><td>${esc(normalizeSubjectForPlan(x.monHoc))}</td><td class="homeroom-cell">${esc(x.gvcn || "")}</td><td class="point-cell">${pointBadge(x.diemTruong)}</td></tr>`;
        firstDay = false;
      }
      j = sessionEnd;
    }
    i = dayEnd;
  }
  $("view").innerHTML =
    `<div class="schedule-table-wrap"><table class="schedule-table"><thead><tr><th>Thứ</th><th>Buổi</th><th>Tiết</th><th>Thời gian</th><th>Lớp</th><th>Môn học</th><th>Giáo viên chủ nhiệm</th><th>Điểm trường</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function renderWeek(data) {
  const order = ["Hai", "Ba", "Tư", "Năm", "Sáu", "Bảy", "Chủ nhật"];
  const days = order.filter((d) => data.some((x) => x.thu === d));
  if (!data.length) {
    $("view").innerHTML =
      '<div class="info">Không có tiết phù hợp với bộ lọc hiện tại.</div>';
    return;
  }
  const dayTitle = (d) =>
    d === "Chủ nhật" ? "CHỦ NHẬT" : `THỨ ${d.toUpperCase()}`;
  const sessions = ["Sáng", "Chiều"].filter((s) =>
    data.some((x) => normKey(x.buoi) === normKey(s)),
  );
  const blocks = sessions
    .map((session) => {
      const sd = data.filter((x) => normKey(x.buoi) === normKey(session));
      const periods = [
        ...new Set(sd.map((x) => Number(x.tiet)).filter(Number.isFinite)),
      ].sort((a, b) => a - b);
      const rows = periods
        .map((tiet) => {
          const time = sd.find((x) => Number(x.tiet) === tiet)?.thoiGian || "";
          const cells = days
            .map((day) => {
              const items = sd.filter(
                (x) => x.thu === day && Number(x.tiet) === tiet,
              );
              return `<td class="matrix-slot">${items.map((x) => `<div class="matrix-lesson clickable-lesson" data-lesson-index="${allLessons.indexOf(x)}" title="Bấm để xem nguồn Excel"><div class="matrix-class">${esc(x.lop)}</div><div class="matrix-subject">${esc(normalizeSubjectForPlan(x.monHoc))}</div><div class="matrix-point">${pointBadge(x.diemTruong, true)}</div><div class="matrix-time">${esc(x.thoiGian)}</div></div>`).join("")}</td>`;
            })
            .join("");
          return `<tr><th class="matrix-period"><b>Tiết ${tiet}</b>${time ? `<small>${esc(time)}</small>` : ""}</th>${cells}</tr>`;
        })
        .join("");
      return `<section class="matrix-section"><div class="matrix-session-title">${session.toUpperCase()}</div><div class="matrix-scroll"><table class="week-matrix"><thead><tr><th class="matrix-corner">TIẾT</th>${days.map((d) => `<th>${dayTitle(d)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
    })
    .join("");
  $("view").innerHTML =
    `<div class="matrix-view"><div class="matrix-heading"><div><h2>LỊCH TUẦN CÁ NHÂN</h2><p>Giáo viên: <b>${esc(selectedTeacher.toUpperCase())}</b> · Hiển thị theo Thứ và Tiết</p></div><div class="matrix-legend">📍 Lớp · Môn · Điểm trường</div></div>${blocks}</div>`;
}
function showSourceDetail(x) {
  if (!x) {
    alert("Không tìm thấy dữ liệu nguồn của tiết này.");
    return;
  }
  const old = document.getElementById("sourceModal");
  if (old) old.remove();
  const addr = `${colLetter(x.cotNguon - 1)}${x.dongNguon}`;
  const sourceTiet = x.tietNguon || "(trống)";
  const adjusted = x.tietDaHieuChinh
    ? `<div class="source-alert"><b>⚠ Tiết đã được hiệu chỉnh</b><br>Tiết ghi trong nguồn: <b>${esc(sourceTiet)}</b> → Tiết ứng dụng xác định: <b>${esc(x.tiet)}</b><br><span>${esc(x.ghiChuTiet)}</span></div>`
    : "";
  const html = `<div class="source-modal" id="sourceModal" role="dialog" aria-modal="true"><div class="source-dialog"><button type="button" class="source-close" aria-label="Đóng">×</button><div class="source-title"><div><small>ĐỐI CHIẾU NGUỒN EXCEL</small><h3>${esc(x.sheetNguon)}!${addr}</h3></div><span class="source-badge">Ô nguồn</span></div><div class="source-origin"><span>Sheet <b>${esc(x.sheetNguon)}</b></span><span>Dòng <b>${x.dongNguon}</b></span><span>Cột <b>${colLetter(x.cotNguon - 1)} (${x.cotNguon})</b></span></div><div class="source-cell"><small>NỘI DUNG Ô EXCEL GỐC</small><strong>${esc(x.oNguon)}</strong></div>${adjusted}<div class="source-grid"><div><small>Thứ</small><b>Thứ ${esc(x.thu)}</b></div><div><small>Buổi</small><b>${esc(x.buoi)}</b></div><div><small>Tiết</small><b>${esc(x.tiet)}</b></div><div><small>Thời gian</small><b>${esc(x.thoiGian)}</b></div><div><small>Lớp</small><b>${esc(x.lop)}</b></div><div><small>Môn học</small><b>${esc(x.monHoc)}</b></div><div class="source-wide"><small>Điểm trường</small><b>📍 ${esc(x.diemTruong)}</b></div></div>${x.plan ? `<div class="source-pl2"><b>📘 PHỤ LỤC 2 · TUẦN ${x.planWeek}</b><div class="plan-title">${esc(x.plan.title)}</div><div class="plan-meta">${esc(x.plan.subject)} · Lớp ${x.plan.grade}${x.plan.duration ? ` · ${esc(x.plan.duration)}` : ""}</div></div>` : `<div class="source-pl2"><b>📘 PHỤ LỤC 2</b><div class="plan-meta">Chưa tìm thấy nội dung phù hợp cho tuần ${x.planWeek || $("weekSelect").value}.</div></div>`}<div class="source-foot">Kết quả được phân tích trực tiếp từ file Excel đang tải.</div></div></div>`;
  document.body.insertAdjacentHTML("beforeend", html);
  const m = document.getElementById("sourceModal");
  const close = () => {
    const z = document.getElementById("sourceModal");
    if (z) z.remove();
  };
  m.querySelector(".source-close").addEventListener("click", close);
  m.addEventListener("click", (e) => {
    if (e.target === m) close();
  });
  setTimeout(() => m.classList.add("source-modal-open"), 0);
}
function bindLessonClicks() {
  // Dùng event delegation để click vẫn hoạt động sau mọi lần render/lọc/chuyển chế độ xem.
  const view = $("view");
  if (view.dataset.sourceClickBound === "1") return;
  view.dataset.sourceClickBound = "1";
  view.addEventListener("click", function (e) {
    const el = e.target.closest(".clickable-lesson");
    if (!el || !view.contains(el)) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = Number(el.dataset.lessonIndex);
    if (Number.isInteger(idx) && allLessons[idx])
      showSourceDetail(allLessons[idx]);
    else
      alert(
        "Không tìm thấy dữ liệu nguồn của tiết này. Vui lòng tải lại file TKB.",
      );
  });
}

const planSubjectCatalog = new Map();
function subjectAliasKeys(subject) {
  const raw = clean(subject),
    base = normKey(raw),
    compact = base.replace(/[^a-z0-9]+/g, "");
  const words = base.split(/[^a-z0-9]+/).filter(Boolean);
  const initials = words.map((w) => w[0]).join("");
  const noConnectors = words
    .filter((w) => !["va", "and", "mon"].includes(w))
    .map((w) => w[0])
    .join("");
  const out = new Set([base, compact, initials, noConnectors].filter(Boolean));
  // Một số viết tắt thông dụng trong TKB; danh mục môn vẫn được lấy động từ Phụ lục 2.
  if (compact === "tinhoc") out.add("th");
  if (compact === "congnghe") {
    out.add("cn");
    out.add("cnghe");
  }
  if (compact === "daoduc") out.add("dd");
  if (compact === "tiengviet") out.add("tv");
  if (compact === "tunhienvaxahoi" || compact === "tunhienxahoi") {
    out.add("tnxh");
    out.add("tnvxh");
  }
  if (compact === "lichsuvadialy" || compact === "lichsudialy") {
    out.add("lsdl");
    out.add("lsvdl");
  }
  if (compact === "mythuat" || compact === "mithuat") out.add("mt");
  if (compact === "amnhac") out.add("an");
  if (compact === "theduc" || compact === "giaoducthechat") {
    out.add("td");
    out.add("gdtc");
  }
  return out;
}
function registerPlanSubject(subject) {
  const canonical = clean(subject)
    .replace(/^môn\s+/iu, "")
    .trim();
  if (!canonical) return canonical;
  for (const k of subjectAliasKeys(canonical))
    planSubjectCatalog.set(k, canonical);
  return canonical;
}
function normalizeSubjectForPlan(s) {
  const raw = clean(s),
    base = normKey(raw),
    compact = base.replace(/[^a-z0-9]+/g, "");
  for (const k of [base, compact])
    if (planSubjectCatalog.has(k)) return planSubjectCatalog.get(k);
  // Tương thích ngay cả trước khi tải PL2.
  const builtins = {
    th: "Tin học",
    tinhoc: "Tin học",
    cn: "Công nghệ",
    cnghe: "Công nghệ",
    congnghe: "Công nghệ",
    dd: "Đạo đức",
    daoduc: "Đạo đức",
    tv: "Tiếng Việt",
    tviet: "Tiếng Việt",
    tiengviet: "Tiếng Việt",
    hdtn: "HĐTN",
    hoatdongtrainghiem: "HĐTN",
    hdgdcd: "HĐTN",
    shdc: "Sinh hoạt dưới cờ",
    sinhhoatduoico: "Sinh hoạt dưới cờ",
    shl: "SH LỚP",
    shlop: "SH LỚP",
    sinhhoatlop: "SH LỚP",
  };
  return builtins[compact] || raw;
}
function gradeFromClass(lop) {
  const m = clean(lop).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}
function planKey(subject, grade, week) {
  return `${normKey(normalizeSubjectForPlan(subject))}|${grade}|${Number(week)}`;
}
function parsePlanSection(text) {
  const x = clean(text);
  // Nhận động mọi tiêu đề: "Môn <tên môn> – Lớp <khối>", không khóa danh sách môn.
  const m = x.match(/(?:^|\b)Môn\s+(.+?)\s*[–—-]\s*Lớp\s*(\d{1,2})(?:\b|$)/iu);
  if (!m) return null;
  const subject = registerPlanSubject(m[1]);
  return subject ? { subject, grade: Number(m[2]) } : null;
}
function addPlanRecord(section, cells, source) {
  if (!section || !cells.length) return;
  const w = Number(clean(cells[0]));
  if (!(w >= 1 && w <= 35)) return;
  // Bảng PL2 chuẩn: Tuần | Chủ điểm | Tên bài | Tiết/thời lượng | Điều chỉnh | Ghi chú
  const title = clean(cells[2] || ""),
    duration = clean(cells[3] || ""),
    integration = clean(cells[4] || ""),
    note = clean(cells[5] || "");
  if (!title) return;
  const pm = duration.match(/Tiết\s*(\d+)/iu);
  const annualPeriod = pm ? Number(pm[1]) : w;
  lessonPlanMap.set(planKey(section.subject, section.grade, w), {
    subject: section.subject,
    grade: section.grade,
    week: w,
    annualPeriod,
    title,
    duration,
    integration,
    note,
    source,
  });
}
function xmlNodeText(node) {
  return clean(
    [...node.getElementsByTagNameNS("*", "t")]
      .map((n) => n.textContent || "")
      .join(" "),
  );
}
async function readPlanDocx(file) {
  if (typeof JSZip === "undefined")
    throw new Error("Không tải được thư viện đọc Word (JSZip).");
  const zip = await JSZip.loadAsync(await file.arrayBuffer()),
    entry = zip.file("word/document.xml");
  if (!entry) throw new Error("Không tìm thấy word/document.xml.");
  const xml = new DOMParser().parseFromString(
      await entry.async("string"),
      "application/xml",
    ),
    body = xml.getElementsByTagNameNS("*", "body")[0];
  let section = null;
  lessonPlanMap.clear();
  planSubjectCatalog.clear();
  for (const node of [...body.children]) {
    const local = node.localName;
    if (local === "p") {
      const sec = parsePlanSection(xmlNodeText(node));
      if (sec) section = sec;
    } else if (local === "tbl") {
      for (const tr of [...node.getElementsByTagNameNS("*", "tr")]) {
        const cells = [...tr.getElementsByTagNameNS("*", "tc")].map(
          xmlNodeText,
        );
        const joined = cells.join(" "),
          sec = parsePlanSection(joined);
        if (sec) {
          section = sec;
          continue;
        }
        addPlanRecord(
          section,
          cells,
          `Word · ${section ? section.subject + " lớp " + section.grade : ""}`,
        );
      }
    }
  }
}
async function readPlanExcel(file) {
  const wb = XLSX.read(await file.arrayBuffer(), {
    type: "array",
    cellText: true,
  });
  lessonPlanMap.clear();
  planSubjectCatalog.clear();
  for (const sn of wb.SheetNames) {
    let section = null,
      rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], {
        header: 1,
        defval: "",
        raw: false,
      });
    for (let r = 0; r < rows.length; r++) {
      const cells = rows[r].map(clean),
        joined = cells.join(" ");
      const sec = parsePlanSection(joined);
      if (sec) section = sec;
      addPlanRecord(section, cells, `${sn}!${r + 1}`);
    }
  }
}
function applyLessonPlan() {
  const week = Number($("weekSelect").value || 1);
  let matched = 0,
    missing = [];
  for (const x of allLessons) {
    const grade = gradeFromClass(x.lop),
      subject = normalizeSubjectForPlan(x.monHoc),
      plan = lessonPlanMap.get(planKey(subject, grade, week));
    x.planWeek = week;
    x.planSubject = subject;
    x.planGrade = grade;
    x.plan = plan || null;
    if (plan) matched++;
    else missing.push(`${x.lop} · ${subject}`);
  }
  if (!lessonPlanMap.size) {
    $("pl2Match").className = "info pl2-match";
    $("pl2Match").innerHTML = "Tải Phụ lục 2 và chọn tuần để ghép tên bài học.";
    return;
  }
  const unique = [...new Set(missing)];
  $("pl2Match").className =
    `info pl2-match ${matched === allLessons.length ? "ok-match" : "warn-match"}`;
  $("pl2Match").innerHTML =
    `<b>Tuần ${week}: ghép được ${matched}/${allLessons.length} tiết TKB</b>${unique.length ? `<div class="pl2-details">Chưa ghép: ${unique.map((x) => `<span class="pl2-chip">${esc(x)}</span>`).join("")}</div>` : `<div class="pl2-details">✓ Tất cả tiết đã tìm được tên bài học trong Phụ lục 2 theo Môn + Khối + Tuần.</div>`}`;
}
async function readLessonPlan(file) {
  try {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (ext === "docx") await readPlanDocx(file);
    else if (ext === "xlsx" || ext === "xls") await readPlanExcel(file);
    else throw new Error("Chỉ hỗ trợ .docx, .xlsx, .xls");
    lessonPlanMeta = { file: file.name, type: ext, count: lessonPlanMap.size };
    $("pl2Info").innerHTML =
      `<b>${esc(file.name)}</b> · ${lessonPlanMap.size} dòng kế hoạch đã nhận diện`;
    applyLessonPlan();
    render();
    if (!currentAuthUser) {
      alert(
        "Phụ lục 2 đã đọc thành công trên máy này. Hãy đăng nhập giáo viên để lưu Kho Phụ lục 2 lên Supabase.",
      );
      return;
    }
    try {
      const saved = await saveAppendix2ToSupabase(file);
      $("pl2Info").innerHTML =
        `<b>${esc(file.name)}</b> · ${lessonPlanMap.size} dòng kế hoạch đã nhận diện · ☁️ Đã lưu Supabase`;
      alert(
        `Đã lưu Phụ lục 2 lên Supabase: ${saved.subjects} môn, ${saved.lessons} dòng kế hoạch.`,
      );
    } catch (cloudErr) {
      console.error("[TKB] Không lưu được Phụ lục 2 lên Supabase", cloudErr);
      const duplicate = String(cloudErr?.message || cloudErr).includes(
        "đã tồn tại",
      );
      alert(
        (duplicate
          ? "Phụ lục 2 đã được nhận diện và vẫn dùng bình thường. "
          : "Phụ lục 2 đã được nhận diện trên máy này nhưng chưa lưu được lên Supabase. ") +
          (cloudErr?.message || cloudErr),
      );
    }
  } catch (err) {
    lessonPlanMap.clear();
    lessonPlanMeta = { file: "", type: "", count: 0 };
    $("pl2Info").textContent = "Không đọc được Phụ lục 2.";
    $("pl2Match").className = "info pl2-match warn-match";
    $("pl2Match").innerHTML =
      `<b>⚠ Không đọc được Phụ lục 2:</b> ${esc(err.message || err)}`;
  }
}
function initWeekSelect() {
  const opts = Array.from(
    { length: 35 },
    (_, i) => `<option value="${i + 1}">Tuần ${i + 1}</option>`,
  ).join("");
  $("weekSelect").innerHTML = opts;
  $("weekSelect").value = "1";
  if ($("effectiveFromWeek")) {
    $("effectiveFromWeek").innerHTML = opts;
    $("effectiveFromWeek").value = "1";
  }
}

function render() {
  applyLessonPlan();
  let d = filterSchedule();
  $("tableBtn").classList.toggle("active-view", currentView === "table");
  $("weekBtn").classList.toggle("active-view", currentView === "week");
  currentView === "table" ? renderTable(d) : renderWeek(d);
  bindLessonClicks();
}
// BƯỚC 5.5.3: bản đồ Lớp -> GVCN được đọc từ TKB toàn trường và dùng để
// bổ sung tên GVCN cho cả các phiên bản TKB cũ đã lưu trước Bước 5.5.2.
// Không thay đổi cấu trúc bảng Supabase hiện có.
let homeroomTeacherMap = {};
function homeroomCacheKey() {
  return currentAuthUser?.id
    ? `tkb_homeroom_map:${currentAuthUser.id}`
    : "tkb_homeroom_map:guest";
}
function loadHomeroomTeacherMap() {
  try {
    const raw = localStorage.getItem(homeroomCacheKey());
    const obj = raw ? JSON.parse(raw) : {};
    homeroomTeacherMap = obj && typeof obj === "object" ? obj : {};
  } catch (e) {
    homeroomTeacherMap = {};
  }
}
function saveHomeroomTeacherMap() {
  try {
    localStorage.setItem(
      homeroomCacheKey(),
      JSON.stringify(homeroomTeacherMap),
    );
  } catch (e) {
    console.warn("Không lưu được bản đồ GVCN", e);
  }
}
function mergeHomeroomTeachersFromLessons(lessons) {
  let changed = false;
  for (const x of lessons || []) {
    const lop = normalizeClassName(x.lop);
    const gvcn = clean(x.gvcn);
    if (lop && gvcn && homeroomTeacherMap[lop] !== gvcn) {
      homeroomTeacherMap[lop] = gvcn;
      changed = true;
    }
  }
  if (changed) saveHomeroomTeacherMap();
  return changed;
}
function applyHomeroomTeachers(lessons) {
  for (const x of lessons || []) {
    const lop = normalizeClassName(x.lop);
    if (!clean(x.gvcn) && lop && homeroomTeacherMap[lop])
      x.gvcn = homeroomTeacherMap[lop];
  }
  return lessons;
}
function enrichAllScheduleVersionsWithHomeroom() {
  for (const v of scheduleVersions || []) applyHomeroomTeachers(v.lessons);
}

function parseWorkbookFile(file) {
  return new Promise((resolve, reject) => {
    let fr = new FileReader();
    fr.onload = (e) => {
      try {
        let wb = XLSX.read(e.target.result, { type: "array", cellText: true }),
          sheets = detectSheets(wb),
          errors = [],
          counts = {},
          lessons = [],
          teacherSet = new Set();
        // BƯỚC 5.6.1C: bảng “Cộng” chỉ hỗ trợ nhận diện tên/biến thể,
        // KHÔNG còn là nguồn tạo danh sách giáo viên hay quyết định tổng số tiết.
        // TKB cá nhân lấy trực tiếp từ các ô tiết học thực tế.
        const expected = extractTeacherExpectedCounts(wb, sheets);
        const expectedTeachers = Object.keys(expected.byTeacher || {});
        // Quét danh sách giáo viên từ CẢ tiêu đề lớp (GVCN), bảng Cộng cuối sheet và các tên GV bộ môn trong ô TKB.
        // Đây là điểm còn thiếu ở 5.6.1: trước đây chỉ quét tên trong ngoặc nên mất toàn bộ GVCN.
        for (const sn of sheets) {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], {
            header: 1,
            defval: "",
            raw: false,
          });
          const hr = detectHeaderRow(rows);
          if (hr < 0) continue;
          const classes = detectClassHeaders(rows[hr]);
          classes.forEach((ch) => {
            if (ch.gvcn) teacherSet.add(ch.gvcn);
          });
          for (let r = hr + 1; r < rows.length; r++)
            for (const ch of classes)
              teacherNamesFromCell(rows[r][ch.col], expectedTeachers).forEach((n) =>
                teacherSet.add(n),
              );
        }
        if (!teacherSet.size) teacherSet.add(TEACHER);
        const teachers = [...teacherSet].sort((a, b) =>
          a.localeCompare(b, "vi"),
        );
        const lessonsByTeacher = {};
        for (const teacherName of teachers) {
          const teacherLessons = [];
          const teacherErrors = [];
          for (const sn of sheets) {
            const r = extractTeacherLessons(sn, wb.Sheets[sn], teacherName, expectedTeachers);
            teacherLessons.push(...r.lessons);
            teacherErrors.push(...r.errors);
          }
          lessonsByTeacher[teacherName] = sortSchedule(teacherLessons);
        }
        const selectedKey =
          teachers.find(
            (x) =>
              normalizeTeacherName(x) === normalizeTeacherName(selectedTeacher),
          ) ||
          teachers.find(
            (x) => normalizeTeacherName(x) === normalizeTeacherName(TEACHER),
          ) ||
          teachers[0];
        lessons = lessonsByTeacher[selectedKey] || [];
        // counts/errors ở Bước 5.6.1 phản ánh đúng giáo viên đang xem.
        for (const sn of sheets) {
          const r = extractTeacherLessons(sn, wb.Sheets[sn], selectedKey, expectedTeachers);
          counts[sn] = r.lessons.length;
          errors.push(...r.errors);
        }
        // Không đối chiếu/ép tổng theo bảng “Cộng”; số tiết thực tế là số ô TKB parser nhận được.
        resolve({
          file: file.name,
          sheets,
          counts,
          errors,
          lessons: sortSchedule(lessons),
          lessonsByTeacher,
          teachers,
        });
      } catch (err) {
        reject(err);
      }
    };
    fr.onerror = () => reject(fr.error || new Error("Không đọc được file"));
    fr.readAsArrayBuffer(file);
  });
}
function effectiveScheduleForWeek(week) {
  return (
    [...scheduleVersions]
      .filter((v) => v.startWeek <= week)
      .sort(
        (a, b) =>
          b.startWeek - a.startWeek ||
          String(b.uploadedAt || "").localeCompare(String(a.uploadedAt || "")),
      )[0] || null
  );
}
function versionRangeText(v) {
  const starts = [
      ...new Set(scheduleVersions.map((x) => Number(x.startWeek))),
    ].sort((a, b) => a - b),
    i = starts.indexOf(Number(v.startWeek)),
    end = i >= 0 && i < starts.length - 1 ? starts[i + 1] - 1 : 35;
  return `Tuần ${v.startWeek}–${end}`;
}
async function readWorkbooks(files) {
  const list = [...files];
  if (!list.length) return;
  // Mốc hiệu lực do người dùng chọn. TKB đầu năm mặc định từ Tuần 1; khi đổi TKB chọn tuần bắt đầu áp dụng.
  const startWeek = Math.max(
    1,
    Math.min(35, Number($("effectiveFromWeek")?.value || 1)),
  );
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    try {
      const parsed = await parseWorkbookFile(file);
      updateTeacherSelector(parsed.teachers);
      // BƯỚC 5.6.1C: không hiện cảnh báo lệch theo bảng “Cộng”.
      // Danh sách giáo viên và tổng tiết lấy từ các ô TKB thực tế.
      // Luôn cập nhật GVCN từ file vừa đọc, kể cả khi TKB bị phát hiện trùng và không lưu lại.
      mergeHomeroomTeachersFromLessons(parsed.lessons);
      enrichAllScheduleVersionsWithHomeroom();
      saveScheduleRepository();
      const sw = Math.min(35, startWeek + i),
        fingerprint = scheduleFingerprint(parsed.lessons),
        duplicate = findDuplicateSchedule(fingerprint);
      if (duplicate) {
        // BƯỚC 5.6.1A: bản TKB cũ trên Supabase chỉ lưu các tiết của Đậm.
        // Khi người dùng tải lại đúng file gốc, bổ sung bản đồ đa giáo viên vào phiên bản đang dùng
        // thay vì bỏ toàn bộ kết quả parse vì "trùng".
        duplicate.teachers = parsed.teachers;
        duplicate.lessonsByTeacher = parsed.lessonsByTeacher;
        let multiTeacherSync = null;
        if (currentAuthUser)
          multiTeacherSync = await syncTimetableTeacherRowsToSupabase(duplicate);
        saveScheduleRepository();
        alert(
          `TKB "${file.name}" trùng với bản đã lưu "${duplicate.file}" (hiệu lực từ Tuần ${duplicate.startWeek}).\n\nĐã cập nhật danh sách và TKB của các giáo viên từ file gốc lên Supabase${multiTeacherSync ? ` (${multiTeacherSync.teachers} giáo viên / ${multiTeacherSync.rows} tiết)` : ""}; không tạo thêm phiên bản trùng.`,
        );
        continue;
      }
      const now = new Date(),
        uploadedAt = now.toISOString(),
        uploadedAtLabel = now.toLocaleString("vi-VN");
      const version = {
        startWeek: sw,
        uploadedAt,
        uploadedAtLabel,
        fingerprint,
        ...parsed,
      };
      if (!currentAuthUser) {
        alert(
          "Bạn cần đăng nhập giáo viên trước khi thêm TKB mới để dữ liệu được lưu đúng tài khoản trên Supabase.",
        );
        continue;
      }
      const sameWeek = scheduleVersions.filter(
        (v) => Number(v.startWeek) === sw,
      );
      let replaceSameWeek = false;
      if (sameWeek.length) {
        replaceSameWeek = confirm(
          `Tuần ${sw} hiện đã có ${sameWeek.length} phiên bản TKB.\n\nOK = lưu bản mới và THAY THẾ các phiên bản cũ cùng mốc Tuần ${sw}.\nCancel = giữ các bản cũ và thêm bản mới song song.`,
        );
      }
      await saveTimetableVersionToSupabase(version);
      scheduleVersions.push(version);
      if (replaceSameWeek) {
        try {
          for (const oldVersion of sameWeek)
            await removeScheduleVersion(oldVersion);
        } catch (cleanErr) {
          console.error(
            "[TKB] Bản mới đã lưu nhưng chưa dọn hết bản cũ cùng tuần",
            cleanErr,
          );
          alert(
            "Bản TKB mới đã được lưu và đang được ưu tiên, nhưng chưa xóa hết bản cũ cùng tuần. Bạn có thể xóa thủ công trong Kho TKB.",
          );
        }
      }
      scheduleVersions.sort(
        (a, b) =>
          a.startWeek - b.startWeek ||
          String(a.uploadedAt || "").localeCompare(String(b.uploadedAt || "")),
      );
      saveScheduleRepository();
      alert(
        `Đã lưu TKB mới vào Supabase. Hiệu lực từ Tuần ${sw}.${replaceSameWeek ? " Các phiên bản cũ cùng tuần đã được thay thế." : ""}`,
      );
    } catch (err) {
      alert(`Không đọc được ${file.name}: ${err.message || err}`);
    }
  }
  activateSelectedWeek();
}
function activateSelectedWeek() {
  const week = Number($("weekSelect").value || 1),
    saved = effectiveScheduleForWeek(week);
  if (saved) {
    loadHomeroomTeacherMap();
    applyHomeroomTeachers(saved.lessons);
    allLessons = sortSchedule(
      applyHomeroomTeachers([...lessonsForSelectedTeacher(saved)]),
    );
    if (Array.isArray(saved.teachers)) updateTeacherSelector(saved.teachers);
    meta = { ...saved, lessons: allLessons };
    finishLoad();
    $("fileInfo").innerHTML +=
      ` · <b>Tuần ${week}</b> · TKB hiệu lực từ <b>Tuần ${saved.startWeek}</b>`;
  } else {
    allLessons = [];
    meta = { file: "", sheets: [], counts: {}, errors: [] };
    $("fileInfo").innerHTML =
      `<b>Tuần ${week}</b> · Chưa có TKB có hiệu lực. Hãy tải TKB đầu năm (hiệu lực từ Tuần 1).`;
    renderStats();
    setOptions("fThu", [], "Tất cả Thứ");
    setOptions("fPoint", [], "Tất cả điểm trường");
    setOptions("fClass", [], "Tất cả lớp");
    $("scan").innerHTML = `<b>Các phiên bản TKB:</b> ${repositorySummary()}`;
    $("errors").innerHTML = "";
    applyLessonPlan();
    render();
  }
}
function finishLoad() {
  const dashboardLessons = allLessons.filter((x) => isValidOutputSubject(x?.monHoc));
  let month =
    meta.file.match(/(?:THÁNG|THANG)\s*([0-9]{1,2})[.\-\s]*(20\d{2})/i) || [];
  $("fileInfo").innerHTML =
    `<b>${esc(meta.file)}</b>${month.length ? ` · TKB tháng ${month[1]}/${month[2]}` : ""} · <b>${allLessons.length} tiết</b>`;
  renderStats();
  setOptions(
    "fThu",
    ["Hai", "Ba", "Tư", "Năm", "Sáu", "Bảy", "Chủ nhật"].filter((d) =>
      dashboardLessons.some((x) => x.thu === d),
    ),
    "Tất cả Thứ",
  );
  setOptions(
    "fPoint",
    dashboardLessons.map((x) => x.diemTruong),
    "Tất cả điểm trường",
  );
  setOptions(
    "fClass",
    dashboardLessons.map((x) => x.lop),
    "Tất cả lớp",
  );
  $("scan").innerHTML =
    `<b>Đã quét: ${meta.sheets.length} sheet</b> · ${meta.sheets.map((s) => `${esc(s)}: ${dashboardLessons.filter((x) => x.sheetNguon === s).length} tiết ${esc(selectedTeacher)}`).join(" · ")} · <b>Tổng: ${dashboardLessons.length}</b><br><small><b>TKB có hiệu lực:</b> ${repositorySummary()}</small>`;
  $("errors").innerHTML = meta.errors.length
    ? `<div class="warn"><b>⚠️ DỮ LIỆU CẦN KIỂM TRA</b><br>${meta.errors.map((x) => `${esc(x.sheetNguon)} → dòng ${x.dongNguon} → cột ${x.cotNguon} → ${esc(x.oNguon)}: <span class="bad">${esc(x.loi)}</span>`).join("<br>")}</div>`
    : `<div class="info ok">✓ Không phát hiện tiết ${esc(selectedTeacher)} thiếu Thứ, Buổi, Lớp, Thời gian, Môn hoặc Tiết.</div>`;
  render();
}
function getConcurrentPeriods() {
  const n = Number($("concurrentPeriods")?.value || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
// BƯỚC 4.3.1: lưu lựa chọn xuất cuối cùng theo đúng tài khoản giáo viên.
function outputSettingsKey() {
  return currentAuthUser?.id
    ? `tkb_output_settings_${currentAuthUser.id}`
    : null;
}
function saveOutputSettings() {
  const key = outputSettingsKey();
  if (!key) return;
  const settings = {
    week: Math.max(1, Math.min(35, Number($("weekSelect")?.value || 1))),
    concurrentPeriods: getConcurrentPeriods(),
  };
  try {
    localStorage.setItem(key, JSON.stringify(settings));
  } catch (e) {
    console.warn("[TKB] Không lưu được cài đặt xuất cuối cùng", e);
  }
}
function restoreOutputSettings() {
  const key = outputSettingsKey();
  if (!key) return;
  try {
    const x = JSON.parse(localStorage.getItem(key) || "null");
    if (!x) return;
    const week = Math.max(1, Math.min(35, Number(x.week) || 1));
    if ($("weekSelect")) $("weekSelect").value = String(week);
    if ($("concurrentPeriods"))
      $("concurrentPeriods").value = String(
        Math.max(0, Math.floor(Number(x.concurrentPeriods) || 0)),
      );
  } catch (e) {
    console.warn("[TKB] Không khôi phục được cài đặt xuất cuối cùng", e);
  }
}
// BƯỚC 4.3.3: điều chỉnh riêng bản kế hoạch xuất, không sửa TKB/Phụ lục 2 gốc.
function outputEditsKey() {
  if (!currentAuthUser?.id) return null;
  return `tkb_output_edits_${currentAuthUser.id}_week_${Math.max(1, Math.min(35, Number($("weekSelect")?.value || 1)))}`;
}
function outputLessonId(x) {
  return [
    clean(x.sheetNguon),
    Number(x.dongNguon) || 0,
    Number(x.cotNguon) || 0,
    clean(x.thu),
    clean(x.buoi),
    Number(x.tiet) || 0,
    clean(x.lop),
    normalizeSubjectForPlan(x.monHoc),
  ].join("|");
}
function loadOutputEdits() {
  const key = outputEditsKey();
  if (!key) return {};
  try {
    const x = JSON.parse(localStorage.getItem(key) || "{}");
    return x && typeof x === "object" && !Array.isArray(x) ? x : {};
  } catch (e) {
    return {};
  }
}
function saveOutputEdits(edits) {
  const key = outputEditsKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(edits || {}));
  } catch (e) {
    console.warn("[TKB] Không lưu được điều chỉnh bản kế hoạch tuần", e);
  }
}
function outputScheduleData() {
  applyLessonPlan();
  const edits = loadOutputEdits();
  return filterSchedule()
    .map((x) => {
      const e = edits[outputLessonId(x)];
      if (e?.deleted) return null;
      if (!e) return x;
      const y = { ...x };
      if (e.monHoc !== undefined) y.monHoc = e.monHoc;
      if (e.lop !== undefined) y.lop = e.lop;
      if (e.title !== undefined)
        y.plan = {
          ...(x.plan || {}),
          title: e.title,
          annualPeriod:
            e.annualPeriod !== undefined
              ? e.annualPeriod
              : x.plan?.annualPeriod || x.planWeek || "",
          week: x.plan?.week || x.planWeek,
          subject: normalizeSubjectForPlan(
            e.monHoc !== undefined ? e.monHoc : x.monHoc,
          ),
          grade: gradeFromClass(e.lop !== undefined ? e.lop : x.lop),
        };
      return y;
    })
    .filter(Boolean);
}
function outputEditRowsHtml() {
  applyLessonPlan();
  const edits = loadOutputEdits();
  const source = filterSchedule();
  if (!source.length)
    return '<div class="preview-edit-empty">Không có tiết học để điều chỉnh.</div>';
  return source
    .map((x, i) => {
      const id = outputLessonId(x),
        e = edits[id] || {},
        deleted = !!e.deleted;
      const mon =
          e.monHoc !== undefined ? e.monHoc : normalizeSubjectForPlan(x.monHoc),
        lop = e.lop !== undefined ? e.lop : clean(x.lop);
      const title =
        e.title !== undefined
          ? e.title
          : x.plan?.title || "[Chưa ghép Phụ lục 2]";
      return `<div class="preview-edit-row ${deleted ? "is-deleted" : ""}" data-output-id="${esc(id)}"><div class="preview-edit-pos"><b>${i + 1}. Thứ ${esc(x.thu)} · ${esc(x.buoi)} · Tiết ${esc(x.tiet)}</b><small>${esc(x.diemTruong || "")}</small></div><label>Môn<input data-edit-field="monHoc" value="${esc(mon)}" ${deleted ? "disabled" : ""}></label><label>Lớp<input data-edit-field="lop" value="${esc(lop)}" ${deleted ? "disabled" : ""}></label><label class="preview-edit-title">Tên bài / Nội dung<textarea data-edit-field="title" rows="2" ${deleted ? "disabled" : ""}>${esc(title)}</textarea></label><button type="button" class="preview-delete-row">${deleted ? "Khôi phục" : "Xóa"}</button></div>`;
    })
    .join("");
}
function formalSubjectGradeText(data) {
  const subjects = [
    ...new Set(
      data.map((x) => normalizeSubjectForPlan(x.monHoc)).filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b, "vi"));
  const grades = [
    ...new Set(
      data
        .map((x) => {
          const m = String(x.lop || "").match(/\d+/);
          return m ? Number(m[0]) : null;
        })
        .filter(Number.isFinite),
    ),
  ].sort((a, b) => a - b);
  return `Môn: ${subjects.join(", ")} – Khối: ${grades.join(", ")}`;
}
function exportExcel() {
  const d = outputScheduleData();
  if (!d.length) return alert("Không có dữ liệu để xuất.");
  const wb = XLSX.utils.book_new();
  const days = ["Hai", "Ba", "Tư", "Năm", "Sáu"];
  const dayLabels = ["Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu"];
  const month =
    meta.file?.match(/(?:THÁNG|THANG)\s*([0-9]{1,2})[.\-\s]*(20\d{2})/i) || [];
  const m = month.length ? Number(month[1]) : "";
  const y = month.length ? Number(month[2]) : "";
  const yearText = y ? `${y} - ${y + 1}` : "2026 - 2027";
  const maxMorning = Math.max(
    4,
    ...d
      .filter((x) => normKey(x.buoi) === "sang")
      .map((x) => Number(x.tiet) || 0),
  );
  const maxAfternoon = Math.max(
    3,
    ...d
      .filter((x) => normKey(x.buoi) === "chieu")
      .map((x) => Number(x.tiet) || 0),
  );
  const rows = [];
  // Tuần xuất phải lấy trực tiếp từ bộ chọn Tuần 1–35, không suy ra từ tên file TKB.
  // File TKB chỉ quyết định phiên bản lịch có hiệu lực; tuần đang chọn quyết định ngày và Phụ lục 2.
  const wd = selectedWeekDates();
  const schoolWeek = wd.week;
  const activityTitle = `Hoạt động giáo dục tuần ${schoolWeek}`;
  const weekLine = `Tuần ${schoolWeek}: từ ngày ${wd.fmt(wd.start)} đến ${wd.fmt(wd.end)}`;
  rows.push(["PHỤ LỤC 1.4", "", "", "", "", "", "", ""]);
  rows.push([activityTitle, "", "", "", "", "", "", ""]);
  rows.push([
    `Năm học ${yearText}. ${formalSubjectGradeText(d)}, Trường TH – THCS & THPT Lại Sơn`,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
  ]);
  rows.push([weekLine, "", "", "", "", "", "", ""]);
  rows.push([
    "Thời gian",
    "",
    ...days.map((x, i) => `Ngày ${wd.days[i]}\n${dayLabels[i]}`),
    "Nội dung điều chỉnh",
  ]);
  // BƯỚC 5.4.3B: tên Thứ đã nằm cùng ô với Ngày ở hàng trên; hàng này chỉ giữ Buổi/Tiết.
  rows.push(["Buổi", "Tiết", ...days.map(() => ""), ""]);
  const morningStart = 7;
  for (let t = 1; t <= maxMorning; t++)
    rows.push([
      "Sáng",
      t,
      ...days.map((day) => excelLessonCellFormal(d, day, "Sáng", t)),
      "",
    ]);
  const afternoonStart = morningStart + maxMorning;
  for (let t = 1; t <= maxAfternoon; t++)
    rows.push([
      "Chiều",
      maxMorning + t,
      ...days.map((day) => excelLessonCellFormal(d, day, "Chiều", t)),
      "",
    ]);
  const totalRow = rows.length + 1;
  rows.push([`Tổng số: ${d.length} tiết`, "", "", "", "", "", "", ""]);
  rows.push(["TỔNG HỢP", "", "", "", "", "", "", ""]);
  rows.push(["TT", "Nội dung", "", "", "Số lượng tiết học", "", "Ghi chú", ""]);
  const subjects = [
    ...new Set(d.map((x) => normalizeSubjectForPlan(x.monHoc)).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, "vi"));
  subjects.forEach((sub, i) =>
    rows.push([
      i + 1,
      sub,
      "",
      "",
      d.filter((x) => normalizeSubjectForPlan(x.monHoc) === sub).length,
      "",
      "",
      "",
    ]),
  );
  // BƯỚC 5.6.2B.8B: khôi phục Kiêm nhiệm như một phần khối lượng công việc,
  // nhưng KHÔNG trộn vào số tiết dạy thực tế trên TKB.
  const concurrent = getConcurrentPeriods();
  if (concurrent > 0)
    rows.push([subjects.length + 1, "Kiêm nhiệm", "", "", concurrent, "", "", ""]);
  const summaryDetailRows = subjects.length + (concurrent > 0 ? 1 : 0);
  const sumRow = rows.length + 1;
  rows.push(["", "Tổng số", "", "", d.length + concurrent, "", "", ""]);
  rows.push(["", "", "", "", "", "", "", ""]);
  const signatureDateRow = rows.length + 1;
  rows.push(["", "", "", "", "", formalSignatureDate(wd), "", ""]);
  const signatureTitleRow = rows.length + 1;
  rows.push([
    "P. HIỆU TRƯỞNG",
    "",
    "TỔ TRƯỞNG",
    "",
    "",
    "NGƯỜI LẬP KẾ HOẠCH",
    "",
    "",
  ]);
  rows.push(["", "", "", "", "", "", "", ""]);
  rows.push(["", "", "", "", "", "", "", ""]);
  const signatureNameRow = rows.length + 1;
  rows.push(["", "", "", "", "", outputTeacherDisplayName(), "", ""]);

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const endSchedule = morningStart + maxMorning + maxAfternoon - 1;
  const merges = [
    "A1:H1",
    "A2:H2",
    "A3:H3",
    "A4:H4",
    "A5:B5",
    "C5:C6",
    "D5:D6",
    "E5:E6",
    "F5:F6",
    "G5:G6",
    "H5:H6",
    `A${morningStart}:A${morningStart + maxMorning - 1}`,
    `A${afternoonStart}:A${afternoonStart + maxAfternoon - 1}`,
    `A${totalRow}:H${totalRow}`,
    `A${totalRow + 1}:H${totalRow + 1}`,
    // Bảng TỔNG HỢP: TT | Nội dung | Số lượng tiết học | Ghi chú
    ...Array.from({ length: summaryDetailRows + 1 }, (_, i) => {
      const r = totalRow + 2 + i;
      return [`B${r}:D${r}`, `E${r}:F${r}`, `G${r}:H${r}`];
    }).flat(),
    `B${sumRow}:D${sumRow}`,
    `E${sumRow}:F${sumRow}`,
    `G${sumRow}:H${sumRow}`,
    `F${signatureDateRow}:H${signatureDateRow}`,
    `A${signatureTitleRow}:B${signatureTitleRow}`,
    `C${signatureTitleRow}:D${signatureTitleRow}`,
    `F${signatureTitleRow}:H${signatureTitleRow}`,
    `F${signatureNameRow}:H${signatureNameRow}`,
  ];
  ws["!merges"] = merges.map(XLSX.utils.decode_range);
  ws["!cols"] = [
    { wch: 10 },
    { wch: 7 },
    ...days.map(() => ({ wch: 22 })),
    { wch: 18 },
  ];
  ws["!rows"] = rows.map((_, i) => ({
    hpt:
      i < 4
        ? [24, 23, 22, 22][i]
        : i === 4 || i === 5
          ? 34
          : i >= 6 && i < endSchedule
            ? 72
            : i >= signatureDateRow - 1
              ? 30
              : 25,
  }));
  ws["!freeze"] = { xSplit: 2, ySplit: 6 };
  // BƯỚC 5.4.3F: bám đúng file Excel mẫu đã được chỉnh thủ công.
  // Chỉ đặt A4 ngang + lề; KHÔNG ép Fit/Scaling, Print Area hay Centering.
  // Excel sẽ dùng đúng kích thước hàng/cột của sheet như file mẫu A1:H26.
  ws["!pageSetup"] = { orientation: "landscape", paperSize: 9 };
  ws["!margins"] = {
    left: 0.25,
    right: 0.25,
    top: 0.3,
    bottom: 0.3,
    header: 0.1,
    footer: 0.1,
  };
  const black = "17382B",
    navy = "0B7A53",
    navy2 = "148A5B",
    pale = "F4FBF6",
    light = "EAF7EF",
    sessionFill = "DDF2E5",
    totalFill = "CFEBD8",
    white = "FFFFFF",
    grid = "9BC9AE";
  const thin = { style: "thin", color: { rgb: grid } },
    med = { style: "medium", color: { rgb: navy } };
  const border = { top: thin, bottom: thin, left: thin, right: thin };
  const center = { horizontal: "center", vertical: "center", wrapText: true };
  for (let R = 0; R < rows.length; R++)
    for (let C = 0; C < 8; C++) {
      const a = XLSX.utils.encode_cell({ r: R, c: C });
      if (!ws[a]) ws[a] = { t: "s", v: "" };
      ws[a].s = {
        font: { name: "Times New Roman", sz: 11, color: { rgb: black } },
        alignment: { vertical: "center", wrapText: true },
        border,
      };
    }
  // Khối tiêu đề là văn bản hành chính: không kẻ khung/đường viền.
  for (let R = 0; R < 4; R++)
    for (let C = 0; C < 8; C++) {
      const a = XLSX.utils.encode_cell({ r: R, c: C });
      if (!ws[a]) ws[a] = { t: "s", v: "" };
      ws[a].s = {
        font: {
          name: "Times New Roman",
          sz: R === 0 ? 14 : R === 1 ? 12 : 11,
          bold: true,
          color: { rgb: black },
        },
        alignment: center,
        border: {},
      };
    }
  for (let C = 0; C < 8; C++)
    for (let R = 4; R <= 5; R++) {
      let a = XLSX.utils.encode_cell({ r: R, c: C });
      ws[a].s = {
        font: {
          name: "Times New Roman",
          sz: 11,
          bold: true,
          color: { rgb: white },
        },
        alignment: center,
        border: { top: med, bottom: med, left: thin, right: thin },
        fill: { patternType: "solid", fgColor: { rgb: navy } },
      };
    }
  for (let R = 6; R < endSchedule; R++)
    for (let C = 0; C < 8; C++) {
      let a = XLSX.utils.encode_cell({ r: R, c: C });
      ws[a].s = {
        font: {
          name: "Times New Roman",
          sz: 11,
          bold: C < 2,
          color: { rgb: black },
        },
        alignment:
          C < 2
            ? center
            : { horizontal: "left", vertical: "center", wrapText: true },
        border,
        fill: {
          patternType: "solid",
          fgColor: { rgb: C < 2 ? sessionFill : R % 2 ? pale : white },
        },
      };
    }
  ws[`A${morningStart}`].s.font.bold = true;
  ws[`A${afternoonStart}`].s.font.bold = true;
  for (let C = 0; C < 8; C++) {
    let a = XLSX.utils.encode_cell({ r: endSchedule - 1, c: C });
    if (ws[a]) ws[a].s.border.bottom = med;
  }
  // Tổng số tiết
  for (let C = 0; C < 8; C++) {
    const a = XLSX.utils.encode_cell({ r: totalRow - 1, c: C });
    ws[a].s = {
      font: {
        name: "Times New Roman",
        sz: 11,
        bold: true,
        color: { rgb: white },
      },
      alignment: center,
      border: { top: med, bottom: med, left: thin, right: thin },
      fill: { patternType: "solid", fgColor: { rgb: navy } },
    };
  }
  // Tổng hợp
  ws[`A${totalRow + 1}`].s = {
    font: {
      name: "Times New Roman",
      sz: 12,
      bold: true,
      color: { rgb: black },
    },
    alignment: center,
    border: {},
    fill: { patternType: "solid", fgColor: { rgb: light } },
  };
  for (let C = 0; C < 8; C++) {
    let a = XLSX.utils.encode_cell({ r: totalRow + 1, c: C });
    ws[a].s = {
      font: {
        name: "Times New Roman",
        sz: 11,
        bold: true,
        color: { rgb: white },
      },
      alignment: center,
      border,
      fill: { patternType: "solid", fgColor: { rgb: navy2 } },
    };
  }
  for (let R = totalRow + 2; R < sumRow; R++)
    for (let C = 0; C < 8; C++) {
      let a = XLSX.utils.encode_cell({ r: R, c: C });
      ws[a].s = {
        font: {
          name: "Times New Roman",
          sz: 11,
          bold: false,
          color: { rgb: black },
        },
        alignment: center,
        border,
        fill: { patternType: "solid", fgColor: { rgb: R % 2 ? pale : white } },
      };
    }
  for (let C = 0; C < 8; C++) {
    let a = XLSX.utils.encode_cell({ r: sumRow - 1, c: C });
    ws[a].s = {
      font: {
        name: "Times New Roman",
        sz: 11,
        bold: true,
        color: { rgb: white },
      },
      alignment: center,
      border: { top: med, bottom: med, left: thin, right: thin },
      fill: { patternType: "solid", fgColor: { rgb: navy2 } },
    };
  }
  // Khu vực ngày ký/chữ ký là phần văn bản, không có bất kỳ khung ô nào.
  for (let R = sumRow; R < rows.length; R++)
    for (let C = 0; C < 8; C++) {
      const a = XLSX.utils.encode_cell({ r: R, c: C });
      if (!ws[a]) ws[a] = { t: "s", v: "" };
      ws[a].s = {
        font: { name: "Times New Roman", sz: 11, color: { rgb: black } },
        alignment: { vertical: "center", wrapText: true },
        border: {},
      };
    }
  for (let C = 0; C < 8; C++) {
    let a = XLSX.utils.encode_cell({ r: signatureDateRow - 1, c: C });
    ws[a].s = {
      font: { name: "Times New Roman", sz: 11, italic: true },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
      border: {},
    };
  }
  [signatureTitleRow - 1, signatureNameRow - 1].forEach((r) => {
    for (let C = 0; C < 8; C++) {
      let a = XLSX.utils.encode_cell({ r, c: C });
      ws[a].s = {
        font: { name: "Times New Roman", sz: 11, bold: true },
        alignment: center,
        border: {},
      };
    }
  });
  XLSX.utils.book_append_sheet(wb, ws, "TKB tuần");

  const src = [
    [
      "Sheet",
      "Dòng",
      "Cột",
      "Ô nguồn",
      "Nội dung ô gốc",
      "Thứ",
      "Buổi",
      "Tiết nguồn",
      "Tiết xác định",
      "Thời gian",
      "Lớp",
      "Môn học",
      "Điểm trường",
      "Ghi chú",
    ],
    ...d.map((x) => [
      x.sheetNguon,
      x.dongNguon,
      `${colLetter(x.cotNguon - 1)} (${x.cotNguon})`,
      `${x.sheetNguon}!${colLetter(x.cotNguon - 1)}${x.dongNguon}`,
      x.oNguon,
      `Thứ ${x.thu}`,
      clean(x.buoi),
      x.tietNguon || "",
      x.tiet,
      x.thoiGian,
      x.lop,
      normalizeSubjectForPlan(x.monHoc),
      x.diemTruong,
      x.ghiChuTiet || "",
    ]),
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(src);
  ws2["!cols"] = [9, 8, 9, 13, 22, 11, 10, 11, 12, 18, 10, 18, 22, 48].map(
    (w) => ({ wch: w }),
  );
  ws2["!autofilter"] = { ref: `A1:N${src.length}` };
  ws2["!pageSetup"] = {
    orientation: "landscape",
    paperSize: 9,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
  };
  ws2["!margins"] = {
    left: 0.25,
    right: 0.25,
    top: 0.3,
    bottom: 0.3,
    header: 0.1,
    footer: 0.1,
  };
  for (let R = 0; R < src.length; R++)
    for (let C = 0; C < 14; C++) {
      const a = XLSX.utils.encode_cell({ r: R, c: C });
      if (!ws2[a]) continue;
      ws2[a].s = {
        font: {
          name: "Times New Roman",
          sz: 12,
          bold: R === 0,
          color: { rgb: R === 0 ? "FFFFFF" : "000000" },
        },
        fill: R === 0 ? { fgColor: { rgb: navy } } : undefined,
        alignment: {
          horizontal: R === 0 ? "center" : "left",
          vertical: "center",
          wrapText: true,
        },
        border,
      };
    }
  XLSX.utils.book_append_sheet(wb, ws2, "Đối chiếu nguồn");
  XLSX.writeFile(wb, `TKB_CA_NHAN_${outputTeacherFileKey()}_TUAN_${wd.week}.xlsx`, {
    cellStyles: true,
  });
}
function isOptionalPracticeSubject(subject) {
  const k = curriculumSubjectKey(subject);
  return k === "ltt" || k === "lttv";
}
function excelLessonCellFormal(data, day, session, tiet) {
  const items = data.filter(
    (x) =>
      x.thu === day &&
      normKey(x.buoi) === normKey(session) &&
      Number(x.tiet) === Number(tiet),
  );
  return items
    .map((x) => {
      const sub = normalizeSubjectForPlan(x.monHoc);
      const planTiet = x.plan?.annualPeriod || x.plan?.week || x.planWeek || "";
      const lesson = x.plan?.title
        ? `Tiết ${planTiet} - ${x.plan.title}`
        : isOptionalPracticeSubject(x.monHoc) ? "" : `[Chưa ghép Phụ lục 2]`;
      return `${sub} ${clean(x.lop)}${lesson ? ` ${lesson}` : ""}`;
    })
    .join("\n────────\n");
}

function excelLessonCell(data, day, session, tiet) {
  const items = data.filter(
    (x) =>
      x.thu === day &&
      normKey(x.buoi) === normKey(session) &&
      Number(x.tiet) === Number(tiet),
  );
  return items
    .map(
      (x) =>
        `${x.monHoc} ${x.lop}\n${clean(x.diemTruong).replace(/^Điểm\s+/i, "Điểm ")}\n${x.thoiGian}`,
    )
    .join("\n────────\n");
}
function selectedWeekDates() {
  const week = Number($("weekSelect")?.value || 1),
    r =
      schoolCalendar.weeks.find((x) => Number(x.week) === week) ||
      generateSchoolWeeks("2026-09-07", [])[week - 1];
  const start = parseLocalDate(r.start),
    end = parseLocalDate(r.end),
    days = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    days.push(fmtDateVN(d));
  }
  return { week, start, end, days, fmt: (d) => fmtDateVN(d) };
}
function formalSignatureDate(wd) {
  const d = new Date(wd.start);
  d.setDate(d.getDate() - 1);
  const pad = (n) => String(n).padStart(2, "0");
  return `Đặc khu Kiên Hải, ngày ${pad(d.getDate())} tháng ${pad(d.getMonth() + 1)} năm ${d.getFullYear()}`;
}
function formalLessonHtml(data, day, session, tiet) {
  const items = data.filter(
    (x) =>
      x.thu === day &&
      normKey(x.buoi) === normKey(session) &&
      Number(x.tiet) === Number(tiet),
  );
  return items
    .map((x) => {
      const sub = normalizeSubjectForPlan(x.monHoc),
        title = x.plan?.title || "",
        planTiet = x.plan?.annualPeriod || x.plan?.week || x.planWeek || "";
      if (!x.plan && isOptionalPracticeSubject(x.monHoc))
        return `<div class="formal-lesson"><b>${esc(sub)} ${esc(x.lop)}</b></div>`;
      return `<div class="formal-lesson"><b>${esc(sub)} ${esc(x.lop)}</b>${x.plan ? ` Tiết ${esc(planTiet)} - ` : " - "}${esc(title || "[Chưa ghép Phụ lục 2]")}</div>`;
    })
    .join("<hr>");
}
function outputTeacherDisplayName() {
  return normalizeTeacherName(selectedTeacher) === normalizeTeacherName(TEACHER)
    ? "Võ Thanh Đậm"
    : clean(selectedTeacher);
}
function outputTeacherFileKey() {
  return normKey(outputTeacherDisplayName()).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "GIAO_VIEN";
}
function isValidOutputSubject(subject) {
  const key = curriculumSubjectKey(normalizeSubjectForPlan(subject));
  return new Set([
    "tinhoc", "congnghe", "daoduc", "tiengviet", "toan",
    "khoahoc", "tnxh", "lsdl", "mythuat", "amnhac", "gdtc",
    "tienganh", "ltt", "lttv", "hdgdcd", "shdc", "shl"
  ]).has(key);
}
function buildFormalOutput(data) {
  applyLessonPlan();
  // BƯỚC 5.6.2B.7A: chỉ các tiết có môn học hợp lệ mới được đưa vào
  // Phụ lục 1.4/TỔNG HỢP. Loại các ô rác từ bảng Cộng như 1,2,3,4,
  // "18+4CN=22"...; không ép tổng theo bảng Cộng.
  data = (data || []).filter((x) => isValidOutputSubject(x.monHoc));
  const wd = selectedWeekDates(),
    days = ["Hai", "Ba", "Tư", "Năm", "Sáu"],
    labels = ["Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu"];
  const morning = Math.max(
      4,
      ...data
        .filter((x) => normKey(x.buoi) === "sang")
        .map((x) => Number(x.tiet) || 0),
    ),
    afternoon = Math.max(
      3,
      ...data
        .filter((x) => normKey(x.buoi) === "chieu")
        .map((x) => Number(x.tiet) || 0),
    );
  const subjects = [
    ...new Set(data.map((x) => normalizeSubjectForPlan(x.monHoc))),
  ].filter(Boolean);
  let grid = `<table class="formal-grid"><colgroup><col class="col-session"><col class="col-period">${days.map(() => '<col class="col-day">').join("")}<col class="col-adjust"></colgroup><thead><tr><th colspan="2">Thời gian</th>${labels.map((l, i) => `<th rowspan="2">Ngày ${wd.days[i]}<br>${l}</th>`).join("")}<th rowspan="2">Nội dung điều chỉnh</th></tr><tr><th>Buổi</th><th>Tiết</th></tr></thead><tbody>`;
  for (let t = 1; t <= morning; t++)
    grid += `<tr>${t === 1 ? `<th rowspan="${morning}">Sáng</th>` : ""}<th>${t}</th>${days.map((day) => `<td>${formalLessonHtml(data, day, "Sáng", t)}</td>`).join("")}<td></td></tr>`;
  for (let t = 1; t <= afternoon; t++)
    grid += `<tr>${t === 1 ? `<th rowspan="${afternoon}">Chiều</th>` : ""}<th>${morning + t}</th>${days.map((day) => `<td>${formalLessonHtml(data, day, "Chiều", t)}</td>`).join("")}<td></td></tr>`;
  grid += `<tr class="formal-grid-total"><th colspan="8">Tổng số: ${data.length} tiết</th></tr></tbody></table>`;
  // BƯỚC 5.6.2B.8B: TKB vẫn hiển thị đúng số tiết dạy thực tế;
  // Kiêm nhiệm chỉ xuất hiện trong TỔNG HỢP và được cộng vào tổng khối lượng.
  const concurrent = getConcurrentPeriods();
  const concurrentRow = concurrent > 0
    ? `<tr><td>${subjects.length + 1}</td><td>Kiêm nhiệm</td><td>${concurrent}</td><td></td></tr>`
    : "";
  let sum = `<h3>TỔNG HỢP</h3><table class="formal-summary"><tr><th>TT</th><th>Nội dung</th><th>Số lượng tiết học</th><th>Ghi chú</th></tr>${subjects.map((sub, i) => `<tr><td>${i + 1}</td><td>${esc(sub)}</td><td>${data.filter((x) => normalizeSubjectForPlan(x.monHoc) === sub).length}</td><td></td></tr>`).join("")}${concurrentRow}<tr class="formal-summary-total"><th></th><th>Tổng số</th><th>${data.length + concurrent}</th><th></th></tr></table>`;
  return `<section id="formalOutput" class="formal-output"><div class="formal-title"><b>PHỤ LỤC 1.4</b><h2>Hoạt động giáo dục tuần ${wd.week}</h2><p><b>Năm học 2026 – 2027. ${esc(formalSubjectGradeText(data))}, Trường TH – THCS & THPT Lại Sơn</b></p><p><b>Tuần ${wd.week}: từ ngày ${wd.fmt(wd.start)} đến ${wd.fmt(wd.end)}</b></p></div>${grid}${sum}<div class="formal-date">${esc(formalSignatureDate(wd))}</div><div class="formal-sign"><div><b>P. HIỆU TRƯỞNG</b></div><div><b>TỔ TRƯỞNG</b></div><div><b>NGƯỜI LẬP KẾ HOẠCH</b><br><br><br><b>${esc(outputTeacherDisplayName())}</b></div></div></section>`;
}
function ensureFormalOutputStyles() {
  if (document.getElementById("formalOutputStylesV42")) return;
  const style = document.createElement("style");
  style.id = "formalOutputStylesV42";
  style.textContent = `
    .formal-holder{position:fixed;left:-10000px;top:0;width:283mm;background:#fff;z-index:-1}
    .formal-output{box-sizing:border-box;width:283mm;padding:3mm 2.5mm 2mm;background:#fff;color:#000;font-family:"Times New Roman",serif;font-size:12pt;line-height:1.12}
    .formal-title{text-align:center;margin:0 0 2mm}.formal-title>b{display:block;font-size:13pt;line-height:1.1;letter-spacing:.15px}.formal-title h2{font-size:13pt;line-height:1.1;margin:.65mm 0;font-weight:700}.formal-title p{font-size:12pt;line-height:1.12;margin:.45mm 0}
    .formal-grid,.formal-summary{width:100%;border-collapse:collapse;table-layout:fixed;border:1.15px solid #000}
    .formal-grid th,.formal-grid td,.formal-summary th,.formal-summary td{border:1px solid #000;padding:.75mm .9mm;vertical-align:middle;text-align:center;font-size:12pt;overflow-wrap:break-word;word-break:normal}
    .formal-grid thead{display:table-header-group}.formal-grid thead th{font-weight:700;line-height:1.08;padding:.8mm .65mm}.formal-grid tr,.formal-summary tr{break-inside:avoid;page-break-inside:avoid}
    .formal-grid .col-session{width:13mm}.formal-grid .col-period{width:10mm}.formal-grid .col-adjust{width:25mm}.formal-grid .col-day{width:auto}
    .formal-grid tbody>tr>th:first-child{font-weight:700}.formal-grid-total th{font-weight:700;text-align:center;padding:.7mm 1mm;border-top:1.15px solid #000}
    .formal-lesson{font-size:12pt;line-height:1.12;text-align:left;padding:0 .15mm}.formal-lesson b{font-size:12pt;font-weight:700}.formal-lesson+hr{border:0;border-top:.3px solid #777;margin:.65mm 0}
    .formal-output h3{text-align:center;font-size:12pt;line-height:1.1;margin:2mm 0 .8mm;font-weight:700}.formal-summary{width:78%;margin:0 auto}.formal-summary th,.formal-summary td{padding:.65mm 1mm;line-height:1.08}.formal-summary tr:first-child th{font-weight:700}.formal-summary td:nth-child(1),.formal-summary th:nth-child(1){width:10%}.formal-summary td:nth-child(2),.formal-summary th:nth-child(2){width:42%}.formal-summary td:nth-child(3),.formal-summary th:nth-child(3){width:26%}.formal-summary td:nth-child(4),.formal-summary th:nth-child(4){width:22%}.formal-summary-total th,.formal-summary-total td{font-weight:700!important;border-top:1.15px solid #000!important}
    .formal-date{text-align:right;font-style:italic;font-size:12pt;margin:2mm 5mm .8mm 0}.formal-sign{display:grid;grid-template-columns:1fr 1fr 1fr;text-align:center;gap:8mm;margin-top:.8mm;min-height:22mm;font-size:12pt;line-height:1.12}.formal-sign>div{padding-top:.4mm}
    .formal-grid thead th,.formal-summary tr:first-child th{background:#0B7A53!important;color:#fff!important;border-color:#6FAE8B!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .formal-grid tbody>tr>th:first-child{background:#EAF7EF!important;color:#17382B!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .formal-grid tbody>tr>th[rowspan]+th{background:#0B7A53!important;color:#fff!important;border-color:#6FAE8B!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .formal-grid tbody tr:nth-child(even) td{background:#F6FBF7!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .formal-grid-total th,.formal-summary-total th,.formal-summary-total td{background:#CFEBD8!important;color:#17382B!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .formal-summary tbody tr:not(:first-child):not(.formal-summary-total):nth-child(odd) td{background:#F4FBF6!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .formal-grid,.formal-summary,.formal-grid th,.formal-grid td,.formal-summary th,.formal-summary td{border-color:#76A98B!important}
    #outputPreviewModal .output-preview-scroll{background:#dfe5ec!important;padding:22px!important}#outputPreviewModal .output-preview-scroll .formal-output{border:1px solid #c7cdd5;box-shadow:0 8px 28px rgba(15,23,42,.18)!important}
    #outputPreviewModal .multi-week-card{margin-bottom:22px}#outputPreviewModal .multi-week-card:last-child{margin-bottom:0}
    @media print{
      @page{size:A4 landscape;margin:5mm}
      html,body{margin:0!important;padding:0!important}
      body.printing-formal>*:not(.print-formal){display:none!important}
      body.printing-formal .print-formal{position:static!important;left:auto!important;top:auto!important;width:287mm!important;margin:0!important;z-index:auto!important}
      body.printing-formal .formal-output{width:287mm!important;padding:0!important;margin:0 auto!important;border:0!important;box-shadow:none!important}
      body.printing-formal .formal-grid th,body.printing-formal .formal-grid td{padding:.5mm .7mm!important}
      body.printing-formal .formal-grid{table-layout:fixed!important}
      body.printing-formal .formal-title{margin-bottom:1.4mm!important}
      body.printing-formal .formal-output h3{margin-top:1.6mm!important}
      .formal-grid tr,.formal-summary tr,.formal-sign{break-inside:avoid;page-break-inside:avoid}
      .formal-summary,.formal-date,.formal-sign{break-inside:avoid;page-break-inside:avoid}
    }`;
  document.head.appendChild(style);
}
function ensureWeekForOutput() {
  const previous = currentView;
  if (currentView !== "week") {
    currentView = "week";
    render();
  }
  return previous;
}
async function exportPDF() {
  const d = outputScheduleData();
  if (!d.length) return alert("Không có dữ liệu để xuất.");
  if (!lessonPlanMap.size)
    return alert(
      "Hãy tải Phụ lục 2 trước khi xuất PDF để có đầy đủ tên bài học.",
    );
  if (typeof html2canvas === "undefined")
    return alert("Không tải được thư viện xuất PDF.");
  ensureFormalOutputStyles();
  const holder = document.createElement("div");
  holder.className = "formal-holder";
  holder.innerHTML = buildFormalOutput(d);
  document.body.appendChild(holder);
  try {
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
    const target = holder.querySelector(".formal-output"),
      canvas = await html2canvas(target, {
        scale: 2,
        backgroundColor: "#ffffff",
        useCORS: true,
        logging: false,
        windowWidth: target.scrollWidth,
      });
    const { jsPDF } = window.jspdf,
      pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" }),
      pw = 297,
      ph = 210,
      margin = 5,
      maxW = pw - margin * 2,
      maxH = ph - margin * 2;
    // Giữ cỡ chữ theo chiều rộng A4 ngang và chỉ ngắt PDF tại ranh giới hàng/khối.
    const drawW = maxW,
      pxPerMm = canvas.width / drawW,
      maxSlicePx = Math.floor(maxH * pxPerMm);
    const scaleY = canvas.height / target.scrollHeight,
      top0 = target.getBoundingClientRect().top;
    const cuts = [
      0,
      ...[
        ...target.querySelectorAll(
          ".formal-grid tr,.formal-summary tr,.formal-date,.formal-sign",
        ),
      ].map((el) =>
        Math.round((el.getBoundingClientRect().bottom - top0) * scaleY),
      ),
      canvas.height,
    ]
      .filter((v, i, a) => v >= 0 && v <= canvas.height && a.indexOf(v) === i)
      .sort((a, b) => a - b);
    let y0 = 0,
      page = 0;
    while (y0 < canvas.height - 2) {
      const limit = Math.min(canvas.height, y0 + maxSlicePx);
      let y1 = cuts.filter((v) => v > y0 + 20 && v <= limit).pop() || limit;
      if (y1 <= y0) y1 = limit;
      const slice = document.createElement("canvas");
      slice.width = canvas.width;
      slice.height = y1 - y0;
      slice
        .getContext("2d")
        .drawImage(
          canvas,
          0,
          y0,
          canvas.width,
          y1 - y0,
          0,
          0,
          canvas.width,
          y1 - y0,
        );
      if (page++) pdf.addPage("a4", "landscape");
      const drawH = (y1 - y0) / pxPerMm;
      pdf.addImage(
        slice.toDataURL("image/jpeg", 0.96),
        "JPEG",
        margin,
        margin,
        drawW,
        drawH,
        undefined,
        "FAST",
      );
      y0 = y1;
    }
    pdf.save(`PHU_LUC_1_4_TUAN_${$("weekSelect").value}.pdf`);
  } finally {
    holder.remove();
  }
}
async function openOutputPreview() {
  if (!filterSchedule().length)
    return alert("Không có dữ liệu để xem trước.");
  let d;
  try {
    d = await sharedCurriculumPreviewData();
  } catch (err) {
    console.error("[TKB] Không đọc được PPCT chung cho Xem trước", err);
    return alert(`Chưa đọc được kho PPCT chung để Xem trước: ${err?.message || err}`);
  }
  ensureFormalOutputStyles();
  document.getElementById("outputPreviewModal")?.remove();
  const modal = document.createElement("div");
  modal.id = "outputPreviewModal";
  modal.className = "output-preview-modal";
  const renderPreview = async () => {
    try {
      d = await sharedCurriculumPreviewData();
    } catch (err) {
      console.error("[TKB] Không làm mới được PPCT chung trong Xem trước", err);
    }
    const body = modal.querySelector(".output-preview-scroll");
    if (body)
      body.innerHTML = d.length
        ? buildFormalOutput(d)
        : '<div class="preview-no-lessons">Bản xuất hiện không còn tiết nào. Có thể vào Sửa để khôi phục.</div>';
    const editBody = modal.querySelector(".output-edit-body");
    if (editBody) editBody.innerHTML = outputEditRowsHtml();
    bindEditRows();
  };
  modal.innerHTML = `<div class="output-preview-dialog"><div class="output-preview-bar"><b>XEM TRƯỚC PHỤ LỤC 1.4 · TUẦN ${esc($("weekSelect").value)}</b><div><button type="button" class="preview-edit">Sửa</button><button type="button" class="preview-export-excel">Xuất Excel</button><button type="button" class="preview-export-pdf">Xuất PDF</button><button type="button" class="preview-print">In</button><button type="button" class="preview-close">Đóng</button></div></div><div class="output-edit-panel" hidden><div class="output-edit-head"><b>ĐIỀU CHỈNH BẢN KẾ HOẠCH TUẦN</b><span>Chỉ ảnh hưởng bản xuất, không sửa TKB hoặc Phụ lục 2 gốc.</span><div><button type="button" class="preview-update">Cập nhật</button><button type="button" class="preview-reset">Xóa điều chỉnh tuần</button></div></div><div class="output-edit-body">${outputEditRowsHtml()}</div></div><div class="output-preview-scroll">${d.length ? buildFormalOutput(d) : ""}</div></div>`;
  document.body.appendChild(modal);
  if (!document.getElementById("outputPreviewStylesV433")) {
    const st = document.createElement("style");
    st.id = "outputPreviewStylesV433";
    st.textContent = `
      .output-preview-modal{position:fixed;inset:0;background:rgba(15,23,42,.72);z-index:100000;display:flex;align-items:center;justify-content:center;padding:18px}
      .output-preview-dialog{width:min(97vw,1550px);height:95vh;background:#e9edf2;border-radius:10px;box-shadow:0 24px 70px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden}
      .output-preview-bar{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 14px;background:#fff;border-bottom:1px solid #cbd5e1;font-family:Arial,sans-serif}
      .output-preview-bar>div,.output-edit-head>div{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.output-preview-bar button,.output-edit-panel button{height:36px;border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:8px;padding:0 14px;cursor:pointer;font:600 13px Arial,sans-serif;box-shadow:0 1px 2px rgba(15,23,42,.06);transition:.15s ease}.output-preview-bar button:hover,.output-edit-panel button:hover{background:#f8fafc;border-color:#94a3b8;transform:translateY(-1px)}.output-preview-bar .preview-export-pdf,.output-preview-bar .preview-export-excel,.output-preview-bar .preview-print{background:#0f4c81;color:#fff;border-color:#0f4c81}.output-preview-bar .preview-export-pdf:hover,.output-preview-bar .preview-export-excel:hover,.output-preview-bar .preview-print:hover{background:#123f68;border-color:#123f68}.output-preview-bar .preview-edit{background:#eef6ff;color:#0f4c81;border-color:#b8d6f2}.output-preview-bar .preview-close{background:#f8fafc}.output-edit-panel .preview-update{background:#0f4c81;color:#fff;border-color:#0f4c81}.output-edit-panel .preview-reset,.preview-delete-row{background:#fff7f7!important;color:#b42318!important;border-color:#f3b7b2!important}
      .output-preview-scroll{flex:1;overflow:auto;padding:18px}.output-preview-scroll .formal-output{margin:0 auto;box-shadow:0 3px 18px rgba(0,0,0,.16)}
      .output-edit-panel{flex:1;overflow:auto;background:#fff;padding:14px 16px;font-family:Arial,sans-serif}.output-edit-head{position:sticky;top:-14px;z-index:2;background:#fff;padding:10px 0;border-bottom:1px solid #dbe3ec;display:grid;grid-template-columns:1fr auto;gap:4px 12px;align-items:center}.output-edit-head>span{font-size:12px;color:#64748b}.output-edit-head>div{grid-row:1/3;grid-column:2}
      .preview-edit-row{display:grid;grid-template-columns:190px 150px 110px minmax(360px,1fr) 76px;gap:10px;align-items:end;padding:10px 0;border-bottom:1px solid #e2e8f0}.preview-edit-row label{font-size:12px;font-weight:700;color:#475569}.preview-edit-row input,.preview-edit-row textarea{box-sizing:border-box;width:100%;margin-top:4px;border:1px solid #cbd5e1;border-radius:5px;padding:7px 8px;font:14px Arial,sans-serif;background:#fff}.preview-edit-row textarea{resize:vertical}.preview-edit-pos{align-self:center}.preview-edit-pos small{display:block;color:#64748b;margin-top:4px}.preview-edit-row.is-deleted{opacity:.55;background:#f8fafc}.preview-delete-row{align-self:center}.preview-no-lessons,.preview-edit-empty{padding:28px;text-align:center;color:#64748b}
    `;
    document.head.appendChild(st);
  }
  const bindEditRows = () => {
    modal.querySelectorAll(".preview-delete-row").forEach(
      (btn) =>
        (btn.onclick = () => {
          const row = btn.closest("[data-output-id]"),
            id = row.dataset.outputId,
            edits = loadOutputEdits(),
            old = edits[id] || {};
          edits[id] = { ...old, deleted: !old.deleted };
          saveOutputEdits(edits);
          renderPreview();
        }),
    );
  };
  bindEditRows();
  const close = () => modal.remove();
  modal.querySelector(".preview-close").onclick = close;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  modal.querySelector(".preview-edit").onclick = () => {
    const p = modal.querySelector(".output-edit-panel"),
      v = modal.querySelector(".output-preview-scroll"),
      show = p.hidden;
    p.hidden = !show;
    v.style.display = show ? "none" : "";
    modal.querySelector(".preview-edit").textContent = show
      ? "Xem bản kế hoạch"
      : "Sửa";
  };
  modal.querySelector(".preview-update").onclick = () => {
    const edits = loadOutputEdits();
    modal
      .querySelectorAll(".preview-edit-row[data-output-id]")
      .forEach((row) => {
        const id = row.dataset.outputId,
          old = edits[id] || {};
        if (old.deleted) return;
        const val = (f) =>
          row.querySelector(`[data-edit-field="${f}"]`)?.value ?? "";
        edits[id] = {
          ...old,
          monHoc: clean(val("monHoc")),
          lop: clean(val("lop")),
          title: clean(val("title")),
        };
      });
    saveOutputEdits(edits);
    renderPreview();
    const p = modal.querySelector(".output-edit-panel"),
      v = modal.querySelector(".output-preview-scroll");
    p.hidden = true;
    v.style.display = "";
    modal.querySelector(".preview-edit").textContent = "Sửa";
  };
  modal.querySelector(".preview-reset").onclick = () => {
    if (
      !confirm(
        "Xóa toàn bộ điều chỉnh riêng của tuần này và trở về dữ liệu gốc?",
      )
    )
      return;
    const key = outputEditsKey();
    if (key) localStorage.removeItem(key);
    renderPreview();
  };
  modal.querySelector(".preview-export-excel").onclick = () => exportExcel();
  modal.querySelector(".preview-export-pdf").onclick = () => exportPDF();
  modal.querySelector(".preview-print").onclick = () => {
    close();
    printSchedule();
  };
}
function ensurePreviewButton() {
  // BƯỚC 4.3.5: giao diện chính chỉ giữ Xem trước; các lệnh xuất vẫn dùng trong cửa sổ xem trước.
  const exportButtons = ["excelBtn", "pdfBtn", "printBtn"]
    .map((id) => $(id))
    .filter(Boolean);
  const anchor = exportButtons[0];
  if (!anchor) return;
  exportButtons.forEach((btn) => {
    btn.style.display = "none";
    btn.setAttribute("aria-hidden", "true");
  });
  if (document.getElementById("previewBtn")) return;
  const b = document.createElement("button");
  b.type = "button";
  b.id = "previewBtn";
  b.className = anchor.className;
  b.textContent = "Xem trước";
  b.title = "Xem trước Phụ lục 1.4 trước khi xuất";
  b.onclick = openOutputPreview;
  anchor.parentNode.insertBefore(b, anchor);
}
function printSchedule() {
  const d = outputScheduleData();
  if (!d.length) return alert("Không có dữ liệu để in.");
  if (!lessonPlanMap.size)
    return alert("Hãy tải Phụ lục 2 trước khi in để có đầy đủ tên bài học.");
  ensureFormalOutputStyles();
  const holder = document.createElement("div");
  holder.className = "formal-holder print-formal";
  holder.innerHTML = buildFormalOutput(d);
  // BƯỚC 4.2-R5: riêng bản In, giữ dòng Tổng số đúng 4 cột của bảng tổng hợp.
  const printTotalRow = holder.querySelector(".formal-summary tr:last-child");
  if (printTotalRow) {
    const totalValue =
      printTotalRow.querySelectorAll("th")[1]?.textContent ||
      String(d.length + getConcurrentPeriods());
    printTotalRow.innerHTML = `<th></th><th>Tổng số</th><th>${esc(totalValue)}</th><th></th>`;
  }
  document.body.appendChild(holder);
  document.body.classList.add("printing-formal");
  const restore = () => {
    document.body.classList.remove("printing-formal");
    holder.remove();
    window.removeEventListener("afterprint", restore);
  };
  window.addEventListener("afterprint", restore);
  setTimeout(() => window.print(), 80);
}
$("loginBtn") && ($("loginBtn").onclick = openAuthModal);
$("logoutBtn") && ($("logoutBtn").onclick = logoutTeacher);
initWeekSelect();
initSupabaseConnection();
loadScheduleRepository();
loadSchoolCalendar();
activateSelectedWeek();
$("fileInput").addEventListener(
  "change",
  (e) => e.target.files.length && readWorkbooks(e.target.files),
);
$("teacherSelect") &&
  $("teacherSelect").addEventListener("change", (e) =>
    switchViewedTeacher(e.target.value),
  );
updateTeacherSelector();
$("pl2Input").addEventListener(
  "change",
  (e) => e.target.files[0] && readLessonPlan(e.target.files[0]),
);
$("weekSelect").addEventListener("change", () => {
  saveOutputSettings();
  activateSelectedWeek();
});
$("calendarBtn") && ($("calendarBtn").onclick = openCalendarManager);
$("repoBtn") && ($("repoBtn").onclick = openRepoManager);
$("appendix2RepoBtn") &&
  ($("appendix2RepoBtn").onclick = openAppendix2RepoManager);
$("curriculumProbeBtn") &&
  ($("curriculumProbeBtn").onclick = probeSharedCurriculum);
$("concurrentPeriods").addEventListener("change", () => {
  if (Number($("concurrentPeriods").value) < 0)
    $("concurrentPeriods").value = 0;
  saveOutputSettings();
});
["fThu", "fBuoi", "fPoint", "fClass"].forEach((id) =>
  $(id).addEventListener("change", render),
);
$("tableBtn").onclick = () => {
  currentView = "table";
  render();
};
$("weekBtn").onclick = () => {
  currentView = "week";
  render();
};
$("excelBtn").onclick = exportExcel;
$("pdfBtn").onclick = exportPDF;
$("printBtn").onclick = printSchedule;
ensurePreviewButton();

// BƯỚC 5.1.1O-R1 - Google Sheets: xác minh đúng mã mới đang chạy; vẫn CHỈ ĐỌC.
const GOOGLE_SHEETS_CLIENT_ID =
  "671858456606-0st6517jnk78bovre7mp3er2u6v3guhs.apps.googleusercontent.com";
let GOOGLE_SHEETS_SPREADSHEET_ID = "";
const GOOGLE_SHEETS_LINK_GID = 162218494;
let GOOGLE_SHEETS_TEACHER_NAME = "";
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
let googleSheetsTokenClient = null;
let googleSheetsMappingUserId = null;
// BƯỚC 5.2.17: chỉ giữ token Google trong RAM của tab hiện tại; không lưu localStorage/Supabase.
let googleSheetsSessionAccessToken = "";
let googleSheetsSessionTokenExpiresAt = 0;
let googleSheetsSessionTokenUserId = null;
let googleSheetsTokenPromise = null;
async function ensureGoogleSheetsTeacherMapping() {
  if (!currentAuthUser?.id)
    throw new Error("Hãy đăng nhập giáo viên trước khi thao tác Google Sheet.");
  if (
    googleSheetsMappingUserId === currentAuthUser.id &&
    GOOGLE_SHEETS_SPREADSHEET_ID &&
    GOOGLE_SHEETS_TEACHER_NAME &&
    Number.isFinite(Number(GOOGLE_SHEETS_TEACHER_GID))
  )
    return;
  if (!supabaseClient)
    throw new Error(
      "Supabase chưa sẵn sàng để xác định Google Sheet của giáo viên.",
    );
  const { data, error } = await supabaseClient
    .from("tkb_teacher_google_sheets")
    .select("spreadsheet_id,sheet_name,sheet_gid")
    .eq("user_id", currentAuthUser.id)
    .maybeSingle();
  if (error)
    throw new Error(
      "Không đọc được ánh xạ Google Sheet của tài khoản này: " + error.message,
    );
  if (
    !data?.spreadsheet_id ||
    !data?.sheet_name ||
    data?.sheet_gid === null ||
    data?.sheet_gid === undefined
  )
    throw new Error(
      "Tài khoản này chưa được phân công tab Google Sheet. DỪNG thao tác để tránh ghi nhầm dữ liệu.",
    );
  GOOGLE_SHEETS_SPREADSHEET_ID = String(data.spreadsheet_id).trim();
  GOOGLE_SHEETS_TEACHER_NAME = String(data.sheet_name).trim();
  GOOGLE_SHEETS_TEACHER_GID = Number(data.sheet_gid);
  if (
    !GOOGLE_SHEETS_SPREADSHEET_ID ||
    !GOOGLE_SHEETS_TEACHER_NAME ||
    !Number.isFinite(GOOGLE_SHEETS_TEACHER_GID)
  )
    throw new Error(
      "Ánh xạ Google Sheet của tài khoản không hợp lệ. DỪNG thao tác.",
    );
  googleSheetsMappingUserId = currentAuthUser.id;
}
function clearGoogleSheetsTeacherMapping() {
  GOOGLE_SHEETS_SPREADSHEET_ID = "";
  GOOGLE_SHEETS_TEACHER_NAME = "";
  GOOGLE_SHEETS_TEACHER_GID = null;
  googleSheetsMappingUserId = null;
  // Mapping/tài khoản đổi thì token của phiên cũ không được tái sử dụng.
  googleSheetsSessionAccessToken = "";
  googleSheetsSessionTokenExpiresAt = 0;
  googleSheetsSessionTokenUserId = null;
  googleSheetsTokenPromise = null;
}
function loadGoogleIdentityServices() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const old = document.getElementById("googleIdentityServicesScript");
    if (old) {
      old.addEventListener("load", resolve, { once: true });
      old.addEventListener(
        "error",
        () => reject(new Error("Không tải được Google Identity Services.")),
        { once: true },
      );
      return;
    }
    const s = document.createElement("script");
    s.id = "googleIdentityServicesScript";
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = resolve;
    s.onerror = () =>
      reject(new Error("Không tải được Google Identity Services."));
    document.head.appendChild(s);
  });
}
async function getGoogleSheetsReadOnlyToken() {
  await ensureGoogleSheetsTeacherMapping();
  const uid = currentAuthUser?.id || null,
    now = Date.now();
  // Tái sử dụng token còn hiệu lực trong cùng phiên mở Web App. Chừa 60 giây đệm trước khi hết hạn.
  if (
    googleSheetsSessionAccessToken &&
    googleSheetsSessionTokenUserId === uid &&
    now < googleSheetsSessionTokenExpiresAt - 60000
  ) {
    return googleSheetsSessionAccessToken;
  }
  // Nếu hai thao tác cùng lúc cần token, dùng chung một yêu cầu OAuth thay vì mở hai popup.
  if (googleSheetsTokenPromise) return googleSheetsTokenPromise;
  await loadGoogleIdentityServices();
  googleSheetsTokenPromise = new Promise((resolve, reject) => {
    googleSheetsTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_SHEETS_CLIENT_ID,
      scope: GOOGLE_SHEETS_SCOPE,
      callback: (r) => {
        googleSheetsTokenPromise = null;
        if (r?.error) return reject(new Error(r.error_description || r.error));
        if (!r?.access_token)
          return reject(new Error("Google không trả về access token."));
        googleSheetsSessionAccessToken = r.access_token;
        googleSheetsSessionTokenUserId = uid;
        const expiresIn = Math.max(60, Number(r.expires_in) || 3600);
        googleSheetsSessionTokenExpiresAt = Date.now() + expiresIn * 1000;
        resolve(googleSheetsSessionAccessToken);
      },
    });
    // Chỉ đến đây khi chưa có token phiên hoặc token đã hết hạn.
    googleSheetsTokenClient.requestAccessToken({ prompt: "consent" });
  });
  return googleSheetsTokenPromise;
}
function googleSheetNameKey(v) {
  return String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function googleSheetWeekFromLine(line) {
  const text = String(line || "")
    .replace(/\s+/g, " ")
    .trim();
  const m = text.match(/Hoạt\s*động\s*giáo\s*dục\s*tuần\s*((?:\d\s*){1,2})/i);
  if (!m) return null;
  const week = Number(m[1].replace(/\s/g, ""));
  return Number.isInteger(week) && week >= 1 && week <= 35 ? week : null;
}
async function checkGoogleSheetReadOnly() {
  const btn = document.querySelector(
    "#outputPreviewModal .preview-google-readonly",
  );
  const oldText = btn?.textContent;
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Đang kiểm tra...";
    }
    const token = await getGoogleSheetsReadOnlyToken();
    const headers = { Authorization: `Bearer ${token}` };
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(GOOGLE_SHEETS_SPREADSHEET_ID)}?fields=properties.title,sheets.properties(sheetId,title,index)`;
    const metaRes = await fetch(metaUrl, { headers });
    const meta = await metaRes.json();
    if (!metaRes.ok)
      throw new Error(
        meta?.error?.message || "Không đọc được thông tin Google Sheet.",
      );
    const sheets = meta.sheets || [];
    const teacherKey = googleSheetNameKey(GOOGLE_SHEETS_TEACHER_NAME);
    const teacherSheet =
      sheets.find(
        (s) => googleSheetNameKey(s?.properties?.title) === teacherKey,
      ) ||
      sheets.find((s) =>
        googleSheetNameKey(s?.properties?.title).includes(teacherKey),
      );
    const linkSheet = sheets.find(
      (s) => Number(s?.properties?.sheetId) === GOOGLE_SHEETS_LINK_GID,
    );
    if (!teacherSheet) {
      const names = sheets
        .map((s) => s?.properties?.title)
        .filter(Boolean)
        .join(", ");
      throw new Error(
        `Chưa tìm thấy tab mang tên "${GOOGLE_SHEETS_TEACHER_NAME}".\n\nTab gid=${GOOGLE_SHEETS_LINK_GID} hiện là: ${linkSheet?.properties?.title || "không tìm thấy"}.\n\nCác tab đọc được: ${names}`,
      );
    }
    const title = teacherSheet.properties.title;
    const targetGid = teacherSheet.properties.sheetId;
    const range = `'${String(title).replace(/'/g, "''")}'!A:K`;
    const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(GOOGLE_SHEETS_SPREADSHEET_ID)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
    const valuesRes = await fetch(valuesUrl, { headers });
    const valuesJson = await valuesRes.json();
    if (!valuesRes.ok)
      throw new Error(
        valuesJson?.error?.message ||
          "Không đọc được dữ liệu của sheet giáo viên.",
      );
    const rows = valuesJson.values || [];
    const weeks = [];
    rows.forEach((row, i) => {
      const week = googleSheetWeekFromLine((row || []).join(" "));
      if (week !== null) weeks.push({ week, row: i + 1 });
    });
    const uniqueWeeks = [];
    const seen = new Set();
    weeks.forEach((x) => {
      if (!seen.has(x.week)) {
        seen.add(x.week);
        uniqueWeeks.push(x);
      }
    });
    uniqueWeeks.sort((a, b) => a.week - b.week);
    const weekText = uniqueWeeks.length
      ? uniqueWeeks.map((x) => `Tuần ${x.week} (dòng ${x.row})`).join(", ")
      : "chưa nhận diện được tiêu đề tuần 1–35 trong cột A:K";
    const missing = Array.from({ length: 35 }, (_, i) => i + 1).filter(
      (w) => !seen.has(w),
    );
    alert(
      `KẾT NỐI GOOGLE SHEETS CHỈ ĐỌC THÀNH CÔNG – O-R1\n\nTệp: ${meta.properties?.title || GOOGLE_SHEETS_SPREADSHEET_ID}\nTab giáo viên: ${title}\nGID thực tế: ${targetGid}\nTab của link gid=${GOOGLE_SHEETS_LINK_GID}: ${linkSheet?.properties?.title || "không tìm thấy"}\nSố dòng đã đọc: ${rows.length}\n\nNhận diện tuần: ${weekText}\n\nTuần chưa thấy: ${missing.length ? missing.join(", ") : "Không có – đã thấy đủ Tuần 1–35"}\n\nBước này vẫn chỉ đọc; app chưa có quyền và chưa có lệnh ghi/sửa/xóa Google Sheet.`,
    );
  } catch (err) {
    console.error("Google Sheets read-only check:", err);
    alert(
      `Chưa xác định được đúng Google Sheet của giáo viên.\n\n${err?.message || err}`,
    );
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || "Kiểm tra Google Sheet O-R1";
    }
  }
}
function ensureGoogleSheetsReadOnlyPreviewButton() {
  const bar = document.querySelector(
    "#outputPreviewModal .output-preview-bar>div",
  );
  if (!bar || bar.querySelector(".preview-google-readonly")) return;
  const close = bar.querySelector(".preview-close");
  const b = document.createElement("button");
  b.type = "button";
  b.className = "preview-google-readonly";
  b.textContent = "Kiểm tra Google Sheet O-R1";
  b.title = "BƯỚC 5.1.1O-R1 – chỉ đọc; tự tìm tab Võ Thanh Đậm và tuần 1–35";
  b.onclick = checkGoogleSheetReadOnly;
  bar.insertBefore(b, close || null);
}
const openOutputPreviewBeforeGoogleReadOnly = openOutputPreview;
openOutputPreview = function () {
  openOutputPreviewBeforeGoogleReadOnly();
  ensureGoogleSheetsReadOnlyPreviewButton();
};
const previewBtnGoogleReadOnly = document.getElementById("previewBtn");
if (previewBtnGoogleReadOnly)
  previewBtnGoogleReadOnly.onclick = openOutputPreview;

// BƯỚC 5.1.3Q - Tuần 4: giữ nguyên nội dung 5.1.3P đã Đạt; bật xuống dòng tự động cho ô bài dạy trên Google Sheet.
// Chỉ ghi khi: đúng Spreadsheet, đúng tab/GID, đang chọn Tuần 4, Google Sheet chưa có Tuần 4.
let GOOGLE_SHEETS_TEACHER_GID = null;
function gsA1Title(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}
async function gsJson(url, options = {}) {
  const res = await fetch(url, options);
  let body = {};
  try {
    body = await res.json();
  } catch (e) {}
  if (!res.ok)
    throw new Error(
      body?.error?.message || `Google Sheets API lỗi ${res.status}`,
    );
  return body;
}
function gsWeek4Rows(data) {
  const wd = selectedWeekDates();
  const days = ["Hai", "Ba", "Tư", "Năm", "Sáu"],
    labels = ["Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu"];
  const concurrent = getConcurrentPeriods();

  // BƯỚC 5.1.3J: lấy chính dữ liệu bài dạy đã ghép đang dùng trong bản Xem trước.
  // Không dựng lại tên bài bằng một đường dữ liệu khác.
  const lessonText = (x) => {
    const subject = normalizeSubjectForPlan(
      x?.monHoc || x?.plan?.subject || "",
    );
    const grade = gradeFromClass(x?.lop || "");
    // outputScheduleData() vừa gọi applyLessonPlan(), vì vậy x.plan chính là dữ liệu
    // đang tạo tên bài trong Xem trước. Chỉ fallback sang map nếu thật sự cần.
    const plan =
      (x?.plan?.title
        ? x.plan
        : lessonPlanMap.get(planKey(subject, grade, 4))) || null;
    const period = plan?.annualPeriod || plan?.week || 4;
    const title = clean(plan?.title || "");
    if (!title)
      throw new Error(
        `Thiếu tên bài Phụ lục 2: ${subject} ${clean(x?.lop)} - Tuần 4.`,
      );
    return `${subject} ${clean(x?.lop)} Tiết ${period} - ${title}`;
  };
  const cell = (day, session, tiet) =>
    data
      .filter(
        (x) =>
          x.thu === day &&
          normKey(x.buoi) === normKey(session) &&
          Number(x.tiet) === Number(tiet),
      )
      .map(lessonText)
      .join("\n────────\n");

  // Đếm trực tiếp 20 tiết đang dùng để tạo bảng Tuần 4.
  // Phân loại bằng khóa không dấu để không phụ thuộc cách viết hoa/thường.
  const classify = (x) => {
    const raw = normKey(
      normalizeSubjectForPlan(x?.monHoc || x?.plan?.subject || ""),
    );
    const k = raw.replace(/[^a-z0-9]+/g, "");
    if (k === "cn" || k === "cnghe" || k.includes("congnghe"))
      return "Công nghệ";
    if (k === "th" || k.includes("tinhoc")) return "Tin học";
    if (k === "dd" || k.includes("daoduc")) return "Đạo đức";
    return "";
  };
  const counts = { "Công nghệ": 0, "Tin học": 0, "Đạo đức": 0 };
  data.forEach((x) => {
    const k = classify(x);
    if (k) counts[k]++;
  });
  const teachingTotal =
    counts["Công nghệ"] + counts["Tin học"] + counts["Đạo đức"];
  if (teachingTotal !== data.length) {
    const unknown = data
      .filter((x) => !classify(x))
      .map((x) => `${x.monHoc || ""} ${x.lop || ""}`)
      .join(", ");
    throw new Error(
      `Không thể tổng hợp đủ ${data.length} tiết Tuần 4. Đã nhận diện ${teachingTotal} tiết. Chưa nhận diện: ${unknown || "không rõ"}.`,
    );
  }
  const details = [
    ["Phòng máy", concurrent],
    ["Công nghệ", counts["Công nghệ"]],
    ["Tin học", counts["Tin học"]],
    ["Đạo đức", counts["Đạo đức"]],
  ];
  const values = [];
  values.push({ range: "A74", values: [[`Hoạt động giáo dục tuần 04`]] });
  // Mẫu Tuần 3 có ô A75 riêng chứa nhãn 'Năm học', còn tiêu đề chính nằm từ B75.
  // Ghi đúng vào B75 để không tạo chữ thừa ở mép trái; đồng thời bổ sung môn Đạo đức.
  values.push({ range: "A75", values: [[""]] });
  values.push({
    range: "B75",
    values: [
      [
        `Năm học 2026 – 2027. Môn: Tin học, Công nghệ, Đạo đức – Khối: 3, 4, 5 – Trường TH – THCS & THPT Lại Sơn`,
      ],
    ],
  });
  values.push({
    range: "A76",
    values: [[`Tuần 4: từ ngày ${wd.fmt(wd.start)} đến ${wd.fmt(wd.end)}`]],
  });
  values.push({
    range: "C77:G77",
    values: [[...wd.days.map((d) => `Ngày ${d}`)]],
  });
  values.push({ range: "C78:G78", values: [[...labels]] });
  const schedule = [];
  for (let t = 1; t <= 4; t++)
    schedule.push(days.map((day) => cell(day, "Sáng", t)));
  for (let t = 1; t <= 3; t++)
    schedule.push(days.map((day) => cell(day, "Chiều", t)));
  values.push({ range: "C79:G85", values: schedule });
  // Không ghi Tổng số vào A86: mẫu sao chép đã có dòng Tổng số đúng ở giữa bảng.
  // Chỉ xóa giá trị thừa ở mép trái để tránh xuất hiện 'Tổng số: 20...' ngoài khung.
  values.push({ range: "A86", values: [[""]] });
  details.forEach((x, i) => {
    const row = 89 + i;
    values.push({ range: `B${row}`, values: [[i + 1]] });
    values.push({ range: `C${row}`, values: [[x[0]]] });
    values.push({ range: `E${row}`, values: [[x[1]]] });
  });
  values.push({ range: "C93", values: [["Tổng số"]] });
  values.push({ range: "E93", values: [[data.length + concurrent]] });
  return values;
}
async function exportWeek4ToGoogleSheet() {
  const btn = document.querySelector(
      "#outputPreviewModal .preview-google-write-week4",
    ),
    old = btn?.textContent;
  try {
    if (Number($("weekSelect")?.value) !== 4)
      throw new Error(
        "BƯỚC 5.1.3P chỉ cho phép ghi Tuần 4. Hãy chọn Tuần 4 trước.",
      );
    // BƯỚC 5.1.3O: dùng CHÍNH dữ liệu đã ghép đang tạo bản Xem trước.
    // Nhờ đó Môn + Lớp + Tên bài + Tiết bài ghi sang Google Sheet phải trùng với bản giáo viên vừa kiểm tra.
    // outputScheduleData() tự applyLessonPlan() và áp dụng lớp điều chỉnh xuất (nếu giáo viên đã sửa trong Xem trước).
    const data = outputScheduleData().map((x) => ({ ...x }));

    // BƯỚC 5.1.3N: tuyệt đối dùng môn đã đọc từ TKB nguồn, không hard-code đổi môn.
    // File TKB chuẩn mới phải cho: Thứ Tư - Chiều - Tiết 2 - lớp 3B2 = Tin học.
    // Nếu app vẫn đang giữ TKB cũ (3B2 = Công nghệ), dừng và yêu cầu nhập lại TKB đã sửa.
    const lesson3B2 = data.find(
      (x) =>
        normKey(x?.thu) === "tu" &&
        normKey(x?.buoi) === "chieu" &&
        Number(x?.tiet) === 2 &&
        normKey(x?.lop) === "3b2",
    );
    if (!lesson3B2)
      throw new Error(
        "DỪNG GHI: TKB nguồn không có lớp 3B2 tại Thứ Tư - Chiều - Tiết 2.",
      );
    const source3B2 = normKey(
      normalizeSubjectForPlan(lesson3B2.monHoc),
    ).replace(/[^a-z0-9]+/g, "");
    if (!(source3B2.includes("tinhoc") || source3B2 === "th"))
      throw new Error(
        `DỪNG GHI: TKB đang nạp vẫn ghi 3B2 Thứ Tư - Chiều - Tiết 2 = ${normalizeSubjectForPlan(lesson3B2.monHoc) || lesson3B2.monHoc}. Hãy nhập lại file TKB đã sửa, trong đó ô này là Tin học.`,
      );

    if (!data.length)
      throw new Error("Tuần 4 hiện không có dữ liệu TKB nguồn để ghi.");
    if (data.length !== 20)
      throw new Error(
        `DỪNG GHI: TKB nguồn Tuần 4 phải có đúng 20 tiết, hiện đọc được ${data.length} tiết.`,
      );

    // Một giáo viên không thể có hai lớp ở cùng Thứ + Buổi + Tiết. Nếu parser/source tạo trùng,
    // dừng để không âm thầm ghi sai sang Google Sheet.
    const slotMap = new Map();
    for (const x of data) {
      const slot = `${clean(x.thu)}|${normKey(x.buoi)}|${Number(x.tiet) || 0}`;
      if (slotMap.has(slot)) {
        const a = slotMap.get(slot);
        throw new Error(
          `DỪNG GHI: trùng vị trí Thứ ${x.thu} - ${x.buoi} - Tiết ${x.tiet}: ${normalizeSubjectForPlan(a.monHoc)} ${a.lop} và ${normalizeSubjectForPlan(x.monHoc)} ${x.lop}.`,
        );
      }
      slotMap.set(slot, x);
    }

    // Chốt theo TKB thật đã đối chiếu của GV Đậm: 20 tiết = Tin học 7 + Công nghệ 12 + Đạo đức 1.
    const subjectCount = { tin: 0, cn: 0, dd: 0 };
    for (const x of data) {
      const k = normKey(normalizeSubjectForPlan(x.monHoc)).replace(
        /[^a-z0-9]+/g,
        "",
      );
      if (k.includes("tinhoc") || k === "th") subjectCount.tin++;
      else if (k.includes("congnghe") || k === "cn" || k === "cnghe")
        subjectCount.cn++;
      else if (k.includes("daoduc") || k === "dd") subjectCount.dd++;
    }
    if (
      subjectCount.tin !== 7 ||
      subjectCount.cn !== 12 ||
      subjectCount.dd !== 1
    )
      throw new Error(
        `DỪNG GHI: cơ cấu môn Tuần 4 chưa đúng TKB thật. Hiện có Tin học ${subjectCount.tin}, Công nghệ ${subjectCount.cn}, Đạo đức ${subjectCount.dd}; yêu cầu 7 / 12 / 1.`,
      );

    // 20/20 tiết phải ghép được tên bài trước khi cho phép ghi.
    const noTitle = data.filter((x) => !clean(x.plan?.title));
    if (noTitle.length)
      throw new Error(
        `DỪNG GHI: còn ${noTitle.length} tiết chưa ghép tên bài Phụ lục 2: ${noTitle
          .slice(0, 4)
          .map((x) => `${normalizeSubjectForPlan(x.monHoc)} ${x.lop}`)
          .join(", ")}.`,
      );
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Đang kiểm tra...";
    }
    const token = await getGoogleSheetsReadOnlyToken(),
      headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(GOOGLE_SHEETS_SPREADSHEET_ID)}`;
    const meta = await gsJson(
      `${base}?fields=properties.title,sheets.properties(sheetId,title,gridProperties)`,
      { headers },
    );
    const teacher = (meta.sheets || []).find(
      (s) => Number(s?.properties?.sheetId) === GOOGLE_SHEETS_TEACHER_GID,
    );
    if (
      !teacher ||
      googleSheetNameKey(teacher.properties.title) !==
        googleSheetNameKey(GOOGLE_SHEETS_TEACHER_NAME)
    )
      throw new Error(
        `DỪNG GHI: không khớp tab ${GOOGLE_SHEETS_TEACHER_NAME} / GID ${GOOGLE_SHEETS_TEACHER_GID}.`,
      );
    const title = teacher.properties.title,
      q = gsA1Title(title);
    const scan = await gsJson(
      `${base}/values/${encodeURIComponent(q + "!A1:H824")}?majorDimension=ROWS`,
      { headers },
    );
    const found = [];
    (scan.values || []).forEach((r, i) => {
      const w = googleSheetWeekFromLine((r || []).join(" "));
      if (w !== null) found.push({ week: w, row: i + 1 });
    });
    if (found.some((x) => x.week === 4))
      throw new Error(
        `Google Sheet đã có Tuần 4 ở dòng ${found.find((x) => x.week === 4).row}. App không ghi chồng.`,
      );
    const w3 = found.find((x) => x.week === 3);
    if (!w3 || w3.row !== 51)
      throw new Error(
        `DỪNG GHI: vị trí Tuần 3 không còn đúng mẫu (mong đợi dòng 51, thực tế ${w3?.row || "không tìm thấy"}).`,
      );
    if (
      !confirm(
        "GHI THẬT TUẦN 4 vào tab Võ Thanh Đậm?\n\nTuần 1–3 sẽ không bị sửa. App sẽ sao chép nguyên mẫu Tuần 3 (merge, định dạng, chiều cao hàng) sang dòng 74–95 rồi thay dữ liệu Tuần 4.",
      )
    )
      return;
    if (btn) btn.textContent = "Đang tạo mẫu Tuần 4...";
    // 5.1.3B: lấy CHÍNH Tuần 3 làm template 1:1. copyPaste giữ format/giá trị,
    // còn merge và chiều cao hàng phải sao chép riêng vì Google Sheets không tạo merge mới bằng copyPaste.
    const tpl = await gsJson(
      `${base}?ranges=${encodeURIComponent(title + "!A51:H72")}&includeGridData=true&fields=sheets(merges,data(rowMetadata(pixelSize)))`,
      { headers },
    );
    const srcMerges = (tpl.sheets?.[0]?.merges || []).filter(
      (m) =>
        m.startRowIndex >= 50 &&
        m.endRowIndex <= 72 &&
        m.startColumnIndex >= 0 &&
        m.endColumnIndex <= 8,
    );
    const srcRowMeta = tpl.sheets?.[0]?.data?.[0]?.rowMetadata || [];
    const requests = [
      {
        unmergeCells: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: 73,
            endRowIndex: 95,
            startColumnIndex: 0,
            endColumnIndex: 8,
          },
        },
      },
      {
        copyPaste: {
          source: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: 50,
            endRowIndex: 72,
            startColumnIndex: 0,
            endColumnIndex: 8,
          },
          destination: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: 73,
            endRowIndex: 95,
            startColumnIndex: 0,
            endColumnIndex: 8,
          },
          pasteType: "PASTE_NORMAL",
          pasteOrientation: "NORMAL",
        },
      },
    ];
    srcMerges.forEach((m) =>
      requests.push({
        mergeCells: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: m.startRowIndex + 23,
            endRowIndex: m.endRowIndex + 23,
            startColumnIndex: m.startColumnIndex,
            endColumnIndex: m.endColumnIndex,
          },
          mergeType: "MERGE_ALL",
        },
      }),
    );
    srcRowMeta.forEach((rm, i) => {
      if (rm?.pixelSize)
        requests.push({
          updateDimensionProperties: {
            range: {
              sheetId: GOOGLE_SHEETS_TEACHER_GID,
              dimension: "ROWS",
              startIndex: 73 + i,
              endIndex: 74 + i,
            },
            properties: { pixelSize: rm.pixelSize },
            fields: "pixelSize",
          },
        });
    });
    // 5.1.3Q: tên bài dài phải tự xuống hàng trong đúng vùng tiết C79:G85.
    // Chỉ đổi wrapStrategy, không đụng font/viền/màu/căn lề đã sao chép từ mẫu Tuần 3.
    requests.push({
      repeatCell: {
        range: {
          sheetId: GOOGLE_SHEETS_TEACHER_GID,
          startRowIndex: 78,
          endRowIndex: 85,
          startColumnIndex: 2,
          endColumnIndex: 7,
        },
        cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
        fields: "userEnteredFormat.wrapStrategy",
      },
    });
    // Cho 7 hàng tiết tự tăng chiều cao theo số dòng sau khi wrap, thay vì ép cố định 62 px.
    requests.push({
      autoResizeDimensions: {
        dimensions: {
          sheetId: GOOGLE_SHEETS_TEACHER_GID,
          dimension: "ROWS",
          startIndex: 78,
          endIndex: 85,
        },
      },
    });
    await gsJson(`${base}:batchUpdate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requests }),
    });
    // 5.1.3G: xóa CHỈ GIÁ TRỊ vùng dữ liệu Tổng hợp, giữ nguyên merge/viền/font/căn chỉnh vừa sao chép.
    // Xóa cả cột A để loại sạch các số/chữ rơi ngoài bảng do dữ liệu cũ của template.
    await gsJson(`${base}/values/${encodeURIComponent(q + "!A89:H93")}:clear`, {
      method: "POST",
      headers,
      body: "{}",
    });
    if (btn) btn.textContent = "Đang ghi Tuần 4...";
    const payload = gsWeek4Rows(data).map((x) => ({
      range: `${q}!${x.range}`,
      majorDimension: "ROWS",
      values: x.values,
    }));
    await gsJson(`${base}/values:batchUpdate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: payload }),
    });
    const verify = await gsJson(
      `${base}/values/${encodeURIComponent(q + "!A74:H95")}?majorDimension=ROWS`,
      { headers },
    );
    const rows = verify.values || [],
      detected = [];
    rows.forEach((r, i) => {
      const w = googleSheetWeekFromLine((r || []).join(" "));
      if (w !== null) detected.push({ week: w, row: 74 + i });
    });
    if (!detected.some((x) => x.week === 4))
      throw new Error(
        "Đã gửi lệnh ghi nhưng chưa đọc lại được tiêu đề Tuần 4. Hãy kiểm tra Google Sheet trước khi thao tác tiếp.",
      );
    const writtenSchedule = (rows.slice(5, 12) || [])
      .flat()
      .map(clean)
      .filter(Boolean)
      .join("\n");
    const expectedTitles = [
      ...new Set(
        data
          .map((x) =>
            clean(
              (
                x.plan ||
                lessonPlanMap.get(
                  planKey(
                    normalizeSubjectForPlan(x.monHoc),
                    gradeFromClass(x.lop),
                    4,
                  ),
                )
              )?.title || "",
            ),
          )
          .filter(Boolean),
      ),
    ];
    const missingTitles = expectedTitles.filter(
      (t) => !writtenSchedule.includes(t),
    );
    if (missingTitles.length)
      throw new Error(
        `BƯỚC 5.1.3K đã đọc lại Google Sheet nhưng còn thiếu tên bài: ${missingTitles.slice(0, 3).join(" | ")}. Dừng tại Tuần 4.`,
      );
    alert(
      `GHI TUẦN 4 THÀNH CÔNG\n\nTệp: ${meta.properties?.title || ""}\nTab: ${title}\nGID: ${GOOGLE_SHEETS_TEACHER_GID}\nVùng ghi: dòng 74–95\nSố tiết: ${data.length}\nTổng kể cả kiêm nhiệm: ${data.length + getConcurrentPeriods()}\n\nTuần 1–3 không bị sửa. Hãy mở Google Sheet kiểm tra trực tiếp trước khi làm Tuần 5.`,
    );
  } catch (err) {
    console.error("[TKB] Ghi thật Tuần 4:", err);
    alert(
      `CHƯA GHI ĐƯỢC TUẦN 4\n\n${err?.message || err}\n\nKhông tiếp tục Tuần 5 cho đến khi Tuần 4 được kiểm tra.`,
    );
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old || "Ghi Tuần 4 vào Google Sheet";
    }
  }
}
function ensureGoogleSheetsWeek4WriteButton() {
  const bar = document.querySelector(
    "#outputPreviewModal .output-preview-bar>div",
  );
  if (!bar || bar.querySelector(".preview-google-write-week4")) return;
  const close = bar.querySelector(".preview-close");
  const b = document.createElement("button");
  b.type = "button";
  b.className = "preview-google-write-week4";
  b.textContent = "Ghi Tuần 4 vào Google Sheet";
  b.title =
    "BƯỚC 5.1.3Q – ghi Tuần 4 và tự xuống hàng tên bài trên Google Sheet; giữ nguyên dữ liệu đã kiểm tra";
  b.onclick = exportWeek4ToGoogleSheet;
  bar.insertBefore(b, close || null);
}
const openOutputPreviewBeforeWeek4Write = openOutputPreview;
openOutputPreview = function () {
  openOutputPreviewBeforeWeek4Write();
  ensureGoogleSheetsWeek4WriteButton();
};
const previewBtnWeek4Write = document.getElementById("previewBtn");
if (previewBtnWeek4Write) previewBtnWeek4Write.onclick = openOutputPreview;

// BƯỚC 5.1.4 - Ghi Tuần 5 bằng cơ chế tổng quát theo tuần.
// Từ đây không dựng riêng dữ liệu từng tuần: hàm dưới nhận week/startRow và dùng chính outputScheduleData() của Xem trước.
function gsWeekRows(data, week, startRow) {
  const wd = selectedWeekDates();
  const days = ["Hai", "Ba", "Tư", "Năm", "Sáu"],
    labels = ["Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu"];
  const concurrent = getConcurrentPeriods();
  const lessonText = (x) => {
    const subject = normalizeSubjectForPlan(
      x?.monHoc || x?.plan?.subject || "",
    );
    const grade = gradeFromClass(x?.lop || "");
    const plan =
      (x?.plan?.title
        ? x.plan
        : lessonPlanMap.get(planKey(subject, grade, week))) || null;
    const period = plan?.annualPeriod || plan?.week || week;
    const title = clean(plan?.title || "");
    if (!title)
      throw new Error(
        `Thiếu tên bài Phụ lục 2: ${subject} ${clean(x?.lop)} - Tuần ${week}.`,
      );
    return `${subject} ${clean(x?.lop)} Tiết ${period} - ${title}`;
  };
  const cell = (day, session, tiet) =>
    data
      .filter(
        (x) =>
          x.thu === day &&
          normKey(x.buoi) === normKey(session) &&
          Number(x.tiet) === Number(tiet),
      )
      .map(lessonText)
      .join("\n────────\n");
  const classify = (x) => {
    const k = normKey(
      normalizeSubjectForPlan(x?.monHoc || x?.plan?.subject || ""),
    ).replace(/[^a-z0-9]+/g, "");
    if (k === "cn" || k === "cnghe" || k.includes("congnghe"))
      return "Công nghệ";
    if (k === "th" || k.includes("tinhoc")) return "Tin học";
    if (k === "dd" || k.includes("daoduc")) return "Đạo đức";
    return "";
  };
  const counts = { "Công nghệ": 0, "Tin học": 0, "Đạo đức": 0 };
  data.forEach((x) => {
    const k = classify(x);
    if (k) counts[k]++;
  });
  const teachingTotal =
    counts["Công nghệ"] + counts["Tin học"] + counts["Đạo đức"];
  if (teachingTotal !== data.length)
    throw new Error(
      `Không thể tổng hợp đủ ${data.length} tiết Tuần ${week}. Đã nhận diện ${teachingTotal} tiết.`,
    );
  const details = [
    ["Phòng máy", concurrent],
    ["Công nghệ", counts["Công nghệ"]],
    ["Tin học", counts["Tin học"]],
    ["Đạo đức", counts["Đạo đức"]],
  ];
  const r = (n) => startRow + n,
    values = [];
  values.push({
    range: `A${r(0)}`,
    values: [[`Hoạt động giáo dục tuần ${String(week).padStart(2, "0")}`]],
  });
  values.push({ range: `A${r(1)}`, values: [[""]] });
  values.push({
    range: `B${r(1)}`,
    values: [
      [
        "Năm học 2026 – 2027. Môn: Tin học, Công nghệ, Đạo đức – Khối: 3, 4, 5 – Trường TH – THCS & THPT Lại Sơn",
      ],
    ],
  });
  values.push({
    range: `A${r(2)}`,
    values: [
      [`Tuần ${week}: từ ngày ${wd.fmt(wd.start)} đến ${wd.fmt(wd.end)}`],
    ],
  });
  values.push({
    range: `C${r(3)}:G${r(3)}`,
    values: [[...wd.days.map((d) => `Ngày ${d}`)]],
  });
  values.push({ range: `C${r(4)}:G${r(4)}`, values: [[...labels]] });
  const schedule = [];
  for (let t = 1; t <= 4; t++)
    schedule.push(days.map((day) => cell(day, "Sáng", t)));
  for (let t = 1; t <= 3; t++)
    schedule.push(days.map((day) => cell(day, "Chiều", t)));
  values.push({ range: `C${r(5)}:G${r(11)}`, values: schedule });
  values.push({ range: `A${r(12)}`, values: [[""]] });
  details.forEach((x, i) => {
    const row = r(15 + i);
    values.push(
      { range: `B${row}`, values: [[i + 1]] },
      { range: `C${row}`, values: [[x[0]]] },
      { range: `E${row}`, values: [[x[1]]] },
    );
  });
  values.push(
    { range: `C${r(19)}`, values: [["Tổng số"]] },
    { range: `E${r(19)}`, values: [[data.length + concurrent]] },
  );
  return values;
}
async function exportWeek5ToGoogleSheet() {
  const week = 5,
    startRow = 96,
    endRow = 117,
    templateStart = 74,
    templateEnd = 95,
    offset = startRow - templateStart;
  const btn = document.querySelector(
      "#outputPreviewModal .preview-google-write-week5",
    ),
    old = btn?.textContent;
  try {
    if (Number($("weekSelect")?.value) !== week)
      throw new Error(
        `BƯỚC 5.1.4 chỉ ghi Tuần ${week}. Hãy chọn Tuần ${week} trước.`,
      );
    const data = outputScheduleData().map((x) => ({ ...x }));
    if (data.length !== 20)
      throw new Error(
        `DỪNG GHI: TKB nguồn Tuần ${week} phải có đúng 20 tiết, hiện đọc được ${data.length} tiết.`,
      );
    const slotMap = new Map();
    for (const x of data) {
      const slot = `${clean(x.thu)}|${normKey(x.buoi)}|${Number(x.tiet) || 0}`;
      if (slotMap.has(slot)) {
        const a = slotMap.get(slot);
        throw new Error(
          `DỪNG GHI: trùng vị trí Thứ ${x.thu} - ${x.buoi} - Tiết ${x.tiet}: ${normalizeSubjectForPlan(a.monHoc)} ${a.lop} và ${normalizeSubjectForPlan(x.monHoc)} ${x.lop}.`,
        );
      }
      slotMap.set(slot, x);
    }
    const subjectCount = { tin: 0, cn: 0, dd: 0 };
    for (const x of data) {
      const k = normKey(normalizeSubjectForPlan(x.monHoc)).replace(
        /[^a-z0-9]+/g,
        "",
      );
      if (k.includes("tinhoc") || k === "th") subjectCount.tin++;
      else if (k.includes("congnghe") || k === "cn" || k === "cnghe")
        subjectCount.cn++;
      else if (k.includes("daoduc") || k === "dd") subjectCount.dd++;
    }
    if (
      subjectCount.tin !== 7 ||
      subjectCount.cn !== 12 ||
      subjectCount.dd !== 1
    )
      throw new Error(
        `DỪNG GHI: cơ cấu môn Tuần ${week} chưa đúng TKB thật. Hiện có Tin học ${subjectCount.tin}, Công nghệ ${subjectCount.cn}, Đạo đức ${subjectCount.dd}; yêu cầu 7 / 12 / 1.`,
      );
    const noTitle = data.filter((x) => !clean(x.plan?.title));
    if (noTitle.length)
      throw new Error(
        `DỪNG GHI: còn ${noTitle.length} tiết chưa ghép tên bài Phụ lục 2.`,
      );
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Đang kiểm tra...";
    }
    const token = await getGoogleSheetsReadOnlyToken(),
      headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(GOOGLE_SHEETS_SPREADSHEET_ID)}`;
    const meta = await gsJson(
      `${base}?fields=properties.title,sheets.properties(sheetId,title,gridProperties)`,
      { headers },
    );
    const teacher = (meta.sheets || []).find(
      (s) => Number(s?.properties?.sheetId) === GOOGLE_SHEETS_TEACHER_GID,
    );
    if (
      !teacher ||
      googleSheetNameKey(teacher.properties.title) !==
        googleSheetNameKey(GOOGLE_SHEETS_TEACHER_NAME)
    )
      throw new Error(
        `DỪNG GHI: không khớp tab ${GOOGLE_SHEETS_TEACHER_NAME} / GID ${GOOGLE_SHEETS_TEACHER_GID}.`,
      );
    const title = teacher.properties.title,
      q = gsA1Title(title),
      maxRows = Number(teacher.properties?.gridProperties?.rowCount) || 1000;
    if (maxRows < endRow)
      throw new Error(
        `Google Sheet chỉ có ${maxRows} dòng, chưa đủ để tạo Tuần ${week} đến dòng ${endRow}.`,
      );
    const scan = await gsJson(
      `${base}/values/${encodeURIComponent(q + `!A1:H${maxRows}`)}?majorDimension=ROWS`,
      { headers },
    );
    const found = [];
    (scan.values || []).forEach((r, i) => {
      const w = googleSheetWeekFromLine((r || []).join(" "));
      if (w !== null) found.push({ week: w, row: i + 1 });
    });
    if (found.some((x) => x.week === week))
      throw new Error(
        `Google Sheet đã có Tuần ${week} ở dòng ${found.find((x) => x.week === week).row}. App không ghi chồng.`,
      );
    const w4 = found.find((x) => x.week === 4);
    if (!w4 || w4.row !== 74)
      throw new Error(
        `DỪNG GHI: Tuần 4 phải ở dòng 74 để làm mẫu, thực tế ${w4?.row || "không tìm thấy"}.`,
      );
    if (
      !confirm(
        `GHI THẬT TUẦN ${week} vào tab Võ Thanh Đậm?\n\nTuần 1–4 sẽ không bị sửa. App dùng nguyên mẫu Tuần 4 đã Đạt và thay bằng dữ liệu Xem trước Tuần ${week}.`,
      )
    )
      return;
    if (btn) btn.textContent = `Đang tạo mẫu Tuần ${week}...`;
    const tpl = await gsJson(
      `${base}?ranges=${encodeURIComponent(title + `!A${templateStart}:H${templateEnd}`)}&includeGridData=true&fields=sheets(merges,data(rowMetadata(pixelSize)))`,
      { headers },
    );
    const s0 = templateStart - 1,
      s1 = templateEnd,
      d0 = startRow - 1,
      d1 = endRow;
    const srcMerges = (tpl.sheets?.[0]?.merges || []).filter(
        (m) =>
          m.startRowIndex >= s0 &&
          m.endRowIndex <= s1 &&
          m.startColumnIndex >= 0 &&
          m.endColumnIndex <= 8,
      ),
      srcRowMeta = tpl.sheets?.[0]?.data?.[0]?.rowMetadata || [];
    const requests = [
      {
        unmergeCells: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: d0,
            endRowIndex: d1,
            startColumnIndex: 0,
            endColumnIndex: 8,
          },
        },
      },
      {
        copyPaste: {
          source: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: s0,
            endRowIndex: s1,
            startColumnIndex: 0,
            endColumnIndex: 8,
          },
          destination: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: d0,
            endRowIndex: d1,
            startColumnIndex: 0,
            endColumnIndex: 8,
          },
          pasteType: "PASTE_NORMAL",
          pasteOrientation: "NORMAL",
        },
      },
    ];
    srcMerges.forEach((m) =>
      requests.push({
        mergeCells: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: m.startRowIndex + offset,
            endRowIndex: m.endRowIndex + offset,
            startColumnIndex: m.startColumnIndex,
            endColumnIndex: m.endColumnIndex,
          },
          mergeType: "MERGE_ALL",
        },
      }),
    );
    srcRowMeta.forEach((rm, i) => {
      if (rm?.pixelSize)
        requests.push({
          updateDimensionProperties: {
            range: {
              sheetId: GOOGLE_SHEETS_TEACHER_GID,
              dimension: "ROWS",
              startIndex: d0 + i,
              endIndex: d0 + i + 1,
            },
            properties: { pixelSize: rm.pixelSize },
            fields: "pixelSize",
          },
        });
    });
    requests.push({
      repeatCell: {
        range: {
          sheetId: GOOGLE_SHEETS_TEACHER_GID,
          startRowIndex: d0 + 5,
          endRowIndex: d0 + 12,
          startColumnIndex: 2,
          endColumnIndex: 7,
        },
        cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
        fields: "userEnteredFormat.wrapStrategy",
      },
    });
    requests.push({
      autoResizeDimensions: {
        dimensions: {
          sheetId: GOOGLE_SHEETS_TEACHER_GID,
          dimension: "ROWS",
          startIndex: d0 + 5,
          endIndex: d0 + 12,
        },
      },
    });
    await gsJson(`${base}:batchUpdate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requests }),
    });
    await gsJson(
      `${base}/values/${encodeURIComponent(q + `!A${startRow + 15}:H${startRow + 19}`)}:clear`,
      { method: "POST", headers, body: "{}" },
    );
    if (btn) btn.textContent = `Đang ghi Tuần ${week}...`;
    const payload = gsWeekRows(data, week, startRow).map((x) => ({
      range: `${q}!${x.range}`,
      majorDimension: "ROWS",
      values: x.values,
    }));
    await gsJson(`${base}/values:batchUpdate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: payload }),
    });
    const verify = await gsJson(
        `${base}/values/${encodeURIComponent(q + `!A${startRow}:H${endRow}`)}?majorDimension=ROWS`,
        { headers },
      ),
      rows = verify.values || [],
      detected = [];
    rows.forEach((r, i) => {
      const w = googleSheetWeekFromLine((r || []).join(" "));
      if (w !== null) detected.push({ week: w, row: startRow + i });
    });
    if (!detected.some((x) => x.week === week))
      throw new Error(
        `Đã gửi lệnh ghi nhưng chưa đọc lại được tiêu đề Tuần ${week}.`,
      );
    const writtenSchedule = (rows.slice(5, 12) || [])
      .flat()
      .map(clean)
      .filter(Boolean)
      .join("\n");
    const expectedTitles = [
        ...new Set(data.map((x) => clean(x.plan?.title || "")).filter(Boolean)),
      ],
      missingTitles = expectedTitles.filter(
        (t) => !writtenSchedule.includes(t),
      );
    if (missingTitles.length)
      throw new Error(
        `Google Sheet còn thiếu tên bài: ${missingTitles.slice(0, 3).join(" | ")}.`,
      );
    alert(
      `GHI TUẦN ${week} THÀNH CÔNG\n\nTệp: ${meta.properties?.title || ""}\nTab: ${title}\nVùng ghi: dòng ${startRow}–${endRow}\nSố tiết: ${data.length}\nTổng kể cả kiêm nhiệm: ${data.length + getConcurrentPeriods()}\n\nTuần 1–4 không bị sửa. Hãy kiểm tra Google Sheet trước khi mở rộng Tuần 6–35.`,
    );
  } catch (err) {
    console.error("[TKB] Ghi thật Tuần 5:", err);
    alert(
      `CHƯA GHI ĐƯỢC TUẦN 5\n\n${err?.message || err}\n\nKhông mở rộng Tuần 6–35 cho đến khi Tuần 5 được kiểm tra.`,
    );
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old || "Ghi Tuần 5 vào Google Sheet";
    }
  }
}
function ensureGoogleSheetsWeek5WriteButton() {
  const bar = document.querySelector(
    "#outputPreviewModal .output-preview-bar>div",
  );
  if (!bar || bar.querySelector(".preview-google-write-week5")) return;
  const close = bar.querySelector(".preview-close"),
    b = document.createElement("button");
  b.type = "button";
  b.className = "preview-google-write-week5";
  b.textContent = "Ghi Tuần 5 vào Google Sheet";
  b.title =
    "BƯỚC 5.1.4 – dùng cơ chế tổng quát theo tuần, lấy Tuần 4 đã Đạt làm mẫu";
  b.onclick = exportWeek5ToGoogleSheet;
  bar.insertBefore(b, close || null);
}
const openOutputPreviewBeforeWeek5Write = openOutputPreview;
openOutputPreview = function () {
  openOutputPreviewBeforeWeek5Write();
  ensureGoogleSheetsWeek5WriteButton();
};
const previewBtnWeek5Write = document.getElementById("previewBtn");
if (previewBtnWeek5Write) previewBtnWeek5Write.onclick = openOutputPreview;

// BƯỚC 5.1.5 - Ghi Google Sheet tổng quát cho Tuần 6–35.
// Mỗi tuần chiếm 22 dòng. BƯỚC 5.1.6: dùng tuần chuẩn gần nhất đã tồn tại
// trên Google Sheet làm mẫu định dạng; không bắt buộc phải có tuần liền trước.
// Dữ liệu Môn + Lớp + Tên bài vẫn lấy trực tiếp từ Xem trước của tuần đang chọn.
async function exportSelectedWeek6To35ToGoogleSheet() {
  const week = Number($("weekSelect")?.value || 0);
  const btn = document.querySelector(
      "#outputPreviewModal .preview-google-write-week6-35",
    ),
    old = btn?.textContent;
  try {
    if (!Number.isInteger(week) || week < 6 || week > 35)
      throw new Error(
        "BƯỚC 5.1.5 chỉ ghi Tuần 6–35. Hãy chọn tuần cần ghi trước.",
      );
    const startRow = 74 + (week - 4) * 22,
      endRow = startRow + 21;
    let templateWeek = 0,
      templateStart = 0,
      templateEnd = 0,
      offset = 0;
    const data = outputScheduleData().map((x) => ({ ...x }));
    if (data.length !== 20)
      throw new Error(
        `DỪNG GHI: TKB nguồn Tuần ${week} phải có đúng 20 tiết, hiện đọc được ${data.length} tiết.`,
      );
    const slotMap = new Map();
    for (const x of data) {
      const slot = `${clean(x.thu)}|${normKey(x.buoi)}|${Number(x.tiet) || 0}`;
      if (slotMap.has(slot)) {
        const a = slotMap.get(slot);
        throw new Error(
          `DỪNG GHI: trùng vị trí Thứ ${x.thu} - ${x.buoi} - Tiết ${x.tiet}: ${normalizeSubjectForPlan(a.monHoc)} ${a.lop} và ${normalizeSubjectForPlan(x.monHoc)} ${x.lop}.`,
        );
      }
      slotMap.set(slot, x);
    }
    const subjectCount = { tin: 0, cn: 0, dd: 0 };
    for (const x of data) {
      const k = normKey(normalizeSubjectForPlan(x.monHoc)).replace(
        /[^a-z0-9]+/g,
        "",
      );
      if (k.includes("tinhoc") || k === "th") subjectCount.tin++;
      else if (k.includes("congnghe") || k === "cn" || k === "cnghe")
        subjectCount.cn++;
      else if (k.includes("daoduc") || k === "dd") subjectCount.dd++;
    }
    if (
      subjectCount.tin !== 7 ||
      subjectCount.cn !== 12 ||
      subjectCount.dd !== 1
    )
      throw new Error(
        `DỪNG GHI: cơ cấu môn Tuần ${week} chưa đúng TKB thật. Hiện có Tin học ${subjectCount.tin}, Công nghệ ${subjectCount.cn}, Đạo đức ${subjectCount.dd}; yêu cầu 7 / 12 / 1.`,
      );
    const noTitle = data.filter((x) => !clean(x.plan?.title));
    if (noTitle.length)
      throw new Error(
        `DỪNG GHI: còn ${noTitle.length} tiết chưa ghép tên bài Phụ lục 2.`,
      );
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Đang kiểm tra...";
    }
    const token = await getGoogleSheetsReadOnlyToken(),
      headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(GOOGLE_SHEETS_SPREADSHEET_ID)}`;
    const meta = await gsJson(
      `${base}?fields=properties.title,sheets.properties(sheetId,title,gridProperties)`,
      { headers },
    );
    const teacher = (meta.sheets || []).find(
      (s) => Number(s?.properties?.sheetId) === GOOGLE_SHEETS_TEACHER_GID,
    );
    if (
      !teacher ||
      googleSheetNameKey(teacher.properties.title) !==
        googleSheetNameKey(GOOGLE_SHEETS_TEACHER_NAME)
    )
      throw new Error(
        `DỪNG GHI: không khớp tab ${GOOGLE_SHEETS_TEACHER_NAME} / GID ${GOOGLE_SHEETS_TEACHER_GID}.`,
      );
    const title = teacher.properties.title,
      q = gsA1Title(title),
      maxRows = Number(teacher.properties?.gridProperties?.rowCount) || 1000;
    if (maxRows < endRow)
      throw new Error(
        `Google Sheet chỉ có ${maxRows} dòng, chưa đủ để tạo Tuần ${week} đến dòng ${endRow}.`,
      );
    const scan = await gsJson(
        `${base}/values/${encodeURIComponent(q + `!A1:H${maxRows}`)}?majorDimension=ROWS`,
        { headers },
      ),
      found = [];
    (scan.values || []).forEach((r, i) => {
      const w = googleSheetWeekFromLine((r || []).join(" "));
      if (w !== null) found.push({ week: w, row: i + 1 });
    });
    if (found.some((x) => x.week === week))
      throw new Error(
        `Google Sheet đã có Tuần ${week} ở dòng ${found.find((x) => x.week === week).row}. App không ghi chồng.`,
      );
    const candidates = found
      .filter(
        (x) => x.week >= 4 && x.week < week && x.row === 74 + (x.week - 4) * 22,
      )
      .sort((a, b) => b.week - a.week);
    const template = candidates[0];
    if (!template)
      throw new Error(
        `DỪNG GHI: chưa tìm thấy tuần chuẩn nào từ Tuần 4 đến Tuần ${week - 1} để làm mẫu định dạng.`,
      );
    templateWeek = template.week;
    templateStart = template.row;
    templateEnd = templateStart + 21;
    offset = startRow - templateStart;
    if (
      !confirm(
        `GHI THẬT TUẦN ${week} vào tab Võ Thanh Đậm?\n\nApp sẽ dùng Tuần ${templateWeek} (dòng ${templateStart}–${templateEnd}) làm mẫu định dạng và tạo Tuần ${week} tại dòng ${startRow}–${endRow}.\nCác tuần đã có sẽ không bị sửa.`,
      )
    )
      return;
    if (btn) btn.textContent = `Đang lấy mẫu Tuần ${templateWeek}...`;
    const tpl = await gsJson(
      `${base}?ranges=${encodeURIComponent(title + `!A${templateStart}:H${templateEnd}`)}&includeGridData=true&fields=sheets(merges,data(rowMetadata(pixelSize)))`,
      { headers },
    );
    const s0 = templateStart - 1,
      s1 = templateEnd,
      d0 = startRow - 1,
      d1 = endRow;
    const srcMerges = (tpl.sheets?.[0]?.merges || []).filter(
        (m) =>
          m.startRowIndex >= s0 &&
          m.endRowIndex <= s1 &&
          m.startColumnIndex >= 0 &&
          m.endColumnIndex <= 8,
      ),
      srcRowMeta = tpl.sheets?.[0]?.data?.[0]?.rowMetadata || [];
    const requests = [
      {
        unmergeCells: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: d0,
            endRowIndex: d1,
            startColumnIndex: 0,
            endColumnIndex: 8,
          },
        },
      },
      {
        copyPaste: {
          source: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: s0,
            endRowIndex: s1,
            startColumnIndex: 0,
            endColumnIndex: 8,
          },
          destination: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: d0,
            endRowIndex: d1,
            startColumnIndex: 0,
            endColumnIndex: 8,
          },
          pasteType: "PASTE_NORMAL",
          pasteOrientation: "NORMAL",
        },
      },
    ];
    srcMerges.forEach((m) =>
      requests.push({
        mergeCells: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: m.startRowIndex + offset,
            endRowIndex: m.endRowIndex + offset,
            startColumnIndex: m.startColumnIndex,
            endColumnIndex: m.endColumnIndex,
          },
          mergeType: "MERGE_ALL",
        },
      }),
    );
    srcRowMeta.forEach((rm, i) => {
      if (rm?.pixelSize)
        requests.push({
          updateDimensionProperties: {
            range: {
              sheetId: GOOGLE_SHEETS_TEACHER_GID,
              dimension: "ROWS",
              startIndex: d0 + i,
              endIndex: d0 + i + 1,
            },
            properties: { pixelSize: rm.pixelSize },
            fields: "pixelSize",
          },
        });
    });
    requests.push({
      repeatCell: {
        range: {
          sheetId: GOOGLE_SHEETS_TEACHER_GID,
          startRowIndex: d0 + 5,
          endRowIndex: d0 + 12,
          startColumnIndex: 2,
          endColumnIndex: 7,
        },
        cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
        fields: "userEnteredFormat.wrapStrategy",
      },
    });
    requests.push({
      autoResizeDimensions: {
        dimensions: {
          sheetId: GOOGLE_SHEETS_TEACHER_GID,
          dimension: "ROWS",
          startIndex: d0 + 5,
          endIndex: d0 + 12,
        },
      },
    });
    await gsJson(`${base}:batchUpdate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requests }),
    });
    await gsJson(
      `${base}/values/${encodeURIComponent(q + `!A${startRow + 15}:H${startRow + 19}`)}:clear`,
      { method: "POST", headers, body: "{}" },
    );
    if (btn) btn.textContent = `Đang ghi Tuần ${week}...`;
    const payload = gsWeekRows(data, week, startRow).map((x) => ({
      range: `${q}!${x.range}`,
      majorDimension: "ROWS",
      values: x.values,
    }));
    await gsJson(`${base}/values:batchUpdate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: payload }),
    });
    const verify = await gsJson(
        `${base}/values/${encodeURIComponent(q + `!A${startRow}:H${endRow}`)}?majorDimension=ROWS`,
        { headers },
      ),
      rows = verify.values || [],
      detected = [];
    rows.forEach((r, i) => {
      const w = googleSheetWeekFromLine((r || []).join(" "));
      if (w !== null) detected.push({ week: w, row: startRow + i });
    });
    if (!detected.some((x) => x.week === week))
      throw new Error(
        `Đã gửi lệnh ghi nhưng chưa đọc lại được tiêu đề Tuần ${week}.`,
      );
    const scheduleSlice = specialWeek1 ? rows.slice(2, 9) : rows.slice(5, 12);
    const writtenSchedule = (scheduleSlice || [])
        .flat()
        .map(clean)
        .filter(Boolean)
        .join("\n"),
      expectedTitles = [
        ...new Set(data.map((x) => clean(x.plan?.title || "")).filter(Boolean)),
      ],
      missingTitles = expectedTitles.filter(
        (t) => !writtenSchedule.includes(t),
      );
    if (missingTitles.length)
      throw new Error(
        `Google Sheet còn thiếu tên bài: ${missingTitles.slice(0, 3).join(" | ")}.`,
      );
    alert(
      `GHI TUẦN ${week} THÀNH CÔNG\n\nTệp: ${meta.properties?.title || ""}\nTab: ${title}\nVùng ghi: dòng ${startRow}–${endRow}\nSố tiết: ${data.length}\nTổng kể cả kiêm nhiệm: ${data.length + getConcurrentPeriods()}\n\nTuần 1–${week - 1} không bị sửa. Hãy kiểm tra Google Sheet trước khi ghi tuần tiếp theo.`,
    );
  } catch (err) {
    console.error(`[TKB] Ghi thật Tuần ${week}:`, err);
    alert(
      `CHƯA GHI ĐƯỢC TUẦN ${week || ""}\n\n${err?.message || err}\n\nKhông ghi tuần tiếp theo cho đến khi tuần này được kiểm tra.`,
    );
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old || `Ghi Tuần ${week || 6} vào Google Sheet`;
    }
  }
}
function ensureGoogleSheetsWeek6To35WriteButton() {
  const bar = document.querySelector(
    "#outputPreviewModal .output-preview-bar>div",
  );
  if (!bar) return;
  const week = Number($("weekSelect")?.value || 0);
  const old4 = bar.querySelector(".preview-google-write-week4"),
    old5 = bar.querySelector(".preview-google-write-week5");
  if (old4) old4.style.display = week === 4 ? "" : "none";
  if (old5) old5.style.display = week === 5 ? "" : "none";
  let b = bar.querySelector(".preview-google-write-week6-35");
  if (week < 6 || week > 35) {
    if (b) b.remove();
    return;
  }
  if (!b) {
    const close = bar.querySelector(".preview-close");
    b = document.createElement("button");
    b.type = "button";
    b.className = "preview-google-write-week6-35";
    b.onclick = exportSelectedWeek6To35ToGoogleSheet;
    bar.insertBefore(b, close || null);
  }
  b.textContent = `Ghi Tuần ${week} vào Google Sheet`;
  b.title = `BƯỚC 5.1.6 – ghi Tuần ${week} bằng cơ chế tổng quát, dùng tuần chuẩn gần nhất đã tồn tại làm mẫu`;
}
const openOutputPreviewBeforeWeek6To35Write = openOutputPreview;
openOutputPreview = function () {
  openOutputPreviewBeforeWeek6To35Write();
  ensureGoogleSheetsWeek6To35WriteButton();
};
const previewBtnWeek6To35Write = document.getElementById("previewBtn");
if (previewBtnWeek6To35Write)
  previewBtnWeek6To35Write.onclick = openOutputPreview;

// BƯỚC 5.2.2A - Mẫu định dạng độc lập + ghi/cập nhật Tuần 1–35.
// Tạo một tab mẫu ẩn từ bản giáo viên hiện tại (chỉ một lần), sau đó mọi tuần đều dùng
// khối Tuần 3 của tab mẫu ẩn. Vì vậy có thể làm sạch Tuần 1–35 ở tab giáo viên mà không mất mẫu.
const GOOGLE_SHEETS_TEMPLATE_NAME = "_TKB_TEMPLATE_VO_THANH_DAM";
const GOOGLE_SHEETS_TEMPLATE_START_ROW = 51;
async function ensureIndependentGoogleSheetTemplate(base, headers, meta) {
  let tpl = (meta.sheets || []).find(
    (s) =>
      googleSheetNameKey(s?.properties?.title) ===
      googleSheetNameKey(GOOGLE_SHEETS_TEMPLATE_NAME),
  );
  if (tpl) return tpl.properties;
  const teacher = (meta.sheets || []).find(
    (s) => Number(s?.properties?.sheetId) === GOOGLE_SHEETS_TEACHER_GID,
  );
  if (!teacher)
    throw new Error(
      "Không tìm thấy tab giáo viên để tạo mẫu định dạng độc lập.",
    );
  const duplicate = await gsJson(`${base}:batchUpdate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requests: [
        {
          duplicateSheet: {
            sourceSheetId: GOOGLE_SHEETS_TEACHER_GID,
            newSheetName: GOOGLE_SHEETS_TEMPLATE_NAME,
          },
        },
      ],
    }),
  });
  const p = duplicate?.replies?.[0]?.duplicateSheet?.properties;
  if (!p?.sheetId) throw new Error("Không tạo được tab mẫu định dạng độc lập.");
  await gsJson(`${base}:batchUpdate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId: p.sheetId, hidden: true },
            fields: "hidden",
          },
        },
      ],
    }),
  });
  return { ...p, hidden: true };
}
async function exportSelectedWeek1To35ToGoogleSheet(options = {}) {
  const week = Number(options.week || $("weekSelect")?.value || 0);
  const btn = document.querySelector(
      "#outputPreviewModal .preview-google-write-week1-35",
    ),
    old = btn?.textContent;
  try {
    if (!Number.isInteger(week) || week < 1 || week > 35)
      throw new Error("Chỉ hỗ trợ Tuần 1–35.");
    const startRow = 8 + (week - 1) * 22,
      endRow = startRow + 21;
    const data = outputScheduleData().map((x) => ({ ...x }));
    if (!data.length) throw new Error(`Tuần ${week} không có tiết dạy để ghi.`);
    const slotMap = new Map();
    for (const x of data) {
      const slot = `${clean(x.thu)}|${normKey(x.buoi)}|${Number(x.tiet) || 0}`;
      if (slotMap.has(slot)) {
        const a = slotMap.get(slot);
        throw new Error(
          `DỪNG GHI: trùng vị trí Thứ ${x.thu} - ${x.buoi} - Tiết ${x.tiet}: ${normalizeSubjectForPlan(a.monHoc)} ${a.lop} và ${normalizeSubjectForPlan(x.monHoc)} ${x.lop}.`,
        );
      }
      slotMap.set(slot, x);
    }
    const noTitle = data.filter((x) => !clean(x.plan?.title));
    if (noTitle.length)
      throw new Error(
        `DỪNG GHI: còn ${noTitle.length} tiết chưa ghép tên bài Phụ lục 2.`,
      );
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Đang kiểm tra...";
    }
    const token = options.accessToken || (await getGoogleSheetsReadOnlyToken()),
      headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(GOOGLE_SHEETS_SPREADSHEET_ID)}`;
    let meta = await gsJson(
      `${base}?fields=properties.title,sheets.properties(sheetId,title,hidden,gridProperties)`,
      { headers },
    );
    const teacher = (meta.sheets || []).find(
      (s) => Number(s?.properties?.sheetId) === GOOGLE_SHEETS_TEACHER_GID,
    );
    if (
      !teacher ||
      googleSheetNameKey(teacher.properties.title) !==
        googleSheetNameKey(GOOGLE_SHEETS_TEACHER_NAME)
    )
      throw new Error(
        `DỪNG GHI: không khớp tab ${GOOGLE_SHEETS_TEACHER_NAME} / GID ${GOOGLE_SHEETS_TEACHER_GID}.`,
      );
    const title = teacher.properties.title,
      q = gsA1Title(title),
      maxRows = Number(teacher.properties?.gridProperties?.rowCount) || 1000;
    if (maxRows < endRow)
      throw new Error(
        `Google Sheet chỉ có ${maxRows} dòng, chưa đủ để ghi Tuần ${week} đến dòng ${endRow}.`,
      );
    const tpl = await ensureIndependentGoogleSheetTemplate(base, headers, meta);
    // BƯỚC 5.2.6: Tuần 1 là khối đặc biệt vì tiêu đề PHỤ LỤC 1.4 + 3 dòng tiêu đề tuần
    // đã nằm cố định ở hàng 4–7. Chỉ sao chép phần bảng từ mẫu (bỏ 3 dòng tiêu đề tuần)
    // vào hàng 8–26. Tuần 2–35 vẫn giữ nguyên cơ chế khối 22 dòng đã Đạt.
    const templateSheetId = Number(tpl.sheetId);
    const specialWeek1 = week === 1;
    const s0 = GOOGLE_SHEETS_TEMPLATE_START_ROW - 1 + (specialWeek1 ? 3 : 0);
    const s1 = GOOGLE_SHEETS_TEMPLATE_START_ROW - 1 + 22;
    const d0 = startRow - 1,
      d1 = specialWeek1 ? 26 : endRow;
    const templateReadStart =
      GOOGLE_SHEETS_TEMPLATE_START_ROW + (specialWeek1 ? 3 : 0);
    const templateReadEnd = GOOGLE_SHEETS_TEMPLATE_START_ROW + 21;
    const tplData = await gsJson(
      `${base}?ranges=${encodeURIComponent(GOOGLE_SHEETS_TEMPLATE_NAME + `!A${templateReadStart}:H${templateReadEnd}`)}&includeGridData=true&fields=sheets(merges,data(rowMetadata(pixelSize)))`,
      { headers },
    );
    const srcMerges = (tplData.sheets?.[0]?.merges || []).filter(
        (m) =>
          m.startRowIndex >= s0 &&
          m.endRowIndex <= s1 &&
          m.startColumnIndex >= 0 &&
          m.endColumnIndex <= 8,
      ),
      srcRowMeta = tplData.sheets?.[0]?.data?.[0]?.rowMetadata || [],
      offset = d0 - s0;
    const scan = await gsJson(
      `${base}/values/${encodeURIComponent(q + `!A${startRow}:H${endRow}`)}?majorDimension=ROWS`,
      { headers },
    );
    const exists = (scan.values || []).some(
      (r) => googleSheetWeekFromLine((r || []).join(" ")) === week,
    );
    const action = exists ? "CẬP NHẬT" : "GHI";
    if (
      !options.skipConfirm &&
      !confirm(
        `${action} TUẦN ${week} vào tab ${title}?\n\nVùng dòng ${startRow}–${endRow}. Mẫu định dạng lấy từ tab mẫu ẩn, không phụ thuộc các tuần đang tồn tại.\nTKB tuần này hiện có ${data.length} tiết; tổng kể cả kiêm nhiệm: ${data.length + getConcurrentPeriods()}.`,
      )
    )
      return false;
    if (btn) btn.textContent = `Đang ${action.toLowerCase()} Tuần ${week}...`;
    const requests = [
      {
        unmergeCells: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: d0,
            endRowIndex: d1,
            startColumnIndex: 0,
            endColumnIndex: 8,
          },
        },
      },
      {
        copyPaste: {
          source: {
            sheetId: templateSheetId,
            startRowIndex: s0,
            endRowIndex: s1,
            startColumnIndex: 0,
            endColumnIndex: 8,
          },
          destination: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: d0,
            endRowIndex: d1,
            startColumnIndex: 0,
            endColumnIndex: 8,
          },
          pasteType: "PASTE_NORMAL",
          pasteOrientation: "NORMAL",
        },
      },
    ];
    // BƯỚC 5.2.14C: PASTE_NORMAL đã sao chép cấu trúc merge từ tab mẫu.
    // Không merge lại srcMerges lần hai vì sẽ chồng lên merge vừa được copy và Google Sheets từ chối.
    srcRowMeta.forEach((rm, i) => {
      if (rm?.pixelSize)
        requests.push({
          updateDimensionProperties: {
            range: {
              sheetId: GOOGLE_SHEETS_TEACHER_GID,
              dimension: "ROWS",
              startIndex: d0 + i,
              endIndex: d0 + i + 1,
            },
            properties: { pixelSize: rm.pixelSize },
            fields: "pixelSize",
          },
        });
    });
    const scheduleStartIndex = specialWeek1 ? 9 : d0 + 5;
    const scheduleEndIndex = scheduleStartIndex + 7;
    requests.push({
      repeatCell: {
        range: {
          sheetId: GOOGLE_SHEETS_TEACHER_GID,
          startRowIndex: scheduleStartIndex,
          endRowIndex: scheduleEndIndex,
          startColumnIndex: 2,
          endColumnIndex: 7,
        },
        cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
        fields: "userEnteredFormat.wrapStrategy",
      },
    });
    requests.push({
      autoResizeDimensions: {
        dimensions: {
          sheetId: GOOGLE_SHEETS_TEACHER_GID,
          dimension: "ROWS",
          startIndex: scheduleStartIndex,
          endIndex: scheduleEndIndex,
        },
      },
    });
    await gsJson(`${base}:batchUpdate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requests }),
    });
    // BƯỚC 5.2.11: khôi phục đúng hai cột bên trái của Phụ lục 1.4 cho mọi tuần.
    // Cột A = Buổi (Sáng/Chiều), cột B = Tiết; hàng trên cùng của hai cột là "Thời gian".
    // Chỉ tác động A:B trong phần lịch, không thay đổi dữ liệu bài học C:G hay phần Tổng hợp.
    const leftHeaderRow = specialWeek1 ? 8 : startRow + 3;
    const leftSubHeaderRow = leftHeaderRow + 1;
    const leftScheduleStart = leftHeaderRow + 2;
    const leftScheduleEnd = leftScheduleStart + 7;
    // BƯỚC 5.2.14C: giữ nguyên merge A:B đã được copy từ tab mẫu; chỉ áp lại định dạng và ghi nhãn bên dưới.
    const leftReq = [
      {
        repeatCell: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: leftHeaderRow - 1,
            endRowIndex: leftScheduleEnd - 1,
            startColumnIndex: 0,
            endColumnIndex: 2,
          },
          cell: {
            userEnteredFormat: {
              horizontalAlignment: "CENTER",
              verticalAlignment: "MIDDLE",
              wrapStrategy: "WRAP",
              textFormat: { fontFamily: "Times New Roman", fontSize: 12 },
            },
          },
          fields:
            "userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy,textFormat)",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: leftHeaderRow - 1,
            endRowIndex: leftSubHeaderRow,
            startColumnIndex: 0,
            endColumnIndex: 2,
          },
          cell: {
            userEnteredFormat: {
              textFormat: {
                bold: true,
                fontFamily: "Times New Roman",
                fontSize: 12,
              },
            },
          },
          fields: "userEnteredFormat.textFormat",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: leftScheduleStart - 1,
            endRowIndex: leftScheduleEnd - 1,
            startColumnIndex: 0,
            endColumnIndex: 2,
          },
          cell: {
            userEnteredFormat: {
              borders: {
                top: { style: "SOLID" },
                bottom: { style: "SOLID" },
                left: { style: "SOLID" },
                right: { style: "SOLID" },
              },
            },
          },
          fields: "userEnteredFormat.borders",
        },
      },
    ];
    await gsJson(`${base}:batchUpdate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requests: leftReq }),
    });
    if (specialWeek1) {
      // BƯỚC 5.2.8: dựng đúng khối cuối Tuần 1 như Xem trước.
      const sumReq = [
        {
          unmergeCells: {
            range: {
              sheetId: GOOGLE_SHEETS_TEACHER_GID,
              startRowIndex: 17,
              endRowIndex: 25,
              startColumnIndex: 1,
              endColumnIndex: 8,
            },
          },
        },
        {
          mergeCells: {
            range: {
              sheetId: GOOGLE_SHEETS_TEACHER_GID,
              startRowIndex: 17,
              endRowIndex: 18,
              startColumnIndex: 1,
              endColumnIndex: 8,
            },
            mergeType: "MERGE_ALL",
          },
        },
        {
          mergeCells: {
            range: {
              sheetId: GOOGLE_SHEETS_TEACHER_GID,
              startRowIndex: 18,
              endRowIndex: 19,
              startColumnIndex: 1,
              endColumnIndex: 8,
            },
            mergeType: "MERGE_ALL",
          },
        },
      ];
      for (let rr = 19; rr < 25; rr++) {
        sumReq.push({
          mergeCells: {
            range: {
              sheetId: GOOGLE_SHEETS_TEACHER_GID,
              startRowIndex: rr,
              endRowIndex: rr + 1,
              startColumnIndex: 2,
              endColumnIndex: 4,
            },
            mergeType: "MERGE_ALL",
          },
        });
        sumReq.push({
          mergeCells: {
            range: {
              sheetId: GOOGLE_SHEETS_TEACHER_GID,
              startRowIndex: rr,
              endRowIndex: rr + 1,
              startColumnIndex: 5,
              endColumnIndex: 8,
            },
            mergeType: "MERGE_ALL",
          },
        });
      }
      sumReq.push({
        repeatCell: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: 17,
            endRowIndex: 25,
            startColumnIndex: 1,
            endColumnIndex: 8,
          },
          cell: {
            userEnteredFormat: {
              horizontalAlignment: "CENTER",
              verticalAlignment: "MIDDLE",
              wrapStrategy: "WRAP",
              textFormat: { fontFamily: "Times New Roman", fontSize: 12 },
            },
          },
          fields:
            "userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy,textFormat)",
        },
      });
      sumReq.push({
        repeatCell: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: 19,
            endRowIndex: 25,
            startColumnIndex: 1,
            endColumnIndex: 8,
          },
          cell: {
            userEnteredFormat: {
              borders: {
                top: { style: "SOLID" },
                bottom: { style: "SOLID" },
                left: { style: "SOLID" },
                right: { style: "SOLID" },
              },
            },
          },
          fields: "userEnteredFormat.borders",
        },
      });
      sumReq.push({
        repeatCell: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: 17,
            endRowIndex: 20,
            startColumnIndex: 1,
            endColumnIndex: 8,
          },
          cell: {
            userEnteredFormat: {
              textFormat: {
                bold: true,
                fontFamily: "Times New Roman",
                fontSize: 12,
              },
            },
          },
          fields: "userEnteredFormat.textFormat",
        },
      });
      sumReq.push({
        repeatCell: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: 24,
            endRowIndex: 25,
            startColumnIndex: 1,
            endColumnIndex: 8,
          },
          cell: {
            userEnteredFormat: {
              textFormat: {
                bold: true,
                fontFamily: "Times New Roman",
                fontSize: 12,
              },
            },
          },
          fields: "userEnteredFormat.textFormat",
        },
      });
      await gsJson(`${base}:batchUpdate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ requests: sumReq }),
      });
    } else {
      // BƯỚC 5.2.10: chuẩn hóa phần cuối cho Tuần 2–35 theo đúng mẫu Tổng hợp đã Đạt của Tuần 1.
      // Mỗi khối tuần 22 dòng: r12 = Tổng số tiết dạy, r13 = TỔNG HỢP, r14 = tiêu đề, r15–r18 = chi tiết, r19 = Tổng số.
      const sr = startRow;
      const sumReq = [
        {
          unmergeCells: {
            range: {
              sheetId: GOOGLE_SHEETS_TEACHER_GID,
              startRowIndex: sr + 11,
              endRowIndex: sr + 20,
              startColumnIndex: 1,
              endColumnIndex: 8,
            },
          },
        },
        {
          mergeCells: {
            range: {
              sheetId: GOOGLE_SHEETS_TEACHER_GID,
              startRowIndex: sr + 11,
              endRowIndex: sr + 12,
              startColumnIndex: 1,
              endColumnIndex: 8,
            },
            mergeType: "MERGE_ALL",
          },
        },
        {
          mergeCells: {
            range: {
              sheetId: GOOGLE_SHEETS_TEACHER_GID,
              startRowIndex: sr + 12,
              endRowIndex: sr + 13,
              startColumnIndex: 1,
              endColumnIndex: 8,
            },
            mergeType: "MERGE_ALL",
          },
        },
      ];
      for (let rr = sr + 13; rr < sr + 20; rr++) {
        sumReq.push({
          mergeCells: {
            range: {
              sheetId: GOOGLE_SHEETS_TEACHER_GID,
              startRowIndex: rr,
              endRowIndex: rr + 1,
              startColumnIndex: 2,
              endColumnIndex: 4,
            },
            mergeType: "MERGE_ALL",
          },
        });
        sumReq.push({
          mergeCells: {
            range: {
              sheetId: GOOGLE_SHEETS_TEACHER_GID,
              startRowIndex: rr,
              endRowIndex: rr + 1,
              startColumnIndex: 5,
              endColumnIndex: 8,
            },
            mergeType: "MERGE_ALL",
          },
        });
      }
      sumReq.push({
        repeatCell: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: sr + 11,
            endRowIndex: sr + 20,
            startColumnIndex: 1,
            endColumnIndex: 8,
          },
          cell: {
            userEnteredFormat: {
              horizontalAlignment: "CENTER",
              verticalAlignment: "MIDDLE",
              wrapStrategy: "WRAP",
              textFormat: { fontFamily: "Times New Roman", fontSize: 12 },
            },
          },
          fields:
            "userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy,textFormat)",
        },
      });
      sumReq.push({
        repeatCell: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: sr + 13,
            endRowIndex: sr + 20,
            startColumnIndex: 1,
            endColumnIndex: 8,
          },
          cell: {
            userEnteredFormat: {
              borders: {
                top: { style: "SOLID" },
                bottom: { style: "SOLID" },
                left: { style: "SOLID" },
                right: { style: "SOLID" },
              },
            },
          },
          fields: "userEnteredFormat.borders",
        },
      });
      sumReq.push({
        repeatCell: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: sr + 11,
            endRowIndex: sr + 14,
            startColumnIndex: 1,
            endColumnIndex: 8,
          },
          cell: {
            userEnteredFormat: {
              textFormat: {
                bold: true,
                fontFamily: "Times New Roman",
                fontSize: 12,
              },
            },
          },
          fields: "userEnteredFormat.textFormat",
        },
      });
      // BƯỚC 5.2.13A: Google Sheets dùng chỉ số hàng 0-based; dòng r(19) tương ứng sr+18.
      // In đậm đúng dòng Tổng số, không định dạng nhầm dòng trống bên dưới.
      sumReq.push({
        repeatCell: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: sr + 18,
            endRowIndex: sr + 19,
            startColumnIndex: 1,
            endColumnIndex: 8,
          },
          cell: {
            userEnteredFormat: {
              textFormat: {
                bold: true,
                fontFamily: "Times New Roman",
                fontSize: 12,
              },
            },
          },
          fields: "userEnteredFormat.textFormat",
        },
      });
      await gsJson(`${base}:batchUpdate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ requests: sumReq }),
      });
    }
    // Tuần 1: giữ nguyên PHỤ LỤC 1.4 ở hàng 4 và ghi lại đúng 3 dòng tiêu đề hàng 5–7;
    // chỉ làm sạch bảng hàng 8–26. Tuần 2–35 giữ nguyên vùng 22 dòng.
    await gsJson(
      `${base}/values/${encodeURIComponent(q + `!A${specialWeek1 ? 8 : startRow}:H${specialWeek1 ? 26 : endRow}`)}:clear`,
      { method: "POST", headers, body: "{}" },
    );
    // BƯỚC 5.2.7: Tuần 1 có tiêu đề cố định ở hàng 5–7 do mẫu đã sao chép.
    // Xóa riêng các ô mép trái từng bị ghi dư và dòng Tổng số dư bên dưới bảng tổng hợp.
    if (specialWeek1) {
      await gsJson(`${base}/values/${encodeURIComponent(q + "!A5:A7")}:clear`, {
        method: "POST",
        headers,
        body: "{}",
      });
      await gsJson(
        `${base}/values/${encodeURIComponent(q + "!A27:H27")}:clear`,
        { method: "POST", headers, body: "{}" },
      );
    }
    let weekRows = gsWeekRows(data, week, startRow);
    if (specialWeek1) {
      const wd = selectedWeekDates();
      weekRows = weekRows
        .map((x) => {
          const m = String(x.range).match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
          if (!m) return x;
          const row = Number(m[2]);
          // Các dòng bảng của mẫu chuẩn dịch lên 3 hàng; ba dòng tiêu đề được ghi riêng ở 5–7.
          if (row >= startRow + 3)
            return {
              ...x,
              range: String(x.range).replace(/(\d+)/g, (n) =>
                String(Number(n) - 3),
              ),
            };
          return null;
        })
        .filter(Boolean);
      // BƯỚC 5.2.8: Tuần 1 có phần cuối riêng. Chỉ giữ dữ liệu lịch ở hàng 8–16;
      // phần Tổng số/TỔNG HỢP sẽ dựng chuẩn riêng ở hàng 18–25 bên dưới.
      weekRows = weekRows.filter((x) => {
        const m = String(x.range).match(/^[A-Z]+(\d+)/);
        return !m || Number(m[1]) < 18;
      });
      weekRows.unshift({
        range: "B6",
        values: [
          [
            "Năm học 2026 – 2027. Môn: Tin học, Công nghệ, Đạo đức – Khối: 3, 4, 5 – Trường TH – THCS & THPT Lại Sơn",
          ],
        ],
      });
      const counts = { "Công nghệ": 0, "Tin học": 0, "Đạo đức": 0 };
      data.forEach((x) => {
        const k = normKey(
          normalizeSubjectForPlan(x?.monHoc || x?.plan?.subject || ""),
        ).replace(/[^a-z0-9]+/g, "");
        if (k.includes("congnghe") || k === "cn" || k === "cnghe")
          counts["Công nghệ"]++;
        else if (k.includes("tinhoc") || k === "th") counts["Tin học"]++;
        else if (k.includes("daoduc") || k === "dd") counts["Đạo đức"]++;
      });
      const concurrent = getConcurrentPeriods();
      weekRows.push(
        { range: "B18", values: [[`Tổng số: ${data.length} tiết`]] },
        { range: "B19", values: [["TỔNG HỢP"]] },
        {
          range: "B20:H20",
          values: [
            ["TT", "Nội dung", "", "Số lượng tiết học", "Ghi chú", "", ""],
          ],
        },
        {
          range: "B21:H24",
          values: [
            [1, "Tin học", "", counts["Tin học"], "", "", ""],
            [2, "Công nghệ", "", counts["Công nghệ"], "", "", ""],
            [3, "Kiêm nhiệm", "", concurrent, "", "", ""],
            [4, "Đạo đức", "", counts["Đạo đức"], "", "", ""],
          ],
        },
        {
          range: "B25:H25",
          values: [["", "Tổng số", "", data.length + concurrent, "", "", ""]],
        },
      );
    }
    if (!specialWeek1) {
      const counts = { "Công nghệ": 0, "Tin học": 0, "Đạo đức": 0 };
      data.forEach((x) => {
        const k = normKey(
          normalizeSubjectForPlan(x?.monHoc || x?.plan?.subject || ""),
        ).replace(/[^a-z0-9]+/g, "");
        if (k.includes("congnghe") || k === "cn" || k === "cnghe")
          counts["Công nghệ"]++;
        else if (k.includes("tinhoc") || k === "th") counts["Tin học"]++;
        else if (k.includes("daoduc") || k === "dd") counts["Đạo đức"]++;
      });
      const concurrent = getConcurrentPeriods(),
        r = (n) => startRow + n;
      // Loại các dòng tổng hợp cũ do gsWeekRows tạo, rồi ghi lại một cấu trúc thống nhất cho Tuần 2–35.
      weekRows = weekRows.filter((x) => {
        const m = String(x.range).match(/^[A-Z]+(\d+)/);
        return !m || Number(m[1]) < r(12);
      });
      weekRows.push(
        { range: `B${r(12)}`, values: [[`Tổng số: ${data.length} tiết`]] },
        { range: `B${r(13)}`, values: [["TỔNG HỢP"]] },
        {
          range: `B${r(14)}:H${r(14)}`,
          values: [
            ["TT", "Nội dung", "", "Số lượng tiết học", "Ghi chú", "", ""],
          ],
        },
        {
          range: `B${r(15)}:H${r(18)}`,
          values: [
            [1, "Tin học", "", counts["Tin học"], "", "", ""],
            [2, "Công nghệ", "", counts["Công nghệ"], "", "", ""],
            [3, "Kiêm nhiệm", "", concurrent, "", "", ""],
            [4, "Đạo đức", "", counts["Đạo đức"], "", "", ""],
          ],
        },
        {
          range: `B${r(19)}:H${r(19)}`,
          values: [["", "Tổng số", "", data.length + concurrent, "", "", ""]],
        },
      );
    }
    // BƯỚC 5.2.11: ghi lại nhãn Thời gian/Buổi, Sáng/Chiều và số Tiết sau mọi phép dịch hàng của Tuần 1.
    weekRows.push(
      {
        range: `A${leftHeaderRow}:B${leftHeaderRow}`,
        values: [["Thời gian", ""]],
      },
      {
        range: `A${leftSubHeaderRow}:B${leftSubHeaderRow}`,
        values: [["Buổi", "Tiết"]],
      },
      // BƯỚC 5.4.3H.1: khôi phục tiêu đề cột cuối đã bị mất ở Google Sheet.
      // Chỉ ghi ô neo H của khối header để an toàn với trường hợp H đang merge dọc 2 hàng.
      { range: `H${leftHeaderRow}`, values: [["Nội dung điều chỉnh"]] },
      { range: `A${leftScheduleStart}`, values: [["Sáng"]] },
      {
        range: `B${leftScheduleStart}:B${leftScheduleStart + 3}`,
        values: [[1], [2], [3], [4]],
      },
      { range: `A${leftScheduleStart + 4}`, values: [["Chiều"]] },
      {
        range: `B${leftScheduleStart + 4}:B${leftScheduleStart + 6}`,
        values: [[5], [6], [7]],
      },
    );
    const payload = weekRows.map((x) => ({
      range: `${q}!${x.range}`,
      majorDimension: "ROWS",
      values: x.values,
    }));
    await gsJson(`${base}/values:batchUpdate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: payload }),
    });

    // BƯỚC 5.4.3H.1 - Đồng bộ màu Google Sheet bằng ColorStyle (API v4) + giữ nguyên logic ghi/cập nhật.
    // Chỉ định dạng màu/chữ/viền; KHÔNG thay đổi giá trị, merge, kích thước hay cấu trúc dữ liệu.
    const gsGreen = { red: 11 / 255, green: 122 / 255, blue: 83 / 255 };
    const gsGreen2 = { red: 25 / 255, green: 145 / 255, blue: 101 / 255 };
    const gsMint = { red: 232 / 255, green: 245 / 255, blue: 238 / 255 };
    const gsMint2 = { red: 245 / 255, green: 250 / 255, blue: 247 / 255 };
    const gsWhite = { red: 1, green: 1, blue: 1 };
    const gsDark = { red: 18 / 255, green: 52 / 255, blue: 45 / 255 };
    const greenBorder = { style: "SOLID", color: gsGreen2 };
    const allGreenBorders = {
      top: greenBorder,
      bottom: greenBorder,
      left: greenBorder,
      right: greenBorder,
    };
    const themeReq = [];
    const addTheme = (r0, r1, c0, c1, fmt, fields) =>
      themeReq.push({
        repeatCell: {
          range: {
            sheetId: GOOGLE_SHEETS_TEACHER_GID,
            startRowIndex: r0,
            endRowIndex: r1,
            startColumnIndex: c0,
            endColumnIndex: c1,
          },
          cell: { userEnteredFormat: fmt },
          fields,
        },
      });
    const hdr0 = leftHeaderRow - 1,
      hdr1 = leftSubHeaderRow;
    // Hai hàng đầu bảng: xanh lá đậm, chữ trắng.
    addTheme(
      hdr0,
      hdr1,
      0,
      8,
      {
        backgroundColorStyle: { rgbColor: gsGreen },
        horizontalAlignment: "CENTER",
        verticalAlignment: "MIDDLE",
        textFormat: {
          bold: true,
          foregroundColorStyle: { rgbColor: gsWhite },
          fontFamily: "Times New Roman",
          fontSize: 12,
        },
        borders: allGreenBorders,
        wrapStrategy: "WRAP",
      },
      "userEnteredFormat.backgroundColorStyle,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat,userEnteredFormat.borders,userEnteredFormat.wrapStrategy",
    );
    // Thân lịch: nền trắng/xanh mint xen kẽ, viền xanh dịu.
    for (let rr = leftScheduleStart - 1; rr < leftScheduleEnd - 1; rr++) {
      addTheme(
        rr,
        rr + 1,
        0,
        8,
        {
          backgroundColorStyle: {
            rgbColor: (rr - (leftScheduleStart - 1)) % 2 ? gsMint2 : gsWhite,
          },
          textFormat: {
            foregroundColorStyle: { rgbColor: gsDark },
            fontFamily: "Times New Roman",
            fontSize: 12,
          },
          borders: allGreenBorders,
          verticalAlignment: "MIDDLE",
          wrapStrategy: "WRAP",
        },
        "userEnteredFormat.backgroundColorStyle,userEnteredFormat.textFormat,userEnteredFormat.borders,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy",
      );
    }
    // Cột Buổi/Tiết dùng xanh mint rõ hơn.
    addTheme(
      leftScheduleStart - 1,
      leftScheduleEnd - 1,
      0,
      2,
      {
        backgroundColorStyle: { rgbColor: gsMint },
        horizontalAlignment: "CENTER",
        verticalAlignment: "MIDDLE",
        textFormat: {
          bold: true,
          foregroundColorStyle: { rgbColor: gsDark },
          fontFamily: "Times New Roman",
          fontSize: 12,
        },
        borders: allGreenBorders,
      },
      "userEnteredFormat.backgroundColorStyle,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat,userEnteredFormat.borders",
    );
    const totalRow0 = specialWeek1 ? 17 : startRow + 11;
    const summaryTitle0 = totalRow0 + 1;
    const summaryHeader0 = totalRow0 + 2;
    const summaryLast0 = specialWeek1 ? 24 : startRow + 18;
    // Tổng số tiết dạy.
    addTheme(
      totalRow0,
      totalRow0 + 1,
      1,
      8,
      {
        backgroundColorStyle: { rgbColor: gsGreen },
        horizontalAlignment: "CENTER",
        verticalAlignment: "MIDDLE",
        textFormat: {
          bold: true,
          foregroundColorStyle: { rgbColor: gsWhite },
          fontFamily: "Times New Roman",
          fontSize: 12,
        },
        borders: allGreenBorders,
      },
      "userEnteredFormat.backgroundColorStyle,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat,userEnteredFormat.borders",
    );
    // Dòng TỔNG HỢP.
    addTheme(
      summaryTitle0,
      summaryTitle0 + 1,
      1,
      8,
      {
        backgroundColorStyle: { rgbColor: gsMint },
        horizontalAlignment: "CENTER",
        verticalAlignment: "MIDDLE",
        textFormat: {
          bold: true,
          foregroundColorStyle: { rgbColor: gsDark },
          fontFamily: "Times New Roman",
          fontSize: 12,
        },
      },
      "userEnteredFormat.backgroundColorStyle,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat",
    );
    // Header bảng tổng hợp.
    addTheme(
      summaryHeader0,
      summaryHeader0 + 1,
      1,
      8,
      {
        backgroundColorStyle: { rgbColor: gsGreen2 },
        horizontalAlignment: "CENTER",
        verticalAlignment: "MIDDLE",
        textFormat: {
          bold: true,
          foregroundColorStyle: { rgbColor: gsWhite },
          fontFamily: "Times New Roman",
          fontSize: 12,
        },
        borders: allGreenBorders,
      },
      "userEnteredFormat.backgroundColorStyle,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat,userEnteredFormat.borders",
    );
    // Nội dung tổng hợp.
    if (summaryLast0 > summaryHeader0 + 1)
      addTheme(
        summaryHeader0 + 1,
        summaryLast0,
        1,
        8,
        {
          backgroundColorStyle: { rgbColor: gsMint2 },
          horizontalAlignment: "CENTER",
          verticalAlignment: "MIDDLE",
          textFormat: {
            foregroundColorStyle: { rgbColor: gsDark },
            fontFamily: "Times New Roman",
            fontSize: 12,
          },
          borders: allGreenBorders,
        },
        "userEnteredFormat.backgroundColorStyle,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat,userEnteredFormat.borders",
      );
    // Dòng Tổng số cuối bảng tổng hợp.
    addTheme(
      summaryLast0,
      summaryLast0 + 1,
      1,
      8,
      {
        backgroundColorStyle: { rgbColor: gsGreen2 },
        horizontalAlignment: "CENTER",
        verticalAlignment: "MIDDLE",
        textFormat: {
          bold: true,
          foregroundColorStyle: { rgbColor: gsWhite },
          fontFamily: "Times New Roman",
          fontSize: 12,
        },
        borders: allGreenBorders,
      },
      "userEnteredFormat.backgroundColorStyle,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat,userEnteredFormat.borders",
    );
    await gsJson(`${base}:batchUpdate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requests: themeReq }),
    });

    // BƯỚC 5.2.7: với Tuần 1, tiêu đề tuần nằm ở hàng 5–7, ngoài vùng A8:H29.
    // Đọc đúng vùng tiêu đề để xác minh, tránh báo thất bại giả sau khi Google Sheet đã ghi thành công.
    const verifyRange = specialWeek1 ? "A4:H27" : `A${startRow}:H${endRow}`;
    const verify = await gsJson(
        `${base}/values/${encodeURIComponent(q + "!" + verifyRange)}?majorDimension=ROWS`,
        { headers },
      ),
      rows = verify.values || [];
    if (
      !rows.some((r) => googleSheetWeekFromLine((r || []).join(" ")) === week)
    )
      throw new Error(
        `Đã gửi lệnh nhưng chưa đọc lại được tiêu đề Tuần ${week}.`,
      );
    const writtenSchedule = (
        specialWeek1 ? rows.slice(6, 13) || [] : rows.slice(5, 12) || []
      )
        .flat()
        .map(clean)
        .filter(Boolean)
        .join("\n"),
      expectedTitles = [
        ...new Set(data.map((x) => clean(x.plan?.title || "")).filter(Boolean)),
      ],
      missingTitles = expectedTitles.filter(
        (t) => !writtenSchedule.includes(t),
      );
    if (missingTitles.length)
      throw new Error(
        `Google Sheet còn thiếu tên bài: ${missingTitles.slice(0, 3).join(" | ")}.`,
      );
    if (!options.silentSuccess)
      alert(
        `${action} TUẦN ${week} THÀNH CÔNG\n\nVùng: dòng ${startRow}–${endRow}\nSố tiết theo TKB có hiệu lực: ${data.length}\nTổng kể cả kiêm nhiệm: ${data.length + getConcurrentPeriods()}\n\nMẫu định dạng đã độc lập với Tuần 1–35.`,
      );
    return true;
  } catch (err) {
    console.error(`[TKB] 5.2.2A Tuần ${week}:`, err);
    if (options.throwOnError) throw err;
    alert(`CHƯA GHI ĐƯỢC TUẦN ${week || ""}\n\n${err?.message || err}`);
    return false;
  } finally {
    if (btn && !options.keepButtonBusy) {
      btn.disabled = false;
      btn.textContent =
        old || `Ghi/Cập nhật Tuần ${week || 1} vào Google Sheet`;
    }
  }
}
function ensureGoogleSheetsWeek1To35WriteButton() {
  const bar = document.querySelector(
    "#outputPreviewModal .output-preview-bar>div",
  );
  if (!bar) return;
  bar
    .querySelectorAll(
      ".preview-google-write-week4,.preview-google-write-week5,.preview-google-write-week6-35",
    )
    .forEach((x) => x.remove());
  let b = bar.querySelector(".preview-google-write-week1-35"),
    week = Number($("weekSelect")?.value || 1);
  if (!b) {
    const close = bar.querySelector(".preview-close");
    b = document.createElement("button");
    b.type = "button";
    b.className = "preview-google-write-week1-35";
    b.onclick = exportSelectedWeek1To35ToGoogleSheet;
    bar.insertBefore(b, close || null);
  }
  b.textContent = `Ghi/Cập nhật Tuần ${week} vào Google Sheet`;
  b.title =
    "BƯỚC 5.2.2A – ghi/cập nhật Tuần 1–35 bằng mẫu định dạng ẩn độc lập";
}
const openOutputPreviewBeforeWeek1To35Write = openOutputPreview;
openOutputPreview = function () {
  openOutputPreviewBeforeWeek1To35Write();
  ensureGoogleSheetsWeek1To35WriteButton();
};
const previewBtnWeek1To35Write = document.getElementById("previewBtn");
if (previewBtnWeek1To35Write)
  previewBtnWeek1To35Write.onclick = openOutputPreview;

// BƯỚC 5.2.14 - Làm mới Google Sheet theo tuần / vùng tuần / toàn bộ 1–35.
// Mỗi tuần chiếm đúng 22 dòng: startRow = 8 + 22 * (week - 1).
// Chỉ làm sạch vùng được chọn; giữ A1:H7, kích thước cột và tab mẫu ẩn.
function googleSheetResetWeekRange(firstWeek, lastWeek) {
  const a = Math.max(1, Math.min(35, Number(firstWeek) || 1)),
    b = Math.max(1, Math.min(35, Number(lastWeek) || a));
  const from = Math.min(a, b),
    to = Math.max(a, b),
    startRow = 8 + 22 * (from - 1),
    endRow = 8 + 22 * to - 1;
  return { from, to, startRow, endRow };
}
function closeGoogleSheetResetDialog() {
  document.getElementById("googleSheetResetRangeModal")?.remove();
}
function openGoogleSheetResetDialog() {
  closeGoogleSheetResetDialog();
  const current = Math.max(
    1,
    Math.min(35, Number($("weekSelect")?.value || 1)),
  );
  const modal = document.createElement("div");
  modal.id = "googleSheetResetRangeModal";
  modal.innerHTML = `<div class="gs-reset-card"><div class="gs-reset-head"><div><b>LÀM MỚI GOOGLE SHEET</b><span>Chỉ làm sạch đúng tuần hoặc vùng tuần bạn chọn.</span></div><button type="button" class="gs-reset-x" aria-label="Đóng">×</button></div><div class="gs-reset-body"><label class="gs-reset-option"><input type="radio" name="gsResetMode" value="current" checked><span><b>Tuần hiện tại</b><small>Tuần ${current}</small></span></label><label class="gs-reset-option"><input type="radio" name="gsResetMode" value="single"><span><b>Một tuần cụ thể</b><small>Chọn một tuần từ 1 đến 35</small></span></label><div class="gs-reset-fields" data-mode="single"><label>Tuần<select class="gs-reset-single">${Array.from({ length: 35 }, (_, i) => `<option value="${i + 1}" ${i + 1 === current ? "selected" : ""}>Tuần ${i + 1}</option>`).join("")}</select></label></div><label class="gs-reset-option"><input type="radio" name="gsResetMode" value="range"><span><b>Một vùng tuần</b><small>Ví dụ Tuần 10 → Tuần 20</small></span></label><div class="gs-reset-fields" data-mode="range"><label>Từ<select class="gs-reset-from">${Array.from({ length: 35 }, (_, i) => `<option value="${i + 1}">Tuần ${i + 1}</option>`).join("")}</select></label><label>Đến<select class="gs-reset-to">${Array.from({ length: 35 }, (_, i) => `<option value="${i + 1}" ${i + 1 === 35 ? "selected" : ""}>Tuần ${i + 1}</option>`).join("")}</select></label></div><label class="gs-reset-option gs-reset-all"><input type="radio" name="gsResetMode" value="all"><span><b>Toàn bộ Tuần 1–35</b><small>Dùng khi cần làm sạch toàn bộ vùng kế hoạch</small></span></label><div class="gs-reset-note">TKB, Phụ lục 2 và các tuần ngoài phạm vi đã chọn không bị thay đổi.</div></div><div class="gs-reset-actions"><button type="button" class="gs-reset-cancel">Hủy</button><button type="button" class="gs-reset-run">Làm mới vùng đã chọn</button></div></div>`;
  document.body.appendChild(modal);
  const style = document.createElement("style");
  style.textContent = `#googleSheetResetRangeModal{position:fixed;inset:0;z-index:100100;background:rgba(15,23,42,.42);display:grid;place-items:center;padding:20px;font-family:Arial,sans-serif}.gs-reset-card{width:min(560px,96vw);background:#fff;border-radius:16px;box-shadow:0 24px 70px rgba(15,23,42,.25);overflow:hidden}.gs-reset-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;padding:20px 22px 16px;border-bottom:1px solid #e2e8f0}.gs-reset-head b{display:block;color:#123f68;font-size:17px}.gs-reset-head span{display:block;margin-top:5px;color:#64748b;font-size:13px}.gs-reset-x{border:0;background:#f1f5f9;width:34px;height:34px;border-radius:9px;font-size:22px;cursor:pointer;color:#475569}.gs-reset-body{padding:16px 22px}.gs-reset-option{display:flex;align-items:center;gap:11px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;margin:7px 0;cursor:pointer}.gs-reset-option:has(input:checked){border-color:#7db3df;background:#f0f7ff}.gs-reset-option input{accent-color:#0f4c81}.gs-reset-option span{display:flex;flex-direction:column;gap:2px}.gs-reset-option b{font-size:14px;color:#1e293b}.gs-reset-option small{font-size:12px;color:#64748b}.gs-reset-fields{display:none;gap:12px;padding:3px 12px 8px 38px}.gs-reset-fields label{font-size:12px;color:#475569;font-weight:700;display:flex;align-items:center;gap:8px}.gs-reset-fields select{height:34px;border:1px solid #cbd5e1;border-radius:8px;padding:0 9px;background:#fff}.gs-reset-note{margin-top:13px;padding:10px 12px;background:#f8fafc;border-radius:9px;color:#475569;font-size:12px}.gs-reset-actions{display:flex;justify-content:flex-end;gap:9px;padding:14px 22px 18px;border-top:1px solid #e2e8f0}.gs-reset-actions button{height:38px;border-radius:9px;padding:0 16px;font-weight:700;cursor:pointer}.gs-reset-cancel{background:#fff;border:1px solid #cbd5e1;color:#475569}.gs-reset-run{background:#0f4c81;border:1px solid #0f4c81;color:#fff}`;
  modal.appendChild(style);
  const refresh = () => {
    const mode = modal.querySelector(
      'input[name="gsResetMode"]:checked',
    )?.value;
    modal
      .querySelectorAll(".gs-reset-fields")
      .forEach(
        (x) => (x.style.display = x.dataset.mode === mode ? "flex" : "none"),
      );
  };
  modal
    .querySelectorAll('input[name="gsResetMode"]')
    .forEach((x) => (x.onchange = refresh));
  refresh();
  modal.querySelector(".gs-reset-x").onclick = modal.querySelector(
    ".gs-reset-cancel",
  ).onclick = closeGoogleSheetResetDialog;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeGoogleSheetResetDialog();
  });
  modal.querySelector(".gs-reset-run").onclick = () => {
    const mode = modal.querySelector(
      'input[name="gsResetMode"]:checked',
    )?.value;
    let from = current,
      to = current;
    if (mode === "single")
      from = to = Number(modal.querySelector(".gs-reset-single").value);
    else if (mode === "range") {
      from = Number(modal.querySelector(".gs-reset-from").value);
      to = Number(modal.querySelector(".gs-reset-to").value);
    } else if (mode === "all") {
      from = 1;
      to = 35;
    }
    closeGoogleSheetResetDialog();
    resetGoogleSheetWeekRange(from, to);
  };
}
async function resetGoogleSheetWeekRange(firstWeek, lastWeek) {
  const btn = document.querySelector(
      "#outputPreviewModal .preview-google-reset-weeks",
    ),
    old = btn?.textContent;
  const rg = googleSheetResetWeekRange(firstWeek, lastWeek);
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Đang kiểm tra...";
    }
    const token = await getGoogleSheetsReadOnlyToken(),
      headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(GOOGLE_SHEETS_SPREADSHEET_ID)}`;
    let meta = await gsJson(
      `${base}?fields=properties.title,sheets.properties(sheetId,title,hidden,gridProperties)`,
      { headers },
    );
    const teacher = (meta.sheets || []).find(
      (s) => Number(s?.properties?.sheetId) === GOOGLE_SHEETS_TEACHER_GID,
    );
    if (
      !teacher ||
      googleSheetNameKey(teacher.properties.title) !==
        googleSheetNameKey(GOOGLE_SHEETS_TEACHER_NAME)
    )
      throw new Error(
        `DỪNG LÀM MỚI: không khớp tab ${GOOGLE_SHEETS_TEACHER_NAME} / GID ${GOOGLE_SHEETS_TEACHER_GID}.`,
      );
    const title = teacher.properties.title,
      q = gsA1Title(title),
      maxRows = Number(teacher.properties?.gridProperties?.rowCount) || 0;
    if (maxRows < rg.endRow)
      throw new Error(
        `Google Sheet hiện chỉ có ${maxRows} dòng, không đủ vùng cần làm mới đến dòng ${rg.endRow}.`,
      );
    const tpl = await ensureIndependentGoogleSheetTemplate(base, headers, meta);
    if (!tpl?.sheetId)
      throw new Error(
        "Chưa bảo đảm được tab mẫu ẩn. App dừng trước khi xóa dữ liệu.",
      );
    const label =
      rg.from === rg.to ? `Tuần ${rg.from}` : `Tuần ${rg.from}–${rg.to}`;
    const ok = confirm(
      `LÀM MỚI ${label} trên tab ${title}?\n\nChỉ vùng A${rg.startRow}:H${rg.endRow} được làm sạch.\nCác tuần ngoài phạm vi này, A1:H7 và tab mẫu ẩn được giữ nguyên.\n\nChọn OK để thực hiện.`,
    );
    if (!ok) return;
    if (btn) btn.textContent = `Đang làm mới ${label}...`;
    await gsJson(
      `${base}/values/${encodeURIComponent(q + `!A${rg.startRow}:H${rg.endRow}`)}:clear`,
      { method: "POST", headers, body: "{}" },
    );
    await gsJson(`${base}:batchUpdate`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requests: [
          {
            unmergeCells: {
              range: {
                sheetId: GOOGLE_SHEETS_TEACHER_GID,
                startRowIndex: rg.startRow - 1,
                endRowIndex: rg.endRow,
                startColumnIndex: 0,
                endColumnIndex: 8,
              },
            },
          },
          {
            repeatCell: {
              range: {
                sheetId: GOOGLE_SHEETS_TEACHER_GID,
                startRowIndex: rg.startRow - 1,
                endRowIndex: rg.endRow,
                startColumnIndex: 0,
                endColumnIndex: 8,
              },
              cell: { userEnteredFormat: {} },
              fields: "userEnteredFormat",
            },
          },
          {
            updateCells: {
              range: {
                sheetId: GOOGLE_SHEETS_TEACHER_GID,
                startRowIndex: rg.startRow - 1,
                endRowIndex: rg.endRow,
                startColumnIndex: 0,
                endColumnIndex: 8,
              },
              rows: [],
              fields: "note,dataValidation",
            },
          },
        ],
      }),
    });
    const verify = await gsJson(
      `${base}/values/${encodeURIComponent(q + `!A${rg.startRow}:H${rg.endRow}`)}?majorDimension=ROWS`,
      { headers },
    );
    const remain = [];
    (verify.values || []).forEach((r, i) => {
      if ((r || []).some((v) => clean(v) !== "")) remain.push(rg.startRow + i);
    });
    if (remain.length)
      throw new Error(
        `Vẫn còn dữ liệu trong vùng làm mới tại dòng ${remain.slice(0, 3).join(", ")}.`,
      );
    alert(
      `LÀM MỚI ${label.toUpperCase()} THÀNH CÔNG\n\nTab: ${title}\nVùng đã làm sạch: A${rg.startRow}:H${rg.endRow}\nCác tuần ngoài phạm vi được giữ nguyên.\n\nBạn có thể chọn tuần cần dùng → Xem trước → Ghi/Cập nhật vào Google Sheet.`,
    );
  } catch (err) {
    console.error("[TKB] 5.2.14 Làm mới theo phạm vi:", err);
    alert(
      `CHƯA LÀM MỚI GOOGLE SHEET\n\n${err?.message || err}\n\nKhông có lệnh ghi tuần nào được thực hiện.`,
    );
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old || "Làm mới";
    }
  }
}
function resetGoogleSheetWeeks1To35() {
  openGoogleSheetResetDialog();
}
function ensureGoogleSheetsResetWeeksButton() {
  const bar = document.querySelector(
    "#outputPreviewModal .output-preview-bar>div",
  );
  if (!bar) return;
  let b = bar.querySelector(".preview-google-reset-weeks");
  if (!b) {
    const write = bar.querySelector(".preview-google-write-week1-35"),
      close = bar.querySelector(".preview-close");
    b = document.createElement("button");
    b.type = "button";
    b.className = "preview-google-reset-weeks";
    bar.insertBefore(b, write || close || null);
  }
  // BƯỚC 5.2.14A: nút này có thể đã được tạo bởi 5.2.9 trước khi 5.2.14 chạy.
  // Vì vậy luôn gắn lại handler mới, không chỉ gắn khi vừa tạo nút.
  b.textContent = "Làm mới";
  b.title =
    "Làm mới tuần hiện tại, một tuần, một vùng tuần hoặc toàn bộ Tuần 1–35";
  b.onclick = openGoogleSheetResetDialog;
  // Nút O-R1 là công cụ kiểm tra kỹ thuật cũ; giữ logic nhưng không để chiếm chỗ trên thanh thao tác chính.
  bar.querySelector(".preview-google-readonly")?.remove();
  if (!document.getElementById("previewActionPolish")) {
    const st = document.createElement("style");
    st.id = "previewActionPolish";
    st.textContent = `#outputPreviewModal .output-preview-bar{padding:10px 14px;gap:12px}#outputPreviewModal .output-preview-bar>div{gap:7px!important;justify-content:flex-end}#outputPreviewModal .output-preview-bar button{height:36px!important;border-radius:9px!important;padding:0 13px!important;white-space:nowrap;font-weight:700!important}#outputPreviewModal .preview-google-write-week1-35{background:#0f4c81!important;color:#fff!important;border-color:#0f4c81!important}#outputPreviewModal .preview-google-reset-weeks{background:#fff7ed!important;color:#9a4b0a!important;border-color:#fdba74!important}#outputPreviewModal .preview-close{margin-left:2px;background:#f8fafc!important}`;
    document.head.appendChild(st);
  }
}
const openOutputPreviewBeforeResetWeeks = openOutputPreview;
openOutputPreview = function () {
  openOutputPreviewBeforeResetWeeks();
  ensureGoogleSheetsResetWeeksButton();
};
const previewBtnResetWeeks = document.getElementById("previewBtn");
if (previewBtnResetWeeks) previewBtnResetWeeks.onclick = openOutputPreview;

// BƯỚC 5.2.15 - Xem trước / xuất Excel / PDF / In tùy chọn nhiều tuần.
// Chỉ mở rộng lớp xuất. Không thay đổi kho TKB, Phụ lục 2, Google Sheet hoặc dữ liệu nguồn.
let multiOutputWeeks = [];
function normalizeOutputWeeks(weeks) {
  return [
    ...new Set(
      (weeks || [])
        .map(Number)
        .filter((w) => Number.isInteger(w) && w >= 1 && w <= 35),
    ),
  ].sort((a, b) => a - b);
}
function currentOutputWeeks() {
  const cur = Math.max(1, Math.min(35, Number($("weekSelect")?.value || 1)));
  return normalizeOutputWeeks(
    multiOutputWeeks.length ? multiOutputWeeks : [cur],
  );
}
function outputWeeksLabel(weeks) {
  const a = normalizeOutputWeeks(weeks);
  if (!a.length) return "Chưa chọn tuần";
  if (a.length === 1) return `Tuần ${a[0]}`;
  return `${a.length} tuần (${a.map((w) => `T${w}`).join(", ")})`;
}
function withOutputWeek(week, fn) {
  const sel = $("weekSelect"),
    oldWeek = sel?.value,
    oldLessons = allLessons,
    oldMeta = meta;
  try {
    if (sel) sel.value = String(week);
    const saved = effectiveScheduleForWeek(week);
    allLessons = saved ? sortSchedule(applyHomeroomTeachers([...lessonsForSelectedTeacher(saved)])) : [];
    meta = saved
      ? { ...saved, lessons: allLessons }
      : { file: "", sheets: [], counts: {}, errors: [] };
    applyLessonPlan();
    return fn();
  } finally {
    allLessons = oldLessons;
    meta = oldMeta;
    if (sel) sel.value = oldWeek;
    applyLessonPlan();
  }
}
function multiWeekPackets(weeks) {
  return normalizeOutputWeeks(weeks).map((week) =>
    withOutputWeek(week, () => {
      const data = outputScheduleData();
      return { week, data, html: data.length ? buildFormalOutput(data) : "" };
    }),
  );
}
function ensureMultiOutputStyles() {
  if (document.getElementById("multiOutputStylesV5215")) return;
  const st = document.createElement("style");
  st.id = "multiOutputStylesV5215";
  st.textContent = `
    #outputPreviewModal .preview-weeks{background:#f0f7ff!important;color:#0f4c81!important;border-color:#9fc6e8!important}
    #outputPreviewModal .multi-week-stack{display:flex;flex-direction:column;gap:18px}
    #outputPreviewModal .multi-week-card{position:relative}
    #outputPreviewModal .multi-week-card+.multi-week-card{padding-top:18px;border-top:2px dashed #94a3b8}
    .multi-week-picker{position:fixed;inset:0;z-index:100200;background:rgba(15,23,42,.52);display:grid;place-items:center;padding:18px;font-family:Arial,sans-serif}
    .multi-week-picker-card{width:min(760px,96vw);max-height:90vh;overflow:auto;background:#fff;border-radius:16px;box-shadow:0 24px 70px rgba(15,23,42,.3)}
    .multi-week-picker-head{position:sticky;top:0;background:#fff;z-index:2;display:flex;justify-content:space-between;gap:12px;align-items:flex-start;padding:18px 20px 14px;border-bottom:1px solid #e2e8f0}.multi-week-picker-head b{color:#123f68;font-size:17px}.multi-week-picker-head span{display:block;color:#64748b;font-size:12px;margin-top:4px}.multi-week-picker-x{border:0;background:#f1f5f9;border-radius:9px;width:34px;height:34px;font-size:21px;cursor:pointer}
    .multi-week-quick{display:flex;gap:8px;flex-wrap:wrap;padding:14px 20px 8px}.multi-week-quick button{border:1px solid #cbd5e1;background:#fff;border-radius:8px;height:34px;padding:0 12px;font-weight:700;color:#475569;cursor:pointer}
    .multi-week-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;padding:10px 20px 18px}.multi-week-grid label{display:flex;align-items:center;gap:6px;border:1px solid #e2e8f0;border-radius:9px;padding:9px 8px;cursor:pointer;font-size:13px}.multi-week-grid label:has(input:checked){background:#eef6ff;border-color:#8bbbe2;color:#0f4c81;font-weight:700}.multi-week-grid input{accent-color:#0f4c81}
    .multi-week-picker-foot{position:sticky;bottom:0;background:#fff;border-top:1px solid #e2e8f0;padding:13px 20px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}.multi-week-picker-foot span{font-size:13px;color:#475569}.multi-week-picker-foot div{display:flex;gap:8px}.multi-week-picker-foot button{height:38px;border-radius:9px;padding:0 16px;font-weight:700;cursor:pointer}.multi-week-cancel{background:#fff;border:1px solid #cbd5e1;color:#475569}.multi-week-apply{background:#0f4c81;border:1px solid #0f4c81;color:#fff}
    @media(max-width:760px){.multi-week-grid{grid-template-columns:repeat(5,1fr)}}
    @media print{body.printing-formal.multi-print .print-formal .formal-output{break-after:page;page-break-after:always}body.printing-formal.multi-print .print-formal .formal-output:last-child{break-after:auto;page-break-after:auto}}
  `;
  document.head.appendChild(st);
}
function openMultiWeekPicker(onApply) {
  ensureMultiOutputStyles();
  document.getElementById("multiWeekPicker")?.remove();
  const cur = Math.max(1, Math.min(35, Number($("weekSelect")?.value || 1))),
    selected = new Set(currentOutputWeeks());
  const m = document.createElement("div");
  m.id = "multiWeekPicker";
  m.className = "multi-week-picker";
  m.innerHTML = `<div class="multi-week-picker-card"><div class="multi-week-picker-head"><div><b>CHỌN TUẦN XEM TRƯỚC / XUẤT</b><span>Có thể chọn một tuần, nhiều tuần hoặc toàn bộ 35 tuần.</span></div><button type="button" class="multi-week-picker-x">×</button></div><div class="multi-week-quick"><button type="button" data-pick="current">Tuần hiện tại</button><button type="button" data-pick="all">Chọn tất cả</button><button type="button" data-pick="none">Bỏ chọn tất cả</button></div><div class="multi-week-grid">${Array.from(
    { length: 35 },
    (_, i) => {
      const w = i + 1;
      return `<label><input type="checkbox" value="${w}" ${selected.has(w) ? "checked" : ""}>Tuần ${w}</label>`;
    },
  ).join(
    "",
  )}</div><div class="multi-week-picker-foot"><span class="multi-week-count"></span><div><button type="button" class="multi-week-cancel">Hủy</button><button type="button" class="multi-week-apply">Áp dụng</button></div></div></div>`;
  document.body.appendChild(m);
  const checks = () => [...m.querySelectorAll(".multi-week-grid input")],
    refresh = () => {
      const a = checks().filter((x) => x.checked);
      m.querySelector(".multi-week-count").textContent =
        `Đã chọn: ${a.length} tuần`;
    };
  refresh();
  checks().forEach((x) => (x.onchange = refresh));
  m.querySelector('[data-pick="current"]').onclick = () => {
    checks().forEach((x) => (x.checked = Number(x.value) === cur));
    refresh();
  };
  m.querySelector('[data-pick="all"]').onclick = () => {
    checks().forEach((x) => (x.checked = true));
    refresh();
  };
  m.querySelector('[data-pick="none"]').onclick = () => {
    checks().forEach((x) => (x.checked = false));
    refresh();
  };
  const close = () => m.remove();
  m.querySelector(".multi-week-picker-x").onclick = close;
  m.querySelector(".multi-week-cancel").onclick = close;
  m.addEventListener("click", (e) => {
    if (e.target === m) close();
  });
  m.querySelector(".multi-week-apply").onclick = () => {
    const weeks = normalizeOutputWeeks(
      checks()
        .filter((x) => x.checked)
        .map((x) => x.value),
    );
    if (!weeks.length) return alert("Hãy chọn ít nhất 1 tuần.");
    multiOutputWeeks = weeks;
    close();
    onApply?.(weeks);
  };
}
function renderMultiWeekPreview(modal, weeks) {
  const packets = multiWeekPackets(weeks),
    body = modal.querySelector(".output-preview-scroll");
  body.innerHTML = `<div class="multi-week-stack">${packets.map((p) => `<div class="multi-week-card" data-week="${p.week}">${p.html || `<div class="preview-no-lessons">Tuần ${p.week}: chưa có TKB có hiệu lực hoặc không có dữ liệu theo bộ lọc hiện tại.</div>`}</div>`).join("")}</div>`;
  const title = modal.querySelector(".output-preview-bar>b");
  if (title)
    title.textContent = `XEM TRƯỚC PHỤ LỤC 1.4 · ${outputWeeksLabel(weeks)}`;
  const edit = modal.querySelector(".preview-edit");
  if (edit) {
    edit.style.display = weeks.length === 1 ? "" : "none";
    edit.title =
      weeks.length === 1
        ? "Điều chỉnh bản xuất tuần đang chọn"
        : "Khi chọn nhiều tuần, hãy sửa riêng từng tuần trước khi xuất.";
  }
  const wb = modal.querySelector(".preview-weeks");
  if (wb) wb.textContent = `Chọn tuần (${weeks.length})`;
}
function exportExcelWeeks(weeks) {
  const chosen = normalizeOutputWeeks(weeks);
  if (chosen.length === 1)
    return withOutputWeek(chosen[0], () => exportExcel());
  if (typeof XLSX === "undefined")
    return alert("Không tải được thư viện xuất Excel.");
  const out = XLSX.utils.book_new(),
    originalWrite = XLSX.writeFile,
    missing = [],
    sourceRows = [];
  try {
    for (const week of chosen) {
      let captured = null;
      XLSX.writeFile = (wb) => {
        captured = wb;
      };
      withOutputWeek(week, () => exportExcel());
      if (!captured) {
        missing.push(week);
        continue;
      }
      const s1 = captured.Sheets[captured.SheetNames[0]],
        s2 = captured.Sheets[captured.SheetNames[1]];
      if (s1) XLSX.utils.book_append_sheet(out, s1, `Tuần ${week}`);
      if (s2) {
        const a = XLSX.utils.sheet_to_json(s2, { header: 1, defval: "" });
        if (a.length) {
          if (!sourceRows.length) sourceRows.push(["Tuần", ...a[0]]);
          a.slice(1).forEach((r) => sourceRows.push([week, ...r]));
        }
      }
    }
  } finally {
    XLSX.writeFile = originalWrite;
  }
  if (sourceRows.length) {
    const src = XLSX.utils.aoa_to_sheet(sourceRows);
    src["!cols"] = [
      { wch: 8 },
      { wch: 9 },
      { wch: 8 },
      { wch: 9 },
      { wch: 13 },
      { wch: 22 },
      { wch: 11 },
      { wch: 10 },
      { wch: 11 },
      { wch: 12 },
      { wch: 18 },
      { wch: 10 },
      { wch: 18 },
      { wch: 22 },
      { wch: 48 },
    ];
    src["!autofilter"] = { ref: `A1:O${sourceRows.length}` };
    const green = "0B7A53",
      white = "FFFFFF",
      grid = "9BC9AE";
    for (let R = 0; R < sourceRows.length; R++)
      for (let C = 0; C < 15; C++) {
        const a = XLSX.utils.encode_cell({ r: R, c: C });
        if (!src[a]) continue;
        src[a].s = {
          font: {
            name: "Times New Roman",
            sz: 11,
            bold: R === 0,
            color: { rgb: R === 0 ? white : "17382B" },
          },
          fill:
            R === 0
              ? { patternType: "solid", fgColor: { rgb: green } }
              : undefined,
          alignment: {
            horizontal: R === 0 ? "center" : "left",
            vertical: "center",
            wrapText: true,
          },
          border: {
            top: { style: "thin", color: { rgb: grid } },
            bottom: { style: "thin", color: { rgb: grid } },
            left: { style: "thin", color: { rgb: grid } },
            right: { style: "thin", color: { rgb: grid } },
          },
        };
      }
    XLSX.utils.book_append_sheet(out, src, "Đối chiếu nguồn");
  }
  if (!out.SheetNames.length)
    return alert("Không có dữ liệu để xuất Excel cho các tuần đã chọn.");
  const first = chosen[0],
    last = chosen[chosen.length - 1],
    name =
      chosen.length === last - first + 1
        ? `TKB_CA_NHAN_GV_DAM_TUAN_${first}-${last}.xlsx`
        : `TKB_CA_NHAN_GV_DAM_${chosen.map((w) => `T${w}`).join("_")}.xlsx`;
  originalWrite(out, name, { cellStyles: true });
  if (missing.length)
    alert(
      `Đã xuất các tuần có dữ liệu. Tuần chưa có dữ liệu: ${missing.join(", ")}.`,
    );
}
async function addFormalElementToPdf(pdf, target, pageState) {
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)),
  );
  const canvas = await html2canvas(target, {
    scale: 2,
    backgroundColor: "#ffffff",
    useCORS: true,
    logging: false,
    windowWidth: target.scrollWidth,
  });
  const pw = 297,
    ph = 210,
    margin = 5,
    maxW = pw - margin * 2,
    maxH = ph - margin * 2,
    drawW = maxW,
    pxPerMm = canvas.width / drawW,
    maxSlicePx = Math.floor(maxH * pxPerMm),
    scaleY = canvas.height / target.scrollHeight,
    top0 = target.getBoundingClientRect().top;
  const cuts = [
    0,
    ...[
      ...target.querySelectorAll(
        ".formal-grid tr,.formal-summary tr,.formal-date,.formal-sign",
      ),
    ].map((el) =>
      Math.round((el.getBoundingClientRect().bottom - top0) * scaleY),
    ),
    canvas.height,
  ]
    .filter((v, i, a) => v >= 0 && v <= canvas.height && a.indexOf(v) === i)
    .sort((a, b) => a - b);
  let y0 = 0;
  while (y0 < canvas.height - 2) {
    const limit = Math.min(canvas.height, y0 + maxSlicePx);
    let y1 = cuts.filter((v) => v > y0 + 20 && v <= limit).pop() || limit;
    if (y1 <= y0) y1 = limit;
    const slice = document.createElement("canvas");
    slice.width = canvas.width;
    slice.height = y1 - y0;
    slice
      .getContext("2d")
      .drawImage(
        canvas,
        0,
        y0,
        canvas.width,
        y1 - y0,
        0,
        0,
        canvas.width,
        y1 - y0,
      );
    if (pageState.count++) pdf.addPage("a4", "landscape");
    pdf.addImage(
      slice.toDataURL("image/jpeg", 0.96),
      "JPEG",
      margin,
      margin,
      drawW,
      (y1 - y0) / pxPerMm,
      undefined,
      "FAST",
    );
    y0 = y1;
  }
}
async function exportPDFWeeks(weeks) {
  const chosen = normalizeOutputWeeks(weeks);
  if (chosen.length === 1) return withOutputWeek(chosen[0], () => exportPDF());
  if (typeof html2canvas === "undefined" || !window.jspdf)
    return alert("Không tải được thư viện xuất PDF.");
  ensureFormalOutputStyles();
  const packets = multiWeekPackets(chosen).filter((p) => p.data.length);
  if (!packets.length)
    return alert("Không có dữ liệu để xuất PDF cho các tuần đã chọn.");
  const holder = document.createElement("div");
  holder.className = "formal-holder";
  holder.innerHTML = packets.map((p) => p.html).join("");
  document.body.appendChild(holder);
  try {
    const { jsPDF } = window.jspdf,
      pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" }),
      state = { count: 0 };
    for (const target of holder.querySelectorAll(".formal-output"))
      await addFormalElementToPdf(pdf, target, state);
    const first = chosen[0],
      last = chosen[chosen.length - 1],
      name =
        chosen.length === last - first + 1
          ? `PHU_LUC_1_4_TUAN_${first}-${last}.pdf`
          : `PHU_LUC_1_4_${chosen.map((w) => `T${w}`).join("_")}.pdf`;
    pdf.save(name);
  } finally {
    holder.remove();
  }
}
function printScheduleWeeks(weeks) {
  const chosen = normalizeOutputWeeks(weeks);
  if (chosen.length === 1)
    return withOutputWeek(chosen[0], () => printSchedule());
  ensureFormalOutputStyles();
  ensureMultiOutputStyles();
  const packets = multiWeekPackets(chosen).filter((p) => p.data.length);
  if (!packets.length)
    return alert("Không có dữ liệu để in cho các tuần đã chọn.");
  const holder = document.createElement("div");
  holder.className = "formal-holder print-formal";
  holder.innerHTML = packets.map((p) => p.html).join("");
  holder.querySelectorAll(".formal-summary tr:last-child").forEach((row) => {
    const th = row.querySelectorAll("th"),
      v = th[2]?.textContent || "";
    row.innerHTML = `<th></th><th>Tổng số</th><th>${esc(v)}</th><th></th>`;
  });
  document.body.appendChild(holder);
  document.body.classList.add("printing-formal", "multi-print");
  const restore = () => {
    document.body.classList.remove("printing-formal", "multi-print");
    holder.remove();
    window.removeEventListener("afterprint", restore);
  };
  window.addEventListener("afterprint", restore);
  setTimeout(() => window.print(), 80);
}
function enhanceOutputPreviewMultiWeek() {
  const modal = document.getElementById("outputPreviewModal");
  if (!modal) return;
  ensureMultiOutputStyles();
  const bar = modal.querySelector(".output-preview-bar>div"),
    close = bar?.querySelector(".preview-close");
  if (!bar) return;
  let b = bar.querySelector(".preview-weeks");
  if (!b) {
    b = document.createElement("button");
    b.type = "button";
    b.className = "preview-weeks";
    bar.insertBefore(b, bar.firstChild);
  }
  const cur = Math.max(1, Math.min(35, Number($("weekSelect")?.value || 1)));
  if (!multiOutputWeeks.length || !multiOutputWeeks.includes(cur))
    multiOutputWeeks = [cur];
  const apply = (weeks) => renderMultiWeekPreview(modal, weeks);
  b.onclick = () => openMultiWeekPicker(apply);
  apply(currentOutputWeeks());
  const excel = modal.querySelector(".preview-export-excel"),
    pdf = modal.querySelector(".preview-export-pdf"),
    print = modal.querySelector(".preview-print");
  if (excel) excel.onclick = () => exportExcelWeeks(currentOutputWeeks());
  if (pdf) pdf.onclick = () => exportPDFWeeks(currentOutputWeeks());
  if (print)
    print.onclick = () => {
      const weeks = currentOutputWeeks();
      modal.remove();
      printScheduleWeeks(weeks);
    };
}
const openOutputPreviewBeforeMultiWeek = openOutputPreview;
openOutputPreview = function () {
  multiOutputWeeks = [
    Math.max(1, Math.min(35, Number($("weekSelect")?.value || 1))),
  ];
  openOutputPreviewBeforeMultiWeek();
  enhanceOutputPreviewMultiWeek();
};
const previewBtnMultiWeek = document.getElementById("previewBtn");
if (previewBtnMultiWeek) previewBtnMultiWeek.onclick = openOutputPreview;

// BƯỚC 5.2.16A - Ghi/Cập nhật nhiều tuần vào Google Sheet.
// Dùng đúng multiOutputWeeks đã Áp dụng ở Bước 5.2.15; không lấy weekSelect cũ khi đang chọn nhiều tuần.
function syncMultiWeekGoogleSheetButton(
  modal = document.getElementById("outputPreviewModal"),
) {
  const btn = modal?.querySelector(".preview-google-write-week1-35");
  if (!btn) return;
  const weeks = currentOutputWeeks();
  btn.textContent =
    weeks.length === 1
      ? `Ghi/Cập nhật Tuần ${weeks[0]} vào Google Sheet`
      : `Ghi/Cập nhật ${weeks.length} tuần vào Google Sheet`;
  btn.title =
    weeks.length === 1
      ? `Ghi/Cập nhật Tuần ${weeks[0]} vào Google Sheet`
      : `Ghi/Cập nhật các tuần: ${weeks.map((w) => `Tuần ${w}`).join(", ")}`;
  btn.onclick = () => exportSelectedWeeksToGoogleSheet(currentOutputWeeks());
}
async function exportSelectedWeeksToGoogleSheet(weeks) {
  const chosen = normalizeOutputWeeks(weeks);
  if (!chosen.length) return alert("Hãy chọn ít nhất 1 tuần.");
  if (chosen.length === 1) {
    return withOutputWeek(chosen[0], () =>
      exportSelectedWeek1To35ToGoogleSheet({ week: chosen[0] }),
    );
  }
  const btn = document.querySelector(
    "#outputPreviewModal .preview-google-write-week1-35",
  );
  if (
    !confirm(
      `GHI/CẬP NHẬT ${chosen.length} TUẦN vào Google Sheet?\n\n${chosen.map((w) => `Tuần ${w}`).join(", ")}\n\nHệ thống sẽ ghi lần lượt từng tuần vào đúng vùng của tuần đó.`,
    )
  )
    return;
  const old = btn?.textContent,
    ok = [],
    failed = [];
  if (btn) btn.disabled = true;
  let sharedAccessToken = "";
  try {
    // BƯỚC 5.2.16B: xin quyền Google đúng một lần cho cả lô tuần.
    // Các tuần sau tái sử dụng cùng access token, tránh Chrome chặn popup OAuth thứ hai.
    if (btn) btn.textContent = "Đang xác thực Google...";
    sharedAccessToken = await getGoogleSheetsReadOnlyToken();
    for (let i = 0; i < chosen.length; i++) {
      const week = chosen[i];
      if (btn)
        btn.textContent = `Đang ghi ${i + 1}/${chosen.length} · Tuần ${week}...`;
      try {
        const result = await withOutputWeek(week, () =>
          exportSelectedWeek1To35ToGoogleSheet({
            week,
            accessToken: sharedAccessToken,
            skipConfirm: true,
            silentSuccess: true,
            throwOnError: true,
            keepButtonBusy: true,
          }),
        );
        if (result === true) ok.push(week);
        else failed.push({ week, error: "Không hoàn tất" });
      } catch (err) {
        failed.push({ week, error: err?.message || String(err) });
      }
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      syncMultiWeekGoogleSheetButton();
      if (!btn.textContent)
        btn.textContent = old || "Ghi/Cập nhật Google Sheet";
    }
  }
  let msg = `ĐÃ XỬ LÝ ${chosen.length} TUẦN\n\nThành công: ${ok.length}/${chosen.length}`;
  if (ok.length) msg += `\nTuần đã cập nhật: ${ok.join(", ")}`;
  if (failed.length)
    msg += `\n\nChưa cập nhật: ${failed.map((x) => `Tuần ${x.week}: ${x.error}`).join("\n")}`;
  alert(msg);
}
const renderMultiWeekPreviewBeforeGoogleMulti = renderMultiWeekPreview;
renderMultiWeekPreview = function (modal, weeks) {
  renderMultiWeekPreviewBeforeGoogleMulti(modal, weeks);
  syncMultiWeekGoogleSheetButton(modal);
};
const enhanceOutputPreviewMultiWeekBeforeGoogleMulti =
  enhanceOutputPreviewMultiWeek;
enhanceOutputPreviewMultiWeek = function () {
  enhanceOutputPreviewMultiWeekBeforeGoogleMulti();
  syncMultiWeekGoogleSheetButton();
};

// BƯỚC 5.4.3 — Đồng bộ xanh lá/mint cho các thành phần tạo động
(function ensureGreenSystemTheme() {
  if (document.getElementById("greenSystemTheme543")) return;
  const st = document.createElement("style");
  st.id = "greenSystemTheme543";
  st.textContent = `
 #outputPreviewModal .output-preview-dialog{background:#EEF5F0!important}
 #outputPreviewModal .output-preview-bar{border-bottom-color:#C8DFD0!important}
 #outputPreviewModal .output-preview-bar .preview-export-pdf,#outputPreviewModal .output-preview-bar .preview-export-excel,#outputPreviewModal .output-preview-bar .preview-print,#outputPreviewModal .preview-google-write-week1-35,#outputPreviewModal .preview-update,#outputPreviewModal .multi-week-apply{background:#0B7A53!important;color:#fff!important;border-color:#0B7A53!important}
 #outputPreviewModal .output-preview-bar .preview-export-pdf:hover,#outputPreviewModal .output-preview-bar .preview-export-excel:hover,#outputPreviewModal .output-preview-bar .preview-print:hover{background:#086544!important;border-color:#086544!important}
 #outputPreviewModal .preview-edit,#outputPreviewModal .preview-weeks{background:#EAF7EF!important;color:#0B6848!important;border-color:#9BC9AE!important}
 #outputPreviewModal .output-preview-scroll{background:#DDE9E1!important}
 .multi-week-picker-head b{color:#0B6848!important}.multi-week-grid label:has(input:checked){background:#EAF7EF!important;border-color:#8EC5A3!important;color:#0B6848!important}.multi-week-grid input{accent-color:#0B7A53!important}
 .gs-reset-head b{color:#0B6848!important}.gs-reset-option:has(input:checked){border-color:#8EC5A3!important;background:#F0F8F3!important}.gs-reset-option input{accent-color:#0B7A53!important}.gs-reset-run{background:#0B7A53!important;border-color:#0B7A53!important}
 `;
  document.head.appendChild(st);
})();

// BƯỚC 5.6.2B.4B - Khôi phục thanh Xem trước sau khi nguồn PPCT chung chuyển sang bất đồng bộ.
// Giữ nguyên TKB đa giáo viên và PPCT chung; không dùng dòng Cộng làm chuẩn.
async function withOutputWeekAsync561B4B(week, fn) {
  const sel = $("weekSelect"), oldWeek = sel?.value, oldLessons = allLessons, oldMeta = meta;
  try {
    if (sel) sel.value = String(week);
    const saved = effectiveScheduleForWeek(week);
    allLessons = saved ? sortSchedule(applyHomeroomTeachers([...lessonsForSelectedTeacher(saved)])) : [];
    meta = saved ? { ...saved, lessons: allLessons } : { file: "", sheets: [], counts: {}, errors: [] };
    applyLessonPlan();
    return await fn();
  } finally {
    allLessons = oldLessons; meta = oldMeta;
    if (sel) sel.value = oldWeek;
    applyLessonPlan();
  }
}
async function renderSharedCurriculumWeeks561B4B(modal, weeks) {
  const chosen = normalizeOutputWeeks(weeks), packets = [];
  for (const week of chosen) {
    const packet = await withOutputWeekAsync561B4B(week, async () => {
      const data = await sharedCurriculumPreviewData();
      return { week, data, html: data.length ? buildFormalOutput(data) : "" };
    });
    packets.push(packet);
  }
  if (!modal?.isConnected) return;
  const body = modal.querySelector(".output-preview-scroll");
  if (body) body.innerHTML = `<div class="multi-week-stack">${packets.map((p) => `<div class="multi-week-card" data-week="${p.week}">${p.html || `<div class="preview-no-lessons">Tuần ${p.week}: chưa có dữ liệu.</div>`}</div>`).join("")}</div>`;
  const title = modal.querySelector(".output-preview-bar>b");
  if (title) title.textContent = `XEM TRƯỚC PHỤ LỤC 1.4 · ${outputWeeksLabel(chosen)}`;
  const edit = modal.querySelector(".preview-edit");
  if (edit) edit.style.display = chosen.length === 1 ? "" : "none";
  const wb = modal.querySelector(".preview-weeks");
  if (wb) wb.textContent = `Chọn tuần (${chosen.length})`;
  syncMultiWeekGoogleSheetButton(modal);
}
function waitPreviewModal561B4B(timeout = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const modal = document.getElementById("outputPreviewModal");
      if (modal) return resolve(modal);
      if (Date.now() - started >= timeout) return resolve(null);
      setTimeout(tick, 25);
    };
    tick();
  });
}
function restorePreviewToolbar561B4B(modal) {
  if (!modal) return;
  ensureMultiOutputStyles();
  ensureGoogleSheetsWeek1To35WriteButton();
  ensureGoogleSheetsResetWeeksButton();
  const bar = modal.querySelector(".output-preview-bar>div");
  if (!bar) return;
  let weeksBtn = bar.querySelector(".preview-weeks");
  if (!weeksBtn) {
    weeksBtn = document.createElement("button");
    weeksBtn.type = "button"; weeksBtn.className = "preview-weeks";
    bar.insertBefore(weeksBtn, bar.firstChild);
  }
  const cur = Math.max(1, Math.min(35, Number($("weekSelect")?.value || 1)));
  multiOutputWeeks = [cur];
  weeksBtn.textContent = "Chọn tuần (1)";
  weeksBtn.onclick = () => openMultiWeekPicker(async (weeks) => {
    multiOutputWeeks = normalizeOutputWeeks(weeks);
    await renderSharedCurriculumWeeks561B4B(modal, multiOutputWeeks);
  });
  const excel = modal.querySelector(".preview-export-excel"), pdf = modal.querySelector(".preview-export-pdf"), print = modal.querySelector(".preview-print");
  if (excel) excel.onclick = () => exportExcelWeeks(currentOutputWeeks());
  if (pdf) pdf.onclick = () => exportPDFWeeks(currentOutputWeeks());
  if (print) print.onclick = () => { const weeks = currentOutputWeeks(); modal.remove(); printScheduleWeeks(weeks); };
  syncMultiWeekGoogleSheetButton(modal);
}
const openOutputPreviewBefore561B4B = openOutputPreview;
openOutputPreview = async function () {
  openOutputPreviewBefore561B4B();
  const modal = await waitPreviewModal561B4B();
  restorePreviewToolbar561B4B(modal);
};
const previewBtn561B4B = document.getElementById("previewBtn");
if (previewBtn561B4B) previewBtn561B4B.onclick = openOutputPreview;

// BƯỚC 5.6.2B.5A - Excel dùng kho PPCT chung giống Xem trước.
// Chỉ thay nguồn tên bài cho Excel; không thay parser TKB/PDF/In/Google Sheet.
let excelSharedCurriculumData561B5A = null;
const outputScheduleDataBefore561B5A = outputScheduleData;
outputScheduleData = function () {
  return Array.isArray(excelSharedCurriculumData561B5A)
    ? excelSharedCurriculumData561B5A
    : outputScheduleDataBefore561B5A();
};
const exportExcelBefore561B5A = exportExcel;
exportExcel = async function () {
  try {
    excelSharedCurriculumData561B5A = await sharedCurriculumPreviewData();
    if (!excelSharedCurriculumData561B5A.length)
      return alert("Không có dữ liệu để xuất.");
    return exportExcelBefore561B5A();
  } catch (err) {
    console.error("[TKB] Không đọc được PPCT chung khi xuất Excel", err);
    return alert(`Chưa đọc được kho PPCT chung để xuất Excel: ${err?.message || err}`);
  } finally {
    excelSharedCurriculumData561B5A = null;
  }
};
exportExcelWeeks = async function (weeks) {
  const chosen = normalizeOutputWeeks(weeks);
  if (!chosen.length) return alert("Hãy chọn ít nhất 1 tuần.");
  if (chosen.length === 1)
    return withOutputWeekAsync561B4B(chosen[0], () => exportExcel());
  if (typeof XLSX === "undefined")
    return alert("Không tải được thư viện xuất Excel.");
  const out = XLSX.utils.book_new(), originalWrite = XLSX.writeFile, missing = [], sourceRows = [];
  try {
    for (const week of chosen) {
      let captured = null;
      XLSX.writeFile = (wb) => { captured = wb; };
      await withOutputWeekAsync561B4B(week, () => exportExcel());
      if (!captured) { missing.push(week); continue; }
      const s1 = captured.Sheets[captured.SheetNames[0]], s2 = captured.Sheets[captured.SheetNames[1]];
      if (s1) XLSX.utils.book_append_sheet(out, s1, `Tuần ${week}`);
      if (s2) {
        const a = XLSX.utils.sheet_to_json(s2, { header: 1, defval: "" });
        if (a.length) {
          if (!sourceRows.length) sourceRows.push(["Tuần", ...a[0]]);
          a.slice(1).forEach((r) => sourceRows.push([week, ...r]));
        }
      }
    }
  } finally { XLSX.writeFile = originalWrite; }
  if (sourceRows.length) {
    const src = XLSX.utils.aoa_to_sheet(sourceRows);
    src["!cols"] = [{wch:8},{wch:9},{wch:8},{wch:9},{wch:13},{wch:22},{wch:11},{wch:10},{wch:11},{wch:12},{wch:18},{wch:10},{wch:18},{wch:22},{wch:48}];
    src["!autofilter"] = { ref: `A1:O${sourceRows.length}` };
    const green="0B7A53", white="FFFFFF", grid="9BC9AE";
    for (let R=0; R<sourceRows.length; R++) for (let C=0; C<15; C++) {
      const a=XLSX.utils.encode_cell({r:R,c:C}); if (!src[a]) continue;
      src[a].s={font:{name:"Times New Roman",sz:11,bold:R===0,color:{rgb:R===0?white:"17382B"}},fill:R===0?{patternType:"solid",fgColor:{rgb:green}}:undefined,alignment:{horizontal:R===0?"center":"left",vertical:"center",wrapText:true},border:{top:{style:"thin",color:{rgb:grid}},bottom:{style:"thin",color:{rgb:grid}},left:{style:"thin",color:{rgb:grid}},right:{style:"thin",color:{rgb:grid}}}};
    }
    XLSX.utils.book_append_sheet(out, src, "Đối chiếu nguồn");
  }
  if (!out.SheetNames.length) return alert("Không có dữ liệu để xuất Excel cho các tuần đã chọn.");
  const first=chosen[0], last=chosen[chosen.length-1], teacher=outputTeacherFileKey();
  const name=chosen.length===last-first+1
    ? `TKB_CA_NHAN_${teacher}_TUAN_${first}-${last}.xlsx`
    : `TKB_CA_NHAN_${teacher}_${chosen.map((w)=>`T${w}`).join("_")}.xlsx`;
  originalWrite(out,name,{cellStyles:true});
  if (missing.length) alert(`Đã xuất các tuần có dữ liệu. Tuần chưa có dữ liệu: ${missing.join(", ")}.`);
};
const excelBtn561B5A = document.getElementById("excelBtn");
if (excelBtn561B5A) excelBtn561B5A.onclick = () => exportExcel();

// BƯỚC 5.6.2B.5B - PDF + In dùng kho PPCT chung giống Xem trước/Excel.
// Chỉ thay nguồn dữ liệu cho PDF/In; không thay parser TKB, Xem trước, Excel hay Google Sheet.
async function sharedCurriculumPackets561B5B(weeks) {
  const chosen = normalizeOutputWeeks(weeks), packets = [];
  for (const week of chosen) {
    const packet = await withOutputWeekAsync561B4B(week, async () => {
      const data = await sharedCurriculumPreviewData();
      return { week, data, html: data.length ? buildFormalOutput(data) : "" };
    });
    packets.push(packet);
  }
  return packets;
}

exportPDFWeeks = async function (weeks) {
  const chosen = normalizeOutputWeeks(weeks);
  if (!chosen.length) return alert("Hãy chọn ít nhất 1 tuần.");
  if (typeof html2canvas === "undefined" || !window.jspdf)
    return alert("Không tải được thư viện xuất PDF.");
  ensureFormalOutputStyles();
  let packets;
  try {
    packets = (await sharedCurriculumPackets561B5B(chosen)).filter((p) => p.data.length);
  } catch (err) {
    console.error("[TKB] Không đọc được PPCT chung khi xuất PDF", err);
    return alert(`Chưa đọc được kho PPCT chung để xuất PDF: ${err?.message || err}`);
  }
  if (!packets.length) return alert("Không có dữ liệu để xuất PDF cho các tuần đã chọn.");
  const holder = document.createElement("div");
  holder.className = "formal-holder";
  holder.innerHTML = packets.map((p) => p.html).join("");
  document.body.appendChild(holder);
  try {
    const { jsPDF } = window.jspdf,
      pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" }),
      state = { count: 0 };
    for (const target of holder.querySelectorAll(".formal-output"))
      await addFormalElementToPdf(pdf, target, state);
    const first = chosen[0], last = chosen[chosen.length - 1], teacher = outputTeacherFileKey();
    const range = chosen.length === last - first + 1
      ? `TUAN_${first}-${last}`
      : chosen.map((w) => `T${w}`).join("_");
    pdf.save(`PHU_LUC_1_4_${teacher}_${range}.pdf`);
  } finally {
    holder.remove();
  }
};

printScheduleWeeks = async function (weeks) {
  const chosen = normalizeOutputWeeks(weeks);
  if (!chosen.length) return alert("Hãy chọn ít nhất 1 tuần.");
  ensureFormalOutputStyles();
  ensureMultiOutputStyles();
  let packets;
  try {
    packets = (await sharedCurriculumPackets561B5B(chosen)).filter((p) => p.data.length);
  } catch (err) {
    console.error("[TKB] Không đọc được PPCT chung khi in", err);
    return alert(`Chưa đọc được kho PPCT chung để in: ${err?.message || err}`);
  }
  if (!packets.length) return alert("Không có dữ liệu để in cho các tuần đã chọn.");
  const holder = document.createElement("div");
  holder.className = "formal-holder print-formal";
  holder.innerHTML = packets.map((p) => p.html).join("");
  holder.querySelectorAll(".formal-summary tr:last-child").forEach((row) => {
    const th = row.querySelectorAll("th"), v = th[2]?.textContent || "";
    row.innerHTML = `<th></th><th>Tổng số</th><th>${esc(v)}</th><th></th>`;
  });
  document.body.appendChild(holder);
  if (chosen.length > 1) document.body.classList.add("multi-print");
  document.body.classList.add("printing-formal");
  const restore = () => {
    document.body.classList.remove("printing-formal", "multi-print");
    holder.remove();
    window.removeEventListener("afterprint", restore);
  };
  window.addEventListener("afterprint", restore);
  setTimeout(() => window.print(), 80);
};

// Nút ngoài giao diện chính cũng dùng đúng PPCT chung.
const pdfBtn561B5B = document.getElementById("pdfBtn");
if (pdfBtn561B5B) pdfBtn561B5B.onclick = () => exportPDFWeeks([Number($("weekSelect")?.value || 1)]);
const printBtn561B5B = document.getElementById("printBtn");
if (printBtn561B5B) printBtn561B5B.onclick = () => printScheduleWeeks([Number($("weekSelect")?.value || 1)]);

// BƯỚC 5.6.2B.7B - Đồng bộ bộ lọc môn hợp lệ cho Excel/PDF/In.
// Xem trước đã dùng isValidOutputSubject(); các luồng xuất phải dùng cùng một nguồn đã lọc.
function validFormalOutputData561B7B(data) {
  return (Array.isArray(data) ? data : []).filter((x) => isValidOutputSubject(x?.monHoc));
}

// Excel: dữ liệu PPCT chung đưa vào hàm xuất cũ phải được lọc trước khi tính Tổng số/TỔNG HỢP.
const exportExcelBefore561B7B = exportExcel;
exportExcel = async function () {
  try {
    const data = validFormalOutputData561B7B(await sharedCurriculumPreviewData());
    if (!data.length) return alert("Không có dữ liệu hợp lệ để xuất.");
    excelSharedCurriculumData561B5A = data;
    // Gọi thẳng hàm Excel gốc trước wrapper 5A để tránh wrapper 5A nạp lại dữ liệu chưa lọc.
    return exportExcelBefore561B5A();
  } catch (err) {
    console.error("[TKB] Không đọc được PPCT chung khi xuất Excel", err);
    return alert(`Chưa đọc được kho PPCT chung để xuất Excel: ${err?.message || err}`);
  } finally {
    excelSharedCurriculumData561B5A = null;
  }
};

// PDF/In: packet dùng đúng cùng dữ liệu hợp lệ như Xem trước.
sharedCurriculumPackets561B5B = async function (weeks) {
  const chosen = normalizeOutputWeeks(weeks), packets = [];
  for (const week of chosen) {
    const packet = await withOutputWeekAsync561B4B(week, async () => {
      const data = validFormalOutputData561B7B(await sharedCurriculumPreviewData());
      return { week, data, html: data.length ? buildFormalOutput(data) : "" };
    });
    packets.push(packet);
  }
  return packets;
};

// Nút Excel ngoài giao diện (nếu được bật lại) cũng dùng bản đã lọc.
const excelBtn561B7B = document.getElementById("excelBtn");
if (excelBtn561B7B) excelBtn561B7B.onclick = () => exportExcel();

// BƯỚC 5.6.2B.9C.1 - Google Sheet cá nhân thử nghiệm đa giáo viên.
// Tách hoàn toàn khỏi mapping Google Sheet công vụ hiện tại.
const MULTI_TEACHER_TEST_SPREADSHEET_ID = "1tIFyPOlJ8z4Eo5ml1eQLrOhPMvRUS5CnrG7DBk5jOo0";
function multiTeacherTestSheetNames() {
  const names = [...new Set((teacherCatalog || []).map(clean).filter(Boolean))];
  if (selectedTeacher && !names.some((x) => normalizeTeacherName(x) === normalizeTeacherName(selectedTeacher))) {
    names.push(selectedTeacher);
  }
  return names.sort((a, b) => a.localeCompare(b, "vi"));
}
async function initializeMultiTeacherTestGoogleSheet() {
  const btn = document.querySelector("#outputPreviewModal .preview-google-multi-init");
  const oldText = btn?.textContent;
  try {
    if (btn) { btn.disabled = true; btn.textContent = "Đang khởi tạo..."; }
    const token = await getGoogleSheetsReadOnlyToken();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(MULTI_TEACHER_TEST_SPREADSHEET_ID)}`;
    let meta = await gsJson(`${base}?fields=properties.title,sheets.properties(sheetId,title,index)`, { headers });
    const wanted = multiTeacherTestSheetNames();
    if (!wanted.length) throw new Error("Chưa có danh sách giáo viên để khởi tạo.");
    const existingKeys = new Set((meta.sheets || []).map((s) => googleSheetNameKey(s?.properties?.title)));
    const requests = [];
    for (const name of wanted) {
      if (!existingKeys.has(googleSheetNameKey(name))) {
        requests.push({ addSheet: { properties: { title: name, gridProperties: { rowCount: 1000, columnCount: 12 } } } });
      }
    }
    if (requests.length) {
      await gsJson(`${base}:batchUpdate`, { method: "POST", headers, body: JSON.stringify({ requests }) });
    }
    meta = await gsJson(`${base}?fields=properties.title,sheets.properties(sheetId,title,index)`, { headers });
    const found = wanted.filter((name) => (meta.sheets || []).some((s) => googleSheetNameKey(s?.properties?.title) === googleSheetNameKey(name)));
    alert(`KHỞI TẠO GOOGLE SHEET ĐA GIÁO VIÊN THÀNH CÔNG\n\nTệp: ${meta.properties?.title || "Google Sheet thử nghiệm"}\nĐã có: ${found.length}/${wanted.length} tab giáo viên.\n\nĐây là file cá nhân thử nghiệm; Google Sheet công vụ của Đậm không bị thay đổi.`);
  } catch (err) {
    console.error("Khởi tạo Google Sheet đa GV:", err);
    alert(`Chưa khởi tạo được Google Sheet đa giáo viên.\n\n${err?.message || err}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldText || "Khởi tạo Sheet đa GV"; }
  }
}
function ensureMultiTeacherTestGoogleSheetButton() {
  const bar = document.querySelector("#outputPreviewModal .output-preview-bar>div");
  if (!bar || bar.querySelector(".preview-google-multi-init")) return;
  const close = bar.querySelector(".preview-close");
  const b = document.createElement("button");
  b.type = "button";
  b.className = "preview-google-multi-init";
  b.textContent = "Khởi tạo Sheet đa GV";
  b.title = "Tạo tab riêng cho toàn bộ giáo viên trong Google Sheet cá nhân thử nghiệm";
  b.onclick = initializeMultiTeacherTestGoogleSheet;
  bar.insertBefore(b, close || null);
}
const openOutputPreviewBeforeMultiTeacherTestInit = openOutputPreview;
openOutputPreview = async function () {
  await openOutputPreviewBeforeMultiTeacherTestInit();
  ensureMultiTeacherTestGoogleSheetButton();
};
const previewBtnMultiTeacherTestInit = document.getElementById("previewBtn");
if (previewBtnMultiTeacherTestInit) previewBtnMultiTeacherTestInit.onclick = openOutputPreview;

// BƯỚC 5.6.2B.9C.2A - Đồng bộ kiểm tra trước khi ghi Google Sheet với kho PPCT chung.
// Chỉ thay nguồn dữ liệu trong lúc ghi: dùng đúng dữ liệu PPCT đang hiển thị ở Xem trước.
// Không thay cấu hình Google Sheet công vụ, không thay parser TKB, tổng số hay kiêm nhiệm.
const exportSelectedWeek1To35ToGoogleSheetBefore562B9C2A = exportSelectedWeek1To35ToGoogleSheet;
exportSelectedWeek1To35ToGoogleSheet = async function (options = {}) {
  try {
    const sharedData = validFormalOutputData561B7B(await sharedCurriculumPreviewData());
    if (!sharedData.length) {
      throw new Error(`Tuần ${Number(options.week || $("weekSelect")?.value || 0) || ""} không có dữ liệu PPCT hợp lệ để ghi.`);
    }
    // outputScheduleData() đã có cơ chế ưu tiên biến tạm này ở Bước 5.6.2B.5A.
    // Tái sử dụng để bộ kiểm tra noTitle và dữ liệu ghi nhìn cùng một nguồn PPCT với Preview/Excel/PDF/In.
    excelSharedCurriculumData561B5A = sharedData;
    return await exportSelectedWeek1To35ToGoogleSheetBefore562B9C2A(options);
  } catch (err) {
    console.error("[TKB] 5.6.2B.9C.2A - Google Sheet/PPCT chung:", err);
    if (options.throwOnError) throw err;
    alert(`CHƯA GHI ĐƯỢC TUẦN ${Number(options.week || $("weekSelect")?.value || 0) || ""}\n\n${err?.message || err}`);
    return false;
  } finally {
    excelSharedCurriculumData561B5A = null;
  }
};


// BƯỚC 5.6.2B.9C.2B - Giáo viên đang chọn ghi đúng tab trong Google Sheet cá nhân đa GV.
// Đậm tiếp tục dùng Google Sheet công vụ đang Đạt; giáo viên khác dùng file cá nhân thử nghiệm.
async function ensureMultiTeacherPersonalTemplate562B9C2B(token) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const personalBase = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(MULTI_TEACHER_TEST_SPREADSHEET_ID)}`;
  let personalMeta = await gsJson(`${personalBase}?fields=sheets.properties(sheetId,title,hidden)`, { headers });
  let tpl = (personalMeta.sheets || []).find((s) => googleSheetNameKey(s?.properties?.title) === googleSheetNameKey(GOOGLE_SHEETS_TEMPLATE_NAME));
  if (tpl?.properties?.sheetId) return tpl.properties;

  // Tạo mẫu một lần từ chính Google Sheet công vụ đã Đạt, không sửa dữ liệu công vụ.
  const officialSpreadsheetId = GOOGLE_SHEETS_SPREADSHEET_ID;
  const officialMeta = await gsJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(officialSpreadsheetId)}?fields=sheets.properties(sheetId,title,hidden,gridProperties)`,
    { headers },
  );
  const officialTpl = await ensureIndependentGoogleSheetTemplate(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(officialSpreadsheetId)}`,
    headers,
    officialMeta,
  );
  const copied = await gsJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(officialSpreadsheetId)}/sheets/${Number(officialTpl.sheetId)}:copyTo`,
    { method: "POST", headers, body: JSON.stringify({ destinationSpreadsheetId: MULTI_TEACHER_TEST_SPREADSHEET_ID }) },
  );
  const copiedId = Number(copied?.sheetId);
  if (!Number.isFinite(copiedId)) throw new Error("Không sao chép được mẫu định dạng sang Google Sheet đa giáo viên.");
  await gsJson(`${personalBase}:batchUpdate`, {
    method: "POST", headers,
    body: JSON.stringify({ requests: [{ updateSheetProperties: {
      properties: { sheetId: copiedId, title: GOOGLE_SHEETS_TEMPLATE_NAME, hidden: true },
      fields: "title,hidden",
    } }] }),
  });
  return { sheetId: copiedId, title: GOOGLE_SHEETS_TEMPLATE_NAME, hidden: true };
}

async function multiTeacherPersonalTarget562B9C2B(token, teacherName) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(MULTI_TEACHER_TEST_SPREADSHEET_ID)}`;
  const meta = await gsJson(`${base}?fields=properties.title,sheets.properties(sheetId,title,hidden,gridProperties)`, { headers });
  const key = googleSheetNameKey(teacherName);
  const sheet = (meta.sheets || []).find((s) => googleSheetNameKey(s?.properties?.title) === key);
  if (!sheet?.properties?.sheetId) throw new Error(`Chưa tìm thấy tab giáo viên "${teacherName}" trong Google Sheet đa giáo viên.`);
  return { spreadsheetId: MULTI_TEACHER_TEST_SPREADSHEET_ID, sheetName: sheet.properties.title, sheetId: Number(sheet.properties.sheetId) };
}

const exportSelectedWeek1To35ToGoogleSheetBefore562B9C2B = exportSelectedWeek1To35ToGoogleSheet;
exportSelectedWeek1To35ToGoogleSheet = async function (options = {}) {
  const teacherName = clean(selectedTeacher || TEACHER);
  const isDam = normalizeTeacherName(teacherName) === normalizeTeacherName(TEACHER);
  if (isDam) return exportSelectedWeek1To35ToGoogleSheetBefore562B9C2B(options);

  // Xin/nhận token trước; cùng token được chuyển xuống hàm ghi để không bật OAuth lần hai.
  const token = options.accessToken || (await getGoogleSheetsReadOnlyToken());
  const oldSpreadsheetId = GOOGLE_SHEETS_SPREADSHEET_ID;
  const oldTeacherName = GOOGLE_SHEETS_TEACHER_NAME;
  const oldTeacherGid = GOOGLE_SHEETS_TEACHER_GID;
  try {
    await ensureMultiTeacherPersonalTemplate562B9C2B(token);
    const target = await multiTeacherPersonalTarget562B9C2B(token, teacherName);
    GOOGLE_SHEETS_SPREADSHEET_ID = target.spreadsheetId;
    GOOGLE_SHEETS_TEACHER_NAME = target.sheetName;
    GOOGLE_SHEETS_TEACHER_GID = target.sheetId;
    return await exportSelectedWeek1To35ToGoogleSheetBefore562B9C2B({ ...options, accessToken: token });
  } finally {
    GOOGLE_SHEETS_SPREADSHEET_ID = oldSpreadsheetId;
    GOOGLE_SHEETS_TEACHER_NAME = oldTeacherName;
    GOOGLE_SHEETS_TEACHER_GID = oldTeacherGid;
  }
};
