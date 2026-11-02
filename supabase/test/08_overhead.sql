-- Σενάριο δοκιμής 0008: γενικά έξοδα μόνο για τον ιδιοκτήτη, ένα ανά
-- κατηγορία και μήνα, έλεγχοι.
\set ON_ERROR_STOP on
\pset format aligned

insert into auth.users (id, email) values
  ('66666666-6666-6666-6666-666666666661', 'oh-owner@example.com'),
  ('66666666-6666-6666-6666-666666666662', 'oh-staff@example.com'),
  ('66666666-6666-6666-6666-666666666663', 'oh-stranger@example.com')
on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claim.sub', '66666666-6666-6666-6666-666666666661', false);

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

do $$
declare
  me       constant uuid := '66666666-6666-6666-6666-666666666661';
  staff    constant uuid := '66666666-6666-6666-6666-666666666662';
  stranger constant uuid := '66666666-6666-6666-6666-666666666663';
  c uuid; n int; v numeric;
begin
  c := public.create_company('Πιτσαρία Έξοδα', null);
  insert into public.company_member (company_id, user_id, role) values (c, staff, 'staff');

  insert into public.overhead (company_id, month, category, amount) values
    (c, '2026-10-01', 'Ενοίκιο', 800), (c, '2026-10-01', 'Ρεύμα', 320.50), (c, '2026-10-01', 'Μισθοί', 2400),
    (c, '2026-11-01', 'Ενοίκιο', 800);
  select total into v from public.v_overhead_month where company_id = c and month = '2026-10-01';
  if v <> 3520.50 then raise exception 'ΑΠΟΤΥΧΙΑ: σύνολο μήνα %', v; end if;

  perform pg_temp.expect_fail(format('insert into public.overhead (company_id, month, category, amount) values (%L, %L, %L, 1)', c, '2026-10-01', 'Ρεύμα'),
                              '%duplicate%', 'δεύτερο ρεύμα τον ίδιο μήνα');
  perform pg_temp.expect_fail(format('insert into public.overhead (company_id, month, category, amount) values (%L, %L, %L, 1)', c, '2026-10-15', 'Νερό'),
                              '%overhead_month_check%', 'μήνας χωρίς 1η');
  perform pg_temp.expect_fail(format('insert into public.overhead (company_id, month, category, amount) values (%L, %L, %L, -5)', c, '2026-10-01', 'Νερό'),
                              '%overhead_amount_check%', 'αρνητικό ποσό');
  -- ξανά ίδια κατηγορία: αλλαγή ποσού (upsert)
  insert into public.overhead (company_id, month, category, amount) values (c, '2026-10-01', 'Ρεύμα', 300)
  on conflict (company_id, month, category) do update set amount = excluded.amount;
  select amount into v from public.overhead where company_id = c and month = '2026-10-01' and category = 'Ρεύμα';
  if v <> 300 then raise exception 'ΑΠΟΤΥΧΙΑ: αλλαγή ποσού %', v; end if;

  -- το προσωπικό δεν βλέπει ούτε γράφει (μέσα είναι οι μισθοί)
  perform pg_temp.as_user(staff);
  select count(*) into n from public.overhead where company_id = c;
  if n <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: το προσωπικό βλέπει % έξοδα', n; end if;
  select count(*) into n from public.v_overhead_month where company_id = c;
  if n <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: το προσωπικό βλέπει σύνολα'; end if;
  perform pg_temp.expect_fail(format('insert into public.overhead (company_id, month, category, amount) values (%L, %L, %L, 1)', c, '2026-10-01', 'Νερό'),
                              '%row-level security%', 'έξοδο από το προσωπικό');
  update public.overhead set amount = 0 where company_id = c;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: το προσωπικό άλλαξε έξοδα'; end if;

  perform pg_temp.as_user(stranger);
  select count(*) into n from public.overhead where company_id = c;
  if n <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: ξένος βλέπει έξοδα'; end if;

  perform pg_temp.as_user(me);
  delete from public.overhead where company_id = c and month = '2026-11-01';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: διαγραφή από τον ιδιοκτήτη'; end if;

  raise notice 'ΟΛΑ ΟΚ (γενικά έξοδα)';
end $$;
reset role;
set role anon;
do $$
begin
  perform 1 from public.overhead limit 1;
  raise exception 'ΑΠΟΤΥΧΙΑ: ο επισκέπτης διαβάζει τα έξοδα';
exception when insufficient_privilege then
  raise notice 'OK ο επισκέπτης δεν βλέπει τα έξοδα';
end $$;
reset role;
