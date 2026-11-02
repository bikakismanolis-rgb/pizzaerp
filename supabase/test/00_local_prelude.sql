-- Τοπική προσομοίωση του περιβάλλοντος Supabase (ΜΟΝΟ για δοκιμές, δεν
-- εφαρμόζεται ποτέ στη Supabase).
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
-- όπως στη Supabase: κάθε νέα function του public παίρνει αυτόματα execute
-- για anon/authenticated, άρα τα migrations πρέπει να κάνουν ρητά revoke
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
-- όπως στη Supabase: ο service_role (Edge Functions) βλέπει το schema public
grant usage on schema public to service_role;
-- και όπως στη Supabase: πλήρης πρόσβαση στους πίνακες, χωρίς RLS
alter role service_role bypassrls;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
