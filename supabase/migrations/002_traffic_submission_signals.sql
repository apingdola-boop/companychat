-- 유류비 페이지(trafficservice)가 companychat과 다른 탭/출처일 때 동기화용
-- Supabase SQL 에디터에서 company_chat_app_state 와 같은 프로젝트에 실행하세요.

create table if not exists public.traffic_submission_signals (
  id uuid primary key default gen_random_uuid(),
  login_id text not null,
  iv_name text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists traffic_submission_signals_created_at_idx
  on public.traffic_submission_signals (created_at desc);

comment on table public.traffic_submission_signals is '유류비 도구 → companychat 제출 브리지(anon insert/select, 내부용)';

alter table public.traffic_submission_signals enable row level security;

-- trafficservice·companychat 브라우저(anon)가 동일 프로젝트를 씀. 악용 방지는 키 노출 수준과 동일.
create policy "traffic_submission_signals_insert_anon"
  on public.traffic_submission_signals
  for insert
  to anon
  with check (true);

create policy "traffic_submission_signals_select_anon"
  on public.traffic_submission_signals
  for select
  to anon
  using (created_at > (now() - interval '90 days'));
