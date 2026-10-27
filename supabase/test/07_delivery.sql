-- Σενάριο δοκιμής 0007: διανομείς με σύνδεσμο, «Την παίρνω», «Παραδόθηκε»,
-- «Έφυγε με…» από την κουζίνα, θέση μόνο όσο έρχεται, ταμείο διανομέα,
-- δικαιώματα.
\set ON_ERROR_STOP on
\pset format aligned

insert into auth.users (id, email) values
  ('77777777-7777-7777-7777-777777777771', 'drv-owner@example.com'),
  ('77777777-7777-7777-7777-777777777772', 'drv-staff@example.com')
on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777771', false);

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
create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  execute 'set role anon';
end $$;
create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  execute 'set role authenticated';
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', p)::text, false);
  perform set_config('request.jwt.claim.sub', p::text, false);
end $$;
create function pg_temp.ord(p_phone text, p_item uuid, p_mode text default 'delivery', p_pay text default 'cash') returns jsonb language sql as $$
  select jsonb_build_object('name', 'Νίκη', 'phone', p_phone, 'mode', p_mode,
                            'address', case when p_mode = 'delivery' then 'Έβανς 40, Ηράκλειο' end, 'payment', p_pay,
                            'lines', jsonb_build_array(jsonb_build_object('item_id', p_item, 'qty', 1)));
$$;

do $$
declare
  me    constant uuid := '77777777-7777-7777-7777-777777777771';
  staff constant uuid := '77777777-7777-7777-7777-777777777772';
  c uuid; marg uuid; flour uuid; b uuid; d uuid; sup uuid;
  nikos uuid; giannis uuid; tn uuid; tg uuid;
  o1 uuid; o2 uuid; o3 uuid; o4 uuid; t1 uuid; t4 uuid;
  r jsonb; a jsonb;
  n int; v numeric;
begin
  c := public.create_company('Πιτσαρία Διανομή', null);
  insert into public.company_member (company_id, user_id, role) values (c, staff, 'staff');
  insert into public.item (company_id, code, name, item_type, unit) values (c, 'ΠΥ-001', 'Αλεύρι', 'raw', 'kg') returning id into flour;
  insert into public.item (company_id, code, name, item_type, category, unit, sale_price, make_to_order, online) values
    (c, 'ΠΡ-001', 'Μαργαρίτα', 'finished', 'Πίτσες', 'τεμ', 8.00, true, true) returning id into marg;
  insert into public.bom (company_id, item_id, output_qty) values (c, marg, 1) returning id into b;
  insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values (c, b, 1, flour, 0.25);
  insert into public.partner (company_id, code, name, is_supplier) values (c, 'ΠΡ-1', 'Μύλος', true) returning id into sup;
  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', current_date - 1, sup) returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price) values (d, 1, flour, 50, 0.6);
  perform public.post_document(d);
  insert into public.online_shop (company_id, slug, title, phone, delivery_fee) values (c, 'drv-pizza', 'Πιτσαρία Διανομή', '2810000003', 1.00);
  perform public.shop_set_open(c, true);

  -- διανομείς: μόνο ο owner τους φτιάχνει και φτιάχνει συνδέσμους
  insert into public.driver (company_id, name, phone) values (c, 'Νίκος', '6970000001') returning id into nikos;
  insert into public.driver (company_id, name) values (c, 'Γιάννης') returning id into giannis;
  tn := public.driver_link(nikos);
  tg := public.driver_link(giannis);
  if tn is null or tg is null or tn = tg then raise exception 'ΑΠΟΤΥΧΙΑ: σύνδεσμοι'; end if;
  if public.driver_link(nikos) <> tn then raise exception 'ΑΠΟΤΥΧΙΑ: το get άλλαξε τον σύνδεσμο'; end if;
  perform pg_temp.as_user(staff);
  perform pg_temp.expect_fail(format('select public.driver_link(%L)', nikos), '%Μόνο ο ιδιοκτήτης%', 'σύνδεσμος από το προσωπικό');
  perform pg_temp.expect_fail(format('insert into public.driver (company_id, name) values (%L, %L)', c, 'Ξένος'),
                              '%row-level security%', 'νέος διανομέας από το προσωπικό');
  perform pg_temp.expect_fail(format('update public.driver set token = gen_random_uuid() where id = %L', nikos),
                              '%permission denied%', 'σύνδεσμος με update');
  select count(*) into n from public.driver where company_id = c;
  if n <> 2 then raise exception 'ΑΠΟΤΥΧΙΑ: το προσωπικό βλέπει % διανομείς', n; end if;
  raise notice 'OK διανομείς και σύνδεσμοι';

  -- παραγγελίες: 2 διανομή (μετρητά, κάρτα), 1 παραλαβή
  perform pg_temp.as_anon();
  r := public.place_order('drv-pizza', pg_temp.ord('6941000001', marg)); o1 := (r->>'order_id')::uuid; t1 := (r->>'token')::uuid;
  r := public.place_order('drv-pizza', pg_temp.ord('6941000002', marg, 'delivery', 'card')); o2 := (r->>'order_id')::uuid;
  r := public.place_order('drv-pizza', pg_temp.ord('6941000003', marg, 'pickup')); o3 := (r->>'order_id')::uuid;
  r := public.place_order('drv-pizza', pg_temp.ord('6941000004', marg)); o4 := (r->>'order_id')::uuid; t4 := (r->>'token')::uuid;

  -- ο διανομέας δεν βλέπει νέες (μη δεκτές) παραγγελίες
  a := public.driver_app(tn);
  if jsonb_array_length(a->'ready') <> 0 or a->'driver'->>'name' <> 'Νίκος' then raise exception 'ΑΠΟΤΥΧΙΑ: οθόνη διανομέα %', a; end if;
  perform pg_temp.expect_fail(format('select public.driver_take(%L, %L)', tn, o1), '%Η παραγγελία #%', 'παίρνει μη δεκτή');
  perform pg_temp.expect_fail(format('select public.driver_app(%L)', gen_random_uuid()), '%δεν ισχύει%', 'άγνωστος σύνδεσμος');
  perform pg_temp.expect_fail('select * from public.driver', '%permission denied%', 'πίνακας διανομέων από επισκέπτη');

  perform pg_temp.as_user(staff);
  perform public.order_accept(o1, 20);
  perform public.order_accept(o2, 20);
  perform public.order_accept(o3, 20);
  perform public.order_accept(o4, 20);

  -- έτοιμες: μόνο οι διανομές
  perform pg_temp.as_anon();
  a := public.driver_app(tn);
  if jsonb_array_length(a->'ready') <> 3 then raise exception 'ΑΠΟΤΥΧΙΑ: έτοιμες % (η παραλαβή δεν είναι για διανομέα)', a->'ready'; end if;
  if (a->'ready'->0->>'address') <> 'Έβανς 40, Ηράκλειο' or (a->'ready'->0->'lines'->0->>'name') <> 'Μαργαρίτα' then
    raise exception 'ΑΠΟΤΥΧΙΑ: στοιχεία έτοιμης %', a->'ready'->0;
  end if;
  perform pg_temp.expect_fail(format('select public.driver_take(%L, %L)', tn, o3), '%Δεν βρέθηκε%', 'παίρνει παραλαβή');

  -- «Την παίρνω»: έφυγε με τον Νίκο· ο Γιάννης δεν την παίρνει
  r := public.driver_take(tn, o1);
  perform pg_temp.expect_fail(format('select public.driver_take(%L, %L)', tg, o1), '%άλλος διανομέας%', 'δεύτερος διανομέας');
  r := public.driver_take(tn, o1);
  if not (r->>'already')::boolean then raise exception 'ΑΠΟΤΥΧΙΑ: ξανά «Την παίρνω»'; end if;
  a := public.driver_app(tn);
  if jsonb_array_length(a->'mine') <> 1 or jsonb_array_length(a->'ready') <> 2 then raise exception 'ΑΠΟΤΥΧΙΑ: δικές του %', a; end if;
  a := public.driver_app(tg);
  if jsonb_array_length(a->'mine') <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: ο Γιάννης βλέπει του Νίκου'; end if;

  -- ο πελάτης: ποιος τη φέρνει· θέση μόνο αν το μαγαζί το έχει ανοίξει
  a := public.order_track(t1);
  if a->>'driver' <> 'Νίκος' or a->'pos' <> 'null'::jsonb then raise exception 'ΑΠΟΤΥΧΙΑ: tracking %', a; end if;
  if public.driver_ping(tn, 35.3387, 25.1442, 12) then raise exception 'ΑΠΟΤΥΧΙΑ: θέση χωρίς άδεια του μαγαζιού'; end if;
  perform pg_temp.as_user(me);
  update public.online_shop set driver_tracking = true where company_id = c;
  perform pg_temp.as_anon();
  if not public.driver_ping(tn, 35.338712345, 25.144298765, 12) then raise exception 'ΑΠΟΤΥΧΙΑ: θέση'; end if;
  perform pg_temp.expect_fail(format('select public.driver_ping(%L, 120, 25, 1)', tn), '%Μη έγκυρη θέση%', 'θέση εκτός ορίων');
  a := public.order_track(t1);
  if (a->'pos'->>'lat')::numeric <> 35.33871 or (a->'pos'->>'lng')::numeric <> 25.1443 then raise exception 'ΑΠΟΤΥΧΙΑ: θέση στον πελάτη %', a; end if;
  -- άλλος πελάτης (η #4, δεν την πήρε ακόμα κανείς) δεν βλέπει θέση
  a := public.order_track(t4);
  if a->'pos' <> 'null'::jsonb or a->>'driver' is not null then raise exception 'ΑΠΟΤΥΧΙΑ: θέση σε άλλον πελάτη %', a; end if;
  -- ο Γιάννης δεν έχει τίποτα στον δρόμο: η θέση του δεν γράφεται
  if public.driver_ping(tg, 35.3, 25.1, 5) then raise exception 'ΑΠΟΤΥΧΙΑ: θέση χωρίς διανομή'; end if;
  raise notice 'OK «Την παίρνω» και θέση μόνο όσο έρχεται';

  -- η κουζίνα: «Έφυγε με τον Γιάννη»
  perform pg_temp.as_user(staff);
  r := public.order_send(o2, giannis);
  if r->>'driver' <> 'Γιάννης' then raise exception 'ΑΠΟΤΥΧΙΑ: order_send %', r; end if;
  perform pg_temp.expect_fail(format('select public.order_send(%L, %L)', o3, giannis), '%παραλαβή%', 'έφυγε με διανομέα η παραλαβή');
  -- απλό «Έφυγε» (χωρίς διανομέα): την παίρνει μετά ο διανομέας
  perform public.order_done(o4);
  perform pg_temp.as_anon();
  a := public.driver_app(tg);
  if jsonb_array_length(a->'ready') <> 1 or (a->'ready'->0->>'id')::uuid <> o4 then raise exception 'ΑΠΟΤΥΧΙΑ: «Έφυγε» χωρίς διανομέα %', a->'ready'; end if;
  perform public.driver_take(tg, o4);
  -- «Δεν την πήρα τελικά»
  perform public.driver_release(tg, o4);
  perform pg_temp.as_user(staff);
  select count(*) into n from public.online_order where id = o4 and status = 'accepted' and driver_id is null and done_at is null;
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: δεν γύρισε στις έτοιμες'; end if;
  perform public.order_send(o4, nikos);

  -- «Παραδόθηκε»: μετρητά στον διανομέα, η θέση σβήνει όταν τελειώσει
  perform pg_temp.as_anon();
  r := public.driver_delivered(tn, o1);
  if (r->>'cash')::numeric <> 10.04 then raise exception 'ΑΠΟΤΥΧΙΑ: μετρητά %', r; end if;
  perform pg_temp.expect_fail(format('select public.driver_delivered(%L, %L)', tg, o1), '%δεν είναι στον δρόμο%', 'παραδίδει άλλου');
  a := public.order_track(t1);
  if a->>'delivered_at' is null or a->'pos' <> 'null'::jsonb then raise exception 'ΑΠΟΤΥΧΙΑ: μετά την παράδοση %', a; end if;
  perform pg_temp.as_user(staff);
  select count(*) into n from public.driver where id = nikos and last_lat is not null;
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: η θέση έσβησε ενώ έχει ακόμα την #4'; end if;
  perform pg_temp.as_anon();
  perform public.driver_delivered(tn, o4);
  perform public.driver_delivered(tg, o2);
  perform pg_temp.as_user(staff);
  select count(*) into n from public.driver where company_id = c and last_lat is not null;
  if n <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: η θέση δεν έσβησε'; end if;

  -- ταμείο: ο Νίκος κρατά 2 × 10,04 μετρητά, ο Γιάννης τίποτα (κάρτα)
  select to_jsonb(x) into a from public.v_driver_today x where driver_id = nikos;
  if (a->>'cash_open')::numeric <> 20.08 or (a->>'delivered_today')::int <> 2 or (a->>'on_way')::int <> 0 then
    raise exception 'ΑΠΟΤΥΧΙΑ: ταμείο Νίκου %', a;
  end if;
  select to_jsonb(x) into a from public.v_driver_today x where driver_id = giannis;
  if (a->>'cash_open')::numeric <> 0 or (a->>'delivered_today')::int <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: ταμείο Γιάννη %', a; end if;
  v := public.driver_settle(nikos);
  if v <> 20.08 then raise exception 'ΑΠΟΤΥΧΙΑ: εκκαθάριση %', v; end if;
  if public.driver_settle(nikos) <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: δεύτερη εκκαθάριση'; end if;
  perform pg_temp.as_anon();
  a := public.driver_app(tn);
  if (a->>'cash_open')::numeric <> 0 or (a->>'delivered_today')::int <> 2 then raise exception 'ΑΠΟΤΥΧΙΑ: οθόνη μετά την εκκαθάριση %', a; end if;
  raise notice 'OK «Παραδόθηκε», θέση σβήνει, ταμείο διανομέα';

  -- σύνδεσμος που σταμάτησε: τίποτα
  perform pg_temp.as_user(me);
  perform public.driver_link(giannis, 'off');
  perform pg_temp.as_anon();
  perform pg_temp.expect_fail(format('select public.driver_app(%L)', tg), '%δεν ισχύει%', 'σύνδεσμος που σταμάτησε');
  raise notice 'OK σύνδεσμος που σταμάτησε';

  raise notice 'ΟΛΑ ΟΚ (διανομείς)';
end $$;
reset role;
