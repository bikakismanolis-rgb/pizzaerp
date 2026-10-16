-- Αναβάθμιση, μέρος 1: τρέχει πάνω σε 0001–0003 ΠΡΙΝ από το 0004, με τις
-- παλιές functions. Δεδομένα όπως μιας εγκατάστασης που ήδη δουλεύει:
-- αγορές, παραγωγή, πώληση με backflush, αγορά την ημέρα της απογραφής και
-- απογραφή καταχωρημένη με την παλιά λογική ("τέλος της ημέρας"), και μια
-- πρόχειρη απογραφή.
\set ON_ERROR_STOP on

insert into auth.users (id, email) values ('55555555-5555-5555-5555-555555555555', 'legacy@example.com')
on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', false);

do $$
declare
  c uuid; flour uuid; mozz uuid; dough uuid; marg uuid; mill uuid;
  b_dough uuid; b_marg uuid; d uuid;
begin
  c := public.create_company('Πιτσαρία Αναβάθμιση', null);
  insert into public.item (company_id, code, name, item_type, unit) values (c, 'L-01', 'Αλεύρι', 'raw', 'kg') returning id into flour;
  insert into public.item (company_id, code, name, item_type, unit) values (c, 'L-02', 'Μοτσαρέλα', 'raw', 'kg') returning id into mozz;
  insert into public.item (company_id, code, name, item_type, unit) values (c, 'L-03', 'Ζυμάρι', 'semi', 'τεμ') returning id into dough;
  insert into public.item (company_id, code, name, item_type, unit, sale_price, make_to_order) values
    (c, 'L-04', 'Μαργαρίτα', 'finished', 'τεμ', 8, true) returning id into marg;
  insert into public.bom (company_id, item_id, output_qty) values (c, dough, 40) returning id into b_dough;
  insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values (c, b_dough, 1, flour, 6.5);
  insert into public.bom (company_id, item_id, output_qty) values (c, marg, 1) returning id into b_marg;
  insert into public.bom_line (company_id, bom_id, line_no, component_item_id, qty) values
    (c, b_marg, 1, dough, 1), (c, b_marg, 2, mozz, 0.12);
  insert into public.partner (company_id, code, name, is_supplier) values (c, 'L-S1', 'Μύλος', true) returning id into mill;

  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', '2026-07-01', mill) returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (d, 1, flour, 100, 0.60, 13), (d, 2, mozz, 20, 7, 13);
  perform public.post_document(d);
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'production', '2026-07-02') returning id into d;
  insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (d, 1, 'output', dough, 40);
  perform public.post_document(d);
  insert into public.doc (company_id, doc_type, doc_date, channel, notes) values (c, 'sale', '2026-07-05', 'store', 'Πώληση 5/7') returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (d, 1, marg, 10, 8, 13);
  perform public.post_document(d);
  -- αγορά την ίδια μέρα με την απογραφή, καταχωρημένη πριν από αυτήν
  insert into public.doc (company_id, doc_type, doc_date, partner_id, notes) values (c, 'purchase', '2026-07-10', mill, 'Πριν την απογραφή') returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (d, 1, mozz, 5, 7, 13);
  perform public.post_document(d);
  -- απογραφή 10/7 (παλιά λογική): αλεύρι 93.5 -> 93, μοτσαρέλα 23.8 -> 23.5, ζυμάρι 30 σωστό
  insert into public.doc (company_id, doc_type, doc_date, notes) values (c, 'stocktake', '2026-07-10', 'Παλιά απογραφή') returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty) values (d, 1, flour, 93), (d, 2, mozz, 23.5), (d, 3, dough, 30);
  perform public.post_document(d);
  if (select sum(diff_qty) from public.doc_line where doc_id = d) <> -0.8 then
    raise exception 'ΑΠΟΤΥΧΙΑ: παλιά απογραφή %', (select sum(diff_qty) from public.doc_line where doc_id = d);
  end if;
  -- πρόχειρη απογραφή: μένει χωρίς στιγμή μέτρησης
  insert into public.doc (company_id, doc_type, doc_date, notes) values (c, 'stocktake', '2026-07-20', 'Πρόχειρη') returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty) values (d, 1, mozz, 20);
  raise notice 'OK δεδομένα πριν από το 0004 (παλιές functions)';
end $$;

reset role;
