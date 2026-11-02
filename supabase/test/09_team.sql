-- Σενάριο δοκιμής 0009: κωδικός για νέο υπάλληλο, όριο λάθος προσπαθειών,
-- λίστα, αφαίρεση, ρόλοι.
\set ON_ERROR_STOP on
\pset format aligned

insert into auth.users (id, email) values
  ('abababab-0009-0009-0009-000000000001', 'team-owner@example.com'),
  ('abababab-0009-0009-0009-000000000002', 'team-new@example.com'),
  ('abababab-0009-0009-0009-000000000003', 'team-guesser@example.com')
on conflict do nothing;

create function pg_temp.expect_fail(p_sql text, p_like text, p_label text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like p_like then
      raise exception 'ΑΠΟΤΥΧΙΑ %: άλλο σφάλμα: %', p_label, sqlerrm;
    end if;
    raise notice 'OK %: %', p_label, sqlerrm;
    return;
  end;
  raise exception 'ΑΠΟΤΥΧΙΑ %: έπρεπε να αποτύχει', p_label;
end $$;
create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  execute 'set role authenticated';
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', p)::text, false);
  perform set_config('request.jwt.claim.sub', p::text, false);
end $$;
create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  execute 'set role anon';
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, false);
  perform set_config('request.jwt.claim.sub', '', false);
end $$;

do $$
declare
  me      constant uuid := 'abababab-0009-0009-0009-000000000001';
  newbie  constant uuid := 'abababab-0009-0009-0009-000000000002';
  guesser constant uuid := 'abababab-0009-0009-0009-000000000003';
  c uuid; r jsonb; code text; code2 text; n int; i int;
begin
  perform pg_temp.as_user(me);
  c := public.create_company('Πιτσαρία Ομάδα', null);

  -- ο υπάλληλος δεν βγάζει κωδικό
  perform pg_temp.as_user(newbie);
  perform pg_temp.expect_fail(format('select public.team_invite(%L)', c), '%μόνο ο ιδιοκτήτης%', 'κωδικός από μη μέλος');

  perform pg_temp.as_user(me);
  if public.team_invite_get(c) is not null then raise exception 'ΑΠΟΤΥΧΙΑ: κωδικός πριν φτιαχτεί'; end if;
  r := public.team_invite(c);
  code := r->>'code';
  if code !~ '^[0-9]{6}$' then raise exception 'ΑΠΟΤΥΧΙΑ: κωδικός %', r; end if;
  if public.team_invite_get(c)->>'code' <> code then raise exception 'ΑΠΟΤΥΧΙΑ: ο τρέχων κωδικός'; end if;
  -- ο πίνακας δεν διαβάζεται απευθείας
  perform pg_temp.expect_fail('select * from public.company_invite', '%permission denied%', 'κωδικοί απευθείας');

  -- ο νέος μπαίνει (με κενά/παύλες στον κωδικό), δεύτερη φορά δεν πειράζει
  perform pg_temp.as_user(newbie);
  r := public.team_join(substr(code, 1, 3) || ' - ' || substr(code, 4));
  if (r->>'company_id')::uuid <> c or r->>'name' <> 'Πιτσαρία Ομάδα' then raise exception 'ΑΠΟΤΥΧΙΑ: είσοδος %', r; end if;
  r := public.team_join(code);
  select count(*) into n from public.company_member where company_id = c and user_id = newbie and role = 'staff';
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: ο υπάλληλος δεν μπήκε ως staff'; end if;
  if not public.is_member(c) or public.is_owner(c) then raise exception 'ΑΠΟΤΥΧΙΑ: ρόλος υπαλλήλου'; end if;
  perform pg_temp.expect_fail(format('select public.team_list(%L)', c), '%Μόνο ο ιδιοκτήτης%', 'λίστα από υπάλληλο');
  raise notice 'OK κωδικός και είσοδος υπαλλήλου';

  -- λάθος κωδικοί: γράφονται, και μετά από 5 περιμένει
  perform pg_temp.as_user(guesser);
  for i in 1..5 loop
    r := public.team_join(case when code = '000000' then '111111' else '000000' end);
    if r->>'error' not like 'Ο κωδικός δεν ισχύει%' then raise exception 'ΑΠΟΤΥΧΙΑ: λάθος κωδικός %', r; end if;
  end loop;
  perform pg_temp.expect_fail(format('select public.team_join(%L)', code), '%Πολλές λάθος προσπάθειες%', 'μετά από 5 λάθος');
  select count(*) into n from public.company_member where company_id = c and user_id = guesser;
  if n <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: μπήκε μετά από 5 λάθος'; end if;
  execute 'reset role';
  update public.team_join_attempt set at = now() - interval '20 minutes' where user_id = guesser;
  perform pg_temp.as_user(guesser);
  r := public.team_join(code);
  if r ? 'error' then raise exception 'ΑΠΟΤΥΧΙΑ: μετά το τέταρτο %', r; end if;
  raise notice 'OK όριο λάθος προσπαθειών';

  -- νέος κωδικός: ο παλιός σταματά· σταμάτημα· λήξη
  perform pg_temp.as_user(me);
  code2 := public.team_invite(c)->>'code';
  perform pg_temp.as_user(guesser);
  if code2 <> code and not (public.team_join(code) ? 'error') then raise exception 'ΑΠΟΤΥΧΙΑ: ο παλιός κωδικός ισχύει'; end if;
  perform pg_temp.as_user(me);
  perform public.team_invite_stop(c);
  if public.team_invite_get(c) is not null then raise exception 'ΑΠΟΤΥΧΙΑ: σταμάτημα'; end if;
  code2 := public.team_invite(c)->>'code';
  execute 'reset role';
  update public.company_invite set expires_at = now() - interval '1 minute' where company_id = c;
  perform pg_temp.as_user(me);
  if public.team_invite_get(c) is not null then raise exception 'ΑΠΟΤΥΧΙΑ: ληγμένος κωδικός'; end if;
  raise notice 'OK νέος, σταματημένος, ληγμένος κωδικός';

  -- λίστα, ρόλος, αφαίρεση
  select count(*) into n from public.team_list(c);
  if n <> 3 then raise exception 'ΑΠΟΤΥΧΙΑ: λίστα % μέλη', n; end if;
  select count(*) into n from public.team_list(c) t where t.email = 'team-owner@example.com' and t.role = 'owner' and t.is_me;
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: ο ιδιοκτήτης στη λίστα'; end if;
  perform pg_temp.expect_fail(format('select public.team_remove(%L, %L)', c, me), '%τον εαυτό σου%', 'βγάζει τον εαυτό του');
  perform pg_temp.expect_fail(format('select public.team_set_role(%L, %L, %L)', c, me, 'staff'), '%δικό σου ρόλο%', 'κατεβάζει τον εαυτό του');
  perform public.team_set_role(c, newbie, 'owner');
  perform pg_temp.as_user(newbie);
  if not public.is_owner(c) then raise exception 'ΑΠΟΤΥΧΙΑ: έγινε ιδιοκτήτης'; end if;
  perform pg_temp.as_user(me);
  perform public.team_set_role(c, newbie, 'staff');
  perform public.team_remove(c, guesser);
  perform pg_temp.as_user(guesser);
  if public.is_member(c) then raise exception 'ΑΠΟΤΥΧΙΑ: αφαίρεση'; end if;

  -- επισκέπτης: τίποτα
  perform pg_temp.as_anon();
  perform pg_temp.expect_fail(format('select public.team_join(%L)', code2), '%permission denied%', 'είσοδος χωρίς λογαριασμό');
  raise notice 'OK λίστα, ρόλοι, αφαίρεση';
end $$;
reset role;
