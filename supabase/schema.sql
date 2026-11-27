-- Схема облачной базы приложения «Расходы» (Supabase, Postgres).
-- По одной таблице на каждое локальное хранилище. Каждая строка принадлежит одному пользователю.
-- При конфликте побеждает более поздняя правка (mtime, время правки на устройстве в миллисекундах).

create or replace function public.sync_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.mtime < old.mtime then
    return null; -- пришла более старая правка, оставляем то, что есть
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;

revoke all on function public.sync_guard() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['tx', 'categories', 'accounts', 'settings'] loop
    execute format($f$
      create table public.%1$I (
        user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
        id text not null check (length(id) between 1 and 80),
        data jsonb not null default '{}'::jsonb,
        mtime bigint not null default 0,
        deleted boolean not null default false,
        updated_at timestamptz not null default now(),
        primary key (user_id, id)
      );
      create index %2$I on public.%1$I (user_id, updated_at, id);
      alter table public.%1$I enable row level security;
      create policy "own rows: select" on public.%1$I for select to authenticated
        using (user_id = (select auth.uid()));
      create policy "own rows: insert" on public.%1$I for insert to authenticated
        with check (user_id = (select auth.uid()));
      create policy "own rows: update" on public.%1$I for update to authenticated
        using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
      revoke all on public.%1$I from anon, authenticated;
      grant select, insert, update on public.%1$I to authenticated;
      create trigger sync_guard before insert or update on public.%1$I
        for each row execute function public.sync_guard();
    $f$, t, t || '_user_updated_idx');
  end loop;
end $$;
