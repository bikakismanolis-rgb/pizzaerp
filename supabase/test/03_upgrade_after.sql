-- Αναβάθμιση, μέρος 2: τρέχει ΑΜΕΣΩΣ μετά το 0004 πάνω στη βάση του
-- 03_upgrade_before.sql. Οι παλιές καταχωρημένες απογραφές παίρνουν στιγμή
-- μέτρησης λίγο πριν από τις δικές τους διορθώσεις (κλειδωμένο ό,τι ήταν
-- ήδη γραμμένο), και από εκεί και πέρα ισχύει η νέα λογική.
\set ON_ERROR_STOP on

-- όλες οι καταχωρημένες απογραφές (όλων των εταιρειών) έχουν στιγμή, πριν
-- από τις δικές τους διορθώσεις (όπως κάθε μέτρηση με τη νέα λογική)
do $$
begin
  if exists (select 1 from public.doc_line dl join public.doc s on s.id = dl.doc_id
              where s.doc_type = 'stocktake' and s.status = 'posted' and dl.stock_cut is null) then
    raise exception 'ΑΠΟΤΥΧΙΑ: καταχωρημένη απογραφή χωρίς στιγμή μέτρησης μετά το 0004';
  end if;
  if exists (select 1 from public.doc_line dl join public.doc s on s.id = dl.doc_id
              where s.doc_type = 'stocktake' and s.status = 'posted'
                and dl.stock_cut >= (select min(m.id) from public.stock_move m where m.doc_id = s.id)) then
    raise exception 'ΑΠΟΤΥΧΙΑ: στιγμή παλιάς απογραφής μετά από δική της διόρθωση';
  end if;
end $$;

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

do $$
declare
  c uuid; flour uuid; mozz uuid; dough uuid; marg uuid; mill uuid;
  st uuid; st_draft uuid; st2 uuid; p_before uuid; s_old uuid; d uuid; p uuid; t uuid;
  v_cut bigint; v numeric; v2 numeric; n int;
begin
  select id into c from public.company where name = 'Πιτσαρία Αναβάθμιση';
  select id into flour from public.item where company_id = c and code = 'L-01';
  select id into mozz  from public.item where company_id = c and code = 'L-02';
  select id into dough from public.item where company_id = c and code = 'L-03';
  select id into marg  from public.item where company_id = c and code = 'L-04';
  select id into mill  from public.partner where company_id = c and code = 'L-S1';
  select id into st from public.doc where company_id = c and notes = 'Παλιά απογραφή';
  select id into st_draft from public.doc where company_id = c and notes = 'Πρόχειρη';
  select id into p_before from public.doc where company_id = c and notes = 'Πριν την απογραφή';
  select id into s_old from public.doc where company_id = c and notes = 'Πώληση 5/7';

  -- 1. στιγμή = λίγο πριν από τις διορθώσεις της (το παλιό κλείδωμα δεν
  --    άφηνε κίνηση με ημερομηνία <= της απογραφής μετά από αυτήν)· η
  --    πρόχειρη μένει κενή
  v_cut := (select min(id) - 1 from public.stock_move where doc_id = st);
  if v_cut is null or exists (select 1 from public.doc_line where doc_id = st and stock_cut is distinct from v_cut) then
    raise exception 'ΑΠΟΤΥΧΙΑ: στιγμή παλιάς απογραφής (% αντί %)', (select min(stock_cut) from public.doc_line where doc_id = st), v_cut;
  end if;
  if exists (select 1 from public.stock_move m where m.company_id = c and m.doc_id <> st and m.id > v_cut) then
    raise exception 'ΑΠΟΤΥΧΙΑ: κίνηση μετά τη στιγμή της παλιάς απογραφής';
  end if;
  if exists (select 1 from public.doc_line where doc_id = st_draft and stock_cut is not null) then
    raise exception 'ΑΠΟΤΥΧΙΑ: η πρόχειρη απογραφή πήρε στιγμή';
  end if;
  raise notice 'OK συμπλήρωση στιγμής παλιών απογραφών: %', v_cut;

  -- 1β. μέτρηση της ίδιας μέρας αμέσως μετά την αναβάθμιση (καμία νέα
  --     κίνηση ακόμα): είναι μετά την παλιά και καταχωρείται
  st2 := public.stocktake_count(c, '2026-07-10', flour, 92.5);
  if (select stock_cut from public.doc_line where doc_id = st2) <= v_cut then
    raise exception 'ΑΠΟΤΥΧΙΑ: στιγμή μέτρησης μετά την αναβάθμιση';
  end if;
  perform public.post_document(st2);
  select expected_qty, diff_qty into v, v2 from public.doc_line where doc_id = st2;
  if v <> 93 or v2 <> -0.5 then raise exception 'ΑΠΟΤΥΧΙΑ: μέτρηση αμέσως μετά την αναβάθμιση % / %', v, v2; end if;
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', st),
    'Υπάρχει μεταγενέστερη απογραφή ΑΠ-% για το είδος "Αλεύρι"%', 'ακύρωση παλιάς ενώ υπάρχει νεότερη της ίδιας μέρας');
  perform public.unpost_document(st2);
  delete from public.doc where id = st2;
  raise notice 'OK μέτρηση της ίδιας μέρας αμέσως μετά την αναβάθμιση';

  -- 2. ό,τι ήταν ήδη γραμμένο μένει κλειδωμένο
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', p_before),
    'Κλειδωμένη περίοδος: το είδος "Μοτσαρέλα" μετρήθηκε στην απογραφή ΑΠ-% μετά από αυτή την κίνηση%', 'παλιά αγορά της ημέρας της απογραφής');
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', s_old),
    'Κλειδωμένη περίοδος: υπάρχει απογραφή ΑΠ-%', 'παλιά πώληση πριν από την απογραφή');
  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', '2026-07-09', mill) returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (d, 1, flour, 1, 0.6, 13);
  perform pg_temp.expect_fail(format('select public.post_document(%L)', d),
    'Κλειδωμένη περίοδος: υπάρχει απογραφή ΑΠ-%"Αλεύρι"%', 'νέα αγορά πριν από την ημέρα της απογραφής');
  delete from public.doc where id = d;

  -- 3. νέα κίνηση την ίδια μέρα: μετά τη μέτρηση, περνάει και ακυρώνεται
  insert into public.doc (company_id, doc_type, doc_date, partner_id) values (c, 'purchase', '2026-07-10', mill) returning id into d;
  insert into public.doc_line (doc_id, line_no, item_id, qty, unit_price, vat_rate) values (d, 1, flour, 10, 0.62, 13);
  perform public.post_document(d);
  perform public.unpost_document(d);
  perform public.post_document(d);
  insert into public.doc (company_id, doc_type, doc_date) values (c, 'production', '2026-07-10') returning id into p;
  insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (p, 1, 'output', dough, 40);
  perform public.post_document(p);
  t := public.tally_add(c, '2026-07-10', 'store', marg, 2);
  perform public.post_document(t);
  raise notice 'OK νέες κινήσεις της ίδιας μέρας μετά την αναβάθμιση';

  -- 4. ακύρωση και ξανά καταχώρηση της παλιάς απογραφής: ίδιο αναμενόμενο,
  --    επιμερισμοί στις ίδιες παραγωγές (οι νέες κινήσεις της 10/7 είναι
  --    μετά τη μέτρηση· η αξία με το μέσο κόστος τη στιγμή της μέτρησης,
  --    χωρίς την αγορά αλευριού σε 0,62 που έγινε μετά). Μόνο το ζυμάρι
  --    του ζυμώματος 2/7 συνεχίζει (cascade) και στη μαργαρίτα της 10/7, που
  --    το ανάλωσε από απόθεμα την ίδια μέρα μετά τη μέτρηση.
  create temp table up_before on commit drop as
    select l.item_id, l.expected_qty, l.diff_qty,
           array(select distinct ca.production_doc_id from public.cost_alloc ca
                  where ca.stocktake_doc_id = st and ca.component_item_id = l.item_id and ca.production_doc_id is not null
                  order by 1) as prods
      from public.doc_line l where l.doc_id = st;
  -- αλεύρι -> ζυμάρι, μοτσαρέλα -> μαργαρίτα, ζυμάρι (cascade) -> μαργαρίτα
  if (select count(*) from up_before where cardinality(prods) = 1) <> 3 then
    raise exception 'ΑΠΟΤΥΧΙΑ: η παλιά απογραφή δεν είχε επιμερισμούς';
  end if;
  perform public.unpost_document(st);
  perform public.post_document(st);
  select count(*) into n
    from up_before b join public.doc_line l on l.doc_id = st and l.item_id = b.item_id
   where l.expected_qty <> b.expected_qty or l.diff_qty <> b.diff_qty or l.stock_cut <> v_cut
      or array(select distinct ca.production_doc_id from public.cost_alloc ca
                where ca.stocktake_doc_id = st and ca.component_item_id = l.item_id and ca.production_doc_id is not null
                order by 1)
         <> case when b.item_id = dough
                 then array(select x from unnest(b.prods || (select a.id from public.doc a where a.source_doc_id = t)) x order by 1)
                 else b.prods end;
  if n <> 0 then raise exception 'ΑΠΟΤΥΧΙΑ: ξανακαταχώρηση παλιάς απογραφής άλλαξε % γραμμές', n; end if;
  select unit_cost into v from public.doc_line where doc_id = st and item_id = flour;
  if abs(v - 0.60) > 0.00001 then raise exception 'ΑΠΟΤΥΧΙΑ: αξία αλευριού παλιάς απογραφής με κόστος % (σωστό 0,60)', v; end if;
  raise notice 'OK ξανακαταχώρηση παλιάς απογραφής: ίδιο αναμενόμενο, ίδιοι επιμερισμοί';

  -- 5. δεύτερη μέτρηση αλευριού την ίδια μέρα: βλέπει όλα, επιμερίζει μόνο τα νέα
  v := public.item_on_hand(flour);
  st2 := public.stocktake_count(c, '2026-07-10', flour, v - 0.1);
  perform public.post_document(st2);
  select expected_qty, diff_qty into v, v2 from public.doc_line where doc_id = st2;
  if v <> 93 + 10 - 6.5 or v2 <> -0.1 then raise exception 'ΑΠΟΤΥΧΙΑ: δεύτερη μέτρηση % / %', v, v2; end if;
  if (select count(*) from public.cost_alloc where stocktake_doc_id = st2 and level = 1) <> 1
     or not exists (select 1 from public.cost_alloc where stocktake_doc_id = st2 and level = 1 and production_doc_id = p) then
    raise exception 'ΑΠΟΤΥΧΙΑ: επιμερισμός δεύτερης μέτρησης μόνο στη νέα παραγωγή';
  end if;
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', st),
    'Υπάρχει μεταγενέστερη απογραφή ΑΠ-% για το είδος "Αλεύρι"%', 'ακύρωση παλιάς ενώ υπάρχει νεότερη');
  perform pg_temp.expect_fail(format('select public.unpost_document(%L)', p),
    'Κλειδωμένη περίοδος: το είδος "Αλεύρι" μετρήθηκε στην απογραφή ΑΠ-%', 'ακύρωση παραγωγής πριν από τη δεύτερη μέτρηση');

  -- 6. η πρόχειρη απογραφή (χωρίς στιγμή) καταχωρείται ως "τώρα"
  perform public.post_document(st_draft);
  if (select stock_cut from public.doc_line where doc_id = st_draft) is null then
    raise exception 'ΑΠΟΤΥΧΙΑ: πρόχειρη απογραφή χωρίς στιγμή μετά την καταχώρηση';
  end if;
  raise notice 'ΟΛΑ ΟΚ (αναβάθμιση)';
end $$;

reset role;
