-- Σενάριο δοκιμής 0005 (online παραγγελίες): το site του μαγαζιού,
-- δικαιώματα επισκέπτη (anon) και προσωπικού, μενού χωρίς κόστη, έλεγχοι
-- παραγγελίας (τιμές από τη βάση, τηλέφωνα, διανομή/παραλαβή, ελάχιστη,
-- όρια κατάχρησης), αρίθμηση ανά ημέρα, αποδοχή → πώληση 'site' με
-- backflush, αποδοχή χωρίς συνταγή, απόρριψη, «έφυγε», ακύρωση (και όταν
-- την κλειδώνει απογραφή), άλλη εταιρεία, μηνιαία σύνοψη.
\set ON_ERROR_STOP on
\pset format aligned

insert into auth.users (id, email) values
  ('55555555-5555-5555-5555-555555555555', 'orders@example.com'),
  ('66666666-6666-6666-6666-666666666666', 'staff@example.com'),
  ('77777777-7777-7777-7777-777777777777', 'stranger@example.com')
on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', false);

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

-- ως επισκέπτης / ως χρήστης (ίδια σύνδεση, άλλος ρόλος)
create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'set role anon';
end $$;
create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  execute 'set role authenticated';
  perform set_config('request.jwt.claim.sub', p::text, false);
end $$;

-- παραγγελία με τα βασικά, για να αλλάζει μόνο ό,τι δοκιμάζεται
create function pg_temp.ord(p_lines jsonb, p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object('name', 'Γιώργος', 'phone', '6941234567', 'mode', 'delivery',
                            'address', 'Ικάρου 12, Ηράκλειο', 'payment', 'cash', 'lines', p_lines) || p_extra;
$$;

do $$
declare
  me       constant uuid := '55555555-5555-5555-5555-555555555555';
  staff    constant uuid := '66666666-6666-6666-6666-666666666666';
  stranger constant uuid := '77777777-7777-7777-7777-777777777777';
  today    date := (now() at time zone 'Europe/Athens')::date;
  c uuid; c2 uuid;
  flour uuid; mozz uuid; box uuid; dough uuid; marg uuid; pep uuid; frozen uuid; hidden uuid; raw_online uuid; foreign_item uuid;
  b_dough uuid; b_marg uuid;
  d uuid; st uuid;
  o1 uuid; o2 uuid; o3 uuid; o4 uuid;
  r jsonb; m jsonb;
  tok uuid;
  v numeric; v2 numeric;
  n int;
  rec record;
begin
  -- -------------------------------------------------------------------
  -- Στήσιμο
  -- -------------------------------------------------------------------
  c := public.create_company('Πιτσαρία Site', '888888888');
  insert into public.company_member (company_id, user_id, role) values (c, staff, 'staff');

  insert into public.item (company_id, code, name, item_type, unit) values (c, 'ΠΥ-001', 'Αλεύρι', 'raw', 'kg') returning id into flour;
  insert into public.item (company_id, code, name, item_type, unit) values (c, 'ΠΥ-002', 'Μοτσαρέλα', 'raw', 'kg') returning id into mozz;
  insert into public.item (company_id, code, name, item_type, unit, vat_rate) values (c, 'ΠΥ-003', 'Κουτί', 'raw', 'τεμ', 24) returning id into box;
  insert into public.item (company_id, code, name, item_type, unit, make_to_order) values
    (c, 'ΗΜ-001', 'Ζυμάρι', 'semi', 'τεμ', true) returning id into dough;
  insert into public.item (company_id, code, name, item_type, category, unit, sale_price, vat_rate, make_to_order, online, description) values
    (c, 'ΠΡ-001', 'Μαργαρίτα', 'finished', 'Πίτσες', 'τεμ', 8.00, 13, true, true, 'Ντομάτα, μοτσαρέλα') returning id into marg;
  -- χωρίς συνταγή: η αποδοχή περνά, η πώληση μένει πρόχειρη
  insert into public.item (company_id, code, name, item_type, category, unit, sale_price, vat_rate, make_to_order, online) values
    (c, 'ΠΡ-002', 'Πεπερόνι', 'finished', 'Πίτσες', 'τεμ', 9.00, 13, true, true) returning id into pep;
  insert into public.item (company_id, code, name, item_type, category, unit, sale_price, vat_rate, online) values
    (c, 'ΠΡ-003', 'Κατεψυγμένη', 'finished', 'Για το σπίτι', 'τεμ', 4.50, 13, true) returning id into frozen;
  insert into public.item (company_id, code, name, item_type, unit, sale_price, make_to_order) values
    (c, 'ΠΡ-004', 'Μυστική', 'finished', 'τεμ', 12, true) returning id into hidden;          -- όχι στο site
  insert into public.item (company_id, code, name, item_type, unit, sale_price, online) values
    (c, 'ΠΥ-009', 'Αλεύρι για πώληση', 'raw', 'kg', 2, true) returning id into raw_online;   -- πρώτη ύλη: ποτέ στο site

  insert into public.bom (company_id, item_id, output_qty) values (c, dough, 10) returning id into b_dough;
  insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values (c, b_dough, 1, flour, 2.5);
  insert into public.bom (company_id, item_id, output_qty) values (c, marg, 1) returning id into b_marg;
  insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values
    (c, b_marg, 1, dough, 1), (c, b_marg, 2, mozz, 0.12), (c, b_marg, 3, box, 1);

  -- αγορά πρώτων υλών και 5 κατεψυγμένες σε απόθεμα (παραγωγή χωρίς συνταγή δεν γίνεται: αγορά)
  insert into public.partner (company_id, code, name, is_supplier) values (c, 'ΠΡ-1', 'Μύλος', true);
  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', today - 3, (select id from public.partner where company_id = c and code = 'ΠΡ-1'))
    returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price) values
    (d, 1, flour, 50, 0.6), (d, 2, mozz, 10, 7), (d, 3, box, 100, 0.2), (d, 4, frozen, 5, 2);
  perform public.post_document(d);

  -- άλλη εταιρεία
  perform pg_temp.as_user(stranger);
  c2 := public.create_company('Ξένη', null);
  insert into public.item (company_id, code, name, item_type, unit, sale_price, online) values
    (c2, 'X-1', 'Ξένη πίτσα', 'finished', 'τεμ', 7, true) returning id into foreign_item;
  perform pg_temp.as_user(me);

  -- -------------------------------------------------------------------
  -- 1. Κανάλι site, δικαιώματα
  -- -------------------------------------------------------------------
  insert into public.doc (company_id, doc_type, channel) values (c, 'sale', 'site') returning id into d;
  delete from public.doc where id = d;
  if not (has_function_privilege('anon', 'public.shop_menu(text)', 'execute')
      and has_function_privilege('anon', 'public.place_order(text,jsonb)', 'execute')
      and has_function_privilege('anon', 'public.order_status(uuid)', 'execute')) then
    raise exception 'ΑΠΟΤΥΧΙΑ: ο επισκέπτης δεν εκτελεί τις δημόσιες functions';
  end if;
  if has_function_privilege('anon', 'public.order_accept(uuid,integer)', 'execute')
     or has_function_privilege('anon', 'public.order_reject(uuid,text)', 'execute')
     or has_function_privilege('anon', 'public.order_done(uuid)', 'execute')
     or has_function_privilege('anon', 'public.order_cancel(uuid,text)', 'execute')
     or has_function_privilege('anon', 'public.shop_set_open(uuid,boolean)', 'execute')
     or has_function_privilege('authenticated', 'public._shop_open_until(time without time zone)', 'execute')
     or has_function_privilege('authenticated', 'public._order_state_text(text)', 'execute') then
    raise exception 'ΑΠΟΤΥΧΙΑ: ο επισκέπτης / χρήστης εκτελεί functions προσωπικού ή εσωτερικές';
  end if;
  if has_table_privilege('anon', 'public.online_order', 'select')
     or has_table_privilege('anon', 'public.online_order_line', 'select')
     or has_table_privilege('anon', 'public.online_shop', 'select')
     or has_table_privilege('authenticated', 'public.online_order', 'insert')
     or has_table_privilege('authenticated', 'public.online_order', 'update')
     or has_table_privilege('authenticated', 'public.online_order', 'delete')
     or has_table_privilege('authenticated', 'public.online_order_line', 'insert') then
    raise exception 'ΑΠΟΤΥΧΙΑ: δικαιώματα πινάκων παραγγελιών';
  end if;
  raise notice 'OK κανάλι site, δικαιώματα';

  -- -------------------------------------------------------------------
  -- 2. Το site του μαγαζιού
  -- -------------------------------------------------------------------
  perform pg_temp.expect_fail(format('insert into public.online_shop (company_id, slug, title) values (%L, %L, %L)', c, 'με κενά', 'Χ'),
    '%online_shop_slug_check%', 'slug με ελληνικά/κενά');
  perform pg_temp.expect_fail(format('insert into public.online_shop (company_id, slug, title) values (%L, %L, %L)', c, 'ab', 'Χ'),
    '%online_shop_slug_check%', 'slug πολύ μικρό');
  perform pg_temp.expect_fail(format('insert into public.online_shop (company_id, slug, title, delivery, pickup) values (%L, %L, %L, false, false)', c, 'pizza-site', 'Χ'),
    '%online_shop_mode_check%', 'ούτε διανομή ούτε παραλαβή');
  insert into public.online_shop (company_id, slug, title, phone, delivery_fee, min_order, compare_fee_pct)
  values (c, '  Pizza-Site ', ' Πιτσαρία   Site ', '2810 123456', 1.5, 8, 30);
  if (select slug from public.online_shop where company_id = c) <> 'pizza-site'
     or (select title from public.online_shop where company_id = c) <> 'Πιτσαρία Site' then
    raise exception 'ΑΠΟΤΥΧΙΑ: καθάρισμα slug / τίτλου';
  end if;
  -- το προσωπικό δεν αλλάζει ρυθμίσεις, ο ξένος δεν βλέπει
  perform pg_temp.as_user(staff);
  update public.online_shop set title = 'Άλλο' where company_id = c;
  if (select title from public.online_shop where company_id = c) <> 'Πιτσαρία Site' then
    raise exception 'ΑΠΟΤΥΧΙΑ: το προσωπικό άλλαξε τις ρυθμίσεις';
  end if;
  perform pg_temp.as_user(stranger);
  if exists (select 1 from public.online_shop where company_id = c) then
    raise exception 'ΑΠΟΤΥΧΙΑ: ο ξένος βλέπει το site';
  end if;
  perform pg_temp.expect_fail(format('insert into public.online_shop (company_id, slug, title) values (%L, %L, %L)', c2, 'pizza-site', 'Ξένη'),
    '%online_shop_slug%', 'ίδιο slug σε άλλη εταιρεία');
  perform pg_temp.expect_fail(format('select public.shop_set_open(%L, true)', c), '%πρόσβαση%', 'ξένος ανοίγει το site');
  perform pg_temp.as_user(me);
  raise notice 'OK site μαγαζιού';

  -- -------------------------------------------------------------------
  -- 3. Μενού για τον επισκέπτη
  -- -------------------------------------------------------------------
  perform pg_temp.as_anon();
  m := public.shop_menu('PIZZA-SITE');
  if m is null or m->>'name' <> 'Πιτσαρία Site' or (m->>'open')::boolean
     or (m->>'delivery_fee')::numeric <> 1.5 or (m->>'min_order')::numeric <> 8 then
    raise exception 'ΑΠΟΤΥΧΙΑ: μενού (στοιχεία μαγαζιού): %', m;
  end if;
  if public.shop_menu('den-yparxei') is not null then
    raise exception 'ΑΠΟΤΥΧΙΑ: μενού για άγνωστο μαγαζί';
  end if;
  if (select array_agg(x->>'name' order by ord) from jsonb_array_elements(m->'items') with ordinality as t(x, ord))
       <> array['Μαργαρίτα', 'Πεπερόνι', 'Κατεψυγμένη'] then
    raise exception 'ΑΠΟΤΥΧΙΑ: είδη του μενού: %', m->'items';
  end if;
  if (select (x->>'price')::numeric from jsonb_array_elements(m->'items') x where x->>'name' = 'Μαργαρίτα') <> 9.04 then
    raise exception 'ΑΠΟΤΥΧΙΑ: τιμή με ΦΠΑ στο μενού';
  end if;
  if exists (select 1 from jsonb_array_elements(m->'items') x, jsonb_object_keys(x) k
              where k not in ('id', 'name', 'description', 'category', 'price', 'extras_ok')) then
    raise exception 'ΑΠΟΤΥΧΙΑ: το μενού δείχνει παραπάνω πεδία';
  end if;
  -- ο επισκέπτης δεν διαβάζει κανέναν πίνακα
  perform pg_temp.expect_fail('select count(*) from public.online_order', '%permission denied%', 'επισκέπτης διαβάζει παραγγελίες');
  perform pg_temp.expect_fail('select count(*) from public.online_shop', '%permission denied%', 'επισκέπτης διαβάζει site');
  perform pg_temp.expect_fail(format('select public.order_accept(%L)', gen_random_uuid()), '%permission denied%', 'επισκέπτης κάνει αποδοχή');
  raise notice 'OK μενού επισκέπτη';

  -- -------------------------------------------------------------------
  -- 4. Κλειστό → καμία παραγγελία· άνοιγμα από το προσωπικό
  -- -------------------------------------------------------------------
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pizza-site',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 2)))),
    '%δεν δέχεται online παραγγελίες%2810 123456%', 'κλειστό μαγαζί');
  perform pg_temp.as_user(staff);
  if public.shop_set_open(c, true) <= now() or public.shop_set_open(c, true) > now() + interval '24 hours' then
    raise exception 'ΑΠΟΤΥΧΙΑ: ώρα κλεισίματος';
  end if;
  perform pg_temp.as_anon();
  if not (public.shop_menu('pizza-site')->>'open')::boolean then
    raise exception 'ΑΠΟΤΥΧΙΑ: δεν άνοιξε';
  end if;
  raise notice 'OK άνοιγμα / κλείσιμο';

  -- -------------------------------------------------------------------
  -- 5. Έλεγχοι παραγγελίας
  -- -------------------------------------------------------------------
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pizza-site',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 2)), '{"name": " "}')),
    '%όνομά σου%', 'χωρίς όνομα');
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pizza-site',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 2)), '{"phone": "12345"}')),
    '%σωστό τηλέφωνο%', 'λάθος τηλέφωνο');
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pizza-site',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 2)), '{"address": ""}')),
    '%διεύθυνση%', 'διανομή χωρίς διεύθυνση');
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pizza-site',
      pg_temp.ord('[]'::jsonb)), '%άδειο%', 'άδειο καλάθι');
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pizza-site',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', foreign_item, 'qty', 1)))),
    '%δεν είναι πια διαθέσιμο%', 'είδος άλλης εταιρείας');
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pizza-site',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', hidden, 'qty', 1)))),
    '%«Μυστική»%', 'είδος που δεν είναι στο site');
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pizza-site',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', raw_online, 'qty', 1)))),
    '%δεν είναι πια διαθέσιμο%', 'πρώτη ύλη στο site');
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pizza-site',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 0)))),
    '%ποσότητα%', 'ποσότητα 0');
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pizza-site',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1.5)))),
    '%γραμμή%', 'ποσότητα με δεκαδικά');
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pizza-site',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', 'κάτι', 'qty', 1)))),
    '%γραμμή%', 'λάθος id');
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pizza-site',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', frozen, 'qty', 1)))),
    '%ελάχιστη παραγγελία είναι 8.00%', 'κάτω από την ελάχιστη');
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pizza-site',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)), '{"mode": "drone"}')),
    '%διανομή ή παραλαβή%', 'άγνωστος τρόπος');
  raise notice 'OK έλεγχοι παραγγελίας';

  -- -------------------------------------------------------------------
  -- 6. Παραγγελίες: τιμές από τη βάση, αριθμός ανά ημέρα, τηλέφωνα
  -- -------------------------------------------------------------------
  r := public.place_order('pizza-site', pg_temp.ord(jsonb_build_array(
         jsonb_build_object('item_id', marg, 'qty', 2, 'price', 0.01, 'note', '  χωρίς   ρίγανη '),
         jsonb_build_object('item_id', marg, 'qty', 1)), '{"phone": "+30 694 123 4567", "notes": "κουδούνι Παπαδάκη"}'));
  tok := (r->>'token')::uuid;
  if (r->>'order_no')::int <> 1 or tok is null then
    raise exception 'ΑΠΟΤΥΧΙΑ: πρώτη παραγγελία: %', r;
  end if;
  m := public.order_status(tok);
  if m->>'status' <> 'new' or (m->>'items_total')::numeric <> 27.12 or (m->>'delivery_fee')::numeric <> 1.5
     or (m->>'total')::numeric <> 28.62 or m->'shop'->>'name' <> 'Πιτσαρία Site'
     or jsonb_array_length(m->'lines') <> 2 or m->'lines'->0->>'note' <> 'χωρίς ρίγανη' then
    raise exception 'ΑΠΟΤΥΧΙΑ: κατάσταση παραγγελίας: %', m;
  end if;
  if public.order_status(gen_random_uuid()) is not null then
    raise exception 'ΑΠΟΤΥΧΙΑ: κατάσταση με άγνωστο token';
  end if;
  -- παραλαβή: χωρίς μεταφορικά και διεύθυνση· ξένο κινητό
  r := public.place_order('pizza-site', pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', pep, 'qty', 1)),
         '{"mode": "pickup", "phone": "+44 7700 900123", "payment": "card"}'));
  if (r->>'order_no')::int <> 2 then raise exception 'ΑΠΟΤΥΧΙΑ: δεύτερος αριθμός'; end if;
  r := public.place_order('pizza-site', pg_temp.ord(jsonb_build_array(
         jsonb_build_object('item_id', marg, 'qty', 1), jsonb_build_object('item_id', frozen, 'qty', 2)), '{"phone": "2810 555 666"}'));
  r := public.place_order('pizza-site', pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)), '{"phone": "6977000000"}'));

  perform pg_temp.as_user(me);
  select id into o1 from public.online_order where company_id = c and order_no = 1 and order_date = today;
  select id into o2 from public.online_order where company_id = c and order_no = 2 and order_date = today;
  select id into o3 from public.online_order where company_id = c and order_no = 3 and order_date = today;
  select id into o4 from public.online_order where company_id = c and order_no = 4 and order_date = today;
  if (select phone from public.online_order where id = o1) <> '6941234567'
     or (select phone from public.online_order where id = o2) <> '+447700900123'
     or (select phone from public.online_order where id = o3) <> '2810555666'
     or (select address from public.online_order where id = o2) is not null
     or (select delivery_fee from public.online_order where id = o2) <> 0
     or (select payment from public.online_order where id = o2) <> 'card'
     or (select unit_price from public.online_order_line where order_id = o1 and line_no = 1) <> 9.04 then
    raise exception 'ΑΠΟΤΥΧΙΑ: στοιχεία παραγγελιών';
  end if;
  raise notice 'OK παραγγελίες (τιμές από τη βάση, αρίθμηση, τηλέφωνα)';

  -- όρια: έως 3 ανεπιβεβαίωτες ανά τηλέφωνο
  perform pg_temp.as_anon();
  r := public.place_order('pizza-site', pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)), '{"phone": "6900000001"}'));
  r := public.place_order('pizza-site', pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)), '{"phone": "6900000001"}'));
  r := public.place_order('pizza-site', pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)), '{"phone": "6900000001"}'));
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pizza-site',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)), '{"phone": "6900000001"}')),
    '%περιμένουν επιβεβαίωση%', 'τέταρτη ανεπιβεβαίωτη από το ίδιο τηλέφωνο');
  raise notice 'OK όρια κατάχρησης';

  -- -------------------------------------------------------------------
  -- 7. Ο ξένος δεν βλέπει ούτε αγγίζει
  -- -------------------------------------------------------------------
  perform pg_temp.as_user(stranger);
  if exists (select 1 from public.online_order where company_id = c)
     or exists (select 1 from public.online_order_line where company_id = c) then
    raise exception 'ΑΠΟΤΥΧΙΑ: ο ξένος βλέπει παραγγελίες';
  end if;
  perform pg_temp.expect_fail(format('select public.order_accept(%L)', o1), '%Δεν βρέθηκε%', 'ξένος κάνει αποδοχή');
  perform pg_temp.expect_fail(format('select public.order_reject(%L)', o1), '%Δεν βρέθηκε%', 'ξένος απορρίπτει');
  perform pg_temp.expect_fail(format('update public.online_order set status = %L where id = %L', 'done', o1), '%permission denied%', 'ξένος αλλάζει παραγγελία');
  raise notice 'OK άλλη εταιρεία';

  -- -------------------------------------------------------------------
  -- 8. Αποδοχή → πώληση site καταχωρημένη, με αυτόματη πίτσα και ζυμάρι
  -- -------------------------------------------------------------------
  perform pg_temp.as_user(staff);
  perform pg_temp.expect_fail(format('update public.online_order set status = %L where id = %L', 'done', o1), '%permission denied%', 'αλλαγή χωρίς function');
  perform pg_temp.expect_fail(format('select public.order_accept(%L, 3)', o1), '%5 ως 240%', 'λάθος λεπτά');
  v := public.item_on_hand(flour);
  r := public.order_accept(o1, 30);
  d := (r->>'doc_id')::uuid;
  if r->>'stock_note' is not null then raise exception 'ΑΠΟΤΥΧΙΑ: αποδοχή με σημείωση: %', r; end if;
  if (select status from public.doc where id = d) <> 'posted'
     or (select channel from public.doc where id = d) <> 'site'
     or (select notes from public.doc where id = d) not like 'Online παραγγελία #1 %'
     or (select count(*) from public.doc_line where doc_id = d and item_id = marg) <> 1
     or (select qty from public.doc_line where doc_id = d and item_id = marg) <> 3
     or (select unit_price from public.doc_line where doc_id = d and item_id = marg) <> 8
     or (select sum(gross) from public.doc_line where doc_id = d and item_id = marg) <> 27.12
     -- με το 0006 τα μεταφορικά (1,50) είναι κι αυτά γραμμή της πώλησης
     or (select total_gross from public.doc where id = d) not in (27.12, 28.62) then
    raise exception 'ΑΠΟΤΥΧΙΑ: πώληση από αποδοχή';
  end if;
  -- 3 μαργαρίτες: 3 ζυμάρια αυτόματα → 0.75 kg αλεύρι, 0.36 μοτσαρέλα, 3 κουτιά
  if round(v - public.item_on_hand(flour), 4) <> 0.75 or public.item_on_hand(box) <> 97
     or public.item_on_hand(marg) <> 0 or public.item_on_hand(dough) <> 0 then
    raise exception 'ΑΠΟΤΥΧΙΑ: backflush από online πώληση (αλεύρι %)', v - public.item_on_hand(flour);
  end if;
  if (select status from public.online_order where id = o1) <> 'accepted'
     or (select ready_minutes from public.online_order where id = o1) <> 30
     or (select sale_doc_id from public.online_order where id = o1) <> d
     or (select handled_by from public.online_order where id = o1) <> staff then
    raise exception 'ΑΠΟΤΥΧΙΑ: κατάσταση μετά την αποδοχή';
  end if;
  perform pg_temp.expect_fail(format('select public.order_accept(%L)', o1), '%#1 έχει ήδη γίνει δεκτή%', 'διπλή αποδοχή');
  perform pg_temp.expect_fail(format('select public.order_reject(%L)', o1), '%#1 έχει ήδη γίνει δεκτή%', 'απόρριψη μετά την αποδοχή');
  perform pg_temp.as_anon();
  if public.order_status(tok)->>'status' <> 'accepted' or (public.order_status(tok)->>'ready_minutes')::int <> 30 then
    raise exception 'ΑΠΟΤΥΧΙΑ: ο πελάτης δεν βλέπει την αποδοχή';
  end if;
  perform pg_temp.as_user(staff);
  raise notice 'OK αποδοχή → πώληση site';

  -- πίτσα χωρίς συνταγή: δεκτή, η πώληση μένει πρόχειρη με το μήνυμα
  r := public.order_accept(o2);
  if r->>'stock_note' not like '%συνταγή%'
     or (select status from public.doc where id = (r->>'doc_id')::uuid) <> 'draft'
     or (select status from public.online_order where id = o2) <> 'accepted'
     or (select stock_note from public.online_order where id = o2) not like '%συνταγή%'
     or exists (select 1 from public.stock_move where doc_id = (r->>'doc_id')::uuid) then
    raise exception 'ΑΠΟΤΥΧΙΑ: αποδοχή χωρίς συνταγή: %', r;
  end if;
  raise notice 'OK αποδοχή χωρίς συνταγή (πρόχειρη πώληση, μήνυμα)';

  -- απόρριψη: καμία κίνηση
  r := public.order_reject(o4, '  Δεν πάμε τόσο μακριά ');
  if (select status from public.online_order where id = o4) <> 'rejected'
     or (select reason from public.online_order where id = o4) <> 'Δεν πάμε τόσο μακριά'
     or (select sale_doc_id from public.online_order where id = o4) is not null then
    raise exception 'ΑΠΟΤΥΧΙΑ: απόρριψη';
  end if;
  perform pg_temp.expect_fail(format('select public.order_accept(%L)', o4), '%#4 έχει απορριφθεί%', 'αποδοχή μετά την απόρριψη');
  perform pg_temp.expect_fail(format('select public.order_done(%L)', o4), '%#4 έχει απορριφθεί%', '«έφυγε» μετά την απόρριψη');
  raise notice 'OK απόρριψη';

  -- «έφυγε», μετά ακύρωση: η πώληση ακυρώνεται και σβήνεται, το απόθεμα γυρίζει
  r := public.order_done(o1);
  if (select status from public.online_order where id = o1) <> 'done' or (select done_at from public.online_order where id = o1) is null then
    raise exception 'ΑΠΟΤΥΧΙΑ: «έφυγε»';
  end if;
  perform pg_temp.expect_fail(format('select public.order_done(%L)', o1), '%#1 έχει ήδη φύγει%', 'διπλό «έφυγε»');
  r := public.order_cancel(o1, 'Δεν ήταν σπίτι');
  if r->>'note' is not null
     or exists (select 1 from public.doc where id = d)
     or exists (select 1 from public.doc where source_doc_id = d)
     or (select status from public.online_order where id = o1) <> 'cancelled'
     or (select sale_doc_id from public.online_order where id = o1) is not null
     or round(public.item_on_hand(flour), 4) <> round(v, 4) or public.item_on_hand(box) <> 100 then
    raise exception 'ΑΠΟΤΥΧΙΑ: ακύρωση μετά την παράδοση: %', r;
  end if;
  -- πρόχειρη πώληση (χωρίς συνταγή): απλά σβήνεται
  d := (select sale_doc_id from public.online_order where id = o2);
  r := public.order_cancel(o2);
  if exists (select 1 from public.doc where id = d) or (select status from public.online_order where id = o2) <> 'cancelled' then
    raise exception 'ΑΠΟΤΥΧΙΑ: ακύρωση με πρόχειρη πώληση';
  end if;
  raise notice 'OK «έφυγε» και ακύρωση';

  -- ακύρωση που κλειδώνει: απογραφή αύριο μετρά το αλεύρι → η πώληση μένει
  r := public.order_accept(o3, 20);
  d := (r->>'doc_id')::uuid;
  if (select status from public.doc where id = d) <> 'posted' then raise exception 'ΑΠΟΤΥΧΙΑ: αποδοχή #3'; end if;
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'stocktake', today + 1) returning id into st;
  insert into public.doc_line (doc_id, line_no, item_id, qty) values (st, 1, flour, 40);
  perform public.post_document(st);
  r := public.order_cancel(o3);
  -- (κλείδωμα ή επιμερισμός κόστους της απογραφής: και τα δύο κρατούν την πώληση)
  if r->>'note' not like '%ΠΩ-%έμεινε%απογραφή%'
     or (select status from public.doc where id = d) <> 'posted'
     or (select status from public.online_order where id = o3) <> 'cancelled'
     or (select sale_doc_id from public.online_order where id = o3) <> d then
    raise exception 'ΑΠΟΤΥΧΙΑ: ακύρωση κλειδωμένης πώλησης: %', r;
  end if;
  raise notice 'OK ακύρωση που την κλειδώνει απογραφή';

  -- -------------------------------------------------------------------
  -- 9. Κλείσιμο, μηνιαία σύνοψη
  -- -------------------------------------------------------------------
  if public.shop_set_open(c, false) is not null then raise exception 'ΑΠΟΤΥΧΙΑ: κλείσιμο'; end if;
  perform pg_temp.as_anon();
  perform pg_temp.expect_fail(format('select public.place_order(%L, %L)', 'pizza-site',
      pg_temp.ord(jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 2)))),
    '%δεν δέχεται%', 'μετά το κλείσιμο');
  perform pg_temp.as_user(me);
  select * into rec from public.v_online_month where company_id = c;
  -- 7 παραγγελίες: 3 ακυρώθηκαν, 1 απορρίφθηκε, 3 νέες (το ίδιο τηλέφωνο)
  if rec.orders <> 0 or rec.cancelled <> 3 or rec.rejected <> 1 then
    raise exception 'ΑΠΟΤΥΧΙΑ: μηνιαία σύνοψη: %', rec;
  end if;
  r := public.order_accept((select id from public.online_order where company_id = c and phone = '6900000001' order by order_no limit 1));
  select * into rec from public.v_online_month where company_id = c;
  if rec.orders <> 1 or rec.total <> 10.54 then
    raise exception 'ΑΠΟΤΥΧΙΑ: μηνιαία σύνοψη μετά την αποδοχή: %', rec;
  end if;
  raise notice 'OK κλείσιμο, μηνιαία σύνοψη';

  raise notice 'ΟΛΑ ΟΚ (παραγγελίες)';
end $$;

reset role;
