-- Σενάριο δοκιμής: έκπτωση καλωσορίσματος και επιβράβευσης (στην
-- παραγγελία, στην πώληση, στο παραστατικό), πηγή παραγγελίας, πελάτες
-- του site, διαγραφή στοιχείων κατόπιν αιτήματος και μετά από 24 μήνες.
\set ON_ERROR_STOP on
\pset format aligned

insert into auth.users (id, email) values
  ('99999999-9999-9999-9999-999999999991', 'loy-owner@example.com'),
  ('99999999-9999-9999-9999-999999999992', 'loy-staff@example.com')
on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claim.sub', '99999999-9999-9999-9999-999999999991', false);

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
create function pg_temp.as_service() returns void language plpgsql as $$
begin
  execute 'set role service_role';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false);
  perform set_config('request.jwt.claim.sub', '', false);
end $$;

create function pg_temp.ord(p_phone text, p_lines jsonb, p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object('name', 'Ελένη', 'phone', p_phone, 'mode', 'delivery',
                            'address', 'Ικάρου 5, Ηράκλειο', 'payment', 'cash', 'lines', p_lines) || p_extra;
$$;

do $$
declare
  me    constant uuid := '99999999-9999-9999-9999-999999999991';
  staff constant uuid := '99999999-9999-9999-9999-999999999992';
  c uuid; marg uuid; xm uuid; cola uuid; b uuid; flour uuid; d uuid; sup uuid;
  r jsonb; m jsonb; st jsonb; ln jsonb;
  o1 uuid; o2 uuid; o3 uuid; o4 uuid; o5 uuid; o6 uuid;
  t1 uuid; t3 uuid;
  doc uuid; f uuid;
  n int; v numeric;
  rec record;
begin
  -- -------------------------------------------------------------------
  -- Στήσιμο: Μαργαρίτα 8,00 + 13% = 9,04 με ΦΠΑ, μεταφορικά 2,00
  -- -------------------------------------------------------------------
  c := public.create_company('Πιτσαρία Επιβράβευση', '094014201');
  insert into public.company_member (company_id, user_id, role) values (c, staff, 'staff');
  insert into public.item (company_id, code, name, item_type, unit) values (c, 'ΠΥ-001', 'Αλεύρι', 'raw', 'kg') returning id into flour;
  insert into public.item (company_id, code, name, item_type, category, unit, sale_price, make_to_order, online) values
    (c, 'ΠΡ-001', 'Μαργαρίτα', 'finished', 'Πίτσες', 'τεμ', 8.00, true, true) returning id into marg;
  insert into public.item (company_id, code, name, item_type, unit, sale_price, make_to_order, online, is_extra) values
    (c, 'ΕΧ-001', 'Extra μοτσαρέλα', 'finished', 'τεμ', 1.33, true, true, true) returning id into xm;
  insert into public.item (company_id, code, name, item_type, category, unit, sale_price, vat_rate, online) values
    (c, 'ΠΡ-020', 'Αναψυκτικό', 'finished', 'Ποτά', 'τεμ', 1.61, 24, true) returning id into cola;
  insert into public.bom (company_id, item_id, output_qty) values (c, xm, 1) returning id into b;
  insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values (c, b, 1, flour, 0.01);
  insert into public.bom (company_id, item_id, output_qty) values (c, marg, 1) returning id into b;
  insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values (c, b, 1, flour, 0.25);
  insert into public.partner (company_id, code, name, is_supplier) values (c, 'ΠΡ-1', 'Μύλος', true) returning id into sup;
  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', current_date - 2, sup) returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price) values (d, 1, flour, 50, 0.6), (d, 2, cola, 24, 0.6);
  perform public.post_document(d);
  insert into public.online_shop (company_id, slug, title, phone, delivery_fee, min_order)
  values (c, 'loyal-pizza', 'Πιτσαρία Επιβράβευση', '2810000002', 2.00, 5);
  perform public.shop_set_open(c, true);

  -- ρυθμίσεις: επιβράβευση θέλει και κάθε πόσες και πόσο %
  perform pg_temp.expect_fail(format('update public.online_shop set loyalty_every = 3 where company_id = %L', c),
                              '%online_shop_discount_check%', 'επιβράβευση χωρίς ποσοστό');
  perform pg_temp.expect_fail(format('update public.online_shop set welcome_pct = 80 where company_id = %L', c),
                              '%online_shop_discount_check%', 'καλωσόρισμα πάνω από 50%');
  update public.online_shop set welcome_pct = 10, loyalty_every = 3, loyalty_pct = 20, pay_provider = 'test' where company_id = c;

  -- -------------------------------------------------------------------
  -- Μενού: εκπτώσεις και στοιχεία της εταιρείας (για τη σελίδα απορρήτου)
  -- -------------------------------------------------------------------
  perform pg_temp.as_anon();
  m := public.shop_menu('loyal-pizza');
  if (m->>'welcome_pct')::numeric <> 10 or (m->>'loyalty_every')::int <> 3 or (m->>'loyalty_pct')::numeric <> 20
     or m->'company'->>'name' <> 'Πιτσαρία Επιβράβευση' or m->'company'->>'vat_no' <> '094014201' then
    raise exception 'ΑΠΟΤΥΧΙΑ: μενού χωρίς εκπτώσεις / εταιρεία: %', m;
  end if;
  raise notice 'OK μενού με εκπτώσεις';

  -- -------------------------------------------------------------------
  -- 1η παραγγελία του τηλεφώνου: καλωσόρισμα 10% στα είδη, όχι στα μεταφορικά
  -- 2 × 9,04 = 18,08 → έκπτωση 1,81 → 16,27 + 2,00 = 18,27
  -- -------------------------------------------------------------------
  r := public.place_order('loyal-pizza', pg_temp.ord('6942222222',
         jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 2, 'note', 'για τη Μαρία στον 3ο')),
         '{"source":"bag"}'));
  o1 := (r->>'order_id')::uuid; t1 := (r->>'token')::uuid;
  if (r->>'total')::numeric <> 18.27 or (r->>'discount')::numeric <> 1.81 then
    raise exception 'ΑΠΟΤΥΧΙΑ: καλωσόρισμα %', r;
  end if;
  st := public.order_status(t1);
  if st->>'discount_kind' <> 'welcome' or (st->>'discount_pct')::numeric <> 10 or (st->>'discount')::numeric <> 1.81
     or (st->'loyalty'->>'count')::int <> 1 or (st->'loyalty'->>'every')::int <> 3 then
    raise exception 'ΑΠΟΤΥΧΙΑ: κατάσταση με έκπτωση %', st;
  end if;

  -- 2η (ενώ η 1η περιμένει ακόμα): χωρίς έκπτωση, και άγνωστη πηγή = τίποτα
  r := public.place_order('loyal-pizza', pg_temp.ord('694 222 2222',
         jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)), '{"source":"Κακό Source!"}'));
  o2 := (r->>'order_id')::uuid;
  if (r->>'discount')::numeric <> 0 or (r->>'total')::numeric <> 11.04 then
    raise exception 'ΑΠΟΤΥΧΙΑ: 2η παραγγελία με έκπτωση %', r;
  end if;
  perform pg_temp.as_user(staff);
  select source into rec from public.online_order where id = o2;
  if rec.source is not null then raise exception 'ΑΠΟΤΥΧΙΑ: άκυρη πηγή γράφτηκε'; end if;
  select source into rec from public.online_order where id = o1;
  if rec.source <> 'bag' then raise exception 'ΑΠΟΤΥΧΙΑ: πηγή %', rec.source; end if;
  raise notice 'OK καλωσόρισμα στην 1η, όχι στη 2η, πηγή';

  -- αποδοχή της 1ης: έκπτωση στις γραμμές της πώλησης, όχι στα μεταφορικά
  r := public.order_accept(o1, 20);
  doc := (r->>'doc_id')::uuid;
  if r->>'stock_note' is not null then raise exception 'ΑΠΟΤΥΧΙΑ: δεν καταχωρήθηκε: %', r; end if;
  select d2.total_gross, d2.notes into rec from public.doc d2 where d2.id = doc;
  if rec.total_gross <> 18.27 then raise exception 'ΑΠΟΤΥΧΙΑ: σύνολο πώλησης % αντί 18,27', rec.total_gross; end if;
  if rec.notes not like '%έκπτωση καλωσορίσματος 10%%' then raise exception 'ΑΠΟΤΥΧΙΑ: σημείωση πώλησης %', rec.notes; end if;
  select count(*) into n from public.doc_line dl where dl.doc_id = doc and dl.item_id = marg and dl.discount_pct = 10;
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: έκπτωση στη γραμμή της πίτσας'; end if;
  select count(*) into n from public.doc_line dl join public.item i on i.id = dl.item_id
   where dl.doc_id = doc and i.is_service and dl.discount_pct = 0 and dl.gross = 2.00;
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: τα μεταφορικά πήραν έκπτωση'; end if;
  perform public.order_done(o1);
  perform public.order_accept(o2, 20);
  perform public.order_done(o2);
  raise notice 'OK έκπτωση στην πώληση';

  -- -------------------------------------------------------------------
  -- 3η: επιβράβευση 20% (κάθε 3η). 9,04 → έκπτωση 1,81 → 7,23 + 2 = 9,23
  -- -------------------------------------------------------------------
  perform pg_temp.as_anon();
  r := public.place_order('loyal-pizza', pg_temp.ord('6942222222', jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1))));
  o3 := (r->>'order_id')::uuid; t3 := (r->>'token')::uuid;
  if (r->>'total')::numeric <> 9.23 or (r->>'discount')::numeric <> 1.81 then
    raise exception 'ΑΠΟΤΥΧΙΑ: επιβράβευση %', r;
  end if;
  st := public.order_status(t3);
  if st->>'discount_kind' <> 'loyalty' or (st->'loyalty'->>'count')::int <> 3 then
    raise exception 'ΑΠΟΤΥΧΙΑ: κάρτα επιβράβευσης %', st;
  end if;
  perform pg_temp.as_user(staff);
  r := public.order_accept(o3, 20);
  select d2.total_gross into v from public.doc d2 where d2.id = (r->>'doc_id')::uuid;
  if v <> 9.23 then raise exception 'ΑΠΟΤΥΧΙΑ: πώληση επιβράβευσης %', v; end if;

  -- στο παραστατικό: η έκπτωση στη γραμμή
  perform pg_temp.as_user(me);
  insert into public.fiscal_settings (company_id, provider) values (c, 'manual');
  perform pg_temp.as_user(staff);
  f := public.fiscal_prepare('receipt', null, o3, null);
  select ln2 into ln from public.fiscal_doc fd, jsonb_array_elements(fd.lines) ln2
   where fd.id = f and (ln2->>'item_id')::uuid = marg;
  if (ln->>'discount_pct')::numeric <> 20 then raise exception 'ΑΠΟΤΥΧΙΑ: παραστατικό χωρίς έκπτωση %', ln; end if;
  select total_gross into v from public.fiscal_doc where id = f;
  if v <> 9.23 then raise exception 'ΑΠΟΤΥΧΙΑ: σύνολο παραστατικού %', v; end if;
  perform public.order_done(o3);
  raise notice 'OK επιβράβευση στην 3η, στην πώληση και στο παραστατικό';

  -- -------------------------------------------------------------------
  -- Απορριφθείσα δεν μετράει: το νέο τηλέφωνο ξαναπαίρνει καλωσόρισμα
  -- -------------------------------------------------------------------
  perform pg_temp.as_anon();
  r := public.place_order('loyal-pizza', pg_temp.ord('6943333333', jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)), '{"source":"flyer"}'));
  o4 := (r->>'order_id')::uuid;
  perform pg_temp.as_user(staff);
  perform public.order_reject(o4, 'Κλείνουμε');
  perform pg_temp.as_anon();
  r := public.place_order('loyal-pizza', pg_temp.ord('6943333333', jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)), '{"source":"flyer"}'));
  o5 := (r->>'order_id')::uuid;
  if (r->>'discount')::numeric <> 0.90 then raise exception 'ΑΠΟΤΥΧΙΑ: καλωσόρισμα μετά από απόρριψη %', r; end if;
  -- online πληρωμή που απέτυχε δεν μετράει, που περιμένει (τώρα) μετράει
  perform pg_temp.as_service();
  r := public.place_order('loyal-pizza', pg_temp.ord('6944444444', jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1)), '{"payment":"online"}'));
  o6 := (r->>'order_id')::uuid; v := (r->>'total')::numeric;
  if (r->>'discount')::numeric <> 0.90 or v <> 10.14 then raise exception 'ΑΠΟΤΥΧΙΑ: καλωσόρισμα online %', r; end if;
  r := public.place_order('loyal-pizza', pg_temp.ord('6944444444', jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1))));
  if (r->>'discount')::numeric <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: δεύτερο καλωσόρισμα όσο περιμένει η πληρωμή %', r; end if;
  perform public.payment_start(o6, 'test', 'T-loy-1', v);
  perform public.payment_failed('test', 'T-loy-1', 'δοκιμή', null);
  reset role;
  delete from public.online_order where company_id = c and phone = '6944444444' and payment = 'cash';
  perform pg_temp.as_service();
  r := public.place_order('loyal-pizza', pg_temp.ord('6944444444', jsonb_build_array(jsonb_build_object('item_id', marg, 'qty', 1))));
  if (r->>'discount')::numeric <> 0.90 then raise exception 'ΑΠΟΤΥΧΙΑ: καλωσόρισμα μετά από αποτυχημένη πληρωμή %', r; end if;
  raise notice 'OK απορριφθείσες και αποτυχημένες πληρωμές δεν μετράνε';

  -- -------------------------------------------------------------------
  -- Στρογγυλέματα: η πώληση βγαίνει ακριβώς όσο πληρώνει ο πελάτης.
  -- 9,04 + extra 1,50 + 2,00 = 12,54 → −10% = −1,25 → 11,29 + 2,00 = 13,29.
  -- Ο ΦΠΑ ανά γραμμή με την έκπτωση βγάζει 13,28: διορθώνεται στην τιμή.
  -- -------------------------------------------------------------------
  perform pg_temp.as_anon();
  r := public.place_order('loyal-pizza', pg_temp.ord('6945555555', jsonb_build_array(
         jsonb_build_object('item_id', marg, 'qty', 1, 'extras', jsonb_build_array(xm)),
         jsonb_build_object('item_id', cola, 'qty', 1))));
  if (r->>'total')::numeric <> 13.29 then raise exception 'ΑΠΟΤΥΧΙΑ: σύνολο στρογγυλέματος %', r; end if;
  perform pg_temp.as_user(staff);
  r := public.order_accept((r->>'order_id')::uuid, 20);
  if r->>'stock_note' is not null then raise exception 'ΑΠΟΤΥΧΙΑ: δεν καταχωρήθηκε: %', r; end if;
  select d2.total_gross into v from public.doc d2 where d2.id = (r->>'doc_id')::uuid;
  if v <> 13.29 then raise exception 'ΑΠΟΤΥΧΙΑ: η πώληση βγήκε % αντί για 13,29', v; end if;
  select count(*) into n from public.doc_line dl where dl.doc_id = (r->>'doc_id')::uuid and dl.discount_pct = 10;
  if n <> 3 then raise exception 'ΑΠΟΤΥΧΙΑ: η έκπτωση δεν έμεινε σε όλες τις γραμμές ειδών (%)', n; end if;
  raise notice 'OK η πώληση ίση με την πληρωμή (στρογγυλέματα ΦΠΑ)';

  -- -------------------------------------------------------------------
  -- Πηγές του μήνα και πελάτες του site
  -- -------------------------------------------------------------------
  perform pg_temp.as_user(staff);
  perform public.order_accept(o5, 20);
  select orders into n from public.v_online_source where company_id = c and source = 'bag';
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: πηγή bag %', n; end if;
  select orders into n from public.v_online_source where company_id = c and source = 'flyer';
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: πηγή flyer (η απορριφθείσα δεν μετράει) %', n; end if;
  select orders into n from public.v_online_source where company_id = c and source = '';
  if n <> 3 then raise exception 'ΑΠΟΤΥΧΙΑ: χωρίς πηγή %', n; end if;
  select * into rec from public.v_site_customer where company_id = c and phone = '6942222222';
  if rec.orders <> 3 or rec.total <> 18.27 + 11.04 + 9.23 or rec.name <> 'Ελένη' then
    raise exception 'ΑΠΟΤΥΧΙΑ: πελάτης site %', rec;
  end if;
  raise notice 'OK πηγές και πελάτες του site';

  -- -------------------------------------------------------------------
  -- Διαγραφή στοιχείων: μόνο ο owner, όχι με παραγγελία σε εξέλιξη
  -- -------------------------------------------------------------------
  perform pg_temp.expect_fail(format('select public.customer_forget(%L, %L)', c, '6942222222'),
                              '%Μόνο ο ιδιοκτήτης%', 'διαγραφή από το προσωπικό');
  perform pg_temp.as_user(me);
  perform pg_temp.expect_fail(format('select public.customer_forget(%L, %L)', c, '6943333333'),
                              '%σε εξέλιξη%', 'διαγραφή με παραγγελία σε εξέλιξη');
  perform pg_temp.expect_fail(format('select public.customer_forget(%L, %L)', c, '6990000000'),
                              '%Δεν βρέθηκαν%', 'διαγραφή άγνωστου');
  n := public.customer_forget(c, '6942222222');
  if n <> 3 then raise exception 'ΑΠΟΤΥΧΙΑ: σβήστηκαν % αντί 3', n; end if;
  select count(*) into n from public.online_order where company_id = c and (customer_name = 'Ελένη' and phone = '6942222222');
  if n <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: έμειναν στοιχεία'; end if;
  select count(*) into n from public.online_order_line l join public.online_order o on o.id = l.order_id
   where o.company_id = c and l.note like '%Μαρία%';
  if n <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: έμεινε σημείωση με όνομα'; end if;
  select count(*) into n from public.v_site_customer where company_id = c and phone = '6942222222';
  if n <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: ο πελάτης φαίνεται ακόμα'; end if;
  -- η πώληση μένει όπως ήταν
  select d2.total_gross into v from public.doc d2 where d2.id = doc;
  if v <> 18.27 then raise exception 'ΑΠΟΤΥΧΙΑ: η πώληση άλλαξε'; end if;
  -- ο πελάτης βλέπει την παλιά σελίδα χωρίς στοιχεία
  perform pg_temp.as_anon();
  st := public.order_status(t1);
  if st->>'name' <> 'Διαγράφηκε' or st->'loyalty' <> 'null'::jsonb then raise exception 'ΑΠΟΤΥΧΙΑ: σελίδα μετά τη διαγραφή %', st; end if;
  perform pg_temp.expect_fail(format('select public.customer_forget(%L, %L)', c, '6943333333'),
                              '%permission denied%', 'διαγραφή από επισκέπτη');
  perform pg_temp.expect_fail('select * from public.v_site_customer', '%permission denied%', 'πελάτες από επισκέπτη');
  raise notice 'OK διαγραφή στοιχείων κατόπιν αιτήματος';

  -- -------------------------------------------------------------------
  -- 24 μήνες: σβήνονται όταν ανοίγει το site (όχι όσες είναι σε εξέλιξη)
  -- -------------------------------------------------------------------
  reset role;
  update public.online_order set created_at = now() - interval '25 months' where id in (o4, o5);
  perform pg_temp.as_user(staff);
  perform public.shop_set_open(c, true);
  select count(*) into n from public.online_order where id = o4 and phone = '' and customer_name = 'Διαγράφηκε';
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: δεν σβήστηκε η παλιά απορριφθείσα'; end if;
  select count(*) into n from public.online_order where id = o5 and phone = '6943333333';
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: σβήστηκε παλιά παραγγελία σε εξέλιξη'; end if;
  raise notice 'OK αυτόματη διαγραφή μετά από 24 μήνες';

  raise notice 'ΟΛΑ ΟΚ (επιβράβευση και απόρρητο)';
end $$;
reset role;
