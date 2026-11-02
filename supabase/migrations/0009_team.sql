-- =====================================================================
-- Pizza ERP - 0009 υπάλληλοι: κωδικός πρόσκλησης
--
-- Ο ιδιοκτήτης βγάζει έναν 6ψήφιο κωδικό («Φτιάξε κωδικό για νέο
-- υπάλληλο»). Ο υπάλληλος φτιάχνει λογαριασμό, γράφει τον κωδικό και
-- μπαίνει στο μαγαζί ως υπάλληλος (staff). Ο κωδικός ισχύει 7 μέρες και
-- για όσους τον γράψουν μέσα σε αυτές· ο ιδιοκτήτης τον σταματά όποτε θέλει.
-- Μετά από 5 λάθος κωδικούς σε 15 λεπτά, ο λογαριασμός περιμένει (να μη
-- δοκιμάζει κάποιος όλους τους αριθμούς).
--
-- Δεν αλλάζει καμία υπάρχουσα function. Ξανατρέχει χωρίς σφάλμα.
-- =====================================================================

create table if not exists public.company_invite (
  company_id  uuid primary key references public.company(id) on delete cascade,
  code        text not null unique,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  constraint company_invite_code_check check (code ~ '^[0-9]{6}$')
);
alter table public.company_invite enable row level security;
-- μόνο μέσω των functions (ο κωδικός δεν διαβάζεται απευθείας)
revoke all on public.company_invite from anon, authenticated;

create table if not exists public.team_join_attempt (
  user_id  uuid not null references auth.users(id) on delete cascade,
  at       timestamptz not null default now()
);
create index if not exists team_join_attempt_user on public.team_join_attempt (user_id, at);
alter table public.team_join_attempt enable row level security;
revoke all on public.team_join_attempt from anon, authenticated;

-- ---------------------------------------------------------------------
-- Ο ιδιοκτήτης: νέος κωδικός (ο παλιός σταματά)
-- ---------------------------------------------------------------------
create or replace function public.team_invite(p_company uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_code text;
  v_exp  timestamptz := now() + interval '7 days';
begin
  if not public.is_owner(p_company) then
    raise exception 'Κωδικό για νέο υπάλληλο βγάζει μόνο ο ιδιοκτήτης.';
  end if;
  loop
    v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from public.company_invite where code = v_code);
  end loop;
  insert into public.company_invite (company_id, code, created_by, expires_at)
  values (p_company, v_code, auth.uid(), v_exp)
  on conflict (company_id) do update set code = excluded.code, created_by = excluded.created_by,
    created_at = now(), expires_at = excluded.expires_at;
  return jsonb_build_object('code', v_code, 'expires_at', v_exp);
end $$;

-- ο τρέχων κωδικός (αν ισχύει)
create or replace function public.team_invite_get(p_company uuid)
returns jsonb
language plpgsql security definer stable
set search_path = public
as $$
declare r public.company_invite%rowtype;
begin
  if not public.is_owner(p_company) then
    raise exception 'Μόνο ο ιδιοκτήτης.';
  end if;
  select * into r from public.company_invite where company_id = p_company and expires_at > now();
  if not found then return null; end if;
  return jsonb_build_object('code', r.code, 'expires_at', r.expires_at);
end $$;

create or replace function public.team_invite_stop(p_company uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_owner(p_company) then
    raise exception 'Μόνο ο ιδιοκτήτης.';
  end if;
  delete from public.company_invite where company_id = p_company;
end $$;

-- ---------------------------------------------------------------------
-- Ο υπάλληλος: γράφει τον κωδικό. Επιστρέφει {company_id, name}, ή
-- {error} για λάθος κωδικό.
-- ---------------------------------------------------------------------
create or replace function public.team_join(p_code text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_code text := regexp_replace(coalesce(p_code, ''), '\D', '', 'g');
  r      public.company_invite%rowtype;
  v_name text;
  n      int;
begin
  if v_uid is null then
    raise exception 'Πρώτα σύνδεση.';
  end if;
  select count(*) into n from public.team_join_attempt where user_id = v_uid and at > now() - interval '15 minutes';
  if n >= 5 then
    raise exception 'Πολλές λάθος προσπάθειες. Περίμενε ένα τέταρτο και ζήτα ξανά τον κωδικό από τον ιδιοκτήτη.';
  end if;
  select * into r from public.company_invite where code = v_code and expires_at > now();
  if not found then
    -- όχι raise: η λάθος προσπάθεια πρέπει να μείνει γραμμένη (το raise θα τη σβήσει)
    insert into public.team_join_attempt (user_id) values (v_uid);
    delete from public.team_join_attempt where at < now() - interval '1 day';
    return jsonb_build_object('error', 'Ο κωδικός δεν ισχύει. Δες ότι τον έγραψες σωστά (6 αριθμοί), ή ζήτα νέο από τον ιδιοκτήτη.');
  end if;
  insert into public.company_member (company_id, user_id, role) values (r.company_id, v_uid, 'staff')
  on conflict (company_id, user_id) do nothing;
  select name into v_name from public.company where id = r.company_id;
  return jsonb_build_object('company_id', r.company_id, 'name', v_name);
end $$;

-- ---------------------------------------------------------------------
-- Ποιοι δουλεύουν εδώ (με το email τους· μόνο ο ιδιοκτήτης)
-- ---------------------------------------------------------------------
create or replace function public.team_list(p_company uuid)
returns table (user_id uuid, email text, role text, since timestamptz, is_me boolean)
language plpgsql security definer stable
set search_path = public
as $$
begin
  if not public.is_owner(p_company) then
    raise exception 'Μόνο ο ιδιοκτήτης.';
  end if;
  return query
    select m.user_id, u.email::text, m.role, m.created_at, m.user_id = auth.uid()
      from public.company_member m left join auth.users u on u.id = m.user_id
     where m.company_id = p_company
     order by m.role = 'owner' desc, m.created_at;
end $$;

-- βγάζει υπάλληλο (όχι τον εαυτό του, όχι τον τελευταίο ιδιοκτήτη)
create or replace function public.team_remove(p_company uuid, p_user uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_owner(p_company) then
    raise exception 'Μόνο ο ιδιοκτήτης.';
  end if;
  if p_user = auth.uid() then
    raise exception 'Δεν βγάζεις τον εαυτό σου.';
  end if;
  delete from public.company_member where company_id = p_company and user_id = p_user;
end $$;

-- υπάλληλος → ιδιοκτήτης (βλέπει κέρδος, μισθούς, ρυθμίσεις) ή πίσω
create or replace function public.team_set_role(p_company uuid, p_user uuid, p_role text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_owner(p_company) then
    raise exception 'Μόνο ο ιδιοκτήτης.';
  end if;
  if p_role not in ('owner', 'staff') then
    raise exception 'Μη έγκυρος ρόλος';
  end if;
  if p_user = auth.uid() and p_role <> 'owner' then
    raise exception 'Δεν αλλάζεις τον δικό σου ρόλο.';
  end if;
  update public.company_member set role = p_role where company_id = p_company and user_id = p_user;
end $$;

revoke execute on function public.team_invite(uuid), public.team_invite_get(uuid), public.team_invite_stop(uuid),
  public.team_join(text), public.team_list(uuid), public.team_remove(uuid, uuid), public.team_set_role(uuid, uuid, text) from public, anon;
grant execute on function public.team_invite(uuid), public.team_invite_get(uuid), public.team_invite_stop(uuid),
  public.team_join(text), public.team_list(uuid), public.team_remove(uuid, uuid), public.team_set_role(uuid, uuid, text) to authenticated;
