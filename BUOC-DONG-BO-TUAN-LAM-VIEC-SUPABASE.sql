-- CÀI ĐẶT MỘT LẦN trong Supabase > SQL Editor > Run.
-- Mỗi tài khoản và mỗi năm học có MỘT tuần làm việc dùng chung trên tất cả thiết bị.
create table if not exists public.tkb_user_week_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  school_year text not null,
  week_number integer not null check (week_number between 1 and 35),
  updated_at timestamptz not null default now(),
  primary key (user_id, school_year),
  constraint tkb_user_week_state_school_year_not_blank check (length(trim(school_year)) > 0)
);

create or replace function public.tkb_week_state_server_timestamp()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tkb_week_state_updated_at on public.tkb_user_week_state;
create trigger tkb_week_state_updated_at
before insert or update on public.tkb_user_week_state
for each row execute function public.tkb_week_state_server_timestamp();

alter table public.tkb_user_week_state enable row level security;
drop policy if exists tkb_week_state_select_own on public.tkb_user_week_state;
create policy tkb_week_state_select_own on public.tkb_user_week_state
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists tkb_week_state_insert_own on public.tkb_user_week_state;
create policy tkb_week_state_insert_own on public.tkb_user_week_state
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists tkb_week_state_update_own on public.tkb_user_week_state;
create policy tkb_week_state_update_own on public.tkb_user_week_state
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update on public.tkb_user_week_state to authenticated;
revoke all on public.tkb_user_week_state from anon;

-- Kiểm tra sau khi chạy (không cần thêm thủ công dòng dữ liệu):
-- select user_id, school_year, week_number, updated_at from public.tkb_user_week_state;
