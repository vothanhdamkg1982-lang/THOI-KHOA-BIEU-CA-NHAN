-- BƯỚC 5.3.1 - Ánh xạ an toàn tài khoản Supabase -> giáo viên -> tab Google Sheet
-- Chỉ tạo lớp dữ liệu ánh xạ. CHƯA thay đổi app.js và CHƯA tác động cơ chế ghi Tuần 1-35.

create table if not exists public.tkb_teacher_google_sheets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  teacher_name text not null,
  spreadsheet_id text not null,
  sheet_name text not null,
  sheet_gid bigint not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tkb_teacher_google_sheets_teacher_name_nonempty check (length(trim(teacher_name)) > 0),
  constraint tkb_teacher_google_sheets_spreadsheet_id_nonempty check (length(trim(spreadsheet_id)) > 0),
  constraint tkb_teacher_google_sheets_sheet_name_nonempty check (length(trim(sheet_name)) > 0),
  constraint tkb_teacher_google_sheets_sheet_gid_valid check (sheet_gid >= 0)
);

alter table public.tkb_teacher_google_sheets enable row level security;

-- Giáo viên chỉ được ĐỌC cấu hình của chính tài khoản đang đăng nhập.
-- Không cấp INSERT/UPDATE/DELETE cho authenticated: ánh xạ phải do quản trị viên cấu hình,
-- tránh giáo viên tự đổi GID sang tab của người khác.
drop policy if exists "teacher_read_own_google_sheet_mapping" on public.tkb_teacher_google_sheets;
create policy "teacher_read_own_google_sheet_mapping"
on public.tkb_teacher_google_sheets
for select
to authenticated
using (auth.uid() = user_id);

grant select on public.tkb_teacher_google_sheets to authenticated;
revoke insert, update, delete on public.tkb_teacher_google_sheets from anon, authenticated;

create unique index if not exists tkb_teacher_google_sheets_spreadsheet_gid_unique
on public.tkb_teacher_google_sheets (spreadsheet_id, sheet_gid);

create unique index if not exists tkb_teacher_google_sheets_spreadsheet_sheet_name_unique
on public.tkb_teacher_google_sheets (spreadsheet_id, lower(trim(sheet_name)));

-- Sau khi chạy xong, KHÔNG chèn dữ liệu bằng tài khoản giáo viên.
-- Ở bước 5.3.2 app sẽ đọc đúng 1 dòng theo currentAuthUser.id.
-- Bản ghi của Võ Thanh Đậm sẽ được thêm sau khi xác nhận chính xác UUID tài khoản hiện tại,
-- để tuyệt đối không đoán hoặc gắn nhầm tài khoản.
