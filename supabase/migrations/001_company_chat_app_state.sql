-- H-채팅 서버(Node)만 service_role 키로 접근합니다. Supabase 대시보드 → SQL 에서 실행하세요.
-- RLS 켜고 정책 없음 → PostgREST(anon) 차단, 서버에서 service_role 은 RLS 우회.

create table if not exists public.company_chat_app_state (
  id text primary key default 'main',
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.company_chat_app_state enable row level security;

comment on table public.company_chat_app_state is 'H-채팅 단일 앱 상태(JSON). 브라우저에서 직접 접근하지 마세요.';
