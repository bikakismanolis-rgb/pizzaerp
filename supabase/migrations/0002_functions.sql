-- =====================================================================
-- Pizza ERP - 0002 functions
-- Δημιουργία εταιρείας, καταχώρηση / ακύρωση παραστατικών, κοστολόγηση
-- =====================================================================

-- ---------------------------------------------------------------------
-- Δημιουργία εταιρείας: ο τρέχων χρήστης γίνεται owner
-- ---------------------------------------------------------------------
create or replace function public.create_company(p_name text, p_vat_no text default null)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_id  uuid;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Απαιτείται σύνδεση';
  end if;
  insert into public.company (name, vat_no) values (p_name, p_vat_no) returning id into v_id;
  insert into public.company_member (company_id, user_id, role) values (v_id, v_uid, 'owner');
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Υπόλοιπο είδους (μέχρι και μια ημερομηνία, προαιρετικά).
-- Security invoker: το RLS του stock_move περιορίζει στα μέλη.
-- ---------------------------------------------------------------------
create or replace function public.item_on_hand(p_item uuid, p_until date default null)
returns numeric
language sql stable
set search_path = public
as $$
  select coalesce(sum(m.qty), 0)
    from public.stock_move m
   where m.item_id = p_item
     and (p_until is null or m.move_date <= p_until);
$$;

-- ---------------------------------------------------------------------
-- Εσωτερικά: κινήσεις αποθήκης με ενημέρωση μέσου σταθμικού κόστους
-- ---------------------------------------------------------------------
create or replace function public._stock_in(
  p_company uuid, p_doc uuid, p_line uuid, p_item uuid, p_date date,
  p_type text, p_qty numeric, p_unit_cost numeric)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_onhand numeric;
  v_avg    numeric;
begin
  select avg_cost into v_avg from public.item where id = p_item for update;
  v_onhand := public.item_on_hand(p_item);

  insert into public.stock_move (company_id, doc_id, doc_line_id, item_id, move_date, move_type, qty, unit_cost, total_cost)
  values (p_company, p_doc, p_line, p_item, p_date, p_type, p_qty, p_unit_cost, round(p_qty * p_unit_cost, 4));

  -- μέσο σταθμικό: αν το υπόλοιπο είναι <= 0, το νέο μέσο είναι απλά το κόστος εισαγωγής
  if v_onhand > 0 and v_onhand + p_qty > 0 then
    v_avg := (v_onhand * v_avg + p_qty * p_unit_cost) / (v_onhand + p_qty);
  else
    v_avg := p_unit_cost;
  end if;
  update public.item set avg_cost = v_avg where id = p_item;
end $$;

create or replace function public._stock_out(
  p_company uuid, p_doc uuid, p_line uuid, p_item uuid, p_date date,
  p_type text, p_qty numeric)
returns numeric   -- συνολικό κόστος εξαγωγής (θετικό)
language plpgsql
set search_path = public
as $$
declare
  v_avg   numeric;
  v_total numeric;
begin
  select avg_cost into v_avg from public.item where id = p_item;
  v_total := round(p_qty * v_avg, 4);
  insert into public.stock_move (company_id, doc_id, doc_line_id, item_id, move_date, move_type, qty, unit_cost, total_cost)
  values (p_company, p_doc, p_line, p_item, p_date, p_type, -p_qty, v_avg, -v_total);
  return v_total;
end $$;

-- Επανυπολογισμός μέσου κόστους από τις κινήσεις (μετά από ακύρωση)
create or replace function public._recalc_avg_cost(p_item uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_qty numeric;
  v_val numeric;
begin
  select coalesce(sum(qty),0), coalesce(sum(total_cost),0) into v_qty, v_val
    from public.stock_move where item_id = p_item;
  if v_qty > 0 then
    update public.item set avg_cost = v_val / v_qty where id = p_item;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Κλείδωμα περιόδου: δεν επιτρέπεται κίνηση είδους με ημερομηνία <=
-- καταχωρημένης απογραφής που περιέχει το είδος.
-- ---------------------------------------------------------------------
create or replace function public._assert_open(p_doc uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  d       public.doc%rowtype;
  v_found record;
begin
  select * into d from public.doc where id = p_doc;
  select s.doc_no, s.doc_date, i.name as item_name into v_found
    from public.doc s
    join public.doc_line sl on sl.doc_id = s.id
    join public.item i on i.id = sl.item_id
   where s.company_id = d.company_id
     and s.doc_type = 'stocktake'
     and s.status = 'posted'
     and s.id <> d.id
     and s.doc_date >= d.doc_date
     and sl.item_id in (select item_id from public.doc_line where doc_id = p_doc)
   order by s.doc_date desc
   limit 1;
  if found then
    raise exception 'Κλειδωμένη περίοδος: υπάρχει απογραφή ΑΠ-% (%) που περιλαμβάνει το είδος "%". Χρησιμοποιήστε μεταγενέστερη ημερομηνία.',
      v_found.doc_no, v_found.doc_date, v_found.item_name;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Ανάπτυξη συνταγής σε γραμμές ανάλωσης (input) μιας παραγωγής
-- ---------------------------------------------------------------------
create or replace function public._explode_bom(p_doc uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  d public.doc%rowtype;
  o public.doc_line%rowtype;
  b public.bom%rowtype;
begin
  select * into d from public.doc where id = p_doc;
  select * into o from public.doc_line where doc_id = p_doc and role = 'output' limit 1;
  if not found then
    raise exception 'Η παραγωγή χρειάζεται μία γραμμή προϊόντος (output)';
  end if;

  if d.bom_id is not null then
    select * into b from public.bom where id = d.bom_id and item_id = o.item_id;
  end if;
  if b.id is null then
    select * into b from public.bom where item_id = o.item_id and is_default and is_active limit 1;
  end if;
  if b.id is null then
    raise exception 'Δεν υπάρχει ενεργή συνταγή για το είδος';
  end if;
  update public.doc set bom_id = b.id where id = p_doc and bom_id is distinct from b.id;

  delete from public.doc_line where doc_id = p_doc and role = 'input';
  insert into public.doc_line (doc_id, line_no, role, item_id, qty)
  select p_doc, 1 + bl.line_no, 'input', bl.component_item_id, round(bl.qty * o.qty / b.output_qty, 4)
    from public.bom_line bl
   where bl.bom_id = b.id
   order by bl.line_no;
end $$;

-- Δημόσια έκδοση για το UI (μόνο σε πρόχειρη παραγωγή μέλους)
create or replace function public.explode_bom(p_doc uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare d public.doc%rowtype;
begin
  select * into d from public.doc where id = p_doc;
  if not found or not public.is_member(d.company_id) then
    raise exception 'Δεν βρέθηκε το παραστατικό';
  end if;
  if d.doc_type <> 'production' or d.status <> 'draft' then
    raise exception 'Η ανάπτυξη συνταγής γίνεται μόνο σε πρόχειρη παραγωγή';
  end if;
  perform public._explode_bom(p_doc);
end $$;

-- ---------------------------------------------------------------------
-- Καταχώρηση ανά τύπο
-- ---------------------------------------------------------------------
create or replace function public._post_purchase(d public.doc)
returns void
language plpgsql
set search_path = public
as $$
declare
  l         record;
  v_net     numeric := 0;
  v_vat     numeric := 0;
  v_unit    numeric;
begin
  if d.partner_id is null then
    raise exception 'Η αγορά χρειάζεται προμηθευτή';
  end if;
  if not exists (select 1 from public.doc_line where doc_id = d.id) then
    raise exception 'Το παραστατικό δεν έχει γραμμές';
  end if;
  perform public._assert_open(d.id);

  for l in select * from public.doc_line where doc_id = d.id order by line_no loop
    if l.qty <= 0 then
      raise exception 'Μη έγκυρη ποσότητα στη γραμμή %', l.line_no;
    end if;
    v_unit := l.unit_price * (1 - coalesce(l.discount_pct, 0) / 100);
    perform public._stock_in(d.company_id, d.id, l.id, l.item_id, d.doc_date, 'purchase_in', l.qty, v_unit);
    update public.doc_line set unit_cost = v_unit, total_cost = l.net where id = l.id;
    v_net := v_net + l.net;
    v_vat := v_vat + l.vat;
  end loop;

  update public.doc set total_net = v_net, total_vat = v_vat, total_gross = v_net + v_vat where id = d.id;
  insert into public.partner_move (company_id, partner_id, doc_id, ledger, move_date, debit, credit)
  values (d.company_id, d.partner_id, d.id, 'supplier', d.doc_date, 0, v_net + v_vat);
end $$;

create or replace function public._post_production(d public.doc)
returns void
language plpgsql
set search_path = public
as $$
declare
  o        public.doc_line%rowtype;
  l        record;
  v_otype  text;
  v_total  numeric := 0;
  v_cost   numeric;
  v_unit   numeric;
begin
  if (select count(*) from public.doc_line where doc_id = d.id and role = 'output') <> 1 then
    raise exception 'Η παραγωγή χρειάζεται ακριβώς μία γραμμή προϊόντος';
  end if;
  select * into o from public.doc_line where doc_id = d.id and role = 'output';
  if o.qty <= 0 then
    raise exception 'Μη έγκυρη ποσότητα παραγωγής';
  end if;
  select item_type into v_otype from public.item where id = o.item_id;
  if v_otype = 'raw' then
    raise exception 'Δεν παράγονται πρώτες ύλες';
  end if;

  if not exists (select 1 from public.doc_line where doc_id = d.id and role = 'input') then
    perform public._explode_bom(d.id);
  end if;
  perform public._assert_open(d.id);

  for l in
    select dl.*, i.item_type as ctype, i.name as cname
      from public.doc_line dl join public.item i on i.id = dl.item_id
     where dl.doc_id = d.id and dl.role = 'input'
     order by dl.line_no
  loop
    if l.qty <= 0 then
      raise exception 'Μη έγκυρη ποσότητα ανάλωσης για "%"', l.cname;
    end if;
    if l.ctype = 'finished' or (v_otype = 'semi' and l.ctype <> 'raw') then
      raise exception 'Μη επιτρεπτό συστατικό "%" για αυτό το προϊόν', l.cname;
    end if;
    v_cost := public._stock_out(d.company_id, d.id, l.id, l.item_id, d.doc_date, 'prod_consume', l.qty);
    update public.doc_line set unit_cost = v_cost / l.qty, total_cost = v_cost where id = l.id;
    v_total := v_total + v_cost;
  end loop;

  v_unit := v_total / o.qty;
  perform public._stock_in(d.company_id, d.id, o.id, o.item_id, d.doc_date, 'prod_output', o.qty, v_unit);
  update public.doc_line set unit_cost = v_unit, total_cost = v_total where id = o.id;
  update public.doc set total_net = round(v_total, 2), total_vat = 0, total_gross = round(v_total, 2) where id = d.id;
end $$;

create or replace function public._post_sale(d public.doc)
returns void
language plpgsql
set search_path = public
as $$
declare
  l        record;
  v_net    numeric := 0;
  v_vat    numeric := 0;
  v_cost   numeric;
  v_bom    uuid;
  v_prod   uuid;
begin
  if not exists (select 1 from public.doc_line where doc_id = d.id and role = 'item') then
    raise exception 'Το παραστατικό δεν έχει γραμμές';
  end if;
  perform public._assert_open(d.id);

  for l in
    select dl.*, i.make_to_order, i.name as iname
      from public.doc_line dl join public.item i on i.id = dl.item_id
     where dl.doc_id = d.id and dl.role = 'item'
     order by dl.line_no
  loop
    if l.qty <= 0 then
      raise exception 'Μη έγκυρη ποσότητα στη γραμμή %', l.line_no;
    end if;

    -- backflush: είδος "κατά παραγγελία" -> αυτόματη παραγωγή πριν την πώληση
    if l.make_to_order then
      select id into v_bom from public.bom where item_id = l.item_id and is_default and is_active limit 1;
      if v_bom is null then
        raise exception 'Το είδος "%" είναι κατά παραγγελία αλλά δεν έχει ενεργή συνταγή', l.iname;
      end if;
      insert into public.doc (company_id, doc_type, doc_date, status, bom_id, source_doc_id, is_auto, notes, created_by)
      values (d.company_id, 'production', d.doc_date, 'draft', v_bom, d.id, true,
              'Αυτόματη παραγωγή από πώληση ' || d.doc_no, d.created_by)
      returning id into v_prod;
      insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (v_prod, 1, 'output', l.item_id, l.qty);
      perform public._explode_bom(v_prod);
      perform public._post_internal(v_prod);
    end if;

    v_cost := public._stock_out(d.company_id, d.id, l.id, l.item_id, d.doc_date, 'sale_out', l.qty);
    update public.doc_line set unit_cost = v_cost / l.qty, total_cost = v_cost where id = l.id;
    v_net := v_net + l.net;
    v_vat := v_vat + l.vat;
  end loop;

  update public.doc set total_net = v_net, total_vat = v_vat, total_gross = v_net + v_vat where id = d.id;
  if d.partner_id is not null then
    insert into public.partner_move (company_id, partner_id, doc_id, ledger, move_date, debit, credit)
    values (d.company_id, d.partner_id, d.id, 'customer', d.doc_date, v_net + v_vat, 0);
  end if;
end $$;

create or replace function public._post_receipt_payment(d public.doc)
returns void
language plpgsql
set search_path = public
as $$
begin
  if d.partner_id is null then
    raise exception 'Χρειάζεται συναλλασσόμενος';
  end if;
  if d.amount is null or d.amount <= 0 then
    raise exception 'Μη έγκυρο ποσό';
  end if;
  if d.doc_type = 'receipt' then
    insert into public.partner_move (company_id, partner_id, doc_id, ledger, move_date, debit, credit)
    values (d.company_id, d.partner_id, d.id, 'customer', d.doc_date, 0, d.amount);
  else
    insert into public.partner_move (company_id, partner_id, doc_id, ledger, move_date, debit, credit)
    values (d.company_id, d.partner_id, d.id, 'supplier', d.doc_date, d.amount, 0);
  end if;
  update public.doc set total_net = d.amount, total_vat = 0, total_gross = d.amount where id = d.id;
end $$;

-- ---------------------------------------------------------------------
-- Απογραφή + επιμερισμός διαφορών
-- ---------------------------------------------------------------------

-- Επιμερισμός μιας διαφοράς (αξία p_value, ποσότητα p_qty, θετικό = έλλειμμα)
-- ενός είδους στις παραγωγές που το κατανάλωσαν στην περίοδο (p_start, doc_date].
create or replace function public._allocate_item(
  d public.doc, p_item uuid, p_value numeric, p_qty numeric, p_start date, p_level int, p_source text)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_total numeric;
  v_resid numeric;
begin
  select coalesce(sum(-m.qty), 0) into v_total
    from public.stock_move m
   where m.company_id = d.company_id
     and m.item_id = p_item
     and m.move_type = 'prod_consume'
     and (p_start is null or m.move_date > p_start)
     and m.move_date <= d.doc_date;

  if v_total <= 0 then
    -- καμία παραγωγή δεν κατανάλωσε το είδος: ανεπιμέριστο (φύρα)
    insert into public.cost_alloc (company_id, stocktake_doc_id, production_doc_id, component_item_id, produced_item_id, level, source, qty_alloc, cost_alloc)
    values (d.company_id, d.id, null, p_item, null, p_level, p_source, p_qty, p_value);
    return;
  end if;

  insert into public.cost_alloc (company_id, stocktake_doc_id, production_doc_id, component_item_id, produced_item_id, level, source, qty_alloc, cost_alloc)
  select d.company_id, d.id, c.doc_id, p_item, o.item_id, p_level, p_source,
         round(p_qty * c.q / v_total, 4), round(p_value * c.q / v_total, 4)
    from (
      select m.doc_id, sum(-m.qty) as q
        from public.stock_move m
       where m.company_id = d.company_id
         and m.item_id = p_item
         and m.move_type = 'prod_consume'
         and (p_start is null or m.move_date > p_start)
         and m.move_date <= d.doc_date
       group by m.doc_id
    ) c
    join public.doc_line o on o.doc_id = c.doc_id and o.role = 'output';

  -- υπόλοιπο στρογγυλοποίησης στη μεγαλύτερη κατανομή
  select p_value - coalesce(sum(cost_alloc), 0) into v_resid
    from public.cost_alloc
   where stocktake_doc_id = d.id and component_item_id = p_item and level = p_level and source = p_source
     and production_doc_id is not null;
  if v_resid <> 0 then
    update public.cost_alloc set cost_alloc = cost_alloc + v_resid
     where id = (select id from public.cost_alloc
                  where stocktake_doc_id = d.id and component_item_id = p_item and level = p_level and source = p_source
                    and production_doc_id is not null
                  order by abs(cost_alloc) desc, id limit 1);
  end if;
end $$;

-- Ημερομηνία προηγούμενης καταχωρημένης απογραφής που περιείχε το είδος
create or replace function public._prev_stocktake_date(d public.doc, p_item uuid)
returns date
language sql stable
set search_path = public
as $$
  select max(s.doc_date)
    from public.doc s
    join public.doc_line sl on sl.doc_id = s.id
   where s.company_id = d.company_id
     and s.doc_type = 'stocktake'
     and s.status = 'posted'
     and s.id <> d.id
     and s.doc_date < d.doc_date
     and sl.item_id = p_item;
$$;

create or replace function public._allocate_stocktake(d public.doc)
returns void
language plpgsql
set search_path = public
as $$
declare
  l       record;
  s       record;
  v_val   numeric;
  v_qty   numeric;
  v_casc  numeric;
begin
  -- Επίπεδο 1: πρώτες ύλες -> παραγωγές (ημιετοίμων και ετοίμων)
  for l in
    select dl.item_id, dl.diff_qty, dl.diff_value
      from public.doc_line dl join public.item i on i.id = dl.item_id
     where dl.doc_id = d.id and i.item_type = 'raw' and dl.diff_qty <> 0
  loop
    perform public._allocate_item(d, l.item_id, l.diff_value, -l.diff_qty,
                                  public._prev_stocktake_date(d, l.item_id), 1, 'count');
  end loop;

  -- Επίπεδο 2: ημιέτοιμα -> παραγωγές ετοίμων
  -- (όσα μετρήθηκαν ή δέχτηκαν επιμερισμούς από το επίπεδο 1)
  for s in
    select i.id as item_id, i.avg_cost
      from public.item i
     where i.company_id = d.company_id and i.item_type = 'semi'
       and (exists (select 1 from public.doc_line dl where dl.doc_id = d.id and dl.item_id = i.id and dl.diff_qty <> 0)
         or exists (select 1 from public.cost_alloc ca where ca.stocktake_doc_id = d.id and ca.produced_item_id = i.id and ca.level = 1))
  loop
    -- δική του διαφορά απογραφής
    select diff_value, -diff_qty into v_val, v_qty
      from public.doc_line where doc_id = d.id and item_id = s.item_id;
    if found and v_val <> 0 then
      perform public._allocate_item(d, s.item_id, v_val, v_qty,
                                    public._prev_stocktake_date(d, s.item_id), 2, 'count');
    end if;
    -- ό,τι έπεσε στις παραγωγές του από τις πρώτες ύλες, συνεχίζει στα έτοιμα
    select coalesce(sum(cost_alloc), 0) into v_casc
      from public.cost_alloc
     where stocktake_doc_id = d.id and produced_item_id = s.item_id and level = 1 and production_doc_id is not null;
    if v_casc <> 0 then
      perform public._allocate_item(d, s.item_id, v_casc,
                                    case when s.avg_cost > 0 then round(v_casc / s.avg_cost, 4) else null end,
                                    public._prev_stocktake_date(d, s.item_id), 2, 'cascade');
    end if;
  end loop;

  -- Επίπεδο 3: έτοιμα -> δεν επιμερίζονται, καταγράφονται ως απώλεια
  insert into public.cost_alloc (company_id, stocktake_doc_id, production_doc_id, component_item_id, produced_item_id, level, source, qty_alloc, cost_alloc)
  select d.company_id, d.id, null, dl.item_id, null, 3, 'count', -dl.diff_qty, dl.diff_value
    from public.doc_line dl join public.item i on i.id = dl.item_id
   where dl.doc_id = d.id and i.item_type = 'finished' and dl.diff_qty <> 0;
end $$;

create or replace function public._post_stocktake(d public.doc)
returns void
language plpgsql
set search_path = public
as $$
declare
  l          record;
  v_expected numeric;
  v_diff     numeric;
  v_avg      numeric;
begin
  if not exists (select 1 from public.doc_line where doc_id = d.id) then
    raise exception 'Η απογραφή δεν έχει γραμμές';
  end if;
  if exists (select 1 from public.doc_line where doc_id = d.id group by item_id having count(*) > 1) then
    raise exception 'Το ίδιο είδος εμφανίζεται δύο φορές στην απογραφή';
  end if;
  perform public._assert_open(d.id);

  for l in select * from public.doc_line where doc_id = d.id order by line_no loop
    if l.qty < 0 then
      raise exception 'Αρνητική μέτρηση στη γραμμή %', l.line_no;
    end if;
    v_expected := public.item_on_hand(l.item_id, d.doc_date);
    v_diff     := l.qty - v_expected;
    select avg_cost into v_avg from public.item where id = l.item_id;

    update public.doc_line
       set expected_qty = v_expected,
           diff_qty     = v_diff,
           unit_cost    = v_avg,
           total_cost   = round(v_diff * v_avg, 4),
           diff_value   = round(-v_diff * v_avg, 4)   -- θετικό = έλλειμμα = επιβάρυνση κόστους
     where id = l.id;

    if v_diff <> 0 then
      insert into public.stock_move (company_id, doc_id, doc_line_id, item_id, move_date, move_type, qty, unit_cost, total_cost)
      values (d.company_id, d.id, l.id, l.item_id, d.doc_date, 'stocktake_adj', v_diff, v_avg, round(v_diff * v_avg, 4));
    end if;
  end loop;

  perform public._allocate_stocktake(d);
end $$;

-- ---------------------------------------------------------------------
-- Καταχώρηση / ακύρωση
-- ---------------------------------------------------------------------
create or replace function public._post_internal(p_doc uuid)
returns void
language plpgsql
set search_path = public
as $$
declare d public.doc%rowtype;
begin
  select * into d from public.doc where id = p_doc for update;
  if d.status <> 'draft' then
    raise exception 'Το παραστατικό είναι ήδη καταχωρημένο';
  end if;
  -- ακεραιότητα εταιρείας
  if exists (select 1 from public.doc_line dl join public.item i on i.id = dl.item_id
              where dl.doc_id = d.id and i.company_id <> d.company_id) then
    raise exception 'Γραμμή με είδος άλλης εταιρείας';
  end if;
  if d.partner_id is not null and not exists (select 1 from public.partner p where p.id = d.partner_id and p.company_id = d.company_id) then
    raise exception 'Συναλλασσόμενος άλλης εταιρείας';
  end if;

  case d.doc_type
    when 'purchase'   then perform public._post_purchase(d);
    when 'sale'       then perform public._post_sale(d);
    when 'production' then perform public._post_production(d);
    when 'stocktake'  then perform public._post_stocktake(d);
    when 'receipt'    then perform public._post_receipt_payment(d);
    when 'payment'    then perform public._post_receipt_payment(d);
  end case;

  update public.doc set status = 'posted', posted_at = now() where id = p_doc;
end $$;

create or replace function public.post_document(p_doc uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare d public.doc%rowtype;
begin
  select * into d from public.doc where id = p_doc;
  if not found or not public.is_member(d.company_id) then
    raise exception 'Δεν βρέθηκε το παραστατικό';
  end if;
  if d.is_auto then
    raise exception 'Η αυτόματη παραγωγή καταχωρείται μέσω της πώλησης';
  end if;
  perform public._post_internal(p_doc);
end $$;

create or replace function public._unpost_internal(p_doc uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  d       public.doc%rowtype;
  v_items uuid[];
  v_it    uuid;
  v_auto  record;
begin
  select * into d from public.doc where id = p_doc for update;
  if d.status <> 'posted' then
    raise exception 'Το παραστατικό δεν είναι καταχωρημένο';
  end if;

  if d.doc_type = 'stocktake' then
    if exists (
      select 1 from public.doc s join public.doc_line sl on sl.doc_id = s.id
       where s.company_id = d.company_id and s.doc_type = 'stocktake' and s.status = 'posted'
         and s.id <> d.id and s.doc_date > d.doc_date
         and sl.item_id in (select item_id from public.doc_line where doc_id = d.id)
    ) then
      raise exception 'Υπάρχει μεταγενέστερη απογραφή για είδη αυτής της απογραφής. Ακυρώστε πρώτα εκείνη.';
    end if;
    delete from public.cost_alloc where stocktake_doc_id = d.id;
    update public.doc_line set expected_qty = null, diff_qty = null, diff_value = null where doc_id = d.id;
  else
    perform public._assert_open(d.id);
  end if;

  -- αυτόματες παραγωγές μιας πώλησης: ακυρώνονται και διαγράφονται
  if d.doc_type = 'sale' then
    for v_auto in select id from public.doc where source_doc_id = d.id loop
      perform public._unpost_internal(v_auto.id);
      delete from public.doc where id = v_auto.id;
    end loop;
  end if;

  select array_agg(distinct item_id) into v_items from public.stock_move where doc_id = d.id;
  delete from public.stock_move   where doc_id = d.id;
  delete from public.partner_move where doc_id = d.id;

  if v_items is not null then
    foreach v_it in array v_items loop
      perform public._recalc_avg_cost(v_it);
    end loop;
  end if;

  update public.doc_line set unit_cost = null, total_cost = null where doc_id = d.id;
  update public.doc set status = 'draft', posted_at = null, total_net = 0, total_vat = 0, total_gross = 0 where id = d.id;
end $$;

create or replace function public.unpost_document(p_doc uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare d public.doc%rowtype;
begin
  select * into d from public.doc where id = p_doc;
  if not found or not public.is_member(d.company_id) then
    raise exception 'Δεν βρέθηκε το παραστατικό';
  end if;
  if d.is_auto then
    raise exception 'Η αυτόματη παραγωγή ακυρώνεται μαζί με την πώληση';
  end if;
  perform public._unpost_internal(p_doc);
end $$;

-- ---------------------------------------------------------------------
-- Δικαιώματα: οι εσωτερικές (_*) functions δεν καλούνται από τον client
-- ---------------------------------------------------------------------
revoke execute on function public._stock_in(uuid,uuid,uuid,uuid,date,text,numeric,numeric) from public, anon, authenticated;
revoke execute on function public._stock_out(uuid,uuid,uuid,uuid,date,text,numeric) from public, anon, authenticated;
revoke execute on function public._recalc_avg_cost(uuid) from public, anon, authenticated;
revoke execute on function public._assert_open(uuid) from public, anon, authenticated;
revoke execute on function public._explode_bom(uuid) from public, anon, authenticated;
revoke execute on function public._post_purchase(public.doc) from public, anon, authenticated;
revoke execute on function public._post_production(public.doc) from public, anon, authenticated;
revoke execute on function public._post_sale(public.doc) from public, anon, authenticated;
revoke execute on function public._post_receipt_payment(public.doc) from public, anon, authenticated;
revoke execute on function public._allocate_item(public.doc,uuid,numeric,numeric,date,int,text) from public, anon, authenticated;
revoke execute on function public._prev_stocktake_date(public.doc,uuid) from public, anon, authenticated;
revoke execute on function public._allocate_stocktake(public.doc) from public, anon, authenticated;
revoke execute on function public._post_stocktake(public.doc) from public, anon, authenticated;
revoke execute on function public._post_internal(uuid) from public, anon, authenticated;
revoke execute on function public._unpost_internal(uuid) from public, anon, authenticated;
-- next_doc_no καλείται από trigger με τα δικαιώματα του χρήστη: μένει
-- διαθέσιμη στους authenticated, με έλεγχο μέλους μέσα της (βλ. 0001).
revoke execute on function public.next_doc_no(uuid,text) from public, anon;
grant execute on function public.next_doc_no(uuid,text) to authenticated;

revoke execute on function public.create_company(text,text) from public, anon;
revoke execute on function public.post_document(uuid) from public, anon;
revoke execute on function public.unpost_document(uuid) from public, anon;
revoke execute on function public.explode_bom(uuid) from public, anon;
revoke execute on function public.item_on_hand(uuid,date) from public, anon;
grant execute on function public.create_company(text,text), public.post_document(uuid), public.unpost_document(uuid),
  public.explode_bom(uuid), public.item_on_hand(uuid,date), public.is_member(uuid), public.is_owner(uuid) to authenticated;
