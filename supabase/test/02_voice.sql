-- Σενάριο δοκιμής 0004 ("Πες το"): aliases, κανάλια, μετρητής ημέρας,
-- απογραφή σε εξέλιξη, αυτόματο κλείσιμο ημερών, αυτόματο ζυμάρι (backflush
-- δύο επιπέδων, μόνο όσο λείπει από το απόθεμα), επιμερισμός απογραφής πάνω
-- σε αυτόματες παραγωγές (και σε δύο διαδοχικές απογραφές), απογραφή με
-- ανοιχτές πωλήσεις ημέρας, κλειδωμένες ημέρες, ασφάλεια (RLS, εταιρεία),
-- μέτρηση "τη στιγμή που λέγεται" (stock_cut): μέτρηση στη μέση της μέρας,
-- πρόσθεση από δωμάτιο σε δωμάτιο, απογραφή με το χέρι, δεύτερη μέτρηση
-- την ίδια μέρα, κλειδώματα πριν/μετά τη μέτρηση, δικές τους φράσεις,
-- κλείδωμα όσων είναι ήδη μέσα σε μέτρηση σε εξέλιξη, πρόχειρες πωλήσεις
-- ημέρας στη μέτρηση, αξία διαφοράς τη στιγμή της μέτρησης, ζυμάρια του
-- πρωινού σε πίτσες όλης της μέρας, στιγμή που δεν πάει πίσω, μέτρηση σε
-- ξεχασμένη απογραφή προηγούμενης μέρας.
\set ON_ERROR_STOP on
\pset format aligned

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'voice@example.com'),
  ('44444444-4444-4444-4444-444444444444', 'other@example.com')
on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

-- βοηθός: η εντολή πρέπει να αποτύχει με μήνυμα που ταιριάζει στο p_like
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

do $$
declare
  me    constant uuid := '33333333-3333-3333-3333-333333333333';
  other constant uuid := '44444444-4444-4444-4444-444444444444';
  d10   constant date := '2026-09-10';
  d11   constant date := '2026-09-11';
  d12   constant date := '2026-09-12';
  d13   constant date := '2026-09-13';
  d15   constant date := '2026-09-15';
  d20   constant date := '2026-09-20';
  d30   constant date := '2026-09-30';
  c uuid; c2 uuid;
  flour uuid; water uuid; yeast uuid; salt uuid; oil uuid; mozz uuid; sauce uuid; box uuid;
  dough uuid; marg uuid; pep uuid; special uuid; foreign_item uuid; napkin uuid;
  mill uuid; hotel uuid;
  b_dough uuid; b_marg uuid; b_special uuid; b_pep uuid;
  d uuid; s1 uuid; p1 uuid; p2 uuid; a1 uuid; a2 uuid; a3 uuid;
  t uuid; t2 uuid; t3 uuid; t10 uuid; t11 uuid; t12 uuid; t13 uuid; t15 uuid; st uuid; st30 uuid;
  p3 uuid; p4 uuid; a4 uuid; imp uuid; b_x uuid;
  t4 uuid; st2 uuid; st3 uuid; pm uuid; vp uuid; pa uuid; pb uuid; pc uuid;
  cut1 bigint; cut2 bigint; cut3 bigint;
  v numeric; v2 numeric; v3 numeric; v4 numeric; v5 numeric; v6 numeric; v_total numeric;
  n int; n2 int; n3 int;
  r record;
  sql text;
  names text[];
begin
  -- -------------------------------------------------------------------
  -- Στήσιμο
  -- -------------------------------------------------------------------
  c := public.create_company('Πιτσαρία Φωνή', '999999999');

  insert into public.item (company_id, code, name, item_type, unit, vat_rate, pack_name, pack_qty) values
    (c, 'ΠΥ-001', 'Αλεύρι', 'raw', 'kg', 13, 'σακί', 25) returning id into flour;
  insert into public.item (company_id, code, name, item_type, unit) values (c, 'ΠΥ-002', 'Νερό', 'raw', 'L') returning id into water;
  insert into public.item (company_id, code, name, item_type, unit) values (c, 'ΠΥ-003', 'Μαγιά', 'raw', 'kg') returning id into yeast;
  insert into public.item (company_id, code, name, item_type, unit) values (c, 'ΠΥ-004', 'Αλάτι', 'raw', 'kg') returning id into salt;
  insert into public.item (company_id, code, name, item_type, unit) values (c, 'ΠΥ-005', 'Ελαιόλαδο', 'raw', 'L') returning id into oil;
  insert into public.item (company_id, code, name, item_type, unit) values (c, 'ΠΥ-006', 'Μοτσαρέλα', 'raw', 'kg') returning id into mozz;
  insert into public.item (company_id, code, name, item_type, unit) values (c, 'ΠΥ-007', 'Σάλτσα ντομάτας', 'raw', 'kg') returning id into sauce;
  insert into public.item (company_id, code, name, item_type, unit, vat_rate) values (c, 'ΠΥ-008', 'Κουτί πίτσας', 'raw', 'τεμ', 24) returning id into box;
  -- ζυμάρι "αυτόματο": φτιάχνεται όταν χρειάζεται
  insert into public.item (company_id, code, name, item_type, unit, make_to_order) values
    (c, 'ΗΜ-001', 'Ζυμάρι 250γρ', 'semi', 'τεμ', true) returning id into dough;
  insert into public.item (company_id, code, name, item_type, unit, sale_price, make_to_order, aliases) values
    (c, 'ΠΡ-001', 'Μαργαρίτα', 'finished', 'τεμ', 8.00, true, '{μαργαρίτες,margarita}') returning id into marg;
  insert into public.item (company_id, code, name, item_type, unit, sale_price, make_to_order) values
    (c, 'ΠΡ-002', 'Πεπερόνι', 'finished', 'τεμ', 9.00, true) returning id into pep;   -- χωρίς συνταγή (ακόμα)
  insert into public.item (company_id, code, name, item_type, unit, sale_price, make_to_order) values
    (c, 'ΠΡ-003', 'Special κατεψυγμένη', 'finished', 'τεμ', 4.50, false) returning id into special;

  insert into public.bom (company_id, item_id, name, output_qty) values (c, dough, 'Παρτίδα 40', 40) returning id into b_dough;
  insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values
    (c, b_dough, 1, flour, 6.5), (c, b_dough, 2, water, 4), (c, b_dough, 3, yeast, 0.1),
    (c, b_dough, 4, salt, 0.12), (c, b_dough, 5, oil, 0.2);
  insert into public.bom (company_id, item_id, output_qty) values (c, marg, 1) returning id into b_marg;
  insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values
    (c, b_marg, 1, dough, 1), (c, b_marg, 2, sauce, 0.08), (c, b_marg, 3, mozz, 0.12), (c, b_marg, 4, box, 1);
  insert into public.bom (company_id, item_id, output_qty) values (c, special, 1) returning id into b_special;
  insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values
    (c, b_special, 1, dough, 1), (c, b_special, 2, sauce, 0.08), (c, b_special, 3, mozz, 0.15), (c, b_special, 4, box, 1);

  insert into public.partner (company_id, code, name, is_supplier, aliases) values
    (c, 'ΠΡ-001', 'Μύλος Α.Ε.', true, '{μύλος,μύλο}') returning id into mill;
  insert into public.partner (company_id, code, name, is_customer) values
    (c, 'ΠΕ-001', 'Ξενοδοχείο Αστέρια', true) returning id into hotel;

  -- άλλη εταιρεία, άλλου χρήστη
  perform set_config('request.jwt.claim.sub', other::text, false);
  c2 := public.create_company('Ξένη πιτσαρία', null);
  insert into public.item (company_id, code, name, item_type, unit, sale_price) values
    (c2, 'X-1', 'Ξένη πίτσα', 'finished', 'τεμ', 7) returning id into foreign_item;
  perform set_config('request.jwt.claim.sub', me::text, false);

  -- -------------------------------------------------------------------
  -- 1. Άλλα ονόματα (aliases)
  -- -------------------------------------------------------------------
  if (select aliases from public.item where id = marg) <> '{μαργαρίτες,margarita}'::text[] then
    raise exception 'ΑΠΟΤΥΧΙΑ aliases είδους';
  end if;
  if (select aliases from public.item where id = flour) <> '{}'::text[] then
    raise exception 'ΑΠΟΤΥΧΙΑ προεπιλογή aliases είδους';
  end if;
  update public.item set aliases = aliases || 'αλευράκι'::text where id = flour;
  if not (select 'αλευράκι' = any(aliases) from public.item where id = flour) then
    raise exception 'ΑΠΟΤΥΧΙΑ προσθήκη alias';
  end if;
  if not (select 'μύλος' = any(aliases) from public.partner where id = mill)
     or (select aliases from public.partner where id = hotel) <> '{}'::text[] then
    raise exception 'ΑΠΟΤΥΧΙΑ aliases συναλλασσομένου';
  end if;
  perform pg_temp.expect_fail(format('update public.item set aliases = null where id = %L', flour),
    '%aliases%', 'aliases όχι null (είδος)');
  perform pg_temp.expect_fail(format('update public.partner set aliases = null where id = %L', mill),
    '%aliases%', 'aliases όχι null (συναλλασσόμενος)');
  raise notice 'OK aliases';

  -- -------------------------------------------------------------------
  -- 2. Κανάλια
  -- -------------------------------------------------------------------
  for r in select unnest(array['wholesale','efood','wolt','box','phone','store']) as ch loop
    insert into public.doc (company_id, doc_type, doc_date, channel) values (c, 'sale', '2026-08-01', r.ch) returning id into d;
    delete from public.doc where id = d;
  end loop;
  perform pg_temp.expect_fail(format('insert into public.doc (company_id, doc_type, channel) values (%L, %L, %L)', c, 'sale', 'skroutz'),
    '%doc_channel_check%', 'άγνωστο κανάλι');
  select count(*) into n
    from pg_constraint k
   where k.conrelid = 'public.doc'::regclass and k.contype = 'c'
     and k.conkey = array[(select a.attnum from pg_attribute a
                            where a.attrelid = 'public.doc'::regclass and a.attname = 'channel')]::int2[];
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: % περιορισμοί για το channel', n; end if;
  raise notice 'OK κανάλια wolt/box';

  -- -------------------------------------------------------------------
  -- 3. Δικαιώματα
  -- -------------------------------------------------------------------
  if has_function_privilege('anon', 'public.tally_add(uuid,date,text,uuid,numeric)', 'execute')
     or has_function_privilege('anon', 'public.stocktake_count(uuid,date,uuid,numeric,boolean)', 'execute')
     or has_function_privilege('anon', 'public.close_running(uuid,date)', 'execute')
     or has_function_privilege('anon', 'public.post_document(uuid)', 'execute') then
    raise exception 'ΑΠΟΤΥΧΙΑ: ο anon εκτελεί RPC';
  end if;
  if not (has_function_privilege('authenticated', 'public.tally_add(uuid,date,text,uuid,numeric)', 'execute')
      and has_function_privilege('authenticated', 'public.stocktake_count(uuid,date,uuid,numeric,boolean)', 'execute')
      and has_function_privilege('authenticated', 'public.close_running(uuid,date)', 'execute')
      and has_function_privilege('authenticated', 'public.post_document(uuid)', 'execute')
      and has_function_privilege('authenticated', 'public.unpost_document(uuid)', 'execute')) then
    raise exception 'ΑΠΟΤΥΧΙΑ: ο authenticated δεν εκτελεί RPC';
  end if;
  if has_function_privilege('authenticated', 'public._post_production(public.doc)', 'execute')
     or has_function_privilege('authenticated', 'public._post_internal(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._unpost_internal(uuid)', 'execute')
     or has_function_privilege('anon', 'public._unpost_internal(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._post_sale(public.doc)', 'execute')
     or has_function_privilege('authenticated', 'public._post_stocktake(public.doc)', 'execute')
     or has_function_privilege('authenticated', 'public._allocate_stocktake(public.doc)', 'execute')
     or has_function_privilege('authenticated', 'public._allocate_cascade(public.doc,uuid,numeric,numeric,date,bigint,bigint)', 'execute')
     or has_function_privilege('authenticated', 'public._semi_stock_use(uuid,uuid,date,bigint,date,bigint)', 'execute')
     or has_function_privilege('authenticated', 'public._allocate_item(public.doc,uuid,numeric,numeric,date,bigint,bigint,int,text)', 'execute')
     or has_function_privilege('authenticated', 'public._prev_stocktake(public.doc,uuid,bigint)', 'execute')
     or has_function_privilege('authenticated', 'public._post_day_tallies(uuid,date,uuid[],uuid[])', 'execute')
     or has_function_privilege('authenticated', 'public._assert_open(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._lock_postings(uuid)', 'execute')
     or has_function_privilege('anon', 'public._lock_postings(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.voice_phrase_clean()', 'execute')
     or has_function_privilege('authenticated', 'public._available_qty(uuid,date)', 'execute')
     or has_function_privilege('authenticated', 'public._item_tree(uuid)', 'execute')
     or has_function_privilege('anon', 'public._stocktake_lock(uuid,date,uuid[])', 'execute')
     or has_function_privilege('authenticated', 'public._stocktake_lock(uuid,date,uuid[])', 'execute') then
    raise exception 'ΑΠΟΤΥΧΙΑ: εσωτερική function εκτελείται από τον client';
  end if;
  perform pg_temp.expect_fail(format('select public._post_internal(%L)', c), '%permission denied%', 'εσωτερική function από client');
  -- οι παλιές υπογραφές (μόνο ημερομηνίες) δεν υπάρχουν πια
  if to_regprocedure('public._prev_stocktake_date(public.doc,uuid)') is not null
     or to_regprocedure('public._allocate_item(public.doc,uuid,numeric,numeric,date,int,text)') is not null
     or to_regprocedure('public._semi_stock_use(uuid,uuid,date,date)') is not null
     or to_regprocedure('public._allocate_cascade(public.doc,uuid,numeric,numeric,date)') is not null then
    raise exception 'ΑΠΟΤΥΧΙΑ: έμειναν παλιές υπογραφές επιμερισμού';
  end if;
  raise notice 'OK δικαιώματα';

  -- -------------------------------------------------------------------
  -- 4. Αγορές 1/9
  -- -------------------------------------------------------------------
  insert into public.doc (company_id, doc_type, doc_date, partner_id, ref_no) values (c, 'purchase', '2026-09-01', mill, 'Τ-1') returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values
    (d, 1, flour, 250, 0.62, 13), (d, 2, water, 200, 0.001, 13), (d, 3, yeast, 5, 3.00, 13), (d, 4, salt, 10, 0.40, 13),
    (d, 5, oil, 20, 6.00, 13), (d, 6, mozz, 60, 7.00, 13), (d, 7, sauce, 40, 2.00, 13), (d, 8, box, 500, 0.25, 24);
  perform public.post_document(d);

  -- -------------------------------------------------------------------
  -- 5. Πώληση λιανικής -> αυτόματη μαργαρίτα -> αυτόματο ζυμάρι (2/9)
  -- -------------------------------------------------------------------
  create temp table snap1 on commit drop as
    select b.item_id, b.on_hand, b.avg_cost from public.v_stock_balance b where b.company_id = c;

  insert into public.doc (company_id, doc_type, doc_date, channel) values (c, 'sale', '2026-09-02', 'store') returning id into s1;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (s1, 1, marg, 10, 8.00, 13);
  perform public.post_document(s1);

  select count(*), min(id::text)::uuid into n, a1 from public.doc where source_doc_id = s1 and is_auto and status = 'posted';
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: % αυτόματες παραγωγές πίτσας', n; end if;
  select count(*), min(id::text)::uuid into n, a2 from public.doc where source_doc_id = a1 and is_auto and status = 'posted';
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: % αυτόματες παραγωγές ζυμαριού', n; end if;
  if not exists (select 1 from public.doc x join public.doc_line o on o.doc_id = x.id and o.role = 'output'
                  where x.id = a2 and x.doc_type = 'production' and x.doc_date = '2026-09-02' and x.bom_id = b_dough
                    and o.item_id = dough and o.qty = 10
                    and x.notes = 'Αυτόματη παραγωγή από ΠΑ-' || (select doc_no from public.doc where id = a1)) then
    raise exception 'ΑΠΟΤΥΧΙΑ: λάθος αυτόματη παραγωγή ζυμαριού';
  end if;
  if exists (select 1 from public.doc where source_doc_id = a2) then
    raise exception 'ΑΠΟΤΥΧΙΑ: τρίτο επίπεδο αυτόματης παραγωγής';
  end if;
  -- το ζυμάρι παράγεται και αναλώνεται: καθαρό 0
  select on_hand into v from public.v_stock_balance where item_id = dough;
  if v <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ υπόλοιπο ζυμαριού (0): %', v; end if;
  select count(*) into n from public.stock_move where item_id = dough;
  if n <> 2 then raise exception 'ΑΠΟΤΥΧΙΑ κινήσεις ζυμαριού: %', n; end if;
  select on_hand into v from public.v_stock_balance where item_id = flour;
  if v <> 248.375 then raise exception 'ΑΠΟΤΥΧΙΑ υπόλοιπο αλευριού (250-1.625): %', v; end if;
  select on_hand into v from public.v_stock_balance where item_id = marg;
  if v <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ υπόλοιπο μαργαρίτας: %', v; end if;

  -- κόστος: ζυμάρι = (6.5*0.62 + 4*0.001 + 0.1*3 + 0.12*0.4 + 0.2*6) / 40 = 0.13955
  select base_unit_cost into v from public.v_production_cost where doc_id = a2;
  if round(v, 5) <> 0.13955 then raise exception 'ΑΠΟΤΥΧΙΑ κόστος αυτόματου ζυμαριού: %', v; end if;
  -- κόστος συνταγής μαργαρίτας από τα μέσα κόστη των πρώτων υλών
  select sum(bl.qty / b.output_qty * i.avg_cost) into v2
    from public.bom b join public.bom_line bl on bl.bom_id = b.id join public.item i on i.id = bl.component_item_id
   where b.id = b_dough;
  select sum(bl.qty * case when bl.component_item_id = dough then v2 else i.avg_cost end) into v3
    from public.bom_line bl join public.item i on i.id = bl.component_item_id
   where bl.bom_id = b_marg;
  select base_unit_cost into v from public.v_production_cost where doc_id = a1;
  if round(v, 5) <> round(v3, 5) or round(v, 5) <> 1.38955 then
    raise exception 'ΑΠΟΤΥΧΙΑ κόστος μαργαρίτας % <> συνταγή %', v, v3;
  end if;
  select unit_cost into v from public.doc_line where doc_id = s1;
  if round(v, 5) <> 1.38955 then raise exception 'ΑΠΟΤΥΧΙΑ κόστος πωληθέντων: %', v; end if;
  raise notice 'OK αυτόματο ζυμάρι: ζυμάρι/τεμ %, μαργαρίτα/τεμ % = συνταγή %', 0.13955, round(v, 5), round(v3, 5);

  -- οι αυτόματες δεν καταχωρούνται / ακυρώνονται μόνες τους
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', a2),
    'Η αυτόματη παραγωγή ακυρώνεται μαζί με το παραστατικό που τη δημιούργησε', 'ακύρωση αυτόματου ζυμαριού');
  perform pg_temp.expect_fail(format('select public.post_document(%L)', a1),
    'Η αυτόματη παραγωγή καταχωρείται μαζί%', 'καταχώρηση αυτόματης');

  -- ακύρωση: φεύγουν και τα δύο επίπεδα, επιστρέφουν υπόλοιπα και μέσα κόστη
  perform public.unpost_document(s1);
  if exists (select 1 from public.doc where id in (a1, a2)) or exists (select 1 from public.doc where company_id = c and is_auto) then
    raise exception 'ΑΠΟΤΥΧΙΑ: έμειναν αυτόματες παραγωγές μετά την ακύρωση';
  end if;
  select count(*) into n
    from snap1 s join public.v_stock_balance b on b.item_id = s.item_id
   where b.on_hand <> s.on_hand or (s.on_hand > 0 and abs(b.avg_cost - s.avg_cost) > 0.000001);
  if n <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: % είδη δεν επανήλθαν μετά την ακύρωση', n; end if;
  if exists (select 1 from public.stock_move where item_id in (dough, marg)) then
    raise exception 'ΑΠΟΤΥΧΙΑ: έμειναν κινήσεις ζυμαριού/μαργαρίτας';
  end if;
  raise notice 'OK ακύρωση πώλησης: σβήστηκαν 2 επίπεδα αυτόματων, υπόλοιπα/κόστη όπως πριν';

  -- ξανά καταχώρηση: πάλι ακριβώς μία αυτόματη ανά επίπεδο
  perform public.post_document(s1);
  select count(*), min(id::text)::uuid into n, a1 from public.doc where source_doc_id = s1 and is_auto and status = 'posted';
  select count(*) into n2 from public.doc where source_doc_id = a1 and is_auto and status = 'posted';
  if n <> 1 or n2 <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ ξανακαταχώρηση: % / %', n, n2; end if;

  -- -------------------------------------------------------------------
  -- 6. Χειροκίνητη παραγωγή (όχι κατά παραγγελία) που αναλώνει αυτόματο ζυμάρι:
  --    πρώτα τα ζυμάρια του αποθέματος, αυτόματα μόνο όσα λείπουν
  -- -------------------------------------------------------------------
  -- 3/9: προετοιμασία 40 ζυμαριών με το χέρι (επιτρέπεται και για αυτόματο ημιέτοιμο)
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'production', '2026-09-03') returning id into p1;
  insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (p1, 1, 'output', dough, 40);
  perform public.post_document(p1);
  if exists (select 1 from public.doc where source_doc_id = p1) then raise exception 'ΑΠΟΤΥΧΙΑ: αυτόματη από παραγωγή ζυμαριού'; end if;
  select on_hand, avg_cost into v, v2 from public.v_stock_balance where item_id = dough;
  if v <> 40 or round(v2, 5) <> 0.13955 then raise exception 'ΑΠΟΤΥΧΙΑ ζυμάρι με το χέρι: % / %', v, v2; end if;
  -- 3/9: ακριβότερο αλεύρι, ώστε το αυτόματο ζυμάρι να έχει άλλο κόστος
  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', '2026-09-03', mill) returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (d, 1, flour, 100, 0.90, 13);
  perform public.post_document(d);

  create temp table snap2 on commit drop as
    select b.item_id, b.on_hand, b.avg_cost from public.v_stock_balance b where b.company_id = c;

  -- 4/9: 60 Special κατεψυγμένες (η ανάπτυξη συνταγής γίνεται στην καταχώρηση):
  -- 40 ζυμάρια από το απόθεμα + 20 αυτόματα
  select on_hand into v3 from public.v_stock_balance where item_id = flour;
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'production', '2026-09-04') returning id into p2;
  insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (p2, 1, 'output', special, 60);
  perform public.post_document(p2);
  select count(*), min(id::text)::uuid into n, a3 from public.doc where source_doc_id = p2 and is_auto and status = 'posted';
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: % αυτόματα ζυμάρια από παραγωγή', n; end if;
  if not exists (select 1 from public.doc x join public.doc_line o on o.doc_id = x.id and o.role = 'output'
                  where x.id = a3 and o.item_id = dough and o.qty = 20 and x.doc_date = '2026-09-04'
                    and x.notes = 'Αυτόματη παραγωγή από ΠΑ-' || (select doc_no from public.doc where id = p2)) then
    raise exception 'ΑΠΟΤΥΧΙΑ: λάθος αυτόματο ζυμάρι από παραγωγή (μόνο τα 20 που έλειπαν)';
  end if;
  if (select qty from public.doc_line where doc_id = p2 and role = 'input' and item_id = dough) <> 60 then
    raise exception 'ΑΠΟΤΥΧΙΑ: ανάλωση ζυμαριού της παραγωγής';
  end if;
  select on_hand, avg_cost into v, v2 from public.v_stock_balance where item_id = dough;
  if v <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ υπόλοιπο ζυμαριού (40+20-60=0): %', v; end if;
  if round(v2, 5) = 0.13955 then raise exception 'ΑΠΟΤΥΧΙΑ: το μέσο κόστος ζυμαριού δεν άλλαξε'; end if;
  select v3 - on_hand into v from public.v_stock_balance where item_id = flour;
  if v <> 3.25 then raise exception 'ΑΠΟΤΥΧΙΑ: αλεύρι μόνο για τα 20 αυτόματα (3.25): %', v; end if;
  select on_hand into v from public.v_stock_balance where item_id = special;
  if v <> 60 then raise exception 'ΑΠΟΤΥΧΙΑ υπόλοιπο special: %', v; end if;
  raise notice 'OK παραγωγή special: 40 ζυμάρια από απόθεμα + 20 αυτόματα, μέσο κόστος ζυμαριού %', round(v2, 6);

  perform public.unpost_document(p2);
  if exists (select 1 from public.doc where id = a3) then raise exception 'ΑΠΟΤΥΧΙΑ: έμεινε το αυτόματο ζυμάρι της παραγωγής'; end if;
  select count(*) into n
    from snap2 s join public.v_stock_balance b on b.item_id = s.item_id
   where b.on_hand <> s.on_hand or (s.on_hand > 0 and abs(b.avg_cost - s.avg_cost) > 0.000001);
  if n <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: % είδη δεν επανήλθαν μετά την ακύρωση παραγωγής', n; end if;
  select avg_cost into v from public.item where id = dough;
  if round(v, 6) <> 0.13955 then raise exception 'ΑΠΟΤΥΧΙΑ μέσο κόστος ζυμαριού μετά ακύρωση: %', v; end if;
  raise notice 'OK ακύρωση παραγωγής: σβήστηκε το αυτόματο ζυμάρι, μέσο κόστος ζυμαριού ξανά %', round(v, 6);
  perform public.post_document(p2);

  -- ημιέτοιμο αυτόματο χωρίς συνταγή: καθαρό μήνυμα
  update public.bom set is_active = false where id = b_dough;
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'production', '2026-09-05') returning id into d;
  insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (d, 1, 'output', special, 1);
  perform pg_temp.expect_fail(format('select public.post_document(%L)', d),
    'Το ημιέτοιμο "Ζυμάρι 250γρ" φτιάχνεται αυτόματα αλλά δεν έχει ενεργή συνταγή', 'αυτόματο ζυμάρι χωρίς συνταγή');
  update public.bom set is_active = true where id = b_dough;
  delete from public.doc where id = d;

  -- -------------------------------------------------------------------
  -- 7. Μετρητής ημέρας: tally_add
  -- -------------------------------------------------------------------
  t := public.tally_add(c, d10, 'efood', marg, 3);
  if t is null or not exists (select 1 from public.doc where id = t and doc_type = 'sale' and status = 'draft' and is_running
                                and channel = 'efood' and doc_date = d10 and partner_id is null and notes = 'Πωλήσεις ημέρας') then
    raise exception 'ΑΠΟΤΥΧΙΑ: δημιουργία μετρητή';
  end if;
  if not exists (select 1 from public.doc_line where doc_id = t and item_id = marg and qty = 3 and unit_price = 8 and vat_rate = 13 and line_no = 1) then
    raise exception 'ΑΠΟΤΥΧΙΑ: γραμμή μετρητή';
  end if;
  if not (select is_running from public.v_doc_list where id = t) then raise exception 'ΑΠΟΤΥΧΙΑ: v_doc_list.is_running'; end if;
  t2 := public.tally_add(c, d10, 'efood', marg, 2);
  if t2 is distinct from t or (select qty from public.doc_line where doc_id = t and item_id = marg) <> 5 then
    raise exception 'ΑΠΟΤΥΧΙΑ: αύξηση μετρητή';
  end if;
  t2 := public.tally_add(c, d10, 'efood', special, 1);
  if t2 is distinct from t or not exists (select 1 from public.doc_line where doc_id = t and item_id = special and qty = 1 and line_no = 2 and unit_price = 4.5) then
    raise exception 'ΑΠΟΤΥΧΙΑ: δεύτερο είδος στον μετρητή';
  end if;
  t2 := public.tally_add(c, d10, 'efood', marg, -5);
  if t2 is distinct from t or exists (select 1 from public.doc_line where doc_id = t and item_id = marg) then
    raise exception 'ΑΠΟΤΥΧΙΑ: μείωση στο 0 πρέπει να σβήνει τη γραμμή';
  end if;
  t2 := public.tally_add(c, d10, 'efood', special, -1);
  if t2 is not null or exists (select 1 from public.doc where id = t) then
    raise exception 'ΑΠΟΤΥΧΙΑ: άδειος μετρητής πρέπει να διαγράφεται';
  end if;
  -- μείωση χωρίς ανοιχτό μετρητή: τίποτα (ούτε κατανάλωση αρίθμησης)
  select last_no into n from public.doc_counter where company_id = c and doc_type = 'sale';
  t2 := public.tally_add(c, d10, 'efood', marg, -1);
  select last_no into n2 from public.doc_counter where company_id = c and doc_type = 'sale';
  if t2 is not null or n2 <> n or exists (select 1 from public.doc where company_id = c and doc_date = d10 and doc_type = 'sale') then
    raise exception 'ΑΠΟΤΥΧΙΑ: μείωση χωρίς μετρητή';
  end if;
  -- μείωση κάτω από το 0
  t := public.tally_add(c, d10, 'efood', marg, 2);
  t2 := public.tally_add(c, d10, 'efood', marg, -10);
  if t2 is not null or exists (select 1 from public.doc where id = t) then
    raise exception 'ΑΠΟΤΥΧΙΑ: μείωση κάτω από 0';
  end if;
  -- κλάσματα (μισή πίτσα) και διπλές γραμμές από χειροκίνητη επεξεργασία
  t := public.tally_add(c, d10, 'efood', marg, 0.5);
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (t, 7, marg, 2, 8, 13);
  t2 := public.tally_add(c, d10, 'efood', marg, 1);
  select count(*), sum(qty) into n, v from public.doc_line where doc_id = t and item_id = marg;
  if t2 is distinct from t or n <> 1 or v <> 3.5 then raise exception 'ΑΠΟΤΥΧΙΑ: ένωση διπλών γραμμών: % γραμμές, %', n, v; end if;
  t2 := public.tally_add(c, d10, 'efood', marg, -3.5);
  if t2 is not null then raise exception 'ΑΠΟΤΥΧΙΑ: καθάρισμα μετρητή'; end if;
  -- άλλο κανάλι / άλλη μέρα = άλλο παραστατικό
  t := public.tally_add(c, d10, 'efood', marg, 1);
  t2 := public.tally_add(c, d10, 'wolt', marg, 1);
  if t2 is null or t2 = t then raise exception 'ΑΠΟΤΥΧΙΑ: ίδιο παραστατικό για άλλο κανάλι'; end if;
  t2 := public.tally_add(c, d11, 'efood', marg, 1);
  if t2 is null or t2 = t then raise exception 'ΑΠΟΤΥΧΙΑ: ίδιο παραστατικό για άλλη μέρα'; end if;
  perform public.tally_add(c, d10, 'wolt', marg, -1);
  perform public.tally_add(c, d11, 'efood', marg, -1);
  perform public.tally_add(c, d10, 'efood', marg, -1);
  if exists (select 1 from public.doc where company_id = c and is_running) then raise exception 'ΑΠΟΤΥΧΙΑ: έμειναν μετρητές'; end if;

  -- λάθος είσοδοι
  sql := 'select public.tally_add(%L, %L, %L, %L, %L)';
  perform pg_temp.expect_fail(format(sql, c, d10, 'wholesale', marg, 1), 'Μη έγκυρο κανάλι λιανικής%', 'tally: κανάλι wholesale');
  perform pg_temp.expect_fail(format(sql, c, d10, 'skroutz', marg, 1), 'Μη έγκυρο κανάλι λιανικής%', 'tally: άγνωστο κανάλι');
  perform pg_temp.expect_fail(format(sql, c, d10, null, marg, 1), 'Μη έγκυρο κανάλι λιανικής%', 'tally: χωρίς κανάλι');
  perform pg_temp.expect_fail(format(sql, c, null, 'efood', marg, 1), 'Χρειάζεται ημερομηνία', 'tally: χωρίς ημερομηνία');
  perform pg_temp.expect_fail(format(sql, c, d10, 'efood', marg, 0), 'Μη έγκυρη ποσότητα', 'tally: 0');
  perform pg_temp.expect_fail(format(sql, c, d10, 'efood', marg, null), 'Μη έγκυρη ποσότητα', 'tally: null');
  perform pg_temp.expect_fail(format(sql, c, d10, 'efood', marg, 'NaN'), 'Μη έγκυρη ποσότητα', 'tally: NaN');
  perform pg_temp.expect_fail(format(sql, c, d10, 'efood', marg, 'Infinity'), 'Μη έγκυρη ποσότητα', 'tally: Infinity');
  perform pg_temp.expect_fail(format(sql, c, d10, 'efood', marg, '-Infinity'), 'Μη έγκυρη ποσότητα', 'tally: -Infinity');
  perform pg_temp.expect_fail(format(sql, c, d10, 'efood', marg, 0.00001), 'Μη έγκυρη ποσότητα', 'tally: σχεδόν 0');
  perform pg_temp.expect_fail(format(sql, c, d10, 'efood', marg, 1e9), 'Μη έγκυρη ποσότητα', 'tally: τεράστια ποσότητα');
  perform pg_temp.expect_fail(format(sql, c, d10, 'efood', flour, 1), 'Στις πωλήσεις ημέρας μπαίνουν μόνο έτοιμα%', 'tally: πρώτη ύλη');
  perform pg_temp.expect_fail(format(sql, c, d10, 'efood', dough, 1), 'Στις πωλήσεις ημέρας μπαίνουν μόνο έτοιμα%', 'tally: ημιέτοιμο');
  perform pg_temp.expect_fail(format(sql, c, d10, 'efood', foreign_item, 1), 'Δεν βρέθηκε το είδος', 'tally: είδος άλλης εταιρείας');
  perform pg_temp.expect_fail(format(sql, c, d10, 'efood', gen_random_uuid(), 1), 'Δεν βρέθηκε το είδος', 'tally: ανύπαρκτο είδος');
  perform pg_temp.expect_fail(format(sql, gen_random_uuid(), d10, 'efood', marg, 1), 'Δεν έχετε πρόσβαση%', 'tally: ανύπαρκτη εταιρεία');
  perform set_config('request.jwt.claim.sub', other::text, false);
  perform pg_temp.expect_fail(format(sql, c, d10, 'efood', marg, 1), 'Δεν έχετε πρόσβαση%', 'tally: μη μέλος');
  perform pg_temp.expect_fail(format(sql, c2, d10, 'efood', marg, 1), 'Δεν βρέθηκε το είδος', 'tally: δικό μου είδος σε ξένη εταιρεία');
  perform pg_temp.expect_fail(format('select public.stocktake_count(%L, %L, %L, %L)', c, d10, flour, 1), 'Δεν έχετε πρόσβαση%', 'απογραφή: μη μέλος');
  perform pg_temp.expect_fail(format('select * from public.close_running(%L, %L)', c, d15), 'Δεν έχετε πρόσβαση%', 'κλείσιμο: μη μέλος');
  perform set_config('request.jwt.claim.sub', '', false);
  perform pg_temp.expect_fail(format(sql, c, d10, 'efood', marg, 1), 'Δεν έχετε πρόσβαση%', 'tally: χωρίς σύνδεση');
  perform set_config('request.jwt.claim.sub', me::text, false);
  if exists (select 1 from public.doc where company_id = c and is_running) then raise exception 'ΑΠΟΤΥΧΙΑ: τα λάθη άφησαν μετρητή'; end if;
  raise notice 'OK tally_add';

  -- -------------------------------------------------------------------
  -- 8. Ένα ανοιχτό πρόχειρο ανά (εταιρεία, τύπος, ημέρα, κανάλι)
  -- -------------------------------------------------------------------
  t := public.tally_add(c, d10, 'efood', marg, 3);
  perform pg_temp.expect_fail(
    format('insert into public.doc (company_id, doc_type, doc_date, channel, is_running) values (%L, %L, %L, %L, true)', c, 'sale', d10, 'efood'),
    '%doc_one_running_draft%', 'δεύτερος ανοιχτός μετρητής');
  insert into public.doc (company_id, doc_type, doc_date, channel) values (c, 'sale', d10, 'efood') returning id into d;  -- απλό πρόχειρο: ναι
  delete from public.doc where id = d;
  perform pg_temp.expect_fail(
    format('insert into public.doc (company_id, doc_type, doc_date, partner_id, is_running) values (%L, %L, %L, %L, true)', c, 'purchase', d10, mill),
    '%doc_running_check%', 'ανοιχτή αγορά');
  raise notice 'OK μοναδικό ανοιχτό πρόχειρο';

  -- -------------------------------------------------------------------
  -- 9. Αυτόματο κλείσιμο προηγούμενων ημερών: close_running
  -- -------------------------------------------------------------------
  t10 := t;                                                     -- 10/9 efood: 3 μαργαρίτες
  t11 := public.tally_add(c, d11, 'wolt', pep, 2);              -- 11/9 wolt: πεπερόνι χωρίς συνταγή -> αποτυχία
  perform public.tally_add(c, d11, 'wolt', marg, 1);
  t12 := public.tally_add(c, d12, 'phone', marg, 4);            -- 12/9 τηλέφωνο
  perform public.tally_add(c, d12, 'phone', special, 1);
  t15 := public.tally_add(c, d15, 'store', marg, 1);            -- 15/9 = "σήμερα": μένει ανοιχτό
  insert into public.doc (company_id, doc_type, doc_date, channel, is_running) values (c, 'sale', d13, 'box', true) returning id into t13;  -- κενό
  -- απογραφή σε εξέλιξη: δεν κλείνει ποτέ αυτόματα (είδος που δεν κινεί ο
  -- μετρητής της 10/9, αλλιώς η πρώτη μέτρηση θα τον καταχωρούσε, ούτε
  -- κινείται μετά τις 10/9: αλλιώς η μέτρηση "τώρα" με ημερομηνία 10/9 δεν γίνεται)
  insert into public.item (company_id, code, name, item_type, unit) values (c, 'ΠΥ-099', 'Χαρτοπετσέτες', 'raw', 'τεμ') returning id into napkin;
  perform pg_temp.expect_fail(format('select public.stocktake_count(%L, %L, %L, %L)', c, d10, special, 50),
    'Το είδος "Special κατεψυγμένη" έχει ήδη κινήσεις της 12/09/2026%', 'μέτρηση με ημερομηνία πριν από κινήσεις του είδους');
  st := public.stocktake_count(c, d10, napkin, 50);
  if not exists (select 1 from public.doc where id = t10 and status = 'draft' and is_running) then
    raise exception 'ΑΠΟΤΥΧΙΑ: μέτρηση είδους καταχώρησε μετρητή που δεν το κινεί';
  end if;

  n := 0; n2 := 0;
  for r in select * from public.close_running(c, d15) loop
    n := n + 1;
    raise notice '   close_running: % ΠΩ-% % ok=% %', r.doc_date, r.doc_no, r.channel, r.ok, r.message;
    if (n = 1 and (r.doc_id <> t10 or not r.ok))
       or (n = 2 and (r.doc_id <> t11 or r.ok or r.message not like '%Πεπερόνι%συνταγή%'))
       or (n = 3 and (r.doc_id <> t12 or not r.ok or r.channel <> 'phone' or r.doc_date <> d12)) then
      raise exception 'ΑΠΟΤΥΧΙΑ close_running γραμμή %: %', n, row_to_json(r);
    end if;
  end loop;
  if n <> 3 then raise exception 'ΑΠΟΤΥΧΙΑ close_running: % γραμμές', n; end if;
  if (select count(*) from public.doc where id in (t10, t12) and status = 'posted' and not is_running) <> 2 then
    raise exception 'ΑΠΟΤΥΧΙΑ: δεν καταχωρήθηκαν οι σωστές μέρες';
  end if;
  if not exists (select 1 from public.doc where id = t11 and status = 'draft' and is_running)
     or exists (select 1 from public.doc where source_doc_id = t11)
     or exists (select 1 from public.stock_move where doc_id = t11) then
    raise exception 'ΑΠΟΤΥΧΙΑ: η αποτυχημένη μέρα δεν έμεινε ανέπαφη';
  end if;
  if not exists (select 1 from public.doc where id = t15 and status = 'draft' and is_running) then
    raise exception 'ΑΠΟΤΥΧΙΑ: έκλεισε η σημερινή μέρα';
  end if;
  if not exists (select 1 from public.doc where id = st and status = 'draft' and is_running) then
    raise exception 'ΑΠΟΤΥΧΙΑ: έκλεισε η απογραφή σε εξέλιξη';
  end if;
  if exists (select 1 from public.doc where id = t13) then raise exception 'ΑΠΟΤΥΧΙΑ: έμεινε κενός μετρητής'; end if;
  -- οι καταχωρημένες μέρες έφτιαξαν αυτόματη πίτσα + αυτόματο ζυμάρι
  select count(*) into n from public.doc a join public.doc b on b.source_doc_id = a.id
   where a.source_doc_id = t10 and a.is_auto and b.is_auto and a.status = 'posted' and b.status = 'posted';
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: αυτόματες παραγωγές της 10/9: %', n; end if;
  select customer_balance into v from public.v_partner_balance where partner_id = hotel;
  if v <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: χρέωση πελάτη από λιανική'; end if;
  raise notice 'OK close_running: 10/9 και 12/9 καταχωρήθηκαν, 11/9 απέτυχε χωρίς να σταματήσει τις άλλες';

  -- δεύτερη φορά: μόνο η αποτυχημένη· με συνταγή πλέον κλείνει
  select count(*) into n from public.close_running(c, d15) x where not x.ok and x.doc_id = t11;
  insert into public.bom (company_id, item_id, output_qty) values (c, pep, 1) returning id into b_pep;
  insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values
    (c, b_pep, 1, dough, 1), (c, b_pep, 2, sauce, 0.08), (c, b_pep, 3, mozz, 0.1), (c, b_pep, 4, box, 1);
  select count(*) into n2 from public.close_running(c, d15) x where x.ok and x.doc_id = t11;
  if n <> 1 or n2 <> 1 or not exists (select 1 from public.doc where id = t11 and status = 'posted' and not is_running) then
    raise exception 'ΑΠΟΤΥΧΙΑ: επανάληψη close_running (% / %)', n, n2;
  end if;
  select count(*) into n from public.close_running(c, d15);
  if n <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: close_running χωρίς δουλειά επέστρεψε %', n; end if;
  -- το "κλείσιμο ημέρας" για σήμερα είναι απλή καταχώρηση
  perform public.post_document(t15);
  if (select is_running from public.doc where id = t15) then raise exception 'ΑΠΟΤΥΧΙΑ: is_running μετά την καταχώρηση'; end if;
  t := public.tally_add(c, d15, 'store', marg, 1);
  if t is null or t = t15 then raise exception 'ΑΠΟΤΥΧΙΑ: ο μετρητής ξαναχρησιμοποίησε καταχωρημένο'; end if;
  perform public.tally_add(c, d15, 'store', marg, -1);
  raise notice 'OK close_running: ξανά μόνο η αποτυχημένη, μετά τη συνταγή κλείνει';

  -- -------------------------------------------------------------------
  -- 10. Απογραφή σε εξέλιξη: stocktake_count
  -- -------------------------------------------------------------------
  t := public.stocktake_count(c, d20, flour, 10);
  if t is null or not exists (select 1 from public.doc where id = t and doc_type = 'stocktake' and status = 'draft' and is_running
                                and doc_date = d20 and channel is null and notes = 'Απογραφή σε εξέλιξη') then
    raise exception 'ΑΠΟΤΥΧΙΑ: δημιουργία απογραφής σε εξέλιξη';
  end if;
  -- στιγμή πρώτης μέτρησης = θέση του μετρητή των κινήσεων εκείνη την ώρα
  select stock_cut into cut1 from public.doc_line where doc_id = t and item_id = flour;
  if cut1 is null or cut1 <> (select last_value from public.stock_move_id_seq)
     or cut1 < (select max(id) from public.stock_move) then
    raise exception 'ΑΠΟΤΥΧΙΑ: στιγμή μέτρησης %', cut1;
  end if;
  t2 := public.stocktake_count(c, d20, flour, 12);
  if t2 is distinct from t or (select qty from public.doc_line where doc_id = t and item_id = flour) <> 12 then
    raise exception 'ΑΠΟΤΥΧΙΑ: νέα μέτρηση';
  end if;
  t2 := public.stocktake_count(c, d20, flour, 3, true);
  if t2 is distinct from t or (select qty from public.doc_line where doc_id = t and item_id = flour) <> 15 then
    raise exception 'ΑΠΟΤΥΧΙΑ: πρόσθεση μέτρησης';
  end if;
  t2 := public.stocktake_count(c, d20, flour, -5, true);
  if t2 is distinct from t or (select qty from public.doc_line where doc_id = t and item_id = flour) <> 10 then
    raise exception 'ΑΠΟΤΥΧΙΑ: αφαίρεση από μέτρηση';
  end if;
  sql := 'select public.stocktake_count(%L, %L, %L, %L, %L)';
  perform pg_temp.expect_fail(format(sql, c, d20, flour, -20, true), 'Αρνητική μέτρηση για "Αλεύρι"', 'απογραφή: αρνητικό αποτέλεσμα');
  perform pg_temp.expect_fail(format(sql, c, d20, flour, -1, false), 'Αρνητική μέτρηση για "Αλεύρι"', 'απογραφή: αρνητική μέτρηση');
  perform pg_temp.expect_fail(format(sql, c, d20, flour, 'NaN', false), 'Μη έγκυρη ποσότητα', 'απογραφή: NaN');
  perform pg_temp.expect_fail(format(sql, c, d20, foreign_item, 1, false), 'Δεν βρέθηκε το είδος', 'απογραφή: είδος άλλης εταιρείας');
  perform pg_temp.expect_fail(format(sql, c, null, flour, 1, false), 'Χρειάζεται ημερομηνία', 'απογραφή: χωρίς ημερομηνία');
  if (select qty from public.doc_line where doc_id = t and item_id = flour) <> 10 then raise exception 'ΑΠΟΤΥΧΙΑ: τα λάθη άλλαξαν τη μέτρηση'; end if;
  -- μέτρηση 0 = "δεν έχουμε" (κρατιέται)· πρόσθεση σε είδος χωρίς γραμμή
  perform public.stocktake_count(c, d20, mozz, 0);
  perform public.stocktake_count(c, d20, special, 5, true);
  if (select count(*) from public.doc_line where doc_id = t) <> 3
     or (select qty from public.doc_line where doc_id = t and item_id = mozz) <> 0
     or (select qty from public.doc_line where doc_id = t and item_id = special) <> 5 then
    raise exception 'ΑΠΟΤΥΧΙΑ: μετρήσεις 0 / πρόσθεση σε νέο είδος';
  end if;
  -- διπλή γραμμή από χειροκίνητη επεξεργασία: η μέτρηση την ενώνει
  insert into public.doc_line (doc_id, line_no, item_id, qty) values (t, 9, special, 1);
  perform public.stocktake_count(c, d20, special, 2, true);
  select count(*), sum(qty) into n, v from public.doc_line where doc_id = t and item_id = special;
  if n <> 1 or v <> 8 then raise exception 'ΑΠΟΤΥΧΙΑ: ένωση διπλών γραμμών απογραφής: % / %', n, v; end if;
  -- null = αφαίρεση· άδεια απογραφή διαγράφεται
  t2 := public.stocktake_count(c, d20, flour, null);
  if t2 is distinct from t or exists (select 1 from public.doc_line where doc_id = t and item_id = flour) then
    raise exception 'ΑΠΟΤΥΧΙΑ: αφαίρεση είδους από απογραφή';
  end if;
  perform public.stocktake_count(c, d20, mozz, null);
  t2 := public.stocktake_count(c, d20, special, null);
  if t2 is not null or exists (select 1 from public.doc where id = t) then
    raise exception 'ΑΠΟΤΥΧΙΑ: άδεια απογραφή πρέπει να διαγράφεται';
  end if;
  if public.stocktake_count(c, d20, flour, null) is not null then raise exception 'ΑΠΟΤΥΧΙΑ: αφαίρεση χωρίς απογραφή'; end if;
  -- και η απογραφή σε εξέλιξη της 10/9 φεύγει
  t2 := public.stocktake_count(c, d10, napkin, null);
  if t2 is not null or exists (select 1 from public.doc where id = st) then
    raise exception 'ΑΠΟΤΥΧΙΑ: καθάρισμα απογραφής 10/9';
  end if;
  raise notice 'OK stocktake_count';

  -- -------------------------------------------------------------------
  -- 11. Απογραφή 30/9 μετά από αυτόματες παραγωγές δύο επιπέδων:
  --     λείπουν 2 kg αλεύρι (μετριέται μόνο το αλεύρι)
  -- -------------------------------------------------------------------
  v := public.item_on_hand(flour, d30);
  st30 := public.stocktake_count(c, d30, flour, v - 2);
  perform public.post_document(st30);
  if (select is_running from public.doc where id = st30) then raise exception 'ΑΠΟΤΥΧΙΑ: is_running στην καταχωρημένη απογραφή'; end if;

  -- αλεύρι που ανάλωσαν οι παραγωγές ζυμαριού (με το χέρι + αυτόματες):
  -- 81 ζυμάρια * 6.5 / 40 = 13.1625 kg
  select sum(-m.qty) into v_total from public.stock_move m
   where m.company_id = c and m.item_id = flour and m.move_type = 'prod_consume';
  if v_total <> 13.1625 then raise exception 'ΑΠΟΤΥΧΙΑ: ανάλωση αλευριού %', v_total; end if;
  select diff_value, allocated_value, unallocated_value into v, v2, v3 from public.v_stocktake_result where doc_id = st30 and item_id = flour;
  if v <= 0 or v2 <> v or v3 <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ επιμερισμός αλευριού: % / % / %', v, v2, v3; end if;

  -- επίπεδο 1: κάθε παραγωγή ζυμαριού (και οι αυτόματες) παίρνει μερίδιο ανάλογο με το αλεύρι της
  select count(*) into n
    from public.doc x
   where x.company_id = c and x.doc_type = 'production' and x.status = 'posted'
     and exists (select 1 from public.stock_move m where m.doc_id = x.id and m.item_id = flour);
  select count(*), count(*) filter (where x.is_auto) into n2, n3
    from public.cost_alloc ca join public.doc x on x.id = ca.production_doc_id
   where ca.stocktake_doc_id = st30 and ca.component_item_id = flour and ca.level = 1 and ca.produced_item_id = dough;
  -- 1 με το χέρι + 7 αυτόματα (πώληση 2/9, special 4/9, 10/9, 11/9 x2, 12/9, 15/9)
  if n2 <> n or n <> 8 or n3 <> 7 then
    raise exception 'ΑΠΟΤΥΧΙΑ: επιμερισμός αλευριού σε % (αυτόματες %) από % παραγωγές ζυμαριού', n2, n3, n;
  end if;
  select count(*) into n
    from public.cost_alloc ca
    join (select m.doc_id, sum(-m.qty) as q from public.stock_move m where m.item_id = flour and m.move_type = 'prod_consume' group by m.doc_id) f
      on f.doc_id = ca.production_doc_id
   where ca.stocktake_doc_id = st30 and ca.component_item_id = flour and ca.level = 1
     and abs(ca.cost_alloc - v * f.q / v_total) > 0.0002;
  if n <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: % μη αναλογικοί επιμερισμοί αλευριού', n; end if;
  a2 := (select b.id from public.doc a join public.doc b on b.source_doc_id = a.id where a.source_doc_id = s1);
  select cost_alloc into v2 from public.cost_alloc where stocktake_doc_id = st30 and production_doc_id = a2 and component_item_id = flour;
  if abs(v2 - v * 1.625 / 13.1625) > 0.0002 then raise exception 'ΑΠΟΤΥΧΙΑ: μερίδιο αυτόματου ζυμαριού της πώλησης %', v2; end if;
  raise notice 'OK επίπεδο 1: έλλειμμα αλευριού % -> 8 παραγωγές ζυμαριού (αυτόματο ζυμάρι πώλησης %)', v, v2;

  -- επίπεδο 2: ό,τι πήρε το ζυμάρι συνεχίζει στις πίτσες (αυτόματες) και στα special
  select sum(cost_alloc) into v2 from public.cost_alloc
   where stocktake_doc_id = st30 and component_item_id = dough and level = 2 and source = 'cascade' and production_doc_id is not null;
  if v2 <> v then raise exception 'ΑΠΟΤΥΧΙΑ cascade ζυμαριού: % <> %', v2, v; end if;
  select array_agg(distinct i.name) into names
    from public.cost_alloc ca join public.item i on i.id = ca.produced_item_id
   where ca.stocktake_doc_id = st30 and ca.component_item_id = dough and ca.source = 'cascade';
  if cardinality(names) <> 3 or not names @> array['Μαργαρίτα', 'Πεπερόνι', 'Special κατεψυγμένη'] then
    raise exception 'ΑΠΟΤΥΧΙΑ cascade σε: %', names;
  end if;
  -- (α) αυτόματο ζυμάρι μέσα σε παραγωγή: όλος ο επιμερισμός του στη γονική
  --     (π.χ. η αυτόματη μαργαρίτα της πώλησης παίρνει ακριβώς ό,τι πήρε το ζυμάρι της)
  a1 := (select id from public.doc where source_doc_id = s1);
  a2 := (select id from public.doc where source_doc_id = a1);
  select cost_alloc into v3 from public.cost_alloc where stocktake_doc_id = st30 and production_doc_id = a1 and component_item_id = dough;
  if v3 is distinct from (select sum(cost_alloc) from public.cost_alloc where stocktake_doc_id = st30 and production_doc_id = a2 and level = 1) then
    raise exception 'ΑΠΟΤΥΧΙΑ cascade στην αυτόματη μαργαρίτα: %', v3;
  end if;
  select count(*) into n
    from public.doc x join public.doc p on p.id = x.source_doc_id and p.doc_type = 'production'
   where x.company_id = c and x.is_auto and x.status = 'posted' and p.id <> p2
     and (select coalesce(sum(ca.cost_alloc), 0) from public.cost_alloc ca
           where ca.stocktake_doc_id = st30 and ca.production_doc_id = p.id and ca.component_item_id = dough and ca.source = 'cascade')
      <> (select coalesce(sum(ca.cost_alloc), 0) from public.cost_alloc ca
           where ca.stocktake_doc_id = st30 and ca.production_doc_id = x.id and ca.level = 1);
  if n <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: % αυτόματες πίτσες με cascade <> επιμερισμός του ζυμαριού τους', n; end if;
  -- (β) τα 40 ζυμάρια με το χέρι τα ανάλωσε από απόθεμα μόνο η παραγωγή special:
  --     εκείνη παίρνει όλο τον επιμερισμό τους (+ του δικού της αυτόματου ζυμαριού)
  a3 := (select id from public.doc where source_doc_id = p2);
  select sum(cost_alloc) into v4 from public.cost_alloc where stocktake_doc_id = st30 and production_doc_id = p2 and component_item_id = dough;
  if v4 is distinct from (select sum(cost_alloc) from public.cost_alloc
                           where stocktake_doc_id = st30 and production_doc_id in (p1, a3) and level = 1) then
    raise exception 'ΑΠΟΤΥΧΙΑ cascade στην παραγωγή special: %', v4;
  end if;
  if not (select is_final from public.v_production_cost where doc_id = a1)
     or (select alloc_cost from public.v_production_cost where doc_id = a1) <> v3 then
    raise exception 'ΑΠΟΤΥΧΙΑ: πραγματικό κόστος αυτόματης μαργαρίτας';
  end if;
  raise notice 'OK επίπεδο 2: cascade % -> πίτσες, αυτόματη μαργαρίτα πώλησης %, special (απόθεμα + αυτόματο) %', v2, v3, v4;

  -- -------------------------------------------------------------------
  -- 12. Κλειδώματα με αυτόματα επίπεδα
  -- -------------------------------------------------------------------
  -- νέα πώληση 29/9 (πριν από τη μέτρηση της 30/9): η πώληση και η αυτόματη
  -- μαργαρίτα δεν έχουν αλεύρι, το αυτόματο ζυμάρι όμως έχει -> κλειδωμένη περίοδος
  insert into public.doc (company_id, doc_type, doc_date, channel) values (c, 'sale', '2026-09-29', 'store') returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (d, 1, marg, 1, 8, 13);
  perform pg_temp.expect_fail(format('select public.post_document(%L)', d),
    'Κλειδωμένη περίοδος: υπάρχει απογραφή ΑΠ-%"Αλεύρι"%', 'κλείδωμα μέσω αυτόματου ζυμαριού');
  if exists (select 1 from public.doc where source_doc_id = d) then raise exception 'ΑΠΟΤΥΧΙΑ: έμειναν μισές αυτόματες'; end if;
  -- την ίδια μέρα με τη μέτρηση, γραμμένη μετά από αυτήν: περνάει (μετράει για μετά)
  update public.doc set doc_date = d30 where id = d;
  perform public.post_document(d);
  select stock_cut into cut1 from public.doc_line where doc_id = st30 and item_id = flour;
  if not exists (select 1 from public.stock_move m join public.doc b on b.id = m.doc_id join public.doc a on a.id = b.source_doc_id
                  where a.source_doc_id = d and m.item_id = flour and m.move_date = d30 and m.id > cut1) then
    raise exception 'ΑΠΟΤΥΧΙΑ: το αλεύρι της πώλησης 30/9 δεν είναι μετά τη μέτρηση';
  end if;
  -- δεν την περιλαμβάνει η μέτρηση: ακυρώνεται και ξανακαταχωρείται
  perform public.unpost_document(d);
  perform public.post_document(d);
  -- μετρητής: την ίδια μέρα με τη μέτρηση περνάει· σε παλιότερη μέρα η αύξηση
  -- απορρίπτεται αμέσως (αλλιώς θα έμενε πρόχειρο που δεν καταχωρείται ποτέ)·
  -- είδος που δεν κινεί αλεύρι (κατεψυγμένη) περνάει
  t := public.tally_add(c, d30, 'efood', marg, 2);
  if t is null then raise exception 'ΑΠΟΤΥΧΙΑ: μετρητής την ίδια μέρα με τη μέτρηση'; end if;
  if public.tally_add(c, d30, 'efood', marg, -2) is not null then raise exception 'ΑΠΟΤΥΧΙΑ: καθάρισμα μετρητή 30/9'; end if;
  perform pg_temp.expect_fail(format('select public.tally_add(%L, %L, %L, %L, %L)', c, d20, 'wolt', pep, 1),
    'Κλειδωμένη περίοδος%"Αλεύρι"%', 'μετρητής σε μέρα πριν από τη μέτρηση');
  t := public.tally_add(c, d20, 'box', special, 1);
  if t is null then raise exception 'ΑΠΟΤΥΧΙΑ: κατεψυγμένη σε μέρα κλειδωμένη μόνο για το αλεύρι'; end if;
  perform public.tally_add(c, d20, 'box', special, -1);
  -- μετρητής που έμεινε ανοιχτός σε κλειδωμένη μέρα (π.χ. από παλιότερη έκδοση): το
  -- close_running τον αναφέρει, και η μείωση επιτρέπεται για να καθαρίσει
  insert into public.doc (company_id, doc_type, doc_date, channel, is_running, notes)
  values (c, 'sale', '2026-09-29', 'efood', true, 'Πωλήσεις ημέρας') returning id into t;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (t, 1, marg, 2, 8, 13);
  select count(*) into n from public.close_running(c, '2026-10-01') x where x.doc_id = t and not x.ok and x.message like 'Κλειδωμένη περίοδος%';
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: close_running σε κλειδωμένη μέρα'; end if;
  t2 := public.tally_add(c, '2026-09-29', 'efood', marg, -2);
  if t2 is not null or exists (select 1 from public.doc where id = t) then
    raise exception 'ΑΠΟΤΥΧΙΑ: καθάρισμα μετρητή σε κλειδωμένη μέρα';
  end if;
  raise notice 'OK μετρητής: ίδια μέρα με τη μέτρηση περνάει, παλιότερη απορρίπτεται (εκτός από μείωση)';

  -- ακυρώσεις: παραγωγή με επιμερισμούς δεν ακυρώνεται (ούτε έμμεσα)
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', s1), '%επιμερισμούς κόστους από την απογραφή%', 'ακύρωση πώλησης με επιμερισμούς');
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', p2), '%επιμερισμούς κόστους από την απογραφή%', 'ακύρωση παραγωγής με επιμερισμούς');
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', p1), 'Κλειδωμένη περίοδος%', 'ακύρωση παραγωγής σε κλειδωμένη περίοδο');
  if (select count(*) from public.cost_alloc where stocktake_doc_id = st30) = 0 then raise exception 'ΑΠΟΤΥΧΙΑ: χάθηκαν επιμερισμοί'; end if;

  -- πρώτα η απογραφή, μετά η πώληση: φεύγουν όλα τα επίπεδα
  perform public.unpost_document(st30);
  perform public.unpost_document(s1);
  if exists (select 1 from public.doc where id in (a1, a2)) then raise exception 'ΑΠΟΤΥΧΙΑ: έμειναν αυτόματες της πώλησης'; end if;
  if (select is_running from public.doc where id = s1) then raise exception 'ΑΠΟΤΥΧΙΑ: απλή πώληση έγινε ανοιχτό πρόχειρο'; end if;
  -- καμία ορφανή αυτόματη παραγωγή
  if exists (select 1 from public.doc a left join public.doc s on s.id = a.source_doc_id
              where a.company_id = c and a.is_auto and (a.status <> 'posted' or s.status is distinct from 'posted')) then
    raise exception 'ΑΠΟΤΥΧΙΑ: ορφανές αυτόματες παραγωγές';
  end if;
  select on_hand into v from public.v_stock_balance where item_id = dough;
  if v <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ τελικό υπόλοιπο ζυμαριού (0): %', v; end if;
  raise notice 'OK κλειδώματα και ακυρώσεις με αυτόματα επίπεδα';

  -- -------------------------------------------------------------------
  -- 13. Δύο μηνιαίες απογραφές αλευριού: το έλλειμμα του Νοεμβρίου πέφτει
  --     μόνο σε παραγωγές του Νοεμβρίου, όχι σε πίτσες κλεισμένων μηνών
  --     (το αυτόματο ζυμάρι δεν μετριέται ποτέ)
  -- -------------------------------------------------------------------
  t := public.tally_add(c, '2026-10-10', 'efood', marg, 30);
  perform public.post_document(t);
  st := public.stocktake_count(c, '2026-10-31', flour, public.item_on_hand(flour, '2026-10-31'));
  perform public.post_document(st);
  if exists (select 1 from public.cost_alloc where stocktake_doc_id = st) then
    raise exception 'ΑΠΟΤΥΧΙΑ: απογραφή χωρίς διαφορά έγραψε επιμερισμούς';
  end if;
  -- Νοέμβριος: 10 ζυμάρια με το χέρι (5/11) -> 10 Special από το απόθεμα (6/11),
  -- 10 πεπερόνι από τον μετρητή (10/11, αυτόματο ζυμάρι)
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'production', '2026-11-05') returning id into p3;
  insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (p3, 1, 'output', dough, 10);
  perform public.post_document(p3);
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'production', '2026-11-06') returning id into p4;
  insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (p4, 1, 'output', special, 10);
  perform public.post_document(p4);
  if exists (select 1 from public.doc where source_doc_id = p4) then raise exception 'ΑΠΟΤΥΧΙΑ: αυτόματο ζυμάρι ενώ υπήρχε απόθεμα'; end if;
  t := public.tally_add(c, '2026-11-10', 'efood', pep, 10);
  perform public.post_document(t);
  a4 := (select id from public.doc where source_doc_id = t);
  st := public.stocktake_count(c, '2026-11-30', flour, public.item_on_hand(flour, '2026-11-30') - 1);
  perform public.post_document(st);
  select diff_value, allocated_value into v, v2 from public.v_stocktake_result where doc_id = st and item_id = flour;
  if v <= 0 or v2 <> v then raise exception 'ΑΠΟΤΥΧΙΑ επιμερισμός Νοεμβρίου: % / %', v, v2; end if;
  -- επίπεδο 1: μόνο οι δύο παραγωγές ζυμαριού του Νοεμβρίου (10 + 10 ζυμάρια, μισό-μισό)
  select count(*) into n from public.cost_alloc ca join public.doc x on x.id = ca.production_doc_id
   where ca.stocktake_doc_id = st and ca.level = 1 and x.doc_date > '2026-10-31';
  select count(*) into n2 from public.cost_alloc ca where ca.stocktake_doc_id = st and ca.level = 1;
  if n <> 2 or n2 <> 2 then raise exception 'ΑΠΟΤΥΧΙΑ επίπεδο 1 Νοεμβρίου: % από %', n, n2; end if;
  -- επίπεδο 2: τίποτα σε παραγωγές πριν από 31/10
  if exists (select 1 from public.cost_alloc ca join public.doc x on x.id = ca.production_doc_id
              where ca.stocktake_doc_id = st and x.doc_date <= '2026-10-31') then
    raise exception 'ΑΠΟΤΥΧΙΑ: το έλλειμμα του Νοεμβρίου έπεσε σε παραγωγές κλεισμένων μηνών';
  end if;
  select sum(cost_alloc) into v2 from public.cost_alloc where stocktake_doc_id = st and level = 2 and source = 'cascade';
  if v2 <> v then raise exception 'ΑΠΟΤΥΧΙΑ cascade Νοεμβρίου: % <> %', v2, v; end if;
  -- τα ζυμάρια με το χέρι -> Special (που τα ανάλωσε), το αυτόματο -> πεπερόνι
  if (select sum(cost_alloc) from public.cost_alloc where stocktake_doc_id = st and production_doc_id = p4 and level = 2)
     is distinct from (select sum(cost_alloc) from public.cost_alloc where stocktake_doc_id = st and production_doc_id = p3 and level = 1)
     or (select sum(cost_alloc) from public.cost_alloc where stocktake_doc_id = st and production_doc_id = a4 and level = 2)
     is distinct from (select sum(cost_alloc) from public.cost_alloc ca join public.doc x on x.id = ca.production_doc_id
                        where ca.stocktake_doc_id = st and x.source_doc_id = a4 and ca.level = 1) then
    raise exception 'ΑΠΟΤΥΧΙΑ: cascade Νοεμβρίου στις σωστές παραγωγές';
  end if;
  raise notice 'OK δύο απογραφές: έλλειμμα Νοεμβρίου % μόνο σε παραγωγές Νοεμβρίου', v;

  -- -------------------------------------------------------------------
  -- 14. Απογραφή με ανοιχτές πωλήσεις ημέρας: όσες κινούν είδη της
  --     καταχωρούνται πρώτα (αλλιώς η κατανάλωσή τους θα έβγαινε έλλειμμα)
  -- -------------------------------------------------------------------
  t := public.tally_add(c, '2026-12-05', 'efood', marg, 4);
  t2 := public.tally_add(c, '2026-12-05', 'box', special, 1);    -- κατεψυγμένη από απόθεμα: δεν κινεί αλεύρι
  t3 := public.tally_add(c, '2026-12-04', 'phone', marg, 1);     -- προηγούμενη μέρα, ακόμα ανοιχτή
  v := public.item_on_hand(flour, '2026-12-05') - 5 * 6.5 / 40;  -- το αλεύρι που υπάρχει πραγματικά
  st := public.stocktake_count(c, '2026-12-05', flour, v);
  -- η πρώτη μέτρηση του αλευριού καταχώρησε ήδη τις πωλήσεις ως εκείνη τη στιγμή
  if (select count(*) from public.doc where id in (t, t3) and status = 'posted' and not is_running) <> 2 then
    raise exception 'ΑΠΟΤΥΧΙΑ: δεν καταχωρήθηκαν οι ανοιχτές πωλήσεις στην πρώτη μέτρηση';
  end if;
  if not exists (select 1 from public.doc where id = t2 and status = 'draft' and is_running) then
    raise exception 'ΑΠΟΤΥΧΙΑ: έκλεισε πώληση ημέρας που δεν κινεί είδη της απογραφής';
  end if;
  if (select stock_cut from public.doc_line where doc_id = st and item_id = flour) <> (select last_value from public.stock_move_id_seq) then
    raise exception 'ΑΠΟΤΥΧΙΑ: στιγμή μέτρησης μετά τις πωλήσεις ημέρας';
  end if;
  perform public.post_document(st);
  select expected_qty, diff_qty into v2, v3 from public.v_stocktake_result where doc_id = st and item_id = flour;
  if v2 <> v or v3 <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: η απογραφή δεν είδε τις πωλήσεις ημέρας (% / %)', v2, v3; end if;
  -- κι άλλες πωλήσεις την ίδια μέρα, μετά τη μέτρηση: νέος μετρητής, κλείνει κανονικά
  t4 := public.tally_add(c, '2026-12-05', 'efood', marg, 1);
  if t4 is null or t4 = t or not (select is_running from public.doc where id = t4) then
    raise exception 'ΑΠΟΤΥΧΙΑ: μετρητής μετά την απογραφή της ημέρας';
  end if;
  if public.tally_add(c, '2026-12-05', 'box', special, 1) is distinct from t2 then
    raise exception 'ΑΠΟΤΥΧΙΑ: μετρητής κατεψυγμένης μετά την απογραφή αλευριού';
  end if;
  perform public.post_document(t2);
  perform public.post_document(t4);

  -- πώληση ημέρας που δεν καταχωρείται: η μέτρηση αποτυγχάνει με καθαρό μήνυμα
  t := public.tally_add(c, '2026-12-10', 'store', marg, 1);
  update public.bom set is_active = false where id = b_dough;
  perform pg_temp.expect_fail(format('select public.stocktake_count(%L, %L, %L, %L)', c, '2026-12-10', mozz, 1),
    'Πρώτα πρέπει να καταχωρηθούν οι πωλήσεις ημέρας ΠΩ-% (10/12 store): Το ημιέτοιμο "Ζυμάρι 250γρ"%συνταγή',
    'μέτρηση με πώληση ημέρας που αποτυγχάνει');
  if not exists (select 1 from public.doc where id = t and status = 'draft' and is_running)
     or exists (select 1 from public.doc where company_id = c and doc_type = 'stocktake' and doc_date = '2026-12-10') then
    raise exception 'ΑΠΟΤΥΧΙΑ: η αποτυχημένη μέτρηση άφησε αλλαγές';
  end if;
  update public.bom set is_active = true where id = b_dough;
  -- πρόχειρο που κόλλησε σε ημέρα ήδη κλειδωμένη (4/12, από το αλεύρι της 5/12): δεν μπλοκάρει
  insert into public.doc (company_id, doc_type, doc_date, channel, is_running, notes)
  values (c, 'sale', '2026-12-04', 'wolt', true, 'Πωλήσεις ημέρας') returning id into t3;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (t3, 1, marg, 1, 8, 13);
  st := public.stocktake_count(c, '2026-12-10', mozz, public.item_on_hand(mozz, '2026-12-10') - 0.12);
  perform public.post_document(st);
  if not exists (select 1 from public.doc where id = t and status = 'posted')
     or not exists (select 1 from public.doc where id = t3 and status = 'draft' and is_running)
     or (select diff_qty from public.doc_line where doc_id = st) <> 0 then
    raise exception 'ΑΠΟΤΥΧΙΑ: απογραφή μοτσαρέλας με ανοιχτές πωλήσεις';
  end if;
  t2 := public.tally_add(c, '2026-12-04', 'wolt', marg, -1);
  if t2 is not null or exists (select 1 from public.doc where id = t3) then
    raise exception 'ΑΠΟΤΥΧΙΑ: καθάρισμα κολλημένου μετρητή';
  end if;
  raise notice 'OK απογραφή με ανοιχτές πωλήσεις ημέρας';

  -- -------------------------------------------------------------------
  -- 15. Ακύρωση πωλήσεων ημέρας: ξαναγίνονται ανοιχτό πρόχειρο
  -- -------------------------------------------------------------------
  t := public.tally_add(c, '2026-12-12', 'efood', marg, 5);
  select count(*) into n from public.close_running(c, '2026-12-13') x where x.doc_id = t and x.ok;
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: κλείσιμο 12/12'; end if;
  perform public.unpost_document(t);
  if not exists (select 1 from public.doc where id = t and status = 'draft' and is_running) then
    raise exception 'ΑΠΟΤΥΧΙΑ: οι ακυρωμένες πωλήσεις ημέρας δεν ξανάνοιξαν';
  end if;
  t2 := public.tally_add(c, '2026-12-12', 'efood', marg, 1);
  if t2 is distinct from t or (select qty from public.doc_line where doc_id = t) <> 6 then
    raise exception 'ΑΠΟΤΥΧΙΑ: ο μετρητής δεν συνέχισε στο ίδιο παραστατικό';
  end if;
  select count(*) into n from public.close_running(c, '2026-12-13') x where x.doc_id = t and x.ok;
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: ξανακλείσιμο 12/12'; end if;
  -- άνοιξε νέος μετρητής για την ίδια μέρα: το ακυρωμένο μένει απλό πρόχειρο
  t2 := public.tally_add(c, '2026-12-12', 'efood', marg, 1);
  perform public.unpost_document(t);
  if (select is_running from public.doc where id = t) or not (select is_running from public.doc where id = t2) then
    raise exception 'ΑΠΟΤΥΧΙΑ: δύο ανοιχτοί μετρητές για την ίδια μέρα';
  end if;
  delete from public.doc where id = t;
  perform public.tally_add(c, '2026-12-12', 'efood', marg, -1);
  raise notice 'OK ακύρωση πωλήσεων ημέρας: ξανανοίγουν';

  -- -------------------------------------------------------------------
  -- 16. Συστατικό που στρογγυλεύεται στο 0 σε ένα αυτόματο ζυμάρι
  -- -------------------------------------------------------------------
  insert into public.item (company_id, code, name, item_type, unit) values (c, 'ΠΥ-009', 'Βελτιωτικό', 'raw', 'kg') returning id into imp;
  insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values (c, b_dough, 6, imp, 0.0015);
  t := public.tally_add(c, '2026-12-14', 'box', marg, 1);
  perform public.post_document(t);
  if exists (select 1 from public.doc_line where item_id = imp) then raise exception 'ΑΠΟΤΥΧΙΑ: γραμμή 0 βελτιωτικού'; end if;
  -- σε παρτίδα 40 μπαίνει κανονικά
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'production', '2026-12-14') returning id into d;
  insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (d, 1, 'output', dough, 40);
  perform public.explode_bom(d);
  if (select qty from public.doc_line where doc_id = d and item_id = imp) <> 0.0015 then raise exception 'ΑΠΟΤΥΧΙΑ: βελτιωτικό σε παρτίδα'; end if;
  delete from public.doc where id = d;
  delete from public.bom_line where bom_id = b_dough and component_item_id = imp;
  raise notice 'OK συστατικό που στρογγυλεύεται στο 0 παραλείπεται';

  -- -------------------------------------------------------------------
  -- 17. Ζυμάρια σε απόθεμα αναλώνονται πρώτα· αυτόματα μόνο όσα λείπουν,
  --     και ποτέ "δανεικά" από μεταγενέστερη ημέρα
  -- -------------------------------------------------------------------
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'production', '2026-12-16') returning id into p3;
  insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (p3, 1, 'output', dough, 5);
  perform public.post_document(p3);
  -- 15/12: τα ζυμάρια δεν υπήρχαν ακόμα -> όλα αυτόματα
  t := public.tally_add(c, '2026-12-15', 'store', marg, 2);
  perform public.post_document(t);
  select o.qty into v from public.doc a join public.doc b on b.source_doc_id = a.id join public.doc_line o on o.doc_id = b.id and o.role = 'output'
   where a.source_doc_id = t;
  if v is distinct from 2 or public.item_on_hand(dough) <> 5 then raise exception 'ΑΠΟΤΥΧΙΑ 15/12: αυτόματα %', v; end if;
  -- 16/12: 8 πίτσες = 5 από απόθεμα + 3 αυτόματα
  v2 := public.item_on_hand(flour);
  t := public.tally_add(c, '2026-12-16', 'store', marg, 8);
  perform public.post_document(t);
  select o.qty into v from public.doc a join public.doc b on b.source_doc_id = a.id join public.doc_line o on o.doc_id = b.id and o.role = 'output'
   where a.source_doc_id = t;
  if v is distinct from 3 or public.item_on_hand(dough) <> 0 or v2 - public.item_on_hand(flour) <> 3 * 6.5 / 40 then
    raise exception 'ΑΠΟΤΥΧΙΑ 16/12: αυτόματα %, ζυμάρι %', v, public.item_on_hand(dough);
  end if;
  -- 17/12: 5 με το χέρι, όλα πουλημένα στις 18/12· πώληση 17/12 περασμένη μετά: αυτόματα
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'production', '2026-12-17') returning id into p4;
  insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (p4, 1, 'output', dough, 5);
  perform public.post_document(p4);
  t := public.tally_add(c, '2026-12-18', 'store', marg, 5);
  perform public.post_document(t);
  if exists (select 1 from public.doc a join public.doc b on b.source_doc_id = a.id where a.source_doc_id = t) then
    raise exception 'ΑΠΟΤΥΧΙΑ 18/12: αυτόματο ζυμάρι ενώ υπήρχε απόθεμα';
  end if;
  t2 := public.tally_add(c, '2026-12-17', 'phone', marg, 3);
  perform public.post_document(t2);
  select o.qty into v from public.doc a join public.doc b on b.source_doc_id = a.id join public.doc_line o on o.doc_id = b.id and o.role = 'output'
   where a.source_doc_id = t2;
  if v is distinct from 3 or public.item_on_hand(dough) <> 0
     or exists (select 1 from public.v_item_ledger where item_id = dough and running_qty < 0) then
    raise exception 'ΑΠΟΤΥΧΙΑ 17/12: αυτόματα %, ζυμάρι %', v, public.item_on_hand(dough);
  end if;
  -- ακύρωση και ξανά καταχώρηση: ίδιο αποτέλεσμα
  perform public.unpost_document(t);
  perform public.post_document(t);
  if exists (select 1 from public.doc a join public.doc b on b.source_doc_id = a.id where a.source_doc_id = t)
     or public.item_on_hand(dough) <> 0 then
    raise exception 'ΑΠΟΤΥΧΙΑ: ξανακαταχώρηση 18/12';
  end if;
  raise notice 'OK ζυμάρια από απόθεμα πρώτα, αυτόματα μόνο όσα λείπουν';

  -- -------------------------------------------------------------------
  -- 18. Ασφάλεια: σύνδεση/αυτόματο μόνο από τις functions· συνταγές και
  --     τιμές μόνο με είδη και πελάτες της ίδιας εταιρείας
  -- -------------------------------------------------------------------
  insert into public.doc (company_id, doc_type, doc_date, channel) values (c, 'sale', '2026-12-20', 'store') returning id into d;
  perform pg_temp.expect_fail(
    format('insert into public.doc (company_id, doc_type, doc_date, partner_id, source_doc_id) values (%L, %L, %L, %L, %L)', c, 'purchase', '2026-12-20', mill, d),
    '%row-level security%', 'πρόχειρο με source_doc_id');
  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', '2026-12-20', mill) returning id into t;
  perform pg_temp.expect_fail(format('update public.doc set source_doc_id = %L where id = %L', d, t),
    '%row-level security%', 'αλλαγή source_doc_id');
  perform pg_temp.expect_fail(format('update public.doc set is_auto = true where id = %L', d),
    '%row-level security%', 'αλλαγή is_auto');
  delete from public.doc where id in (d, t);
  if (select confdeltype from pg_constraint where conrelid = 'public.doc'::regclass and conname = 'doc_source_doc_id_fkey') <> 'a' then
    raise exception 'ΑΠΟΤΥΧΙΑ: το source_doc_id σβήνει με cascade';
  end if;
  perform pg_temp.expect_fail(
    format('insert into public.doc (company_id, doc_type, doc_date, channel, is_running) values (%L, %L, %L, %L, true)', c, 'stocktake', '2026-12-20', 'efood'),
    '%doc_running_check%', 'ανοιχτή απογραφή με κανάλι');
  perform set_config('request.jwt.claim.sub', other::text, false);
  perform pg_temp.expect_fail(format('insert into public.bom (company_id, item_id, output_qty) values (%L, %L, 1)', c2, dough),
    'Το είδος της συνταγής ανήκει σε άλλη εταιρεία', 'συνταγή για είδος άλλης εταιρείας');
  insert into public.bom (company_id, item_id, output_qty) values (c2, foreign_item, 1) returning id into b_x;
  perform pg_temp.expect_fail(format('insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values (%L, %L, 1, %L, 5)', c2, b_x, mozz),
    'Το συστατικό ανήκει σε άλλη εταιρεία', 'συστατικό άλλης εταιρείας');
  perform pg_temp.expect_fail(format('insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values (%L, %L, 9, %L, 5)', c2, b_marg, foreign_item),
    'Η γραμμή συνταγής ανήκει σε άλλη εταιρεία%', 'γραμμή σε συνταγή άλλης εταιρείας');
  perform pg_temp.expect_fail(format('insert into public.partner_price (company_id, partner_id, item_id, price) values (%L, %L, %L, 1)', c2, hotel, foreign_item),
    'Ο πελάτης ή το είδος ανήκει σε άλλη εταιρεία', 'τιμή για πελάτη άλλης εταιρείας');
  delete from public.bom where id = b_x;
  perform set_config('request.jwt.claim.sub', me::text, false);
  if (select count(*) from public.bom where item_id = dough) <> 1 or (select count(*) from public.bom_line where bom_id = b_marg) <> 4 then
    raise exception 'ΑΠΟΤΥΧΙΑ: άλλαξαν οι συνταγές μας';
  end if;
  raise notice 'OK ασφάλεια: source_doc_id/is_auto, συνταγές και τιμές ίδιας εταιρείας';

  -- -------------------------------------------------------------------
  -- 19. Μέτρηση στη μέση της μέρας (μερική απογραφή αλευριού): μετράει τη
  --     στιγμή που λέγεται. Πρωί: αγορά και πωλήσεις -> «αλεύρι 20 κιλά»
  --     στην αποθήκη -> απόγευμα: κι άλλες πωλήσεις και αγορά την ίδια
  --     μέρα -> «αλεύρι άλλα … κιλά» στο ψυγείο -> «τέλος απογραφής»
  -- -------------------------------------------------------------------
  -- αφετηρία: μέτρηση 5/1 χωρίς διαφορά (κλείνει την προηγούμενη περίοδο)
  st := public.stocktake_count(c, '2027-01-05', flour, public.item_on_hand(flour, '2027-01-05'));
  perform public.post_document(st);
  -- πρωί 10/1
  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', '2027-01-10', mill) returning id into pm;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (pm, 1, flour, 10, 0.68, 13);
  perform public.post_document(pm);
  t := public.tally_add(c, '2027-01-10', 'efood', marg, 3);       -- κινεί αλεύρι (αυτόματο ζυμάρι)
  t2 := public.tally_add(c, '2027-01-10', 'box', special, 1);     -- δεν κινεί αλεύρι
  -- πραγματικό αλεύρι = βιβλία - πρωινή κατανάλωση - 0,5 kg έλλειμμα
  v := public.item_on_hand(flour, '2027-01-10') - 3 * 6.5 / 40 - 0.5;
  st := public.stocktake_count(c, '2027-01-10', flour, 20);       -- «αλεύρι 20 κιλά» (αποθήκη)
  select stock_cut into cut1 from public.doc_line where doc_id = st and item_id = flour;
  if not exists (select 1 from public.doc where id = t and status = 'posted' and not is_running) then
    raise exception 'ΑΠΟΤΥΧΙΑ: η πρώτη μέτρηση δεν καταχώρησε τις πρωινές πωλήσεις';
  end if;
  if not exists (select 1 from public.doc where id = t2 and status = 'draft' and is_running) then
    raise exception 'ΑΠΟΤΥΧΙΑ: η μέτρηση αλευριού καταχώρησε πωλήσεις που δεν το κινούν';
  end if;
  if cut1 is distinct from (select last_value from public.stock_move_id_seq)
     or not exists (select 1 from public.stock_move m join public.doc b on b.id = m.doc_id join public.doc a on a.id = b.source_doc_id
                     where a.source_doc_id = t and m.item_id = flour and m.id <= cut1) then
    raise exception 'ΑΠΟΤΥΧΙΑ: στιγμή πρώτης μέτρησης %', cut1;
  end if;
  -- απόγευμα, ίδια μέρα: κι άλλες πωλήσεις (νέος μετρητής) και αγορά αλευριού
  t3 := public.tally_add(c, '2027-01-10', 'efood', marg, 2);
  if t3 is null or t3 = t or not (select is_running and status = 'draft' from public.doc where id = t3) then
    raise exception 'ΑΠΟΤΥΧΙΑ: μετρητής μετά τη μέτρηση της ίδιας μέρας';
  end if;
  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', '2027-01-10', mill) returning id into p3;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (p3, 1, flour, 25, 0.70, 13);
  perform public.post_document(p3);
  -- «αλεύρι άλλα … κιλά» (ψυγείο): πρόσθεση, ίδια στιγμή μέτρησης
  perform public.stocktake_count(c, '2027-01-10', flour, v - 20, true);
  if (select qty from public.doc_line where doc_id = st and item_id = flour) <> v
     or (select stock_cut from public.doc_line where doc_id = st and item_id = flour) is distinct from cut1 then
    raise exception 'ΑΠΟΤΥΧΙΑ: πρόσθεση δεύτερου δωματίου (% / στιγμή %)',
      (select qty from public.doc_line where doc_id = st and item_id = flour),
      (select stock_cut from public.doc_line where doc_id = st and item_id = flour);
  end if;
  -- κλείσιμο του απογευματινού efood πριν από το «τέλος απογραφής», κι ένα
  -- τηλέφωνο που μένει ανοιχτό ως μετά
  perform public.post_document(t3);
  t4 := public.tally_add(c, '2027-01-10', 'phone', marg, 1);
  v2 := public.item_on_hand(flour);
  perform public.post_document(st);                               -- «τέλος απογραφής»
  select expected_qty, diff_qty into v3, v4 from public.doc_line where doc_id = st and item_id = flour;
  if v3 <> v + 0.5 or v4 <> -0.5 then
    raise exception 'ΑΠΟΤΥΧΙΑ: αναμενόμενο μέτρησης στη μέση της μέρας: % / % (σωστό % / -0.5)', v3, v4, v + 0.5;
  end if;
  if not exists (select 1 from public.doc where id = t4 and status = 'draft' and is_running) then
    raise exception 'ΑΠΟΤΥΧΙΑ: το «τέλος απογραφής» καταχώρησε πωλήσεις μετά τη μέτρηση';
  end if;
  -- υπόλοιπο μετά τη διόρθωση = μέτρηση + κινήσεις μετά τη μέτρηση
  if public.item_on_hand(flour) <> v + 25 - 2 * 6.5 / 40 or public.item_on_hand(flour) <> v2 - 0.5 then
    raise exception 'ΑΠΟΤΥΧΙΑ: υπόλοιπο μετά τη διόρθωση % (σωστό %)', public.item_on_hand(flour), v + 25 - 2 * 6.5 / 40;
  end if;
  -- κλείσιμο ημέρας μετά το «τέλος απογραφής»: περνάει
  perform public.post_document(t4);
  perform public.post_document(t2);
  -- επιμερισμός: το έλλειμμα μόνο στο πρωινό αυτόματο ζυμάρι, όχι στα απογευματινά
  select count(*) into n from public.cost_alloc where stocktake_doc_id = st and level = 1;
  select count(*) into n2
    from public.cost_alloc ca join public.doc b on b.id = ca.production_doc_id join public.doc a on a.id = b.source_doc_id
   where ca.stocktake_doc_id = st and ca.level = 1 and a.source_doc_id = t;
  select diff_value, allocated_value into v3, v4 from public.v_stocktake_result where doc_id = st and item_id = flour;
  if n <> 1 or n2 <> 1 or v3 <= 0 or v4 <> v3 then
    raise exception 'ΑΠΟΤΥΧΙΑ: επιμερισμός μέτρησης στη μέση της μέρας: % (πρωινά %), % / %', n, n2, v3, v4;
  end if;
  -- κλειδώματα: ό,τι είναι πριν από τη μέτρηση κλειδώνει, ό,τι είναι μετά όχι
  insert into public.doc (company_id, doc_type, doc_date, channel) values (c, 'sale', '2027-01-09', 'store') returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (d, 1, marg, 1, 8, 13);
  perform pg_temp.expect_fail(format('select public.post_document(%L)', d),
    'Κλειδωμένη περίοδος: υπάρχει απογραφή ΑΠ-%"Αλεύρι"%', 'πώληση με ημερομηνία πριν από τη μέτρηση');
  delete from public.doc where id = d;
  perform pg_temp.expect_fail(format('select public.tally_add(%L, %L, %L, %L, %L)', c, '2027-01-09', 'efood', marg, 1),
    'Κλειδωμένη περίοδος%"Αλεύρι"%', 'μετρητής την προηγούμενη μέρα της μέτρησης');
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', pm),
    'Κλειδωμένη περίοδος: το είδος "Αλεύρι" μετρήθηκε στην απογραφή ΑΠ-% μετά από αυτή την κίνηση%', 'ακύρωση πρωινής αγοράς (πριν από τη μέτρηση)');
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', t),
    '%απογραφή ΑΠ-%', 'ακύρωση πρωινών πωλήσεων (πριν από τη μέτρηση)');
  perform public.unpost_document(p3);                              -- απογευματινή αγορά
  perform public.post_document(p3);
  perform public.unpost_document(t3);                              -- απογευματινές πωλήσεις
  if not (select is_running from public.doc where id = t3) then raise exception 'ΑΠΟΤΥΧΙΑ: οι απογευματινές πωλήσεις δεν ξανάνοιξαν'; end if;
  perform public.post_document(t3);
  -- επόμενη μέτρηση (15/1): η απογευματινή κατανάλωση της 10/1 πέφτει εδώ, δεν χάνεται
  st2 := public.stocktake_count(c, '2027-01-15', flour, public.item_on_hand(flour, '2027-01-15') - 0.25);
  perform public.post_document(st2);
  select count(*) into n from public.cost_alloc where stocktake_doc_id = st2 and level = 1;
  select count(*) into n2
    from public.cost_alloc ca join public.doc b on b.id = ca.production_doc_id join public.doc a on a.id = b.source_doc_id
   where ca.stocktake_doc_id = st2 and ca.level = 1 and a.source_doc_id in (t3, t4);
  select diff_value, allocated_value into v3, v4 from public.v_stocktake_result where doc_id = st2 and item_id = flour;
  if n <> 2 or n2 <> 2 or v3 <= 0 or v4 <> v3 then
    raise exception 'ΑΠΟΤΥΧΙΑ: η απογευματινή κατανάλωση στην επόμενη περίοδο: % (απογευματινά %), % / %', n, n2, v3, v4;
  end if;
  raise notice 'OK μέτρηση στη μέση της μέρας: πρωινές πωλήσεις πριν, απογευματινές μετά (στην επόμενη περίοδο, έλλειμμα αξίας %)', v4;

  -- -------------------------------------------------------------------
  -- 20. Πρόσθεση / διόρθωση κρατούν τη στιγμή της πρώτης μέτρησης·
  --     αφαίρεση και ξανά μέτρηση = νέα στιγμή
  -- -------------------------------------------------------------------
  st := public.stocktake_count(c, '2027-01-20', sauce, 10);        -- «σάλτσα 10 κιλά»
  select stock_cut into cut1 from public.doc_line where doc_id = st and item_id = sauce;
  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', '2027-01-20', mill) returning id into p4;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (p4, 1, sauce, 5, 2, 13);
  perform public.post_document(p4);
  perform public.stocktake_count(c, '2027-01-20', sauce, 2, true); -- «σάλτσα άλλα 2»
  if (select qty from public.doc_line where doc_id = st and item_id = sauce) <> 12
     or (select stock_cut from public.doc_line where doc_id = st and item_id = sauce) is distinct from cut1 then
    raise exception 'ΑΠΟΤΥΧΙΑ: πρόσθεση μετά από κίνηση άλλαξε τη στιγμή';
  end if;
  perform public.stocktake_count(c, '2027-01-20', sauce, 11);      -- «σάλτσα σύνολο 11»
  if (select qty from public.doc_line where doc_id = st and item_id = sauce) <> 11
     or (select stock_cut from public.doc_line where doc_id = st and item_id = sauce) is distinct from cut1 then
    raise exception 'ΑΠΟΤΥΧΙΑ: διόρθωση άλλαξε τη στιγμή';
  end if;
  t2 := public.stocktake_count(c, '2027-01-20', sauce, null);      -- αφαίρεση
  if t2 is not null or exists (select 1 from public.doc where id = st) then raise exception 'ΑΠΟΤΥΧΙΑ: αφαίρεση σάλτσας'; end if;
  st := public.stocktake_count(c, '2027-01-20', sauce, 11);        -- ξανά: νέα στιγμή, μετά την αγορά
  select stock_cut into cut2 from public.doc_line where doc_id = st and item_id = sauce;
  if cut2 <= cut1 or cut2 < (select max(id) from public.stock_move where doc_id = p4) then
    raise exception 'ΑΠΟΤΥΧΙΑ: νέα στιγμή μετά την αφαίρεση (% <= %)', cut2, cut1;
  end if;
  v := public.item_on_hand(sauce);
  perform public.post_document(st);
  if (select expected_qty from public.doc_line where doc_id = st and item_id = sauce) <> v then
    raise exception 'ΑΠΟΤΥΧΙΑ: η νέα μέτρηση δεν είδε την αγορά';
  end if;
  raise notice 'OK πρόσθεση/διόρθωση κρατούν τη στιγμή %, αφαίρεση + ξανά = νέα στιγμή %', cut1, cut2;

  -- -------------------------------------------------------------------
  -- 21. Απογραφή με το χέρι (γραμμές χωρίς στιγμή): "μετρήθηκε στην
  --     καταχώρηση", με τις ανοιχτές πωλήσεις της ημέρας πρώτα
  -- -------------------------------------------------------------------
  t := public.tally_add(c, '2027-01-25', 'store', marg, 2);
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'stocktake', '2027-01-25') returning id into st;
  insert into public.doc_line (doc_id, line_no, item_id, qty) values
    (st, 1, flour, public.item_on_hand(flour, '2027-01-25') - 2 * 6.5 / 40);
  -- στιγμή "από το μέλλον" (γραμμένη με το χέρι): σαν να μετρήθηκε τώρα
  insert into public.doc_line (doc_id, line_no, item_id, qty, stock_cut) values
    (st, 2, oil, public.item_on_hand(oil, '2027-01-25') - 2 * 0.2 / 40, 999999999999);
  perform public.post_document(st);
  if not exists (select 1 from public.doc where id = t and status = 'posted') then
    raise exception 'ΑΠΟΤΥΧΙΑ: η απογραφή με το χέρι δεν καταχώρησε τις πωλήσεις της ημέρας';
  end if;
  select min(stock_cut), max(stock_cut) into cut1, cut2 from public.doc_line where doc_id = st;
  if cut1 is null or cut1 <> cut2 or cut1 < (select max(id) from public.stock_move where doc_id = t)
     or exists (select 1 from public.stock_move where doc_id = st and id <= cut1) then
    raise exception 'ΑΠΟΤΥΧΙΑ: στιγμή απογραφής με το χέρι % / %', cut1, cut2;
  end if;
  if exists (select 1 from public.doc_line where doc_id = st and diff_qty <> 0) then
    raise exception 'ΑΠΟΤΥΧΙΑ: απογραφή με το χέρι χωρίς τις πωλήσεις της ημέρας';
  end if;
  -- κι άλλες πωλήσεις την ίδια μέρα: περνούν, και ακυρώνονται
  t := public.tally_add(c, '2027-01-25', 'store', marg, 1);
  perform public.post_document(t);
  perform public.unpost_document(t);
  perform public.post_document(t);
  raise notice 'OK απογραφή με το χέρι: στιγμή = καταχώρηση';

  -- -------------------------------------------------------------------
  -- 22. Δεύτερη μέτρηση του ίδιου είδους την ίδια μέρα (πρωί και βράδυ)
  -- -------------------------------------------------------------------
  st := public.stocktake_count(c, '2027-02-01', flour, public.item_on_hand(flour, '2027-02-01') - 0.2);
  perform public.post_document(st);                                -- πρωί
  t := public.tally_add(c, '2027-02-01', 'efood', marg, 4);        -- μεσημέρι
  perform public.post_document(t);
  st2 := public.stocktake_count(c, '2027-02-01', flour, public.item_on_hand(flour) - 0.1);
  if st2 is null or st2 = st then raise exception 'ΑΠΟΤΥΧΙΑ: βραδινή μέτρηση στην ίδια απογραφή'; end if;
  v := public.item_on_hand(flour);
  perform public.post_document(st2);                               -- βράδυ
  select expected_qty, diff_qty into v2, v3 from public.doc_line where doc_id = st2 and item_id = flour;
  if v2 <> v or v3 <> -0.1 then raise exception 'ΑΠΟΤΥΧΙΑ: βραδινή μέτρηση % / %', v2, v3; end if;
  -- επιμερισμός της βραδινής: μόνο το μεσημεριανό αυτόματο ζυμάρι
  select count(*) into n from public.cost_alloc where stocktake_doc_id = st2 and level = 1;
  select count(*) into n2
    from public.cost_alloc ca join public.doc b on b.id = ca.production_doc_id join public.doc a on a.id = b.source_doc_id
   where ca.stocktake_doc_id = st2 and ca.level = 1 and a.source_doc_id = t;
  if n <> 1 or n2 <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: επιμερισμός βραδινής μέτρησης % / %', n, n2; end if;
  if exists (select 1 from public.cost_alloc ca
              where ca.stocktake_doc_id = st
                and ca.production_doc_id in (select a.id from public.doc a where a.source_doc_id = t
                                             union all
                                             select b.id from public.doc a join public.doc b on b.source_doc_id = a.id
                                              where a.source_doc_id = t)) then
    raise exception 'ΑΠΟΤΥΧΙΑ: η πρωινή μέτρηση πήρε το μεσημέρι';
  end if;
  -- το μεσημέρι είναι πριν από τη βραδινή μέτρηση: κλειδωμένο
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', t),
    '%απογραφή ΑΠ-%', 'ακύρωση μεσημεριανών πωλήσεων (πριν από τη βραδινή μέτρηση)');
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', st),
    'Υπάρχει μεταγενέστερη απογραφή ΑΠ-% για το είδος "Αλεύρι"%', 'ακύρωση πρωινής ενώ υπάρχει βραδινή');
  -- ακύρωση και ξανά καταχώρηση με τη σειρά: ίδια αποτελέσματα
  select diff_qty into v from public.doc_line where doc_id = st and item_id = flour;
  perform public.unpost_document(st2);
  perform public.unpost_document(st);
  perform public.post_document(st2);
  perform pg_temp.expect_fail(format('select public.post_document(%L)', st),
    'Το είδος "Αλεύρι" μετρήθηκε ξανά μετά από αυτή τη μέτρηση, στην απογραφή ΑΠ-%', 'πρωινή μετά τη βραδινή');
  perform public.unpost_document(st2);
  perform public.post_document(st);
  perform public.post_document(st2);
  if (select diff_qty from public.doc_line where doc_id = st and item_id = flour) <> v
     or (select diff_qty from public.doc_line where doc_id = st2 and item_id = flour) <> v3
     or (select count(*) from public.cost_alloc where stocktake_doc_id = st2 and level = 1) <> 1 then
    raise exception 'ΑΠΟΤΥΧΙΑ: ξανακαταχώρηση πρωινής/βραδινής';
  end if;
  raise notice 'OK δύο μετρήσεις την ίδια μέρα: πρωί %, βράδυ %', v, v3;

  -- -------------------------------------------------------------------
  -- 23. Παλιότερη μέτρηση δεν καταχωρείται μετά από νεότερη του ίδιου
  --     είδους· βγάζεις το είδος και το ξαναμετράς
  -- -------------------------------------------------------------------
  st := public.stocktake_count(c, '2027-02-05', mozz, 3);           -- φωνή, πρωί
  t := public.tally_add(c, '2027-02-05', 'store', marg, 1);
  perform public.post_document(t);
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'stocktake', '2027-02-05') returning id into st3;
  insert into public.doc_line (doc_id, line_no, item_id, qty) values (st3, 1, mozz, public.item_on_hand(mozz) - 0.3);
  perform public.post_document(st3);                               -- με το χέρι, μεσημέρι
  perform pg_temp.expect_fail(format('select public.post_document(%L)', st),
    'Το είδος "Μοτσαρέλα" μετρήθηκε ξανά μετά από αυτή τη μέτρηση, στην απογραφή ΑΠ-%', 'παλιότερη μέτρηση μετά από νεότερη');
  perform public.stocktake_count(c, '2027-02-05', mozz, null);
  st := public.stocktake_count(c, '2027-02-05', mozz, public.item_on_hand(mozz));
  perform public.post_document(st);
  if (select diff_qty from public.doc_line where doc_id = st) <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: ξαναμέτρηση μοτσαρέλας'; end if;
  raise notice 'OK σειρά μετρήσεων: παλιότερη δεν περνά μετά από νεότερη';

  -- -------------------------------------------------------------------
  -- 24. Δικές τους φράσεις (voice_phrase): μόνο μέλη, μία φορά η καθεμία
  -- -------------------------------------------------------------------
  insert into public.voice_phrase (company_id, phrase, meaning) values (c, '  Οικογενειακή ', ' μεγάλη   μαργαρίτα ') returning id into vp;
  if (select phrase || '|' || meaning from public.voice_phrase where id = vp) <> 'Οικογενειακή|μεγάλη μαργαρίτα' then
    raise exception 'ΑΠΟΤΥΧΙΑ: καθάρισμα κενών φράσης';
  end if;
  insert into public.voice_phrase (company_id, phrase, meaning) values (c, 'το συνηθισμένο του ξενοδοχείου',
    'πούλησα στο ξενοδοχείο Αστέρια 60 σπέσιαλ κατεψυγμένες');
  sql := 'insert into public.voice_phrase (company_id, phrase, meaning) values (%L, %L, %L)';
  perform pg_temp.expect_fail(format(sql, c, 'ΟΙΚΟΓΕΝΕΙΑΚΉ', 'κάτι'), '%voice_phrase_company_phrase%', 'φράση: διπλή με κεφαλαία');
  perform pg_temp.expect_fail(format(sql, c, 'οικογενειακή  ', 'κάτι'), '%voice_phrase_company_phrase%', 'φράση: διπλή με κενά');
  perform pg_temp.expect_fail(format(sql, c, '   ', 'κάτι'), '%voice_phrase_phrase_check%', 'φράση: κενή');
  perform pg_temp.expect_fail(format(sql, c, 'κάτι', ''), '%voice_phrase_meaning_check%', 'φράση: κενή σημασία');
  perform pg_temp.expect_fail(format(sql, c, repeat('α', 201), 'κάτι'), '%voice_phrase_phrase_check%', 'φράση: πάνω από 200');
  perform pg_temp.expect_fail(format('insert into public.voice_phrase (company_id, phrase) values (%L, %L)', c, 'χωρίς σημασία'),
    '%meaning%', 'φράση: χωρίς σημασία');
  update public.voice_phrase set meaning = 'μεγάλη σπέσιαλ' where id = vp;
  if (select meaning from public.voice_phrase where id = vp) <> 'μεγάλη σπέσιαλ' then raise exception 'ΑΠΟΤΥΧΙΑ: αλλαγή σημασίας'; end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.voice_phrase'::regclass and tgname = 'voice_phrase_updated_at') then
    raise exception 'ΑΠΟΤΥΧΙΑ: updated_at στο voice_phrase';
  end if;
  -- άλλη εταιρεία: δεν βλέπει, δεν γράφει, δεν αλλάζει, δεν σβήνει
  perform set_config('request.jwt.claim.sub', other::text, false);
  if exists (select 1 from public.voice_phrase where company_id = c) then raise exception 'ΑΠΟΤΥΧΙΑ: ξένος βλέπει φράσεις'; end if;
  perform pg_temp.expect_fail(format(sql, c, 'ξένη', 'κάτι'), '%row-level security%', 'φράση σε ξένη εταιρεία');
  update public.voice_phrase set meaning = 'χακαρισμένο' where id = vp;
  get diagnostics n = row_count;
  delete from public.voice_phrase where id = vp;
  get diagnostics n2 = row_count;
  if n <> 0 or n2 <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: ξένος άλλαξε/έσβησε φράση (% / %)', n, n2; end if;
  insert into public.voice_phrase (company_id, phrase, meaning) values (c2, 'οικογενειακή', 'ξένη πίτσα');  -- ίδια φράση, άλλη εταιρεία
  perform pg_temp.expect_fail(format('update public.voice_phrase set company_id = %L where company_id = %L', c, c2),
    '%row-level security%', 'μεταφορά φράσης σε ξένη εταιρεία');
  perform set_config('request.jwt.claim.sub', me::text, false);
  if (select meaning from public.voice_phrase where id = vp) <> 'μεγάλη σπέσιαλ'
     or exists (select 1 from public.voice_phrase where company_id = c2) then
    raise exception 'ΑΠΟΤΥΧΙΑ: φράσεις μεταξύ εταιρειών';
  end if;
  if has_table_privilege('anon', 'public.voice_phrase', 'select') or has_table_privilege('anon', 'public.voice_phrase', 'insert') then
    raise exception 'ΑΠΟΤΥΧΙΑ: ο anon έχει πρόσβαση στις φράσεις';
  end if;
  delete from public.voice_phrase where id = vp;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'ΑΠΟΤΥΧΙΑ: διαγραφή φράσης'; end if;
  raise notice 'OK δικές τους φράσεις: μέλη μόνο, μία φορά η καθεμία (χωρίς πεζά/κεφαλαία)';

  -- -------------------------------------------------------------------
  -- 25. Ό,τι είναι ήδη μέσα σε μέτρηση δεν ακυρώνεται, ούτε όσο η
  --     απογραφή είναι σε εξέλιξη: ξανακαταχωρημένο θα έπαιρνε νέα id και
  --     θα μετρούσε για μετά (διπλό απόθεμα / φανταστικό έλλειμμα).
  --     Βγάζεις το είδος από την απογραφή, διορθώνεις, ξαναμετράς.
  -- -------------------------------------------------------------------
  -- 28/2: αγορά αλευριού (παλιότερη μέρα από τη μέτρηση της 1/3)
  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', '2027-02-28', mill) returning id into pb;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (pb, 1, flour, 5, 0.68, 13);
  perform public.post_document(pb);
  -- 1/3 πρωί: παραλαβή 25 kg (λάθος τιμή) και 2 μαργαρίτες
  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', '2027-03-01', mill) returning id into pa;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (pa, 1, flour, 25, 0.80, 13);
  perform public.post_document(pa);
  t := public.tally_add(c, '2027-03-01', 'store', marg, 2);
  v := public.item_on_hand(flour) - 2 * 6.5 / 40;                  -- ό,τι υπάρχει στο ράφι
  st := public.stocktake_count(c, '2027-03-01', flour, v);         -- «αλεύρι … κιλά»
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', pa),
    'Κλειδωμένη περίοδος: το είδος "Αλεύρι" μετρήθηκε στην απογραφή σε εξέλιξη ΑΠ-% μετά από αυτή την κίνηση%βγάλτε πρώτα το είδος%',
    'ακύρωση αγοράς που είναι μέσα σε μέτρηση σε εξέλιξη');
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', t),
    'Κλειδωμένη περίοδος: το είδος "Αλεύρι" μετρήθηκε στην απογραφή σε εξέλιξη ΑΠ-%',
    'ακύρωση πωλήσεων ημέρας μέσα σε μέτρηση σε εξέλιξη (μέσω αυτόματου ζυμαριού)');
  if not exists (select 1 from public.doc where id = t and status = 'posted') then
    raise exception 'ΑΠΟΤΥΧΙΑ: η αποτυχημένη ακύρωση άφησε αλλαγές';
  end if;
  -- παλιότερη μέρα: μένει "πριν" ό,τι κι αν γίνει, ακυρώνεται και ξανακαταχωρείται
  perform public.unpost_document(pb);
  perform public.post_document(pb);
  -- ίδια μέρα, μετά τη μέτρηση: περνάει, ακυρώνεται, ξανακαταχωρείται
  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', '2027-03-01', mill) returning id into pc;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (pc, 1, flour, 10, 0.68, 13);
  perform public.post_document(pc);
  perform public.unpost_document(pc);
  perform public.post_document(pc);
  -- και σε πρόχειρη απογραφή που κρατά τη στιγμή («Χειροκίνητη επεξεργασία»)
  update public.doc set is_running = false where id = st;
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', pa),
    'Κλειδωμένη περίοδος: το είδος "Αλεύρι" μετρήθηκε στην πρόχειρη απογραφή ΑΠ-%', 'ακύρωση αγοράς μέσα σε πρόχειρη απογραφή');
  update public.doc set is_running = true where id = st;
  -- όπως λέει το μήνυμα: βγάζεις το αλεύρι, διορθώνεις την τιμή, ξαναμετράς
  if public.stocktake_count(c, '2027-03-01', flour, null) is not null then
    raise exception 'ΑΠΟΤΥΧΙΑ: αφαίρεση αλευριού από την απογραφή σε εξέλιξη';
  end if;
  perform public.unpost_document(pa);
  update public.doc_line set unit_price = 0.70 where doc_id = pa;
  perform public.post_document(pa);
  st := public.stocktake_count(c, '2027-03-01', flour, v + 10 - 0.5);   -- + η απογευματινή αγορά, λείπει 0,5
  perform public.post_document(st);
  select expected_qty, diff_qty into v2, v3 from public.doc_line where doc_id = st and item_id = flour;
  if v2 <> v + 10 or v3 <> -0.5 or public.item_on_hand(flour) <> v + 10 - 0.5 then
    raise exception 'ΑΠΟΤΥΧΙΑ: ξαναμέτρηση μετά τη διόρθωση: % / % / υπόλοιπο %', v2, v3, public.item_on_hand(flour);
  end if;
  -- καταχωρημένη: το μήνυμα λέει τι να κάνεις· ακυρωμένη κρατά τη στιγμή,
  -- άρα κλειδώνει ακόμα (και ξανακαταχωρείται με το ίδιο αποτέλεσμα)
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', pa),
    'Κλειδωμένη περίοδος: το είδος "Αλεύρι" μετρήθηκε στην απογραφή ΑΠ-% μετά από αυτή την κίνηση%βγάλτε το είδος%',
    'ακύρωση αγοράς μέσα σε καταχωρημένη μέτρηση');
  perform public.unpost_document(st);
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', pa),
    'Κλειδωμένη περίοδος: το είδος "Αλεύρι" μετρήθηκε στην πρόχειρη απογραφή ΑΠ-%', 'ακύρωση αγοράς μέσα σε ακυρωμένη μέτρηση');
  perform public.post_document(st);
  if (select diff_qty from public.doc_line where doc_id = st) <> -0.5 or public.item_on_hand(flour) <> v + 10 - 0.5 then
    raise exception 'ΑΠΟΤΥΧΙΑ: ξανακαταχώρηση μέτρησης';
  end if;
  raise notice 'OK ό,τι είναι μέσα σε μέτρηση (και σε εξέλιξη) δεν ακυρώνεται· βγάζεις το είδος, διορθώνεις, ξαναμετράς';

  -- -------------------------------------------------------------------
  -- 26. Πωλήσεις ημέρας που έγιναν απλό πρόχειρο («Χειροκίνητη
  --     επεξεργασία», ή ακύρωση ενώ άνοιξε νέος μετρητής) είναι πωλήσεις
  --     πριν από τη μέτρηση: καταχωρούνται κι αυτές με την πρώτη μέτρηση
  -- -------------------------------------------------------------------
  t := public.tally_add(c, '2027-03-05', 'store', marg, 4);
  update public.doc set is_running = false where id = t;           -- «Χειροκίνητη επεξεργασία»
  update public.doc_line set unit_price = 7.5 where doc_id = t;
  t2 := public.tally_add(c, '2027-03-04', 'efood', marg, 2);
  perform public.post_document(t2);
  t3 := public.tally_add(c, '2027-03-04', 'efood', marg, 1);       -- νέος μετρητής της 4/3
  perform public.unpost_document(t2);                               -- μένει απλό πρόχειρο
  if (select is_running from public.doc where id = t2) then raise exception 'ΑΠΟΤΥΧΙΑ: δύο ανοιχτοί μετρητές 4/3'; end if;
  v := public.item_on_hand(flour) - 7 * 6.5 / 40;                  -- 4 + 2 + 1 μαργαρίτες
  st := public.stocktake_count(c, '2027-03-05', flour, v);
  if (select count(*) from public.doc where id in (t, t2, t3) and status = 'posted') <> 3 then
    raise exception 'ΑΠΟΤΥΧΙΑ: η μέτρηση δεν καταχώρησε τις πρόχειρες πωλήσεις ημέρας';
  end if;
  if (select total_net from public.doc where id = t) <> 30 then
    raise exception 'ΑΠΟΤΥΧΙΑ: χάθηκε η αλλαγή τιμής της χειροκίνητης επεξεργασίας';
  end if;
  perform public.post_document(st);
  if (select diff_qty from public.doc_line where doc_id = st) <> 0 or public.item_on_hand(flour) <> v then
    raise exception 'ΑΠΟΤΥΧΙΑ: πρόχειρες πωλήσεις ημέρας μετρήθηκαν δύο φορές (% / %)',
      (select diff_qty from public.doc_line where doc_id = st), public.item_on_hand(flour);
  end if;
  raise notice 'OK πρόχειρες πωλήσεις ημέρας καταχωρούνται με την πρώτη μέτρηση';

  -- -------------------------------------------------------------------
  -- 27. Αξία διαφοράς με το μέσο κόστος τη στιγμή της μέτρησης: αγορά σε
  --     άλλη τιμή πριν από το «τέλος απογραφής» δεν αλλάζει την αξία του
  --     ελλείμματος, και η ακύρωσή της αφήνει σωστό μέσο κόστος
  -- -------------------------------------------------------------------
  select coalesce(sum(qty), 0), coalesce(sum(total_cost), 0) into v5, v6 from public.stock_move where item_id = flour;
  v2 := (select avg_cost from public.item where id = flour);
  st := public.stocktake_count(c, '2027-03-08', flour, v5 - 1);    -- λείπει 1 kg
  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', '2027-03-08', mill) returning id into pa;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (pa, 1, flour, 100, 5, 13);
  perform public.post_document(pa);
  if (select avg_cost from public.item where id = flour) < v2 + 0.5 then raise exception 'ΑΠΟΤΥΧΙΑ: στήσιμο αξίας'; end if;
  perform public.post_document(st);
  select unit_cost, diff_value into v3, v4 from public.doc_line where doc_id = st;
  if abs(v3 - v2) > 0.000002 or v4 <> round(v3, 4) then
    raise exception 'ΑΠΟΤΥΧΙΑ: αξία ελλείμματος με κόστος % (σωστό %), αξία %', v3, v2, v4;
  end if;
  -- νέο μέσο κόστος = (απόθεμα πριν + αγορά - έλλειμμα στο κόστος της μέτρησης)
  if abs((select avg_cost from public.item where id = flour) - (v6 + 500 - v4) / (v5 + 100 - 1)) > 0.000002 then
    raise exception 'ΑΠΟΤΥΧΙΑ: μέσο κόστος μετά το έλλειμμα %', (select avg_cost from public.item where id = flour);
  end if;
  perform public.unpost_document(pa);                               -- μετά τη μέτρηση: ακυρώνεται
  if abs((select avg_cost from public.item where id = flour) - (v6 - v4) / (v5 - 1)) > 0.000002
     or (select sum(total_cost) from public.stock_move where item_id = flour) <> v6 - v4 then
    raise exception 'ΑΠΟΤΥΧΙΑ: μέσο κόστος μετά την ακύρωση της αγοράς % (σωστό %)',
      (select avg_cost from public.item where id = flour), (v6 - v4) / (v5 - 1);
  end if;
  raise notice 'OK αξία ελλείμματος με το κόστος της στιγμής της μέτρησης (%)', v3;

  -- -------------------------------------------------------------------
  -- 28. Μέτρηση αλευριού στη μέση της μέρας, με ζυμάρια ζυμωμένα το πρωί
  --     (με το χέρι): το έλλειμμα του ζυμώματος πέφτει σε όλες τις πίτσες
  --     της μέρας από αυτά τα ζυμάρια, όχι μόνο στις λίγες πριν τη μέτρηση
  -- -------------------------------------------------------------------
  st := public.stocktake_count(c, '2027-03-10', flour, public.item_on_hand(flour));   -- αφετηρία
  perform public.post_document(st);
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'production', '2027-03-11') returning id into p3;
  insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (p3, 1, 'output', dough, 40);
  perform public.post_document(p3);                                 -- 8:00 ζύμωμα
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'production', '2027-03-11') returning id into p4;
  insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (p4, 1, 'output', special, 4);
  perform public.post_document(p4);                                 -- πρωί: 4 πίτσες
  st := public.stocktake_count(c, '2027-03-11', flour, public.item_on_hand(flour) - 0.5);   -- 12:00 μέτρηση
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'production', '2027-03-11') returning id into d;
  insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (d, 1, 'output', special, 36);
  perform public.post_document(d);                                  -- απόγευμα: 36 πίτσες
  if exists (select 1 from public.doc where source_doc_id in (p4, d)) then raise exception 'ΑΠΟΤΥΧΙΑ: στήσιμο ζυμαριών'; end if;
  perform public.post_document(st);
  select diff_value into v from public.doc_line where doc_id = st;
  select sum(cost_alloc) into v2 from public.cost_alloc where stocktake_doc_id = st and level = 1 and production_doc_id = p3;
  select coalesce(sum(cost_alloc) filter (where production_doc_id = p4), 0),
         coalesce(sum(cost_alloc) filter (where production_doc_id = d), 0),
         coalesce(sum(cost_alloc), 0)
    into v3, v4, v5
    from public.cost_alloc where stocktake_doc_id = st and level = 2 and source = 'cascade';
  if v <= 0 or v2 <> v or v5 <> v or abs(v3 - v * 4 / 40) > 0.0002 or abs(v4 - v * 36 / 40) > 0.0002 then
    raise exception 'ΑΠΟΤΥΧΙΑ: ζυμάρια του πρωινού: % -> πρωί % / απόγευμα % (σύνολο %)', v, v3, v4, v5;
  end if;
  raise notice 'OK ζυμάρια του πρωινού: έλλειμμα % σε όλες τις πίτσες της μέρας (% / %)', v, v3, v4;

  -- -------------------------------------------------------------------
  -- 29. Η στιγμή της μέτρησης δεν πάει πίσω όταν ακυρώνεται η τελευταία
  --     κίνηση: η βραδινή μέτρηση της ίδιας μέρας καταχωρείται
  -- -------------------------------------------------------------------
  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', '2027-03-15', mill) returning id into pm;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (pm, 1, mozz, 2, 8, 13);
  perform public.post_document(pm);
  st := public.stocktake_count(c, '2027-03-15', flour, public.item_on_hand(flour));     -- πρωί, χωρίς διαφορά
  perform public.post_document(st);
  select stock_cut into cut1 from public.doc_line where doc_id = st;
  perform public.unpost_document(pm);                               -- η τελευταία κίνηση φεύγει
  delete from public.doc where id = pm;
  if (select max(id) from public.stock_move) >= cut1 then raise exception 'ΑΠΟΤΥΧΙΑ: στήσιμο στιγμής'; end if;
  st2 := public.stocktake_count(c, '2027-03-15', flour, public.item_on_hand(flour) - 0.1);   -- βράδυ
  select stock_cut into cut2 from public.doc_line where doc_id = st2;
  if cut2 < cut1 then raise exception 'ΑΠΟΤΥΧΙΑ: η στιγμή πήγε πίσω (% < %)', cut2, cut1; end if;
  perform public.post_document(st2);
  if (select diff_qty from public.doc_line where doc_id = st2) <> -0.1 then raise exception 'ΑΠΟΤΥΧΙΑ: βραδινή μέτρηση 15/3'; end if;
  raise notice 'OK η στιγμή δεν πάει πίσω: πρωί %, βράδυ %', cut1, cut2;

  -- -------------------------------------------------------------------
  -- 30. Μέτρηση τώρα σε απογραφή παλιότερης ημερομηνίας (ξεχασμένη από
  --     χθες) ενώ το είδος έχει ήδη κινήσεις ή ανοιχτές πωλήσεις ημέρας με
  --     μεταγενέστερη ημερομηνία: δεν γίνεται (θα μετρούσαν δύο φορές).
  --     Χωρίς τίποτα της νέας μέρας (μέτρημα μετά τα μεσάνυχτα) γίνεται.
  -- -------------------------------------------------------------------
  declare
    oreg uuid; basil uuid; pie uuid;
  begin
    insert into public.item (company_id, code, name, item_type, unit) values (c, 'ΠΥ-030', 'Ρίγανη', 'raw', 'kg') returning id into oreg;
    insert into public.item (company_id, code, name, item_type, unit) values (c, 'ΠΥ-031', 'Βασιλικός', 'raw', 'kg') returning id into basil;
    insert into public.item (company_id, code, name, item_type, unit, sale_price) values (c, 'ΠΡ-030', 'Τυρόπιτα', 'finished', 'τεμ', 2) returning id into pie;
    insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', '2027-04-02', mill) returning id into pm;
    insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (pm, 1, oreg, 1, 10, 13);
    perform public.post_document(pm);                                 -- σήμερα (2/4): αγορά ρίγανης
    perform public.tally_add(c, '2027-04-02', 'store', pie, 2);       -- σήμερα: ανοιχτή πώληση
    -- χθεσινή απογραφή που έμεινε ανοιχτή
    st := public.stocktake_count(c, '2027-04-01', basil, 0.5);        -- μετά τα μεσάνυχτα, τίποτα της 2/4: γίνεται
    perform pg_temp.expect_fail(format('select public.stocktake_count(%L, %L, %L, %L)', c, '2027-04-01', oreg, 1),
      'Το είδος "Ρίγανη" έχει ήδη κινήσεις της 02/04/2027%', 'χθεσινή απογραφή, σημερινή αγορά');
    perform pg_temp.expect_fail(format('select public.stocktake_count(%L, %L, %L, %L)', c, '2027-04-01', pie, 3),
      'Το είδος "Τυρόπιτα" έχει ήδη κινήσεις της 02/04/2027%', 'χθεσινή απογραφή, σημερινή ανοιχτή πώληση');
    if (select count(*) from public.doc_line where doc_id = st) <> 1
       or not exists (select 1 from public.doc where id = st and status = 'draft' and is_running) then
      raise exception 'ΑΠΟΤΥΧΙΑ: η χθεσινή απογραφή άλλαξε';
    end if;
    perform public.stocktake_count(c, '2027-04-01', basil, 0.2, true); -- ίδιο είδος, ήδη μετρημένο: συνεχίζει
    -- στη σημερινή απογραφή γίνονται
    st2 := public.stocktake_count(c, '2027-04-02', oreg, 0.9);
    perform public.stocktake_count(c, '2027-04-02', pie, 0);
    if (select status from public.doc d2 join public.doc_line dl on dl.doc_id = d2.id
         where d2.doc_date = '2027-04-02' and d2.channel = 'store' and dl.item_id = pie) <> 'posted' then
      raise exception 'ΑΠΟΤΥΧΙΑ: η σημερινή πώληση πριν από τη μέτρηση δεν καταχωρήθηκε';
    end if;
    perform public.post_document(st);
    perform public.post_document(st2);
    if (select qty from public.doc_line where doc_id = st) <> 0.7
       or (select diff_qty from public.doc_line where doc_id = st2 and item_id = oreg) <> -0.1
       or public.item_on_hand(oreg) <> 0.9 then
      raise exception 'ΑΠΟΤΥΧΙΑ: μετρήσεις 1/4 - 2/4';
    end if;
  end;
  raise notice 'OK μέτρηση σε ξεχασμένη απογραφή παλιότερης μέρας μόνο χωρίς κινήσεις μετά';

  raise notice 'ΟΛΑ ΟΚ (φωνή)';
end $$;

-- Εικόνα αποτελεσμάτων
select b.code, b.name, b.item_type, b.make_to_order, b.on_hand, round(b.avg_cost, 5) as avg_cost
  from public.v_stock_balance b join public.company k on k.id = b.company_id
 where k.name = 'Πιτσαρία Φωνή' order by b.code;
select v.doc_no, v.doc_date, v.is_auto, v.item_name, v.produced_qty, round(v.base_unit_cost, 5) base_unit
  from public.v_production_cost v join public.company k on k.id = v.company_id
 where k.name = 'Πιτσαρία Φωνή' order by v.doc_no;
reset role;
