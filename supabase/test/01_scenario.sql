-- Σενάριο δοκιμής: ζυμάρι -> πίτσες -> πωλήσεις -> απογραφή -> επιμερισμός
\set ON_ERROR_STOP on
\pset format aligned

insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'test@example.com')
on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare
  c uuid;
  flour uuid; water uuid; yeast uuid; salt uuid; oil uuid; mozz uuid; sauce uuid; box uuid;
  dough uuid; marg uuid; special uuid;
  mill uuid; dairy uuid; hotel uuid; efood uuid;
  b_dough uuid; b_marg uuid; b_special uuid;
  d uuid;
  v numeric; v2 numeric;
begin
  c := public.create_company('Πιτσαρία Δοκιμή', '123456789');

  insert into public.item (company_id, code, name, item_type, unit, vat_rate) values
    (c, 'RM-001', 'Αλεύρι', 'raw', 'kg', 13) returning id into flour;
  insert into public.item (company_id, code, name, item_type, unit, vat_rate) values
    (c, 'RM-002', 'Νερό', 'raw', 'L', 13) returning id into water;
  insert into public.item (company_id, code, name, item_type, unit, vat_rate) values
    (c, 'RM-003', 'Μαγιά', 'raw', 'kg', 13) returning id into yeast;
  insert into public.item (company_id, code, name, item_type, unit, vat_rate) values
    (c, 'RM-004', 'Αλάτι', 'raw', 'kg', 13) returning id into salt;
  insert into public.item (company_id, code, name, item_type, unit, vat_rate) values
    (c, 'RM-005', 'Ελαιόλαδο', 'raw', 'L', 13) returning id into oil;
  insert into public.item (company_id, code, name, item_type, unit, vat_rate) values
    (c, 'RM-006', 'Μοτσαρέλα', 'raw', 'kg', 13) returning id into mozz;
  insert into public.item (company_id, code, name, item_type, unit, vat_rate) values
    (c, 'RM-007', 'Σάλτσα ντομάτας', 'raw', 'kg', 13) returning id into sauce;
  insert into public.item (company_id, code, name, item_type, unit, vat_rate) values
    (c, 'RM-008', 'Κουτί πίτσας', 'raw', 'τεμ', 24) returning id into box;
  insert into public.item (company_id, code, name, item_type, unit) values
    (c, 'SF-001', 'Ζυμάρι 250γρ', 'semi', 'τεμ') returning id into dough;
  insert into public.item (company_id, code, name, item_type, unit, sale_price, make_to_order) values
    (c, 'FG-001', 'Μαργαρίτα', 'finished', 'τεμ', 8.00, true) returning id into marg;
  insert into public.item (company_id, code, name, item_type, unit, sale_price, make_to_order) values
    (c, 'FG-002', 'Special κατεψυγμένη', 'finished', 'τεμ', 4.50, false) returning id into special;

  -- συνταγές
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

  -- κανόνας συνταγής: ημιέτοιμο με ημιέτοιμο πρέπει να αποτύχει
  begin
    insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values (c, b_dough, 9, dough, 1);
    raise exception 'ΑΠΟΤΥΧΙΑ: επιτράπηκε ημιέτοιμο μέσα σε ημιέτοιμο';
  exception when others then
    if sqlerrm like 'ΑΠΟΤΥΧΙΑ%' then raise; end if;
    raise notice 'OK κανόνας συνταγής: %', sqlerrm;
  end;

  -- συναλλασσόμενοι
  insert into public.partner (company_id, code, name, is_supplier) values (c, 'S-001', 'Μύλος Α.Ε.', true) returning id into mill;
  insert into public.partner (company_id, code, name, is_supplier) values (c, 'S-002', 'Τυροκομείο', true) returning id into dairy;
  insert into public.partner (company_id, code, name, is_customer) values (c, 'C-001', 'Ξενοδοχείο Χ', true) returning id into hotel;
  insert into public.partner (company_id, code, name, is_customer) values (c, 'C-002', 'efood', true) returning id into efood;

  -- τιμοκατάλογος ανά πελάτη
  insert into public.partner_price (company_id, partner_id, item_id, price) values (c, hotel, special, 4.20);
  if public.item_price_for(special, hotel) <> 4.20 then raise exception 'ΑΠΟΤΥΧΙΑ τιμή πελάτη'; end if;
  if public.item_price_for(special, efood) <> 4.50 then raise exception 'ΑΠΟΤΥΧΙΑ γενική τιμή'; end if;
  if public.item_price_for(special) <> 4.50 then raise exception 'ΑΠΟΤΥΧΙΑ γενική τιμή χωρίς πελάτη'; end if;
  raise notice 'OK τιμοκατάλογος πελάτη: ξενοδοχείο %, γενική %', public.item_price_for(special, hotel), public.item_price_for(special);

  -- Αγορά 1 (μύλος), 1/8
  insert into public.doc (company_id, doc_type, doc_date, partner_id, ref_no) values (c, 'purchase', '2026-08-01', mill, 'ΤΙΜ-1001') returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values
    (d, 1, flour, 250, 0.62, 13), (d, 2, yeast, 5, 3.00, 13), (d, 3, salt, 10, 0.40, 13), (d, 4, oil, 20, 6.00, 13), (d, 5, water, 200, 0.001, 13);
  perform public.post_document(d);

  -- Αγορά 2 (τυροκομείο), 2/8
  insert into public.doc (company_id, doc_type, doc_date, partner_id, ref_no) values (c, 'purchase', '2026-08-02', dairy, 'ΤΙΜ-77') returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values
    (d, 1, mozz, 60, 7.00, 13), (d, 2, sauce, 40, 2.00, 13), (d, 3, box, 500, 0.25, 24);
  perform public.post_document(d);

  select avg_cost into v from public.item where id = flour;
  if v <> 0.62 then raise exception 'ΑΠΟΤΥΧΙΑ μέσο κόστος αλευριού: %', v; end if;

  -- Παραγωγή ζυμαριού 80 τεμ, 5/8 (ανάπτυξη συνταγής από το UI)
  insert into public.doc (company_id, doc_type, doc_date, bom_id) values (c, 'production', '2026-08-05', b_dough) returning id into d;
  insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (d, 1, 'output', dough, 80);
  perform public.explode_bom(d);
  select qty into v from public.doc_line where doc_id = d and role = 'input' and item_id = flour;
  if v <> 13 then raise exception 'ΑΠΟΤΥΧΙΑ ανάπτυξη συνταγής αλεύρι: %', v; end if;
  perform public.post_document(d);
  select avg_cost into v from public.item where id = dough;
  -- (13*0.62 + 8*0.001 + 0.2*3 + 0.24*0.4 + 0.4*6) / 80 = 11.164 / 80 = 0.13955
  if round(v, 5) <> 0.13955 then raise exception 'ΑΠΟΤΥΧΙΑ κόστος ζυμαριού: %', v; end if;
  raise notice 'OK κόστος ζυμαριού: %', round(v, 5);

  -- Παραγωγή Special κατεψυγμένη 60 τεμ, 6/8 (χωρίς ανάπτυξη: την κάνει η καταχώρηση)
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'production', '2026-08-06') returning id into d;
  insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (d, 1, 'output', special, 60);
  perform public.post_document(d);
  select avg_cost into v from public.item where id = special;
  -- 60*0.13955 + 4.8*2 + 9*7 + 60*0.25 = 8.373 + 9.6 + 63 + 15 = 95.973 / 60 = 1.59955
  if round(v, 5) <> 1.59955 then raise exception 'ΑΠΟΤΥΧΙΑ κόστος special: %', v; end if;
  raise notice 'OK κόστος special: %', round(v, 5);

  -- Πώληση χονδρικής στο ξενοδοχείο, 10/8
  insert into public.doc (company_id, doc_type, doc_date, partner_id, channel) values (c, 'sale', '2026-08-10', hotel, 'wholesale') returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (d, 1, special, 60, 4.50, 13);
  perform public.post_document(d);
  select customer_balance into v from public.v_partner_balance where partner_id = hotel;
  if v <> 305.10 then raise exception 'ΑΠΟΤΥΧΙΑ υπόλοιπο ξενοδοχείου: %', v; end if;
  raise notice 'OK υπόλοιπο ξενοδοχείου: %', v;

  -- Πώληση λιανικής efood (backflush), 12/8
  insert into public.doc (company_id, doc_type, doc_date, partner_id, channel) values (c, 'sale', '2026-08-12', efood, 'efood') returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (d, 1, marg, 12, 8.00, 13);
  perform public.post_document(d);
  if (select count(*) from public.doc where source_doc_id = d and is_auto and status = 'posted') <> 1 then
    raise exception 'ΑΠΟΤΥΧΙΑ: δεν δημιουργήθηκε αυτόματη παραγωγή';
  end if;
  select on_hand into v from public.v_stock_balance where item_id = dough;
  if v <> 8 then raise exception 'ΑΠΟΤΥΧΙΑ υπόλοιπο ζυμαριού (80-60-12=8): %', v; end if;
  select on_hand into v from public.v_stock_balance where item_id = mozz;
  if v <> 49.56 then raise exception 'ΑΠΟΤΥΧΙΑ υπόλοιπο μοτσαρέλας (60-9-1.44): %', v; end if;
  raise notice 'OK backflush: ζυμάρι %, μοτσαρέλα %', 8, v;

  -- Είσπραξη από ξενοδοχείο
  insert into public.doc (company_id, doc_type, doc_date, partner_id, amount) values (c, 'receipt', '2026-08-20', hotel, 200) returning id into d;
  perform public.post_document(d);
  select customer_balance into v from public.v_partner_balance where partner_id = hotel;
  if v <> 105.10 then raise exception 'ΑΠΟΤΥΧΙΑ υπόλοιπο μετά είσπραξη: %', v; end if;

  -- Απογραφή 31/8: λείπουν 3 kg μοτσαρέλα και 2 kg αλεύρι, ζυμάρι/special σωστά
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'stocktake', '2026-08-31') returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty) values
    (d, 1, mozz, 46.56), (d, 2, flour, 235), (d, 3, dough, 8), (d, 4, special, 0), (d, 5, sauce, 34.24);
  perform public.post_document(d);

  select diff_value into v from public.v_stocktake_result where doc_id = d and item_id = mozz;
  if v <> 21 then raise exception 'ΑΠΟΤΥΧΙΑ διαφορά μοτσαρέλας: %', v; end if;
  select allocated_value into v from public.v_stocktake_result where doc_id = d and item_id = mozz;
  if v <> 21 then raise exception 'ΑΠΟΤΥΧΙΑ επιμερισμός μοτσαρέλας: %', v; end if;
  -- special: 21 * 9/10.44 = 18.1034 ; μαργαρίτα: 21 * 1.44/10.44 = 2.8966
  select cost_alloc into v from public.cost_alloc ca where ca.stocktake_doc_id = d and ca.component_item_id = mozz and ca.produced_item_id = special;
  if round(v, 2) <> 18.10 then raise exception 'ΑΠΟΤΥΧΙΑ επιμερισμός μοτσαρέλας σε special: %', v; end if;
  raise notice 'OK επιμερισμός μοτσαρέλας: special %, μαργαρίτα %', v, 21 - v;

  -- αλεύρι: 2 kg * 0.62 = 1.24 στο ζυμάρι, μετά cascade 60/72 στο special, 12/72 στη μαργαρίτα
  select cost_alloc into v from public.cost_alloc ca where ca.stocktake_doc_id = d and ca.component_item_id = flour and ca.produced_item_id = dough;
  if v <> 1.24 then raise exception 'ΑΠΟΤΥΧΙΑ επιμερισμός αλευριού σε ζυμάρι: %', v; end if;
  select cost_alloc into v from public.cost_alloc ca where ca.stocktake_doc_id = d and ca.component_item_id = dough and ca.produced_item_id = special and ca.source = 'cascade';
  if round(v, 4) <> round(1.24 * 60 / 72.0, 4) then raise exception 'ΑΠΟΤΥΧΙΑ cascade ζυμαριού σε special: %', v; end if;
  raise notice 'OK cascade αλεύρι -> ζυμάρι -> special: %', v;

  -- πραγματικό κόστος special: 95.973 + 18.1034 + 1.0333 = 115.1097 / 60 = 1.91850
  select actual_cost, actual_unit_cost into v, v2 from public.v_production_cost where item_id = special;
  raise notice 'OK πραγματικό κόστος special: σύνολο %, ανά τεμ %', round(v, 4), round(v2, 4);
  if round(v, 2) <> 115.11 then raise exception 'ΑΠΟΤΥΧΙΑ πραγματικό κόστος special: %', v; end if;

  -- κλείδωμα: αγορά μοτσαρέλας με ημερομηνία πριν την απογραφή πρέπει να αποτύχει
  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', '2026-08-25', dairy) returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (d, 1, mozz, 10, 7.2, 13);
  begin
    perform public.post_document(d);
    raise exception 'ΑΠΟΤΥΧΙΑ: επιτράπηκε καταχώρηση σε κλειδωμένη περίοδο';
  exception when others then
    if sqlerrm like 'ΑΠΟΤΥΧΙΑ%' then raise; end if;
    raise notice 'OK κλείδωμα περιόδου: %', sqlerrm;
  end;
  -- με ημερομηνία μετά την απογραφή περνάει
  update public.doc set doc_date = '2026-09-01' where id = d;
  perform public.post_document(d);
  select avg_cost into v from public.item where id = mozz;
  -- (46.56*7 + 10*7.2) / 56.56 = 7.035360...
  raise notice 'OK νέο μέσο κόστος μοτσαρέλας: %', round(v, 4);

  -- ακύρωση της πώλησης efood: πρέπει να αποτύχει (κλειδωμένη από απογραφή)
  select id into d from public.doc where company_id = c and doc_type = 'sale' and channel = 'efood';
  begin
    perform public.unpost_document(d);
    raise exception 'ΑΠΟΤΥΧΙΑ: επιτράπηκε ακύρωση σε κλειδωμένη περίοδο';
  exception when others then
    if sqlerrm like 'ΑΠΟΤΥΧΙΑ%' then raise; end if;
    raise notice 'OK κλείδωμα ακύρωσης: %', sqlerrm;
  end;

  -- ακύρωση απογραφής και μετά της πώλησης efood
  select id into d from public.doc where company_id = c and doc_type = 'stocktake';
  perform public.unpost_document(d);
  if exists (select 1 from public.cost_alloc where stocktake_doc_id = d) then raise exception 'ΑΠΟΤΥΧΙΑ: έμειναν επιμερισμοί'; end if;
  select id into d from public.doc where company_id = c and doc_type = 'sale' and channel = 'efood';
  perform public.unpost_document(d);
  if exists (select 1 from public.doc where source_doc_id = d) then raise exception 'ΑΠΟΤΥΧΙΑ: έμεινε αυτόματη παραγωγή'; end if;
  select on_hand into v from public.v_stock_balance where item_id = dough;
  if v <> 20 then raise exception 'ΑΠΟΤΥΧΙΑ υπόλοιπο ζυμαριού μετά ακύρωση (80-60=20): %', v; end if;
  raise notice 'OK ακυρώσεις: ζυμάρι % (αναμενόμενο 20)', v;

  -- ξανακαταχώρηση της πώλησης
  perform public.post_document(d);
  raise notice 'ΟΛΑ ΟΚ';
end $$;

-- Εικόνα αποτελεσμάτων
select code, name, item_type, on_hand, round(avg_cost, 4) as avg_cost, round(stock_value, 2) as value from public.v_stock_balance order by code;
select name, customer_balance, supplier_balance from public.v_partner_balance order by code;
select doc_no, doc_date, is_auto, item_name, produced_qty, round(base_unit_cost, 4) base_unit, round(actual_unit_cost, 4) actual_unit, is_final from public.v_production_cost order by doc_no;
select partner_name, channel, item_name, qty, net, round(cogs, 2) cogs, round(gross_profit, 2) gp from public.v_sales_by_partner_item order by 1, 3;

-- RLS: άλλος χρήστης δεν βλέπει τίποτα
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select count(*) as visible_items_for_other_user from public.item;
select count(*) as visible_docs_for_other_user from public.v_doc_list;
reset role;
