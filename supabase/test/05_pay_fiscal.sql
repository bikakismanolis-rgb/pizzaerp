-- Σενάριο δοκιμής 0006: κλειδιά (μόνο ο server τα διαβάζει), extras πάνω
-- σε πίτσα, CAPTCHA, online πληρωμή (αναμονή, επιβεβαίωση, λάθος ποσό,
-- αποτυχία, διπλή πληρωμή, πληρωμή μετά την απόρριψη, επιστροφή), μεταφορικά
-- ως γραμμή υπηρεσίας χωρίς αποθήκη, παραστατικά (τιμολόγιο, απόδειξη,
-- πιστωτικό, αρίθμηση χωρίς κενά, με το χέρι, δημόσιος σύνδεσμος),
-- παραγγελίες ξενοδοχείων από σύνδεσμο, δικαιώματα.
\set ON_ERROR_STOP on
\pset format aligned

insert into auth.users (id, email) values
  ('88888888-8888-8888-8888-888888888881', 'pay-owner@example.com'),
  ('88888888-8888-8888-8888-888888888882', 'pay-staff@example.com'),
  ('88888888-8888-8888-8888-888888888883', 'pay-stranger@example.com')
on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claim.sub', '88888888-8888-8888-8888-888888888881', false);

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
-- η Edge Function: κλειδί service_role
create function pg_temp.as_service() returns void language plpgsql as $$
begin
  execute 'set role service_role';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false);
  perform set_config('request.jwt.claim.sub', '', false);
end $$;

create function pg_temp.ord(p_lines jsonb, p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object('name', 'Μαρία', 'phone', '6941111111', 'mode', 'delivery',
                            'address', 'Δαιδάλου 3, Ηράκλειο', 'payment', 'cash', 'lines', p_lines) || p_extra;
$$;

do $$
declare
  me       constant uuid := '88888888-8888-8888-8888-888888888881';
  staff    constant uuid := '88888888-8888-8888-8888-888888888882';
  stranger constant uuid := '88888888-8888-8888-8888-888888888883';
  today    date := (now() at time zone 'Europe/Athens')::date;
  c uuid; c2 uuid;
  flour uuid; mozz uuid; box uuid; dough uuid; marg uuid; xmozz uuid; frozen uuid; cola uuid; svc uuid;
  b uuid; d uuid; d2 uuid; sup uuid; hotel uuid; hotel2 uuid; plain uuid;
  r jsonb; m jsonb;
  o1 uuid; o2 uuid; o3 uuid; o4 uuid;
  p1 uuid; p2 uuid;
  f1 uuid; f2 uuid; f3 uuid; f4 uuid; f5 uuid;
  tok uuid; tok2 uuid;
  v numeric; v2 numeric;
  n int;
  rec record;
begin
  -- -------------------------------------------------------------------
  -- Στήσιμο
  -- -------------------------------------------------------------------
  c := public.create_company('Πιτσαρία Πληρωμές', '094014201');
  update public.company set address = 'Ικάρου 1, Ηράκλειο', phone = '2810000001' where id = c;
  insert into public.company_member (company_id, user_id, role) values (c, staff, 'staff');

  insert into public.item (company_id, code, name, item_type, unit) values (c, 'ΠΥ-001', 'Αλεύρι', 'raw', 'kg') returning id into flour;
  insert into public.item (company_id, code, name, item_type, unit) values (c, 'ΠΥ-002', 'Μοτσαρέλα', 'raw', 'kg') returning id into mozz;
  insert into public.item (company_id, code, name, item_type, unit, vat_rate) values (c, 'ΠΥ-003', 'Κουτί', 'raw', 'τεμ', 24) returning id into box;
  insert into public.item (company_id, code, name, item_type, unit, make_to_order) values (c, 'ΗΜ-001', 'Ζυμάρι', 'semi', 'τεμ', true) returning id into dough;
  insert into public.item (company_id, code, name, item_type, category, unit, sale_price, make_to_order, online) values
    (c, 'ΠΡ-001', 'Μαργαρίτα', 'finished', 'Πίτσες', 'τεμ', 8.00, true, true) returning id into marg;
  insert into public.item (company_id, code, name, item_type, unit, sale_price, make_to_order, online, is_extra) values
    (c, 'ΕΧ-001', 'Extra μοτσαρέλα', 'finished', 'τεμ', 1.00, true, true, true) returning id into xmozz;
  insert into public.item (company_id, code, name, item_type, category, unit, sale_price, online) values
    (c, 'ΠΡ-010', 'Κατεψυγμένη', 'finished', 'Χονδρική', 'τεμ', 4.50, true) returning id into frozen;
  insert into public.item (company_id, code, name, item_type, category, unit, sale_price, vat_rate, online) values
    (c, 'ΠΡ-020', 'Αναψυκτικό', 'finished', 'Ποτά', 'τεμ', 1.61, 24, true) returning id into cola;
  insert into public.bom (company_id, item_id, output_qty) values (c, dough, 10) returning id into b;
  insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values (c, b, 1, flour, 2.5);
  insert into public.bom (company_id, item_id, output_qty) values (c, marg, 1) returning id into b;
  insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values (c, b, 1, dough, 1), (c, b, 2, mozz, 0.12), (c, b, 3, box, 1);
  insert into public.bom (company_id, item_id, output_qty) values (c, xmozz, 1) returning id into b;
  insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values (c, b, 1, mozz, 0.05);

  insert into public.partner (company_id, code, name, is_supplier) values (c, 'ΠΡ-1', 'Μύλος', true) returning id into sup;
  insert into public.partner (company_id, code, name, is_customer, vat_no, tax_office, address, city, postal_code) values
    (c, 'ΠΕ-1', 'Ξενοδοχείο Κνωσός ΑΕ', true, '094014201', 'Α΄ Ηρακλείου', 'Λεωφ. Κνωσού 10', 'Ηράκλειο', '71409') returning id into hotel;
  insert into public.partner (company_id, code, name, is_customer) values (c, 'ΠΕ-2', 'Ταβέρνα χωρίς ΑΦΜ', true) returning id into hotel2;
  insert into public.partner_price (company_id, partner_id, item_id, price) values (c, hotel, frozen, 4.00);

  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', today - 3, sup) returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price) values
    (d, 1, flour, 50, 0.6), (d, 2, mozz, 10, 7), (d, 3, box, 200, 0.2), (d, 4, frozen, 100, 2), (d, 5, cola, 48, 0.6);
  perform public.post_document(d);

  insert into public.online_shop (company_id, slug, title, phone, delivery_fee, min_order)
  values (c, 'pay-pizza', 'Πιτσαρία Πληρωμές', '2810000001', 2.00, 5);
  perform public.shop_set_open(c, true);

  perform pg_temp.as_user(stranger);
  c2 := public.create_company('Ξένη Πληρωμές', null);
  perform pg_temp.as_user(me);

  -- -------------------------------------------------------------------
  -- 1. Δικαιώματα
  -- -------------------------------------------------------------------
  if has_function_privilege('anon', 'public.payment_confirm(text,text,text,numeric,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.payment_confirm(text,text,text,numeric,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.service_secrets(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.fiscal_begin(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.fiscal_done(uuid,boolean,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.payment_start(uuid,text,text,numeric)', 'execute')
     or has_function_privilege('anon', 'public.secret_set(uuid,text,text)', 'execute')
     or has_function_privilege('anon', 'public.fiscal_prepare(text,uuid,uuid,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._is_service()', 'execute') then
    raise exception 'ΑΠΟΤΥΧΙΑ: δικαιώματα functions';
  end if;
  if not (has_function_privilege('service_role', 'public.payment_confirm(text,text,text,numeric,jsonb)', 'execute')
      and has_function_privilege('service_role', 'public.fiscal_begin(uuid)', 'execute')
      and has_function_privilege('anon', 'public.fiscal_public(uuid)', 'execute')
      and has_function_privilege('anon', 'public.b2b_order_place(uuid,jsonb)', 'execute')) then
    raise exception 'ΑΠΟΤΥΧΙΑ: δικαιώματα server / επισκέπτη';
  end if;
  if has_table_privilege('authenticated', 'public.integration_secret', 'select')
     or has_table_privilege('anon', 'public.integration_secret', 'select')
     or has_table_privilege('anon', 'public.online_payment', 'select')
     or has_table_privilege('anon', 'public.fiscal_doc', 'select')
     or has_table_privilege('authenticated', 'public.fiscal_doc', 'insert')
     or has_table_privilege('authenticated', 'public.fiscal_doc', 'update')
     or has_table_privilege('authenticated', 'public.online_payment', 'update')
     or has_table_privilege('authenticated', 'public.fiscal_counter', 'update') then
    raise exception 'ΑΠΟΤΥΧΙΑ: δικαιώματα πινάκων';
  end if;
  raise notice 'OK δικαιώματα';

  -- -------------------------------------------------------------------
  -- 2. Κλειδιά: ο owner γράφει, κανείς δεν διαβάζει εκτός από τον server
  -- -------------------------------------------------------------------
  perform public.secret_set(c, 'viva_client_id', '  abc-123  ');
  perform public.secret_set(c, 'stripe_secret_key', 'sk_test_x');
  perform public.secret_set(c, 'stripe_secret_key', '');
  if (select array_agg(name order by name) from public.secret_names(c)) <> array['viva_client_id'] then
    raise exception 'ΑΠΟΤΥΧΙΑ: ονόματα κλειδιών';
  end if;
  perform pg_temp.expect_fail('select * from public.integration_secret', '%permission denied%', 'ανάγνωση κλειδιών από χρήστη');
  perform pg_temp.expect_fail(format('select public.service_secrets(%L)', c), '%permission denied%', 'service_secrets από χρήστη');
  perform pg_temp.expect_fail(format('select public.secret_set(%L, %L, %L)', c, 'Bad Name', 'x'), '%όνομα κλειδιού%', 'κακό όνομα κλειδιού');
  perform pg_temp.as_user(staff);
  perform pg_temp.expect_fail(format('select public.secret_set(%L, %L, %L)', c, 'viva_api_key', 'x'), '%ιδιοκτήτης%', 'κλειδί από προσωπικό');
  if (select count(*) from public.secret_names(c)) <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: το προσωπικό βλέπει ονόματα'; end if;
  perform pg_temp.as_user(stranger);
  if (select count(*) from public.secret_names(c)) <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: ο ξένος βλέπει ονόματα κλειδιών'; end if;
  perform pg_temp.as_service();
  if public.service_secrets(c)->>'viva_client_id' <> 'abc-123' then raise exception 'ΑΠΟΤΥΧΙΑ: ο server δεν διαβάζει το κλειδί'; end if;
  perform pg_temp.as_user(me);
  raise notice 'OK κλειδιά';

  -- -------------------------------------------------------------------
  -- 3. Extras
  -- -------------------------------------------------------------------
  perform pg_temp.as_anon();
  m := public.shop_menu('pay-pizza');
  if jsonb_array_length(m->'extras') <> 1 or m->'extras'->0->>'name' <> 'Extra μοτσαρέλα'
     or (m->'extras'->0->>'price')::numeric <> 1.13
     or exists (select 1 from jsonb_array_elements(m->'items') x where x->>'name' = 'Extra μοτσαρέλα')
     or (select (x->>'extras_ok')::boolean from jsonb_array_elements(m->'items') x where x->>'name' = 'Μαργαρίτα') is not true
     or (select (x->>'extras_ok')::boolean from jsonb_array_elements(m->'items') x where x->>'name' = 'Αναψυκτικό') is not false
     or (m->>'pay_online')::boolean or not (m->>'pay_cash')::boolean then
    raise exception 'ΑΠΟΤΥΧΙΑ: μενού με extras: %', m;
  end if;
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pay-pizza',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', cola, 'qty', 5, 'extras', jsonb_build_array(xmozz))))),
    '%δεν παίρνει extra%', 'extra σε αναψυκτικό');
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pay-pizza',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1, 'extras', jsonb_build_array(cola))))),
    '%extra δεν είναι πια διαθέσιμο%', 'κανονικό είδος ως extra');
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pay-pizza',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', xmozz, 'qty', 1)))),
    '%«Extra μοτσαρέλα»%', 'extra μόνο του');
  r := public.place_order('pay-pizza', pg_temp.ord(jsonb_build_array(
         jsonb_build_object('item_id', marg, 'qty', 2, 'extras', jsonb_build_array(xmozz, xmozz)),
         jsonb_build_object('item_id', marg, 'qty', 1))));
  perform pg_temp.as_user(me);
  o1 := (r->>'order_id')::uuid;
  if (select count(*) from public.online_order_line where order_id = o1) <> 3
     or (select parent_line from public.online_order_line where order_id = o1 and item_id = xmozz) <> 1
     or (select qty from public.online_order_line where order_id = o1 and item_id = xmozz) <> 2
     or (select items_total from public.online_order where id = o1) <> 9.04 * 3 + 1.13 * 2
     or (select total from public.online_order where id = o1) <> 9.04 * 3 + 1.13 * 2 + 2 then
    raise exception 'ΑΠΟΤΥΧΙΑ: παραγγελία με extras';
  end if;
  raise notice 'OK extras';

  -- -------------------------------------------------------------------
  -- 4. Αποδοχή: extras κινούν τη συνταγή τους, μεταφορικά χωρίς αποθήκη
  -- -------------------------------------------------------------------
  v := public.item_on_hand(mozz);
  r := public.order_accept(o1, 20);
  d := (r->>'doc_id')::uuid;
  if r->>'stock_note' is not null then raise exception 'ΑΠΟΤΥΧΙΑ: αποδοχή: %', r; end if;
  select id into svc from public.item where company_id = c and is_service;
  if svc is null or (select code from public.item where id = svc) <> 'ΥΠ-ΜΕΤ' or (select vat_rate from public.item where id = svc) <> 24
     or (select delivery_item_id from public.online_shop where company_id = c) <> svc then
    raise exception 'ΑΠΟΤΥΧΙΑ: είδος μεταφορικών';
  end if;
  if (select qty from public.doc_line where doc_id = d and item_id = marg) <> 3
     or (select qty from public.doc_line where doc_id = d and item_id = xmozz) <> 2
     or (select gross from public.doc_line where doc_id = d and item_id = svc) <> 2.00
     or exists (select 1 from public.stock_move where doc_id = d and item_id = svc)
     or (select total_cost from public.doc_line where doc_id = d and item_id = svc) <> 0
     or abs((select total_gross from public.doc where id = d) - (select total from public.online_order where id = o1)) > 0.02 then
    raise exception 'ΑΠΟΤΥΧΙΑ: γραμμές πώλησης με extras και μεταφορικά';
  end if;
  -- 3 μαργαρίτες × 0,12 + 2 extra × 0,05 = 0,46 kg μοτσαρέλα
  if round(v - public.item_on_hand(mozz), 4) <> 0.46 then
    raise exception 'ΑΠΟΤΥΧΙΑ: μοτσαρέλα από extras: %', v - public.item_on_hand(mozz);
  end if;
  -- ακύρωση: όλα πίσω, και η υπηρεσία
  r := public.order_cancel(o1, null);
  if (r->>'refund')::boolean or exists (select 1 from public.doc where id = d) or round(public.item_on_hand(mozz), 4) <> round(v, 4) then
    raise exception 'ΑΠΟΤΥΧΙΑ: ακύρωση με extras/μεταφορικά: %', r;
  end if;
  perform pg_temp.expect_fail(format('update public.item set make_to_order = true where id = %L', svc), '%item_service_check%', 'υπηρεσία κατά παραγγελία');
  raise notice 'OK αποδοχή με extras και μεταφορικά (υπηρεσία χωρίς αποθήκη)';

  -- -------------------------------------------------------------------
  -- 5. CAPTCHA: με κλειδί, μόνο μέσω server
  -- -------------------------------------------------------------------
  update public.online_shop set captcha_site_key = '0x4AAAAAAAtestkey' where company_id = c;
  perform pg_temp.as_anon();
  if public.shop_menu('pay-pizza')->>'captcha_site_key' <> '0x4AAAAAAAtestkey' then raise exception 'ΑΠΟΤΥΧΙΑ: κλειδί CAPTCHA στο μενού'; end if;
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pay-pizza',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)))), '%δεν είμαι ρομπότ%', 'χωρίς CAPTCHA');
  perform pg_temp.as_service();
  r := public.place_order('pay-pizza', pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)), '{"phone": "6942222222"}'));
  if (r->>'order_no') is null then raise exception 'ΑΠΟΤΥΧΙΑ: παραγγελία μέσω server με CAPTCHA'; end if;
  perform pg_temp.as_user(me);
  update public.online_shop set captcha_site_key = null where company_id = c;
  raise notice 'OK CAPTCHA';

  -- -------------------------------------------------------------------
  -- 6. Online πληρωμή
  -- -------------------------------------------------------------------
  perform pg_temp.expect_fail(format('update public.online_shop set pay_cash = false, pay_card_door = false where company_id = %L', c),
    '%online_shop_pay_check%', 'κανένας τρόπος πληρωμής');
  perform pg_temp.as_service();
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pay-pizza',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)), '{"payment": "online"}')),
    '%δεν δέχεται online πληρωμή%', 'online χωρίς πάροχο');
  perform pg_temp.as_user(me);
  update public.online_shop set pay_provider = 'test', pay_card_door = false where company_id = c;
  perform pg_temp.as_anon();
  if not (public.shop_menu('pay-pizza')->>'pay_online')::boolean or not (public.shop_menu('pay-pizza')->>'pay_test')::boolean then
    raise exception 'ΑΠΟΤΥΧΙΑ: online στο μενού';
  end if;
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pay-pizza',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)), '{"payment": "online"}')),
    '%μόνο από τη σελίδα%', 'online χωρίς server');
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pay-pizza',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)), '{"payment": "card"}')),
    '%κάρτα στην παράδοση%', 'κάρτα στην πόρτα κλειστή');

  perform pg_temp.as_service();
  r := public.place_order('pay-pizza', pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 2)),
         '{"payment": "online", "phone": "6943333333"}'));
  o2 := (r->>'order_id')::uuid; tok := (r->>'token')::uuid;
  if (r->>'total')::numeric <> 20.08 then raise exception 'ΑΠΟΤΥΧΙΑ: σύνολο για την πληρωμή: %', r; end if;
  perform pg_temp.as_user(me);
  if (select status from public.online_order where id = o2) <> 'awaiting_payment' or (select pay_status from public.online_order where id = o2) <> 'pending' then
    raise exception 'ΑΠΟΤΥΧΙΑ: αναμονή πληρωμής';
  end if;
  perform pg_temp.expect_fail(format('select public.order_accept(%L)', o2), '%Η παραγγελία #%', 'αποδοχή πριν από την πληρωμή');

  perform pg_temp.as_service();
  perform pg_temp.expect_fail(format('select public.payment_start(%L, %L, %L, 19)', o2, 'test', 'T-1'), '%Λάθος ποσό%', 'έναρξη με λάθος ποσό');
  p1 := public.payment_start(o2, 'test', 'T-1', 20.08);
  if (public.payment_lookup('test', 'T-1')->>'token')::uuid <> tok or public.payment_lookup('test', 'T-1')->>'slug' <> 'pay-pizza' then
    raise exception 'ΑΠΟΤΥΧΙΑ: εύρεση πληρωμής';
  end if;
  r := public.payment_confirm('test', 'T-1', 'TX-1', 19.00, null);
  if (r->>'ok')::boolean or r->>'reason' <> 'amount' then raise exception 'ΑΠΟΤΥΧΙΑ: λάθος ποσό από τον πάροχο: %', r; end if;
  if (public.payment_confirm('test', 'NOPE', 'TX', 1, null)->>'reason') <> 'unknown' then raise exception 'ΑΠΟΤΥΧΙΑ: άγνωστη πληρωμή'; end if;
  -- νέα προσπάθεια, πετυχαίνει
  p2 := public.payment_start(o2, 'test', 'T-2', 20.08);
  r := public.payment_confirm('test', 'T-2', 'TX-2', 20.08, '{"x":1}');
  if not (r->>'ok')::boolean or (r->>'refund')::boolean or (r->>'token')::uuid <> tok then raise exception 'ΑΠΟΤΥΧΙΑ: επιβεβαίωση: %', r; end if;
  r := public.payment_confirm('test', 'T-2', 'TX-2', 20.08, null);
  if not (r->>'already')::boolean then raise exception 'ΑΠΟΤΥΧΙΑ: δεύτερη επιβεβαίωση: %', r; end if;
  perform pg_temp.as_user(me);
  if (select status from public.online_order where id = o2) <> 'new' or (select pay_status from public.online_order where id = o2) <> 'paid'
     or (select paid_at from public.online_order where id = o2) is null
     or (select status from public.online_payment where id = p2) <> 'paid' or (select transaction_id from public.online_payment where id = p2) <> 'TX-2' then
    raise exception 'ΑΠΟΤΥΧΙΑ: μετά την πληρωμή';
  end if;
  perform pg_temp.as_anon();
  if public.order_status(tok)->>'pay_status' <> 'paid' or not (public.order_status(tok)->>'pay_test')::boolean then
    raise exception 'ΑΠΟΤΥΧΙΑ: ο πελάτης δεν βλέπει την πληρωμή';
  end if;
  perform pg_temp.as_user(staff);
  perform pg_temp.expect_fail('select * from public.integration_secret', '%permission denied%', 'κλειδιά από προσωπικό');
  -- απόρριψη πληρωμένης: επιστροφή
  r := public.order_reject(o2, 'Τελείωσε η μοτσαρέλα');
  if not (r->>'refund')::boolean or (select pay_status from public.online_order where id = o2) <> 'refund_pending' then
    raise exception 'ΑΠΟΤΥΧΙΑ: απόρριψη πληρωμένης: %', r;
  end if;
  if not public.order_refund_request(o2) then raise exception 'ΑΠΟΤΥΧΙΑ: περιμένει επιστροφή'; end if;
  perform pg_temp.as_service();
  select * into rec from public.refunds_due(o2);
  if rec.payment_id <> p2 or rec.transaction_id <> 'TX-2' or rec.amount <> 20.08 then raise exception 'ΑΠΟΤΥΧΙΑ: επιστροφές που περιμένουν'; end if;
  perform public.payment_refunded(p2, false, 'Δεν έχει δικαίωμα επιστροφής το κλειδί', null);
  perform pg_temp.as_user(me);
  if (select pay_status from public.online_order where id = o2) <> 'refund_failed' then raise exception 'ΑΠΟΤΥΧΙΑ: αποτυχία επιστροφής'; end if;
  if not public.order_refund_request(o2) then raise exception 'ΑΠΟΤΥΧΙΑ: ξανά επιστροφή'; end if;
  if (select pay_status from public.online_order where id = o2) <> 'refund_pending' then
    raise exception 'ΑΠΟΤΥΧΙΑ: ξανά επιστροφή (κατάσταση)';
  end if;
  perform pg_temp.as_service();
  perform public.payment_refunded(p2, true, null, null);
  perform pg_temp.as_user(me);
  if (select pay_status from public.online_order where id = o2) <> 'refunded' or (select refunded_at from public.online_payment where id = p2) is null then
    raise exception 'ΑΠΟΤΥΧΙΑ: επιστροφή';
  end if;
  raise notice 'OK online πληρωμή: αναμονή, λάθος ποσό, επιβεβαίωση, απόρριψη → επιστροφή';

  -- πληρωμή που φτάνει μετά την απόρριψη, διπλή πληρωμή, αποτυχία, εγκατάλειψη
  perform pg_temp.as_service();
  r := public.place_order('pay-pizza', pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)),
         '{"payment": "online", "phone": "6944444444"}'));
  o3 := (r->>'order_id')::uuid;
  perform public.payment_start(o3, 'test', 'T-3', 11.04);
  r := public.payment_failed('test', 'T-3', 'Απορρίφθηκε από την τράπεζα', null);
  perform pg_temp.as_user(me);
  if (select pay_status from public.online_order where id = o3) <> 'failed' or (select status from public.online_order where id = o3) <> 'awaiting_payment' then
    raise exception 'ΑΠΟΤΥΧΙΑ: αποτυχία πληρωμής';
  end if;
  perform pg_temp.as_service();
  perform public.payment_start(o3, 'test', 'T-4', 11.04);
  perform public.payment_start(o3, 'test', 'T-5', 11.04);
  r := public.payment_confirm('test', 'T-4', 'TX-4', 11.04, null);
  r := public.payment_confirm('test', 'T-5', 'TX-5', 11.04, null);
  if not (r->>'refund')::boolean then raise exception 'ΑΠΟΤΥΧΙΑ: διπλή πληρωμή: %', r; end if;
  perform pg_temp.as_user(me);
  if (select pay_status from public.online_order where id = o3) <> 'paid' or (select status from public.online_order where id = o3) <> 'new'
     or (select status from public.online_payment where provider_ref = 'T-5') <> 'refund_pending' then
    raise exception 'ΑΠΟΤΥΧΙΑ: κατάσταση μετά τη διπλή πληρωμή';
  end if;
  perform pg_temp.as_service();
  perform public.payment_refunded((select id from public.online_payment where provider_ref = 'T-5'), true, null, null);
  perform pg_temp.as_user(me);
  if (select pay_status from public.online_order where id = o3) <> 'paid' then raise exception 'ΑΠΟΤΥΧΙΑ: η καλή πληρωμή μένει'; end if;

  perform pg_temp.as_service();
  r := public.place_order('pay-pizza', pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)),
         '{"payment": "online", "phone": "6945555555"}'));
  o4 := (r->>'order_id')::uuid;
  perform public.payment_abort(o4, 'Ο πάροχος δεν απάντησε');
  perform pg_temp.as_user(me);
  if (select status from public.online_order where id = o4) <> 'expired' then raise exception 'ΑΠΟΤΥΧΙΑ: εγκατάλειψη'; end if;
  -- ξεχασμένη πληρωμή πάνω από 3 ώρες: λήγει στην επόμενη παραγγελία
  perform pg_temp.as_service();
  r := public.place_order('pay-pizza', pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)),
         '{"payment": "online", "phone": "6946666666"}'));
  update public.online_order set created_at = now() - interval '4 hours' where id = (r->>'order_id')::uuid;
  r := public.place_order('pay-pizza', pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)), '{"phone": "6947777777"}'));
  perform pg_temp.as_user(me);
  if (select count(*) from public.online_order where company_id = c and phone = '6946666666' and status = 'expired') <> 1 then
    raise exception 'ΑΠΟΤΥΧΙΑ: λήξη ξεχασμένης πληρωμής';
  end if;
  raise notice 'OK πληρωμές: αποτυχία, διπλή, εγκατάλειψη, λήξη';

  -- -------------------------------------------------------------------
  -- 7. Παραστατικά
  -- -------------------------------------------------------------------
  insert into public.doc (company_id, doc_type, doc_date, partner_id, channel) values (c, 'sale', today, hotel, 'wholesale') returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (d, 1, frozen, 40, 4.00, 13), (d, 2, cola, 10, 1.30, 24);
  perform pg_temp.expect_fail(format('select public.fiscal_prepare(%L, %L)', 'invoice', d), '%καταχωρημένη πώληση%', 'τιμολόγιο από πρόχειρη');
  perform public.post_document(d);
  perform pg_temp.expect_fail(format('select public.fiscal_prepare(%L, %L)', 'invoice', d), '%Δεν έχει ρυθμιστεί πάροχος%', 'χωρίς πάροχο');
  insert into public.fiscal_settings (company_id, provider, issuer_activity, issuer_tax_office, issuer_city, issuer_postal_code)
  values (c, 'test', 'Παρασκευή πίτσας', 'Α΄ Ηρακλείου', 'Ηράκλειο', '71201');
  f1 := public.fiscal_prepare('invoice', d);
  if public.fiscal_prepare('invoice', d) <> f1 then raise exception 'ΑΠΟΤΥΧΙΑ: δεύτερο πρόχειρο τιμολόγιο'; end if;
  select * into rec from public.fiscal_doc where id = f1;
  if rec.mydata_type <> '1.1' or rec.series <> 'ΤΠ' or rec.number is not null or rec.payment_method <> 'credit'
     or rec.customer->>'vat_no' <> '094014201' or rec.customer->>'tax_office' <> 'Α΄ Ηρακλείου'
     or rec.total_net <> 173.00 or rec.total_vat <> 23.92 or rec.total_gross <> 196.92
     or jsonb_array_length(rec.lines) <> 2 or jsonb_array_length(rec.vat_breakdown) <> 2 then
    raise exception 'ΑΠΟΤΥΧΙΑ: πρόχειρο τιμολόγιο: %', to_jsonb(rec);
  end if;
  perform pg_temp.expect_fail(format('select public.fiscal_prepare(%L, %L)', 'receipt', d), '%υπάρχει ήδη τιμολόγιο (σε εξέλιξη)%', 'απόδειξη πάνω σε τιμολόγιο');
  -- πελάτης χωρίς ΑΦΜ
  insert into public.doc (company_id, doc_type, doc_date, partner_id, channel) values (c, 'sale', today, hotel2, 'wholesale') returning id into d2;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (d2, 1, frozen, 5, 4.50, 13);
  perform public.post_document(d2);
  perform pg_temp.expect_fail(format('select public.fiscal_prepare(%L, %L)', 'invoice', d2), '%σωστό ΑΦΜ%', 'τιμολόγιο χωρίς ΑΦΜ');
  -- ο ξένος
  perform pg_temp.as_user(stranger);
  perform pg_temp.expect_fail(format('select public.fiscal_prepare(%L, %L)', 'invoice', d), '%Δεν βρέθηκε%', 'ξένος φτιάχνει τιμολόγιο');
  perform pg_temp.expect_fail(format('select public.fiscal_check(%L)', f1), '%Δεν βρέθηκε%', 'ξένος ελέγχει παραστατικό');
  -- έκδοση (server)
  perform pg_temp.as_service();
  r := public.fiscal_begin(f1);
  if (r->'doc'->>'number')::int <> 1 or r->'doc'->>'status' <> 'sending' or r->'issuer'->>'vat_no' <> '094014201'
     or r->'issuer'->>'activity' <> 'Παρασκευή πίτσας' or r->'settings'->>'provider' <> 'test' then
    raise exception 'ΑΠΟΤΥΧΙΑ: έναρξη έκδοσης: %', r;
  end if;
  perform pg_temp.expect_fail(format('select public.fiscal_begin(%L)', f1), '%εκδίδεται ήδη%', 'διπλή έκδοση');
  perform public.fiscal_done(f1, true, '{"mark": "400001234567890", "uid": "ABC", "qr_url": "https://example.test/qr"}');
  perform pg_temp.as_user(me);
  if (select status from public.fiscal_doc where id = f1) <> 'issued' or (select mark from public.fiscal_doc where id = f1) <> '400001234567890' then
    raise exception 'ΑΠΟΤΥΧΙΑ: εκδομένο τιμολόγιο';
  end if;
  perform pg_temp.expect_fail(format('select public.fiscal_prepare(%L, %L)', 'invoice', d), '%υπάρχει ήδη τιμολόγιο ΤΠ-1%', 'δεύτερο τιμολόγιο');
  perform pg_temp.expect_fail(format('select public.fiscal_discard(%L)', f1), '%πιστωτικό%', 'σβήσιμο εκδομένου');
  -- πιστωτικό → μετά ξανά τιμολόγιο για την ίδια πώληση
  f2 := public.fiscal_prepare('credit_invoice', null, null, f1);
  if (select mydata_type from public.fiscal_doc where id = f2) <> '5.1' or (select series from public.fiscal_doc where id = f2) <> 'ΠΤ'
     or (select total_gross from public.fiscal_doc where id = f2) <> 196.92 or (select related_id from public.fiscal_doc where id = f2) <> f1 then
    raise exception 'ΑΠΟΤΥΧΙΑ: πιστωτικό';
  end if;
  perform pg_temp.expect_fail(format('select public.fiscal_prepare(%L, null, null, %L)', 'credit_receipt', f1), '%μόνο για εκδομένο απόδειξη%', 'πιστωτικό λιανικής σε τιμολόγιο');
  perform pg_temp.as_service();
  r := public.fiscal_begin(f2);
  if (r->'related'->>'mark') <> '400001234567890' or (r->'doc'->>'number')::int <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: πιστωτικό: σχετικό: %', r; end if;
  perform public.fiscal_done(f2, true, '{"mark": "400001234567891"}');
  perform pg_temp.as_user(me);
  perform pg_temp.expect_fail(format('select public.fiscal_prepare(%L, null, null, %L)', 'credit_invoice', f1), '%ήδη πιστωτικό%', 'δεύτερο πιστωτικό');
  f3 := public.fiscal_prepare('invoice', d);
  if f3 = f1 then raise exception 'ΑΠΟΤΥΧΙΑ: νέο τιμολόγιο μετά το πιστωτικό'; end if;
  -- σφάλμα του παρόχου: ο αριθμός μένει για τη νέα προσπάθεια
  perform pg_temp.as_service();
  r := public.fiscal_begin(f3);
  perform public.fiscal_done(f3, false, '{"error": "Ο πάροχος δεν απάντησε"}');
  update public.fiscal_doc set updated_at = now() - interval '5 minutes' where id = f3;
  r := public.fiscal_begin(f3);
  if (r->'doc'->>'number')::int <> 2 then raise exception 'ΑΠΟΤΥΧΙΑ: ίδιος αριθμός μετά από σφάλμα: %', r; end if;
  perform public.fiscal_done(f3, false, '{"error": "πάλι"}');
  perform pg_temp.as_user(me);
  if (select error from public.fiscal_doc where id = f3) <> 'πάλι' then raise exception 'ΑΠΟΤΥΧΙΑ: σφάλμα παρόχου'; end if;
  -- σβήσιμο με αριθμό: μόνο ο τελευταίος της σειράς, και ο μετρητής γυρίζει
  perform public.fiscal_discard(f3);
  if (select last_no from public.fiscal_counter where company_id = c and series = 'ΤΠ') <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: μετρητής μετά το σβήσιμο'; end if;
  raise notice 'OK τιμολόγιο, πιστωτικό, αρίθμηση χωρίς κενά';

  -- απόδειξη online παραγγελίας (πληρωμένη, με μεταφορικά)
  r := public.order_accept(o3, 15);
  f4 := public.fiscal_prepare('receipt', null, o3);
  select * into rec from public.fiscal_doc where id = f4;
  if rec.mydata_type <> '11.1' or rec.payment_method <> 'online' or rec.customer is not null or rec.series <> 'ΑΛΠ'
     or rec.online_order_id <> o3 or not exists (select 1 from jsonb_array_elements(rec.lines) x where (x->>'is_service')::boolean)
     or abs(rec.total_gross - (select total from public.online_order where id = o3)) > 0.02 then
    raise exception 'ΑΠΟΤΥΧΙΑ: απόδειξη online παραγγελίας: %', to_jsonb(rec);
  end if;
  perform pg_temp.as_service();
  r := public.fiscal_begin(f4);
  perform public.fiscal_done(f4, true, '{"mark": "400001234567892", "qr_url": "https://example.test/r"}');
  perform pg_temp.as_user(me);
  tok := (select token from public.online_order where id = o3);
  perform pg_temp.as_anon();
  tok2 := (public.order_status(tok)->>'receipt')::uuid;
  m := public.fiscal_public(tok2);
  if m is null or m->>'kind' <> 'receipt' or m->>'mark' <> '400001234567892' or not (m->>'test')::boolean
     or m->'issuer'->>'name' <> 'Πιτσαρία Πληρωμές' or (m->>'number')::int <> 1 then
    raise exception 'ΑΠΟΤΥΧΙΑ: δημόσια απόδειξη: %', m;
  end if;
  if public.fiscal_public(gen_random_uuid()) is not null then raise exception 'ΑΠΟΤΥΧΙΑ: δημόσιο με άγνωστο token'; end if;
  perform pg_temp.as_user(me);
  if public.fiscal_public((select public_token from public.fiscal_doc where id = f2)) is null then raise exception 'ΑΠΟΤΥΧΙΑ: δημόσιο πιστωτικό'; end if;
  raise notice 'OK απόδειξη online παραγγελίας και δημόσιος σύνδεσμος';

  -- συνέχεια: με το χέρι (από την ταμειακή)
  update public.fiscal_settings set provider = 'manual' where company_id = c;
end $$;

do $$
declare
  me     constant uuid := '88888888-8888-8888-8888-888888888881';
  staff  constant uuid := '88888888-8888-8888-8888-888888888882';
  c uuid; d uuid; f uuid; hotel uuid; frozen uuid; tok uuid; tok_old uuid; pz uuid; drink uuid;
  r jsonb; m jsonb; n int;
begin
  perform pg_temp.as_user(me);
  select id into c from public.company where name = 'Πιτσαρία Πληρωμές';
  select id into hotel from public.partner where company_id = c and code = 'ΠΕ-1';
  select id into frozen from public.item where company_id = c and code = 'ΠΡ-010';
  select id into pz from public.item where company_id = c and code = 'ΠΡ-001';
  select id into drink from public.item where company_id = c and code = 'ΠΡ-020';
  if (select provider from public.fiscal_settings where company_id = c) <> 'manual' then
    raise exception 'ΑΠΟΤΥΧΙΑ: το προηγούμενο σενάριο δεν έφτασε ως το τέλος';
  end if;

  -- απόδειξη με το χέρι: αριθμός από την ταμειακή
  insert into public.doc (company_id, doc_type, channel) values (c, 'sale', 'store') returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (d, 1, frozen, 2, 4.50, 13);
  perform public.post_document(d);
  f := public.fiscal_prepare('receipt', d);
  perform pg_temp.as_service();
  perform pg_temp.expect_fail(format('select public.fiscal_begin(%L)', f), '%με το χέρι%', 'έκδοση από server για το χέρι');
  perform pg_temp.as_user(staff);
  perform pg_temp.expect_fail(format('select public.fiscal_record_manual(%L, 0)', f), '%αριθμό%', 'χωρίς αριθμό');
  perform pg_temp.expect_fail(format('select public.fiscal_record_manual(%L, 345, %L)', f, 'abc'), '%ΜΑΡΚ%', 'κακό ΜΑΡΚ');
  perform public.fiscal_record_manual(f, 345, '400009999999999', 'Α');
  if (select status from public.fiscal_doc where id = f) <> 'issued' or (select series || '-' || number from public.fiscal_doc where id = f) <> 'Α-345' then
    raise exception 'ΑΠΟΤΥΧΙΑ: απόδειξη με το χέρι';
  end if;
  perform pg_temp.expect_fail(format('select public.fiscal_record_manual(%L, 346)', f), '%ήδη αριθμό%', 'δεύτερη φορά με το χέρι');
  -- το προσωπικό δεν αλλάζει ρυθμίσεις παραστατικών
  update public.fiscal_settings set provider = 'test' where company_id = c;
  if (select provider from public.fiscal_settings where company_id = c) <> 'manual' then raise exception 'ΑΠΟΤΥΧΙΑ: το προσωπικό άλλαξε πάροχο'; end if;
  raise notice 'OK παραστατικά με το χέρι, ρυθμίσεις μόνο από τον owner';

  -- -------------------------------------------------------------------
  -- 8. Παραγγελίες ξενοδοχείων από σύνδεσμο
  -- -------------------------------------------------------------------
  perform pg_temp.as_user(me);
  perform pg_temp.expect_fail(format('select public.partner_order_link(%L)', (select id from public.partner where company_id = c and code = 'ΠΡ-1')),
    '%μόνο οι πελάτες%', 'σύνδεσμος σε προμηθευτή');
  tok := public.partner_order_link(hotel);
  if public.partner_order_link(hotel) <> tok then raise exception 'ΑΠΟΤΥΧΙΑ: ίδιος σύνδεσμος'; end if;
  perform pg_temp.as_anon();
  m := public.b2b_menu(tok);
  if m->>'partner' <> 'Ξενοδοχείο Κνωσός ΑΕ'
     or (select (x->>'price')::numeric from jsonb_array_elements(m->'items') x where x->>'name' = 'Κατεψυγμένη') <> 4.00
     or (select (x->>'last_qty')::numeric from jsonb_array_elements(m->'items') x where x->>'name' = 'Κατεψυγμένη') <> 40
     or exists (select 1 from jsonb_array_elements(m->'items') x where x->>'name' in ('Μαργαρίτα', 'Extra μοτσαρέλα', 'Μεταφορικά')) then
    raise exception 'ΑΠΟΤΥΧΙΑ: κατάλογος ξενοδοχείου: %', m;
  end if;
  r := public.b2b_order_place(tok, jsonb_build_object('note', 'Πίσω πόρτα, πριν τις 10', 'wanted_date', to_char(current_date + 2, 'YYYY-MM-DD'),
         'lines', jsonb_build_array(jsonb_build_object('item_id', frozen, 'qty', 60),
                                    jsonb_build_object('item_id', drink, 'qty', 0))));
  if (r->>'lines')::int <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: παραγγελία ξενοδοχείου: %', r; end if;
  perform pg_temp.expect_fail(format('select public.b2b_order_place(%L, %L)', tok, jsonb_build_object('lines',
      jsonb_build_array(jsonb_build_object('item_id', pz, 'qty', 3)))),
    '%δεν είναι πια διαθέσιμο%', 'πίτσα κατά παραγγελία από ξενοδοχείο');
  perform pg_temp.expect_fail(format('select public.b2b_order_place(%L, %L)', tok, '{"lines": [], "note": "x"}'), '%1 έως 50%', 'άδεια παραγγελία ξενοδοχείου');
  perform pg_temp.as_user(staff);
  select x.doc_id into d from public.b2b_order x where x.partner_id = hotel order by x.created_at desc limit 1;
  if (select status from public.doc where id = d) <> 'draft' or (select channel from public.doc where id = d) <> 'wholesale'
     or (select partner_id from public.doc where id = d) <> hotel or (select doc_date from public.doc where id = d) <> current_date + 2
     or (select unit_price from public.doc_line where doc_id = d) <> 4.00 or (select qty from public.doc_line where doc_id = d) <> 60
     or (select doc_no from public.doc where id = d) <> (select last_no from public.doc_counter where company_id = c and doc_type = 'sale') then
    raise exception 'ΑΠΟΤΥΧΙΑ: πρόχειρη πώληση από ξενοδοχείο';
  end if;
  perform public.b2b_seen((select id from public.b2b_order where doc_id = d));
  -- το μαγαζί την καταχωρεί κανονικά
  perform public.post_document(d);
  -- νέος σύνδεσμος: ο παλιός σταματά· κλείσιμο
  tok_old := tok;
  perform pg_temp.as_user(me);
  tok := public.partner_order_link(hotel, 'rotate');
  perform pg_temp.as_anon();
  if public.b2b_menu(tok_old) is not null or public.b2b_menu(tok) is null then raise exception 'ΑΠΟΤΥΧΙΑ: νέος σύνδεσμος'; end if;
  perform pg_temp.expect_fail(format('select public.b2b_order_place(%L, %L)', tok_old, '{"lines": []}'), '%δεν ισχύει%', 'παλιός σύνδεσμος');
  for n in 1..4 loop
    perform public.b2b_order_place(tok, jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('item_id', frozen, 'qty', 1))));
  end loop;
  perform pg_temp.expect_fail(format('select public.b2b_order_place(%L, %L)', tok, jsonb_build_object('lines',
      jsonb_build_array(jsonb_build_object('item_id', frozen, 'qty', 1)))), '%Πολλές παραγγελίες%', 'όριο ξενοδοχείου');
  perform pg_temp.as_user(me);
  perform public.partner_order_link(hotel, 'off');
  if (select order_token from public.partner where id = hotel) is not null then raise exception 'ΑΠΟΤΥΧΙΑ: κλείσιμο συνδέσμου'; end if;
  raise notice 'OK παραγγελίες ξενοδοχείων από σύνδεσμο';

  raise notice 'ΟΛΑ ΟΚ (πληρωμές και παραστατικά)';
end $$;

reset role;
