-- =====================================================================
-- Pizza ERP - 0004 voice ("Πες το")
-- Άλλα ονόματα (aliases), κανάλια wolt/box, ανοιχτά πρόχειρα (μετρητής
-- ημέρας, απογραφή σε εξέλιξη), αυτόματο ζυμάρι (backflush δύο επιπέδων,
-- μόνο όσο λείπει από το απόθεμα), επιμερισμός απογραφής με αυτόματα
-- ημιέτοιμα, έλεγχοι εταιρείας σε συνταγές/τιμές, source_doc_id/is_auto
-- μόνο από τον server, δικές τους λέξεις/φράσεις (voice_phrase).
-- Απογραφή "τη στιγμή της μέτρησης": κάθε γραμμή απογραφής κρατά τη
-- στιγμή που μετρήθηκε το είδος (doc_line.stock_cut = θέση του μετρητή
-- των stock_move.id εκείνη τη στιγμή). Κίνηση m είναι "πριν" από τη μέτρηση
-- (D, cut) αν (m.move_date, m.id) <= (D, cut): ό,τι γράφτηκε αργότερα την
-- ίδια μέρα μετράει για μετά, άρα η μέρα δεν κλειδώνει· ό,τι ήταν ήδη
-- μέσα στη μέτρηση δεν ακυρώνεται (ούτε όσο η απογραφή είναι σε εξέλιξη).
-- Ξανατρέχει χωρίς σφάλμα (if not exists / create or replace).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Άλλα ονόματα: πώς λένε το είδος / τον συναλλασσόμενο στην πράξη
-- ---------------------------------------------------------------------
alter table public.item    add column if not exists aliases text[] not null default '{}';
alter table public.partner add column if not exists aliases text[] not null default '{}';

-- ---------------------------------------------------------------------
-- Ανοιχτό πρόχειρο που γεμίζει σταδιακά: πωλήσεις ημέρας ανά κανάλι,
-- απογραφή σε εξέλιξη ανά ημέρα. Η καταχώρηση το "κλείνει".
-- ---------------------------------------------------------------------
alter table public.doc add column if not exists is_running boolean not null default false;

-- ανοιχτή απογραφή: χωρίς κανάλι (μία ανά ημέρα)
update public.doc set is_running = false where is_running and doc_type = 'stocktake' and channel is not null;
alter table public.doc drop constraint if exists doc_running_check;
alter table public.doc add constraint doc_running_check
  check (not is_running or (status = 'draft' and doc_type in ('sale','stocktake')
                            and (doc_type <> 'stocktake' or channel is null)));

-- ένα ανοιχτό πρόχειρο ανά εταιρεία / τύπο / ημέρα / κανάλι
create unique index if not exists doc_one_running_draft
  on public.doc (company_id, doc_type, doc_date, (coalesce(channel, '')))
  where is_running and status = 'draft';

-- ---------------------------------------------------------------------
-- Στιγμή μέτρησης ανά γραμμή απογραφής: η θέση του μετρητή των
-- stock_move.id τη στιγμή που μετρήθηκε το είδος (_move_mark: ό,τι
-- γράφτηκε ως τότε έχει id <= στιγμή, ό,τι γραφτεί μετά έχει μεγαλύτερο).
-- Η φωνή (stocktake_count) τη γράφει στην πρώτη μέτρηση του είδους· όσες
-- μένουν κενές (απογραφή με το χέρι) παίρνουν τη στιγμή της καταχώρησης.
-- ---------------------------------------------------------------------
alter table public.doc_line add column if not exists stock_cut bigint;
alter table public.doc_line drop constraint if exists doc_line_stock_cut_check;
alter table public.doc_line add constraint doc_line_stock_cut_check check (stock_cut is null or stock_cut >= 0);

-- παλιές καταχωρημένες απογραφές: μετρήθηκαν λίγο πριν από τις δικές τους
-- διορθώσεις (το παλιό κλείδωμα δεν άφηνε κίνηση με ημερομηνία <= της
-- απογραφής μετά από αυτήν). Χωρίς διορθώσεις: ό,τι γράφτηκε ως τώρα.
-- Στιγμή >= από δική τους διόρθωση δεν γίνεται με τη νέα λογική (η διόρθωση
-- γράφεται πάντα μετά τη μέτρηση): διορθώνεται κι αυτή (παλιότερη εκδοχή).
update public.doc_line dl
   set stock_cut = coalesce((select min(m.id) - 1 from public.stock_move m where m.doc_id = s.id),
                            (select case when q.is_called then q.last_value else 0 end from public.stock_move_id_seq q))
  from public.doc s
 where s.id = dl.doc_id and s.doc_type = 'stocktake' and s.status = 'posted'
   and (dl.stock_cut is null
        or dl.stock_cut >= (select min(m.id) from public.stock_move m where m.doc_id = s.id));

-- ---------------------------------------------------------------------
-- Δικές τους λέξεις και φράσεις: "όταν λέω «οικογενειακή» εννοώ «μεγάλη
-- μαργαρίτα»". Τις εφαρμόζει ο τοπικός κατανοητής πριν από όλα.
-- ---------------------------------------------------------------------
create table if not exists public.voice_phrase (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.company(id) on delete cascade,
  phrase      text not null,
  meaning     text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint voice_phrase_phrase_check  check (char_length(btrim(phrase)) between 1 and 200),
  constraint voice_phrase_meaning_check check (char_length(btrim(meaning)) between 1 and 200)
);
-- μία φορά η κάθε φράση ανά εταιρεία (χωρίς διάκριση πεζών/κεφαλαίων)
create unique index if not exists voice_phrase_company_phrase on public.voice_phrase (company_id, lower(phrase));

-- κενά στην αρχή/στο τέλος και διπλά κενά φεύγουν
create or replace function public.voice_phrase_clean()
returns trigger language plpgsql as $$
begin
  new.phrase  := btrim(regexp_replace(new.phrase, '\s+', ' ', 'g'));
  new.meaning := btrim(regexp_replace(new.meaning, '\s+', ' ', 'g'));
  return new;
end $$;
drop trigger if exists voice_phrase_clean on public.voice_phrase;
create trigger voice_phrase_clean before insert or update on public.voice_phrase
  for each row execute function public.voice_phrase_clean();
drop trigger if exists voice_phrase_updated_at on public.voice_phrase;
create trigger voice_phrase_updated_at before update on public.voice_phrase
  for each row execute function public.set_updated_at();

alter table public.voice_phrase enable row level security;
drop policy if exists voice_phrase_all on public.voice_phrase;
create policy voice_phrase_all on public.voice_phrase for all to authenticated
  using (public.is_member(company_id)) with check (public.is_member(company_id));
grant select, insert, update, delete on public.voice_phrase to authenticated;
revoke all on public.voice_phrase from anon;

-- ---------------------------------------------------------------------
-- Κανάλια: + wolt, box. Ο αρχικός περιορισμός έχει αυτόματο όνομα, οπότε
-- σβήνουμε κάθε check που αφορά μόνο τη στήλη channel και τον ξαναφτιάχνουμε.
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.doc'::regclass
       and c.contype = 'c'
       and c.conkey = array[(select a.attnum from pg_attribute a
                              where a.attrelid = 'public.doc'::regclass and a.attname = 'channel')]::int2[]
  loop
    execute format('alter table public.doc drop constraint %I', r.conname);
  end loop;
end $$;
alter table public.doc add constraint doc_channel_check
  check (channel in ('wholesale','efood','wolt','box','phone','store'));

-- ---------------------------------------------------------------------
-- Σύνδεση με άλλο παραστατικό (source_doc_id) και "αυτόματο" τα γράφουν
-- μόνο οι functions καταχώρησης. Ο client δεν τα ορίζει, και η διαγραφή
-- παραστατικού που έχει "παιδιά" αποτυγχάνει αντί να τα σβήνει (cascade
-- που παρακάμπτει RLS, κλειδώματα και μέσο κόστος).
-- ---------------------------------------------------------------------
drop policy if exists doc_insert on public.doc;
create policy doc_insert on public.doc for insert to authenticated
  with check (public.is_member(company_id) and status = 'draft' and not is_auto and source_doc_id is null);
drop policy if exists doc_update on public.doc;
create policy doc_update on public.doc for update to authenticated
  using (public.is_member(company_id) and status = 'draft')
  with check (public.is_member(company_id) and status = 'draft' and not is_auto and source_doc_id is null);

do $$
declare r record;
begin
  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.doc'::regclass
       and c.contype = 'f'
       and c.conkey = array[(select a.attnum from pg_attribute a
                              where a.attrelid = 'public.doc'::regclass and a.attname = 'source_doc_id')]::int2[]
  loop
    execute format('alter table public.doc drop constraint %I', r.conname);
  end loop;
end $$;
-- no action: οι αυτόματες σβήνονται ρητά στην ακύρωση (_unpost_internal)
alter table public.doc add constraint doc_source_doc_id_fkey
  foreign key (source_doc_id) references public.doc(id);

-- ---------------------------------------------------------------------
-- Συνταγές / τιμές πελάτη: είδη και συναλλασσόμενοι της ίδιας εταιρείας.
-- (Τα foreign keys δεν βλέπουν RLS: χωρίς αυτόν τον έλεγχο μέλος άλλης
-- εταιρείας που ξέρει τα ids θα μπορούσε να "φυτέψει" συνταγή.)
-- ---------------------------------------------------------------------
create or replace function public.bom_check_company()
returns trigger language plpgsql as $$
begin
  if not exists (select 1 from public.item i where i.id = new.item_id and i.company_id = new.company_id) then
    raise exception 'Το είδος της συνταγής ανήκει σε άλλη εταιρεία';
  end if;
  return new;
end $$;
drop trigger if exists bom_check_company on public.bom;
create trigger bom_check_company before insert or update on public.bom
  for each row execute function public.bom_check_company();

create or replace function public.bom_validate()
returns trigger language plpgsql as $$
declare
  v_product_type   text;
  v_component_type text;
  v_bom_company    uuid;
  v_comp_company   uuid;
begin
  select i.item_type, b.company_id into v_product_type, v_bom_company
    from public.bom b join public.item i on i.id = b.item_id
   where b.id = new.bom_id;
  select item_type, company_id into v_component_type, v_comp_company
    from public.item where id = new.component_item_id;

  if v_bom_company is distinct from new.company_id then
    raise exception 'Η γραμμή συνταγής ανήκει σε άλλη εταιρεία από τη συνταγή';
  end if;
  if v_comp_company is distinct from new.company_id then
    raise exception 'Το συστατικό ανήκει σε άλλη εταιρεία';
  end if;
  if v_product_type = 'raw' then
    raise exception 'Οι πρώτες ύλες δεν έχουν συνταγή';
  end if;
  if v_product_type = 'semi' and v_component_type <> 'raw' then
    raise exception 'Ένα ημιέτοιμο μπορεί να περιέχει μόνο πρώτες ύλες';
  end if;
  if v_component_type = 'finished' then
    raise exception 'Ένα έτοιμο προϊόν δεν μπορεί να είναι συστατικό';
  end if;
  return new;
end $$;

create or replace function public.partner_price_check_company()
returns trigger language plpgsql as $$
begin
  if not exists (select 1 from public.partner p where p.id = new.partner_id and p.company_id = new.company_id)
     or not exists (select 1 from public.item i where i.id = new.item_id and i.company_id = new.company_id) then
    raise exception 'Ο πελάτης ή το είδος ανήκει σε άλλη εταιρεία';
  end if;
  return new;
end $$;
drop trigger if exists partner_price_check_company on public.partner_price;
create trigger partner_price_check_company before insert or update on public.partner_price
  for each row execute function public.partner_price_check_company();

-- ---------------------------------------------------------------------
-- Βοηθητικά για αυτόματες παραγωγές και κλειδώματα
-- ---------------------------------------------------------------------

-- Διαθέσιμο απόθεμα είδους για ανάλωση την p_date, χωρίς να γίνει αρνητικό
-- το υπόλοιπο σε καμία επόμενη ημέρα (κινήσεις με μεταγενέστερη ημερομηνία)
create or replace function public._available_qty(p_item uuid, p_date date)
returns numeric
language sql stable
set search_path = public
as $$
  select public.item_on_hand(p_item, p_date)
         + least(0, coalesce((select min(z.run)
                                from (select sum(m.qty) over (order by m.move_date) as run
                                        from public.stock_move m
                                       where m.item_id = p_item and m.move_date > p_date) z), 0));
$$;

-- Είδη που κινεί η πώληση ενός είδους: το ίδιο και, αν φτιάχνεται κατά
-- παραγγελία, τα συστατικά του (και τα συστατικά των αυτόματων ημιετοίμων του)
create or replace function public._item_tree(p_item uuid)
returns setof uuid
language sql stable
set search_path = public
as $$
  with recursive t(item_id, lvl) as (
    select p_item, 0
    union
    select bl.component_item_id, t.lvl + 1
      from t
      join public.item i on i.id = t.item_id and i.make_to_order
      join public.bom b on b.item_id = i.id and b.company_id = i.company_id and b.is_default and b.is_active
      join public.bom_line bl on bl.bom_id = b.id
     where t.lvl < 2
  )
  select distinct item_id from t;
$$;

-- Στιγμή τώρα: η θέση του μετρητή των stock_move.id. Δεν πάει ποτέ πίσω
-- (το max(id) πάει, όταν ακυρώνεται η τελευταία κίνηση), άρα μέτρηση που
-- γίνεται αργότερα έχει πάντα μεγαλύτερη στιγμή. Με το _lock_postings:
-- κάθε κίνηση της εταιρείας που υπάρχει έχει id <= στιγμή, κάθε επόμενη >.
create or replace function public._move_mark()
returns bigint
language sql volatile
set search_path = public
as $$
  select case when q.is_called then q.last_value else 0 end from public.stock_move_id_seq q;
$$;

-- Καταχωρημένη απογραφή με μεταγενέστερη ημερομηνία που κλειδώνει την
-- ημέρα p_date για κάποιο από τα είδη p_items (καμία γραμμή = ανοιχτή
-- ημέρα). Μέτρηση της ίδιας ημέρας δεν κλειδώνει: νέα κίνηση μετράει για
-- μετά από αυτήν.
create or replace function public._stocktake_lock(p_company uuid, p_date date, p_items uuid[])
returns table(doc_no int, doc_date date, item_name text)
language sql stable
set search_path = public
as $$
  select s.doc_no, s.doc_date, i.name
    from public.doc s
    join public.doc_line sl on sl.doc_id = s.id
    join public.item i on i.id = sl.item_id
   where s.company_id = p_company and s.doc_type = 'stocktake' and s.status = 'posted'
     and s.doc_date > p_date and sl.item_id = any(p_items)
   order by s.doc_date desc, s.doc_no desc
   limit 1;
$$;

-- ---------------------------------------------------------------------
-- Κλείδωμα: δεν καταχωρείται / ακυρώνεται παραστατικό που κινεί είδος
-- (α) με ημερομηνία πριν από καταχωρημένη απογραφή του είδους, ή
-- (β) (ακύρωση) με κίνηση που υπήρχε ήδη όταν μετρήθηκε το είδος: θα
--     άλλαζε το "αναμενόμενο" της μέτρησης. Ισχύει και για απογραφή σε
--     εξέλιξη / πρόχειρη (η στιγμή της μέτρησης μένει ως την καταχώρηση):
--     ξανακαταχωρημένο, το παραστατικό θα έπαιρνε νέα id και θα μετρούσε
--     για μετά, ενώ είναι ήδη μέσα στη μέτρηση. Στην πρόχειρη μόνο κινήσεις
--     της ίδιας μέρας (οι παλιότερων ημερών μένουν "πριν" ό,τι κι αν γίνει).
-- Νέο παραστατικό της ημέρας μιας μέτρησης καταχωρείται κανονικά (μετράει
-- για μετά), και ακυρώνεται όσο δεν το περιλαμβάνει κάποια μέτρηση.
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
     and s.doc_date > d.doc_date
     and sl.item_id in (select dl.item_id from public.doc_line dl where dl.doc_id = p_doc)
   order by s.doc_date desc, s.doc_no desc
   limit 1;
  if found then
    raise exception 'Κλειδωμένη περίοδος: υπάρχει απογραφή ΑΠ-% (%) που περιλαμβάνει το είδος "%". Χρησιμοποιήστε μεταγενέστερη ημερομηνία.',
      v_found.doc_no, v_found.doc_date, v_found.item_name;
  end if;

  select s.doc_no, s.doc_date, s.status, s.is_running, i.name as item_name into v_found
    from public.stock_move m
    join public.doc_line sl on sl.item_id = m.item_id
    join public.doc s on s.id = sl.doc_id
    join public.item i on i.id = m.item_id
   where m.doc_id = p_doc
     and s.company_id = d.company_id
     and s.doc_type = 'stocktake'
     and s.id <> d.id
     and (s.status = 'posted' or (sl.stock_cut is not null and m.move_date = s.doc_date))
     and (m.move_date, m.id) <= (s.doc_date, coalesce(sl.stock_cut, 9223372036854775807))
   order by (s.status = 'posted') desc, s.doc_date desc, s.doc_no desc
   limit 1;
  if found and v_found.status = 'posted' then
    raise exception 'Κλειδωμένη περίοδος: το είδος "%" μετρήθηκε στην απογραφή ΑΠ-% (%) μετά από αυτή την κίνηση, άρα η κίνηση μετράει ήδη στη μέτρηση. Για διόρθωση: ακυρώστε την απογραφή, βγάλτε το είδος από αυτήν και, μετά τη διόρθωση, γράψτε ξανά τη μέτρησή του.',
      v_found.item_name, v_found.doc_no, v_found.doc_date;
  elsif found then
    raise exception 'Κλειδωμένη περίοδος: το είδος "%" μετρήθηκε στην % ΑΠ-% (%) μετά από αυτή την κίνηση, άρα η κίνηση μετράει ήδη στη μέτρηση. Για διόρθωση: βγάλτε πρώτα το είδος από εκείνη την απογραφή (ή διαγράψτε την) και, μετά τη διόρθωση, μετρήστε το ξανά.',
      v_found.item_name, case when v_found.is_running then 'απογραφή σε εξέλιξη' else 'πρόχειρη απογραφή' end,
      v_found.doc_no, v_found.doc_date;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Ανάπτυξη συνταγής: μόνο συνταγές της εταιρείας· συστατικό που
-- στρογγυλεύεται στο 0 (π.χ. λίγα γραμμάρια σε ένα αυτόματο ζυμάρι)
-- παραλείπεται αντί να μπλοκάρει την καταχώρηση.
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
    select * into b from public.bom where id = d.bom_id and item_id = o.item_id and company_id = d.company_id;
  end if;
  if b.id is null then
    select * into b from public.bom
     where item_id = o.item_id and company_id = d.company_id and is_default and is_active limit 1;
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
     and round(bl.qty * o.qty / b.output_qty, 4) > 0
   order by bl.line_no;
end $$;

-- ---------------------------------------------------------------------
-- Πώληση: είδος "κατά παραγγελία" -> αυτόματη παραγωγή μόνο όσου λείπει
-- από το διαθέσιμο απόθεμα (ό,τι υπάρχει ήδη έτοιμο πωλείται πρώτα).
-- ---------------------------------------------------------------------
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
  v_need   numeric;
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
      v_need := round(l.qty - greatest(public._available_qty(l.item_id, d.doc_date), 0), 4);
      if v_need > 0 then
        select id into v_bom from public.bom
         where item_id = l.item_id and company_id = d.company_id and is_default and is_active limit 1;
        if v_bom is null then
          raise exception 'Το είδος "%" είναι κατά παραγγελία αλλά δεν έχει ενεργή συνταγή', l.iname;
        end if;
        insert into public.doc (company_id, doc_type, doc_date, status, bom_id, source_doc_id, is_auto, notes, created_by)
        values (d.company_id, 'production', d.doc_date, 'draft', v_bom, d.id, true,
                'Αυτόματη παραγωγή από πώληση ' || d.doc_no, d.created_by)
        returning id into v_prod;
        insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (v_prod, 1, 'output', l.item_id, v_need);
        perform public._explode_bom(v_prod);
        perform public._post_internal(v_prod);
      end if;
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

-- ---------------------------------------------------------------------
-- Παραγωγή: ημιέτοιμο "κατά παραγγελία" (π.χ. ζυμάρι) στις αναλώσεις
-- -> πρώτα αυτόματη παραγωγή όσου λείπει από το διαθέσιμο απόθεμα
-- (ζυμάρια που φτιάχτηκαν από πριν ή βρέθηκαν στην απογραφή αναλώνονται
-- πρώτα), μετά ανάλωση. Πώληση λιανικής -> αυτόματη παραγωγή πίτσας ->
-- αυτόματη παραγωγή ζυμαριού. Το ημιέτοιμο περιέχει μόνο πρώτες ύλες,
-- άρα η αναδρομή σταματά εκεί.
-- ---------------------------------------------------------------------
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
  v_need   numeric;
  v_bom    uuid;
  v_prod   uuid;
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

  -- έλεγχος όλων των αναλώσεων πριν από κάθε κίνηση / αυτόματη παραγωγή
  for l in
    select dl.qty, i.item_type as ctype, i.name as cname
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
  end loop;

  for l in
    select dl.*, i.item_type as ctype, i.name as cname, i.make_to_order as cmto
      from public.doc_line dl join public.item i on i.id = dl.item_id
     where dl.doc_id = d.id and dl.role = 'input'
     order by dl.line_no
  loop
    -- αυτόματο ημιέτοιμο: παράγεται όσο λείπει για την ανάλωση
    if l.ctype = 'semi' and l.cmto then
      -- σειριοποίηση με άλλες καταχωρήσεις που αναλώνουν το ίδιο απόθεμα
      -- (ίδια σειρά κλειδωμάτων με το _stock_in του ημιετοίμου)
      perform 1 from public.item where id = l.item_id for update;
      v_need := round(l.qty - greatest(public._available_qty(l.item_id, d.doc_date), 0), 4);
      if v_need > 0 then
        select id into v_bom from public.bom
         where item_id = l.item_id and company_id = d.company_id and is_default and is_active limit 1;
        if v_bom is null then
          raise exception 'Το ημιέτοιμο "%" φτιάχνεται αυτόματα αλλά δεν έχει ενεργή συνταγή', l.cname;
        end if;
        insert into public.doc (company_id, doc_type, doc_date, status, bom_id, source_doc_id, is_auto, notes, created_by)
        values (d.company_id, 'production', d.doc_date, 'draft', v_bom, d.id, true,
                'Αυτόματη παραγωγή από ΠΑ-' || d.doc_no, d.created_by)
        returning id into v_prod;
        insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (v_prod, 1, 'output', l.item_id, v_need);
        perform public._explode_bom(v_prod);
        perform public._post_internal(v_prod);
      end if;
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

-- ---------------------------------------------------------------------
-- Πωλήσεις ημέρας πριν από μέτρηση: καταχωρούνται οι πρόχειρες πωλήσεις
-- ημέρας της εταιρείας (ανοιχτές, ή που έγιναν απλό πρόχειρο με
-- «Χειροκίνητη επεξεργασία» / ακύρωση) που κινούν (και μέσω αυτόματων
-- παραγωγών) κάποιο από τα p_items με ημερομηνία πριν από p_date, ή κάποιο
-- από τα p_same_day με ημερομηνία ίση με p_date. Είναι πωλήσεις που έγιναν
-- ήδη: αλλιώς η κατανάλωσή τους θα έβγαινε έλλειμμα στη μέτρηση και, όταν
-- καταχωρούνταν αργότερα, θα μετρούσε δεύτερη φορά (μετά τη μέτρηση)· οι
-- παλιότερων ημερών δεν θα καταχωρούνταν ποτέ (κλειδωμένη περίοδος). Αν
-- κάποια αποτύχει, αποτυγχάνει και η μέτρηση με καθαρό μήνυμα.
-- ---------------------------------------------------------------------
create or replace function public._post_day_tallies(p_company uuid, p_date date, p_items uuid[], p_same_day uuid[])
returns void
language plpgsql
set search_path = public
as $$
declare
  r     record;
  v_ids uuid[];
  v_id  uuid;
begin
  -- κλείδωμα όλων μαζί πριν από κάθε καταχώρηση (ίδια σειρά με το close_running)
  select array_agg(z.id order by z.doc_date, z.channel, z.doc_no) into v_ids
    from (select x.id, x.doc_date, x.channel, x.doc_no
            from public.doc x
           where x.company_id = p_company and x.doc_type = 'sale'
             and (x.is_running or (x.notes = 'Πωλήσεις ημέρας' and x.channel in ('efood','wolt','box','phone','store')))
             and x.status = 'draft' and not x.is_auto and x.doc_date <= p_date
             and exists (select 1
                           from public.doc_line xl
                           cross join lateral public._item_tree(xl.item_id) t(item_id)
                          where xl.doc_id = x.id
                            and t.item_id = any(case when x.doc_date < p_date then p_items else p_same_day end))
           order by x.doc_date, x.channel, x.doc_no
             for update of x) z;

  foreach v_id in array coalesce(v_ids, '{}'::uuid[]) loop
    select x.id, x.doc_no, x.doc_date, x.channel, x.status into r from public.doc x where x.id = v_id;
    if r.status <> 'draft' then
      continue;
    end if;
    -- ήδη κλειδωμένη από μεταγενέστερη απογραφή: μένει ως έχει (την αναφέρει το close_running)
    if exists (select 1 from public._stocktake_lock(p_company, r.doc_date,
                 array(select t.item_id from public.doc_line xl
                         cross join lateral public._item_tree(xl.item_id) t(item_id)
                        where xl.doc_id = r.id))) then
      continue;
    end if;
    begin
      perform public._post_internal(r.id);
    exception when others then
      raise exception 'Πρώτα πρέπει να καταχωρηθούν οι πωλήσεις ημέρας ΠΩ-% (% %): %',
        r.doc_no, to_char(r.doc_date, 'DD/MM'), r.channel, sqlerrm;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Απογραφή: κάθε είδος μετράει τη στιγμή που μετρήθηκε (stock_cut).
-- Αναμενόμενο = κινήσεις με (ημερομηνία, id) <= (D, cut) + οι διορθώσεις
-- των προηγούμενων μετρήσεων. Ό,τι γράφτηκε την ίδια μέρα μετά τη μέτρηση
-- μένει για μετά: υπόλοιπο μετά τη διόρθωση = μέτρηση + κινήσεις μετά.
-- Γραμμή χωρίς στιγμή (απογραφή με το χέρι) = "μετρήθηκε τώρα": πρώτα
-- καταχωρούνται οι πρόχειρες πωλήσεις ημέρας που κινούν το είδος. Για
-- γραμμή που έχει ήδη στιγμή, οι ανοιχτές πωλήσεις της ίδιας μέρας είναι
-- πωλήσεις μετά τη μέτρηση και μένουν ανοιχτές· οι παλιότερων ημερών
-- καταχωρούνται (είναι πριν από τη μέτρηση).
-- Αξία διαφοράς: με το μέσο κόστος τη στιγμή της μέτρησης, όχι του
-- κλεισίματος (αγορά μετά τη μέτρηση αλλάζει το σημερινό μέσο κόστος).
-- ---------------------------------------------------------------------
create or replace function public._post_stocktake(d public.doc)
returns void
language plpgsql
set search_path = public
as $$
declare
  l          record;
  v_found    record;
  v_items    uuid[];
  v_now      uuid[];
  v_expected numeric;
  v_onhand   numeric;
  v_after_val numeric;
  v_after_in boolean;
  v_diff     numeric;
  v_avg      numeric;
  v_unit     numeric;
begin
  if not exists (select 1 from public.doc_line where doc_id = d.id) then
    raise exception 'Η απογραφή δεν έχει γραμμές';
  end if;
  if exists (select 1 from public.doc_line where doc_id = d.id group by item_id having count(*) > 1) then
    raise exception 'Το ίδιο είδος εμφανίζεται δύο φορές στην απογραφή';
  end if;
  for l in select line_no from public.doc_line where doc_id = d.id and qty < 0 order by line_no limit 1 loop
    raise exception 'Αρνητική μέτρηση στη γραμμή %', l.line_no;
  end loop;
  perform public._assert_open(d.id);

  -- στιγμή που δεν έχει έρθει ακόμα (γραμμένη με το χέρι): "μετρήθηκε τώρα"
  update public.doc_line set stock_cut = null where doc_id = d.id and stock_cut > public._move_mark();

  select array_agg(item_id), coalesce(array_agg(item_id) filter (where stock_cut is null), '{}')
    into v_items, v_now
    from public.doc_line where doc_id = d.id;
  perform public._post_day_tallies(d.company_id, d.doc_date, v_items, v_now);

  update public.doc_line set stock_cut = public._move_mark()
   where doc_id = d.id and stock_cut is null;

  -- σειρά μετρήσεων ανά είδος: (ημερομηνία, στιγμή). Μέτρηση παλιότερη από
  -- άλλη καταχωρημένη (ή από τη διόρθωσή της) δεν καταχωρείται μετά από αυτήν.
  select i.name as item_name, s.doc_no, s.doc_date into v_found
    from public.doc_line dl
    join public.doc_line sl on sl.item_id = dl.item_id and sl.doc_id <> dl.doc_id
    join public.doc s on s.id = sl.doc_id
    join public.item i on i.id = dl.item_id
   where dl.doc_id = d.id
     and s.company_id = d.company_id and s.doc_type = 'stocktake' and s.status = 'posted'
     and ((s.doc_date, coalesce(sl.stock_cut, 9223372036854775807)) > (d.doc_date, dl.stock_cut)
          or ((s.doc_date, coalesce(sl.stock_cut, 9223372036854775807)) = (d.doc_date, dl.stock_cut)
              and exists (select 1 from public.stock_move m where m.doc_id = s.id and m.item_id = dl.item_id)))
   order by s.doc_date desc, sl.stock_cut desc
   limit 1;
  if found then
    raise exception 'Το είδος "%" μετρήθηκε ξανά μετά από αυτή τη μέτρηση, στην απογραφή ΑΠ-% (%). Ακυρώστε πρώτα εκείνη, ή βγάλτε το είδος από αυτή την απογραφή και μετρήστε το ξανά.',
      v_found.item_name, v_found.doc_no, v_found.doc_date;
  end if;

  for l in select * from public.doc_line where doc_id = d.id order by line_no loop
    -- οι διορθώσεις άλλων απογραφών είναι όλες πριν από αυτή τη μέτρηση (βλ. παραπάνω)
    select coalesce(sum(z.qty) filter (where z.before), 0),
           coalesce(sum(z.qty), 0),
           coalesce(sum(z.total_cost) filter (where not z.before), 0),
           coalesce(bool_or(not z.before and z.qty > 0), false)
      into v_expected, v_onhand, v_after_val, v_after_in
      from (select m.qty, m.total_cost,
                   (m.move_type = 'stocktake_adj' or (m.move_date, m.id) <= (d.doc_date, l.stock_cut)) as before
              from public.stock_move m
             where m.company_id = d.company_id and m.item_id = l.item_id) z;
    v_diff := l.qty - v_expected;
    select avg_cost into v_avg from public.item where id = l.item_id for update;

    -- μέσο κόστος τη στιγμή της μέτρησης: αν μετά από αυτήν μπήκε απόθεμα
    -- (π.χ. αγορά σε άλλη τιμή), το σημερινό χωρίς τις κινήσεις μετά· αλλιώς
    -- το σημερινό (οι εξαγωγές δεν αλλάζουν το μέσο κόστος)
    v_unit := v_avg;
    if v_after_in and v_expected > 0 then
      v_unit := round((v_onhand * v_avg - v_after_val) / v_expected, 6);
      if v_unit < 0 then
        v_unit := v_avg;
      end if;
    end if;

    update public.doc_line
       set expected_qty = v_expected,
           diff_qty     = v_diff,
           unit_cost    = v_unit,
           total_cost   = round(v_diff * v_unit, 4),
           diff_value   = round(-v_diff * v_unit, 4)   -- θετικό = έλλειμμα = επιβάρυνση κόστους
     where id = l.id;

    if v_diff <> 0 then
      insert into public.stock_move (company_id, doc_id, doc_line_id, item_id, move_date, move_type, qty, unit_cost, total_cost)
      values (d.company_id, d.id, l.id, l.item_id, d.doc_date, 'stocktake_adj', v_diff, v_unit, round(v_diff * v_unit, 4));
      -- διόρθωση σε άλλο κόστος από το σημερινό: νέο μέσο κόστος (όπως στο _stock_in)
      if v_unit <> v_avg and v_onhand > 0 and v_onhand + v_diff > 0 then
        update public.item set avg_cost = (v_onhand * v_avg + v_diff * v_unit) / (v_onhand + v_diff)
         where id = l.item_id;
      end if;
    end if;
  end loop;

  perform public._allocate_stocktake(d);
end $$;

-- ---------------------------------------------------------------------
-- Επιμερισμός απογραφής ανά περίοδο μέτρησης. Η περίοδος μιας μέτρησης
-- (D, cut) ενός είδους είναι οι κινήσεις με
--   (προηγούμενη D, προηγούμενο cut) < (ημερομηνία, id) <= (D, cut),
-- όπου προηγούμενη = η τελευταία καταχωρημένη μέτρηση του ίδιου είδους
-- (χωρίς προηγούμενη: από την αρχή). Ό,τι αναλώθηκε την ίδια μέρα μετά
-- τη μέτρηση πέφτει στην επόμενη περίοδο, δεν χάνεται.
-- Αλλάζουν οι υπογραφές: οι παλιές (μόνο ημερομηνίες) σβήνονται.
-- ---------------------------------------------------------------------
drop function if exists public._prev_stocktake_date(public.doc, uuid);
drop function if exists public._allocate_item(public.doc, uuid, numeric, numeric, date, int, text);
drop function if exists public._semi_stock_use(uuid, uuid, date, date);
drop function if exists public._allocate_cascade(public.doc, uuid, numeric, numeric, date);

-- Προηγούμενη καταχωρημένη μέτρηση του είδους πριν από τη (d.doc_date, p_cut)
create or replace function public._prev_stocktake(
  d public.doc, p_item uuid, p_cut bigint, out prev_date date, out prev_cut bigint)
language sql stable
set search_path = public
as $$
  select s.doc_date, coalesce(sl.stock_cut, 9223372036854775807)
    from public.doc s
    join public.doc_line sl on sl.doc_id = s.id
   where s.company_id = d.company_id
     and s.doc_type = 'stocktake'
     and s.status = 'posted'
     and s.id <> d.id
     and sl.item_id = p_item
     and (s.doc_date, coalesce(sl.stock_cut, 9223372036854775807)) < (d.doc_date, coalesce(p_cut, 9223372036854775807))
   order by s.doc_date desc, coalesce(sl.stock_cut, 9223372036854775807) desc
   limit 1;
$$;

-- Επιμερισμός μιας διαφοράς (αξία p_value, ποσότητα p_qty, θετικό = έλλειμμα)
-- ενός είδους στις παραγωγές που το ανάλωσαν στην περίοδο
-- ((p_from_date, p_from_cut), (d.doc_date, p_to_cut)]
create or replace function public._allocate_item(
  d public.doc, p_item uuid, p_value numeric, p_qty numeric,
  p_from_date date, p_from_cut bigint, p_to_cut bigint, p_level int, p_source text)
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
     and (p_from_date is null or (m.move_date, m.id) > (p_from_date, coalesce(p_from_cut, 9223372036854775807)))
     and (m.move_date, m.id) <= (d.doc_date, coalesce(p_to_cut, 9223372036854775807));

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
         and (p_from_date is null or (m.move_date, m.id) > (p_from_date, coalesce(p_from_cut, 9223372036854775807)))
         and (m.move_date, m.id) <= (d.doc_date, coalesce(p_to_cut, 9223372036854775807))
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

-- ---------------------------------------------------------------------
-- Επιμερισμός απογραφής με αυτόματα ημιέτοιμα. Ό,τι έπεσε στις παραγωγές
-- ενός ημιετοίμου από τις πρώτες ύλες συνεχίζει (cascade) στα έτοιμα:
-- (α) αυτόματη παραγωγή μέσα σε άλλη παραγωγή: όλο στη γονική, που την
--     ανάλωσε ολόκληρη (ακριβές· δεν χρειάζεται περίοδος).
-- (β) χειροκίνητη παραγωγή: στις παραγωγές που ανάλωσαν το ημιέτοιμο από
--     απόθεμα (όχι από δικές τους αυτόματες) από την προηγούμενη μέτρηση
--     της πρώτης ύλης ως το τέλος της ημέρας της απογραφής. Όχι ως τη
--     στιγμή της μέτρησης: ζυμάρι που ζυμώθηκε πριν από μέτρηση στη μέση
--     της μέρας αναλώνεται κυρίως μετά, και τότε όλο το έλλειμμα θα έπεφτε
--     στις λίγες πίτσες του πρωινού. (Παλιά η αρχή ήταν η τελευταία μέτρηση
--     του ίδιου του ημιετοίμου, που για αυτόματο ζυμάρι δεν μετριέται ποτέ,
--     άρα από την αρχή: το έλλειμμα του μήνα έπεφτε και σε πίτσες
--     κλεισμένων μηνών.)
-- (γ) αυτόματη παραγωγή από πώληση του ίδιου του ημιετοίμου: μένει εκεί.
-- ---------------------------------------------------------------------

-- Αναλώσεις ημιετοίμου από απόθεμα ανά παραγωγή στην περίοδο
-- ((p_from_date, p_from_cut), (p_to_date, p_to_cut)] (κενό p_to_cut = ως
-- το τέλος της p_to_date)
create or replace function public._semi_stock_use(
  p_company uuid, p_semi uuid, p_from_date date, p_from_cut bigint, p_to_date date, p_to_cut bigint)
returns table(doc_id uuid, qty numeric)
language sql stable
set search_path = public
as $$
  select c.doc_id, c.q - coalesce(a.q, 0)
    from (select m.doc_id, sum(-m.qty) as q
            from public.stock_move m
           where m.company_id = p_company and m.item_id = p_semi and m.move_type = 'prod_consume'
             and (p_from_date is null or (m.move_date, m.id) > (p_from_date, coalesce(p_from_cut, 9223372036854775807)))
             and (m.move_date, m.id) <= (p_to_date, coalesce(p_to_cut, 9223372036854775807))
           group by m.doc_id) c
    left join lateral (
      select sum(ao.qty) as q
        from public.doc x join public.doc_line ao on ao.doc_id = x.id and ao.role = 'output'
       where x.source_doc_id = c.doc_id and x.is_auto and x.status = 'posted' and ao.item_id = p_semi
    ) a on true
   where c.q - coalesce(a.q, 0) > 0;
$$;

create or replace function public._allocate_cascade(
  d public.doc, p_semi uuid, p_value numeric, p_qty numeric,
  p_from_date date, p_from_cut bigint, p_to_cut bigint)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_total numeric;
  v_id    bigint;
  v_resid numeric;
begin
  select coalesce(sum(u.qty), 0) into v_total
    from public._semi_stock_use(d.company_id, p_semi, p_from_date, p_from_cut, d.doc_date, p_to_cut) u;

  if v_total <= 0 then
    -- το ημιέτοιμο δεν αναλώθηκε από απόθεμα στην περίοδο: ανεπιμέριστο
    insert into public.cost_alloc (company_id, stocktake_doc_id, production_doc_id, component_item_id, produced_item_id, level, source, qty_alloc, cost_alloc)
    values (d.company_id, d.id, null, p_semi, null, 2, 'cascade', p_qty, p_value);
    return;
  end if;

  -- υπόλοιπο στρογγυλοποίησης στη μεγαλύτερη κατανομή αυτής της κλήσης
  with ins as (
    insert into public.cost_alloc (company_id, stocktake_doc_id, production_doc_id, component_item_id, produced_item_id, level, source, qty_alloc, cost_alloc)
    select d.company_id, d.id, u.doc_id, p_semi, o.item_id, 2, 'cascade',
           round(p_qty * u.qty / v_total, 4), round(p_value * u.qty / v_total, 4)
      from public._semi_stock_use(d.company_id, p_semi, p_from_date, p_from_cut, d.doc_date, p_to_cut) u
      join public.doc_line o on o.doc_id = u.doc_id and o.role = 'output'
    returning id, cost_alloc
  )
  select (array_agg(ins.id order by abs(ins.cost_alloc) desc, ins.id))[1], p_value - sum(ins.cost_alloc)
    into v_id, v_resid
    from ins;
  if v_resid <> 0 then
    update public.cost_alloc set cost_alloc = cost_alloc + v_resid where id = v_id;
  end if;
end $$;

create or replace function public._allocate_stocktake(d public.doc)
returns void
language plpgsql
set search_path = public
as $$
declare
  l       record;
  s       record;
  w       record;
  v_val   numeric;
  v_qty   numeric;
  v_cut   bigint;
  v_pd    date;
  v_pc    bigint;
begin
  -- Επίπεδο 1: πρώτες ύλες -> παραγωγές (ημιετοίμων και ετοίμων)
  for l in
    select dl.item_id, dl.diff_qty, dl.diff_value, dl.stock_cut
      from public.doc_line dl join public.item i on i.id = dl.item_id
     where dl.doc_id = d.id and i.item_type = 'raw' and dl.diff_qty <> 0
     order by dl.line_no
  loop
    select p.prev_date, p.prev_cut into v_pd, v_pc from public._prev_stocktake(d, l.item_id, l.stock_cut) p;
    perform public._allocate_item(d, l.item_id, l.diff_value, -l.diff_qty, v_pd, v_pc, l.stock_cut, 1, 'count');
  end loop;

  -- Επίπεδο 2: ημιέτοιμα -> παραγωγές ετοίμων
  -- (όσα μετρήθηκαν ή δέχτηκαν επιμερισμούς από το επίπεδο 1)
  for s in
    select i.id as item_id, i.avg_cost
      from public.item i
     where i.company_id = d.company_id and i.item_type = 'semi'
       and (exists (select 1 from public.doc_line dl where dl.doc_id = d.id and dl.item_id = i.id and dl.diff_qty <> 0)
         or exists (select 1 from public.cost_alloc ca where ca.stocktake_doc_id = d.id and ca.produced_item_id = i.id and ca.level = 1))
     order by i.code, i.id
  loop
    -- δική του διαφορά απογραφής
    select diff_value, -diff_qty, stock_cut into v_val, v_qty, v_cut
      from public.doc_line where doc_id = d.id and item_id = s.item_id;
    if found and v_val <> 0 then
      select p.prev_date, p.prev_cut into v_pd, v_pc from public._prev_stocktake(d, s.item_id, v_cut) p;
      perform public._allocate_item(d, s.item_id, v_val, v_qty, v_pd, v_pc, v_cut, 2, 'count');
    end if;

    -- (α) αυτόματες παραγωγές του μέσα σε άλλη παραγωγή -> στη γονική
    insert into public.cost_alloc (company_id, stocktake_doc_id, production_doc_id, component_item_id, produced_item_id, level, source, qty_alloc, cost_alloc)
    select d.company_id, d.id, p.id, s.item_id, po.item_id, 2, 'cascade',
           case when s.avg_cost > 0 then round(sum(ca.cost_alloc) / s.avg_cost, 4) end, sum(ca.cost_alloc)
      from public.cost_alloc ca
      join public.doc a on a.id = ca.production_doc_id and a.is_auto
      join public.doc p on p.id = a.source_doc_id and p.doc_type = 'production'
      join public.doc_line po on po.doc_id = p.id and po.role = 'output'
     where ca.stocktake_doc_id = d.id and ca.level = 1 and ca.produced_item_id = s.item_id
     group by p.id, po.item_id
    having sum(ca.cost_alloc) <> 0;

    -- (β) χειροκίνητες παραγωγές του -> αναλώσεις από απόθεμα, από την
    --     προηγούμενη μέτρηση της κάθε πρώτης ύλης ως το τέλος της ημέρας
    for w in
      select ca.component_item_id as comp, cl.stock_cut as to_cut, sum(ca.cost_alloc) as v
        from public.cost_alloc ca
        join public.doc a on a.id = ca.production_doc_id and not a.is_auto
        join public.doc_line cl on cl.doc_id = d.id and cl.item_id = ca.component_item_id
       where ca.stocktake_doc_id = d.id and ca.level = 1 and ca.produced_item_id = s.item_id
       group by ca.component_item_id, cl.stock_cut
       order by ca.component_item_id
    loop
      if w.v <> 0 then
        select p.prev_date, p.prev_cut into v_pd, v_pc from public._prev_stocktake(d, w.comp, w.to_cut) p;
        perform public._allocate_cascade(d, s.item_id, w.v,
                                         case when s.avg_cost > 0 then round(w.v / s.avg_cost, 4) end,
                                         v_pd, v_pc, null);
      end if;
    end loop;
  end loop;

  -- Επίπεδο 3: έτοιμα -> δεν επιμερίζονται, καταγράφονται ως απώλεια
  insert into public.cost_alloc (company_id, stocktake_doc_id, production_doc_id, component_item_id, produced_item_id, level, source, qty_alloc, cost_alloc)
  select d.company_id, d.id, null, dl.item_id, null, 3, 'count', -dl.diff_qty, dl.diff_value
    from public.doc_line dl join public.item i on i.id = dl.item_id
   where dl.doc_id = d.id and i.item_type = 'finished' and dl.diff_qty <> 0;
end $$;

-- ---------------------------------------------------------------------
-- Καταχώρηση: κλείνει και το ανοιχτό πρόχειρο (is_running = false).
-- Καταχωρήσεις / ακυρώσεις / μετρήσεις της ίδιας εταιρείας γίνονται μία
-- τη φορά (_lock_postings, πρώτο κλείδωμα κάθε RPC που γράφει κινήσεις):
-- έτσι η "στιγμή" μιας μέτρησης (_move_mark) δεν προσπερνά κίνηση άλλης
-- συσκευής που δεν έχει ολοκληρωθεί ακόμα.
-- ---------------------------------------------------------------------
create or replace function public._lock_postings(p_company uuid)
returns void
language sql
set search_path = public
as $$
  select pg_advisory_xact_lock(hashtextextended(format('post|%s', p_company), 0));
$$;

create or replace function public._post_internal(p_doc uuid)
returns void
language plpgsql
set search_path = public
as $$
declare d public.doc%rowtype;
begin
  select * into d from public.doc where id = p_doc for update;
  if not found then
    raise exception 'Δεν βρέθηκε το παραστατικό';
  end if;
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

  update public.doc set status = 'posted', posted_at = now(), is_running = false where id = p_doc;
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
    raise exception 'Η αυτόματη παραγωγή καταχωρείται μαζί με το παραστατικό που τη δημιουργεί';
  end if;
  perform public._lock_postings(d.company_id);
  perform public._post_internal(p_doc);
end $$;

-- ---------------------------------------------------------------------
-- Ακύρωση: οι αυτόματες παραγωγές (πώλησης ή παραγωγής) ακυρώνονται
-- αναδρομικά και διαγράφονται. Παραγωγή που έχει επιμερισμούς από
-- καταχωρημένη απογραφή δεν ακυρώνεται (θα χάνονταν οι επιμερισμοί).
-- Απογραφή ακυρώνεται μόνο αν δεν υπάρχει μεταγενέστερη μέτρηση
-- (ημερομηνία, στιγμή) κάποιου είδους της· κρατά τις στιγμές μέτρησης,
-- άρα ξανακαταχώρηση χωρίς αλλαγές δίνει το ίδιο αναμενόμενο, την ίδια
-- διαφορά και αξία (όσο η στιγμή μένει στην απογραφή, ό,τι ήταν μέσα στη
-- μέτρηση δεν ακυρώνεται: _assert_open).
-- Οι πωλήσεις ημέρας ξαναγίνονται ανοιχτό πρόχειρο (αν δεν άνοιξε άλλο
-- στο μεταξύ), ώστε να φαίνονται στις «Πωλήσεις ημέρας», να δέχονται
-- ποσότητες και να κλείνουν όπως πριν.
-- ---------------------------------------------------------------------
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
  v_st    int;
  v_found record;
  v_run   boolean := false;
begin
  select * into d from public.doc where id = p_doc for update;
  if not found or d.status <> 'posted' then
    raise exception 'Το παραστατικό δεν είναι καταχωρημένο';
  end if;

  if d.doc_type = 'stocktake' then
    select s.doc_no, i.name as item_name into v_found
      from public.doc_line dl
      join public.doc_line sl on sl.item_id = dl.item_id and sl.doc_id <> dl.doc_id
      join public.doc s on s.id = sl.doc_id
      join public.item i on i.id = dl.item_id
     where dl.doc_id = d.id
       and s.company_id = d.company_id and s.doc_type = 'stocktake' and s.status = 'posted'
       and (s.doc_date, coalesce(sl.stock_cut, 9223372036854775807))
         > (d.doc_date, coalesce(dl.stock_cut, 9223372036854775807))
     order by s.doc_date, sl.stock_cut
     limit 1;
    if found then
      raise exception 'Υπάρχει μεταγενέστερη απογραφή ΑΠ-% για το είδος "%" αυτής της απογραφής. Ακυρώστε πρώτα εκείνη.',
        v_found.doc_no, v_found.item_name;
    end if;
    delete from public.cost_alloc where stocktake_doc_id = d.id;
    update public.doc_line set expected_qty = null, diff_qty = null, diff_value = null where doc_id = d.id;
  else
    perform public._assert_open(d.id);
  end if;

  if d.doc_type = 'production' then
    select s.doc_no into v_st
      from public.cost_alloc ca join public.doc s on s.id = ca.stocktake_doc_id
     where ca.production_doc_id = d.id
     order by s.doc_date desc
     limit 1;
    if found then
      raise exception 'Η παραγωγή ΠΑ-% έχει επιμερισμούς κόστους από την απογραφή ΑΠ-%. Ακυρώστε πρώτα την απογραφή.',
        d.doc_no, v_st;
    end if;
  end if;

  -- αυτόματες παραγωγές αυτού του παραστατικού (και οι δικές τους, αναδρομικά)
  for v_auto in
    select a.id, a.status from public.doc a
     where a.source_doc_id = d.id and a.is_auto and a.company_id = d.company_id
     order by a.doc_no desc
  loop
    if v_auto.status = 'posted' then
      perform public._unpost_internal(v_auto.id);
    end if;
    delete from public.doc where id = v_auto.id;
  end loop;

  select array_agg(distinct item_id) into v_items from public.stock_move where doc_id = d.id;
  delete from public.stock_move   where doc_id = d.id;
  delete from public.partner_move where doc_id = d.id;

  -- μέσο κόστος ξανά από τις κινήσεις (τα παιδιά έχουν ήδη κάνει το δικό τους)
  if v_items is not null then
    foreach v_it in array v_items loop
      perform public._recalc_avg_cost(v_it);
    end loop;
  end if;

  if d.doc_type = 'sale' and not d.is_auto and d.notes = 'Πωλήσεις ημέρας'
     and d.channel in ('efood','wolt','box','phone','store') then
    perform pg_advisory_xact_lock(hashtextextended(format('tally|%s|%s|%s', d.company_id, d.doc_date, d.channel), 0));
    v_run := not exists (select 1 from public.doc x
                          where x.company_id = d.company_id and x.doc_type = 'sale' and x.doc_date = d.doc_date
                            and x.channel = d.channel and x.is_running and x.status = 'draft');
  end if;

  update public.doc_line set unit_cost = null, total_cost = null where doc_id = d.id;
  update public.doc set status = 'draft', posted_at = null, total_net = 0, total_vat = 0, total_gross = 0,
                        is_running = v_run
   where id = d.id;
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
    raise exception 'Η αυτόματη παραγωγή ακυρώνεται μαζί με το παραστατικό που τη δημιούργησε';
  end if;
  perform public._lock_postings(d.company_id);
  perform public._unpost_internal(p_doc);
end $$;

-- ---------------------------------------------------------------------
-- Μετρητής ημέρας: +/- ποσότητα ενός ετοίμου στην ανοιχτή πώληση της
-- ημέρας για ένα κανάλι λιανικής. Επιστρέφει το id της πώλησης ή null αν
-- άδειασε (και διαγράφηκε). Αύξηση σε ημέρα κλειδωμένη από απογραφή με
-- μεταγενέστερη ημερομηνία (για είδος που θα κινούσε η πώληση)
-- απορρίπτεται εδώ, αντί να μείνει πρόχειρο που δεν καταχωρείται ποτέ· η
-- μείωση επιτρέπεται (καθάρισμα). Μέτρηση της ίδιας μέρας δεν εμποδίζει:
-- η πρώτη μέτρηση ενός είδους καταχωρεί τις πωλήσεις ως εκείνη τη στιγμή,
-- και οι επόμενες μπαίνουν σε νέο ανοιχτό πρόχειρο (μετρούν για μετά).
-- ---------------------------------------------------------------------
create or replace function public.tally_add(
  p_company uuid, p_date date, p_channel text, p_item uuid, p_delta numeric)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_item  public.item%rowtype;
  v_doc   uuid;
  v_line  uuid;
  v_old   numeric;
  v_qty   numeric;
  v_lock  record;
begin
  if p_company is null or not public.is_member(p_company) then
    raise exception 'Δεν έχετε πρόσβαση στην εταιρεία';
  end if;
  if p_date is null then
    raise exception 'Χρειάζεται ημερομηνία';
  end if;
  if p_channel is null or p_channel not in ('efood','wolt','box','phone','store') then
    raise exception 'Μη έγκυρο κανάλι λιανικής: %', coalesce(p_channel, '(κενό)');
  end if;
  if p_delta is null or p_delta in ('NaN', 'Infinity', '-Infinity')
     or round(p_delta, 4) = 0 or abs(p_delta) >= 100000000 then
    raise exception 'Μη έγκυρη ποσότητα';
  end if;
  select * into v_item from public.item where id = p_item and company_id = p_company;
  if not found then
    raise exception 'Δεν βρέθηκε το είδος';
  end if;
  if v_item.item_type <> 'finished' then
    raise exception 'Στις πωλήσεις ημέρας μπαίνουν μόνο έτοιμα προϊόντα ("%")', v_item.name;
  end if;

  -- σειριοποίηση με καταχωρήσεις/μετρήσεις της εταιρείας και ανά ημέρα /
  -- κανάλι (πολλές συσκευές ταυτόχρονα)· πάντα με αυτή τη σειρά
  perform public._lock_postings(p_company);
  perform pg_advisory_xact_lock(hashtextextended(format('tally|%s|%s|%s', p_company, p_date, p_channel), 0));

  select x.id into v_doc
    from public.doc x
   where x.company_id = p_company and x.doc_type = 'sale' and x.doc_date = p_date
     and x.channel = p_channel and x.is_running and x.status = 'draft' and not x.is_auto
   limit 1
     for update;

  if p_delta > 0 then
    select * into v_lock from public._stocktake_lock(p_company, p_date, array(select public._item_tree(p_item)));
    if found then
      raise exception 'Κλειδωμένη περίοδος: υπάρχει απογραφή ΑΠ-% (%) που περιλαμβάνει το είδος "%". Χρησιμοποιήστε μεταγενέστερη ημερομηνία.',
        v_lock.doc_no, v_lock.doc_date, v_lock.item_name;
    end if;
  end if;

  select coalesce(sum(dl.qty), 0), (array_agg(dl.id order by dl.line_no, dl.id))[1]
    into v_old, v_line
    from public.doc_line dl
   where dl.doc_id = v_doc and dl.item_id = p_item and dl.role = 'item';
  v_qty := round(v_old + p_delta, 4);

  if v_qty > 0 then
    if v_qty >= 100000000 then
      raise exception 'Μη έγκυρη ποσότητα';
    end if;
    if v_doc is null then
      insert into public.doc (company_id, doc_type, doc_date, status, channel, is_running, notes)
      values (p_company, 'sale', p_date, 'draft', p_channel, true, 'Πωλήσεις ημέρας')
      returning id into v_doc;
    end if;
    if v_line is null then
      insert into public.doc_line (doc_id, line_no, role, item_id, qty, unit_price, vat_rate)
      select v_doc, coalesce(max(dl.line_no), 0) + 1, 'item', p_item, v_qty, v_item.sale_price, v_item.vat_rate
        from public.doc_line dl where dl.doc_id = v_doc;
    else
      update public.doc_line set qty = v_qty where id = v_line;
      -- διπλές γραμμές του ίδιου είδους (από χειροκίνητη επεξεργασία) ενώνονται
      delete from public.doc_line
       where doc_id = v_doc and item_id = p_item and role = 'item' and id <> v_line;
    end if;
  elsif v_doc is not null then
    delete from public.doc_line where doc_id = v_doc and item_id = p_item and role = 'item';
  end if;

  if v_doc is null then
    return null;
  end if;
  if not exists (select 1 from public.doc_line where doc_id = v_doc) then
    delete from public.doc where id = v_doc;
    return null;
  end if;
  return v_doc;
end $$;

-- ---------------------------------------------------------------------
-- Απογραφή σε εξέλιξη: μέτρηση ενός είδους στην ανοιχτή απογραφή της
-- ημέρας (p_add: πρόσθεση στη μέτρηση, π.χ. «αλεύρι άλλα 5» στο επόμενο
-- δωμάτιο· p_qty null: αφαίρεση γραμμής). Η πρώτη μέτρηση του είδους
-- κρατά τη στιγμή (stock_cut), αφού πρώτα καταχωρήσει τις πρόχειρες
-- πωλήσεις ημέρας ως σήμερα που το κινούν· οι επόμενες προσθέσεις /
-- διορθώσεις κρατούν την ίδια στιγμή. Σε απογραφή παλιότερης ημερομηνίας
-- η πρώτη μέτρηση γίνεται μόνο αν το είδος δεν έχει ήδη κινήσεις μετά από
-- αυτήν. Επιστρέφει το id της απογραφής ή null αν άδειασε (και διαγράφηκε).
-- ---------------------------------------------------------------------
create or replace function public.stocktake_count(
  p_company uuid, p_date date, p_item uuid, p_qty numeric, p_add boolean default false)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_item  public.item%rowtype;
  v_doc   uuid;
  v_line  uuid;
  v_old   numeric;
  v_qty   numeric;
  v_cut   bigint;
  v_lock  record;
  v_later date;
begin
  if p_company is null or not public.is_member(p_company) then
    raise exception 'Δεν έχετε πρόσβαση στην εταιρεία';
  end if;
  if p_date is null then
    raise exception 'Χρειάζεται ημερομηνία';
  end if;
  if p_qty in ('NaN', 'Infinity', '-Infinity') or abs(p_qty) >= 100000000 then
    raise exception 'Μη έγκυρη ποσότητα';
  end if;
  select * into v_item from public.item where id = p_item and company_id = p_company;
  if not found then
    raise exception 'Δεν βρέθηκε το είδος';
  end if;

  perform public._lock_postings(p_company);
  perform pg_advisory_xact_lock(hashtextextended(format('stocktake|%s|%s', p_company, p_date), 0));

  select x.id into v_doc
    from public.doc x
   where x.company_id = p_company and x.doc_type = 'stocktake' and x.doc_date = p_date
     and x.is_running and x.status = 'draft' and not x.is_auto
   order by x.created_at, x.id
   limit 1
     for update;

  if p_qty is null then
    if v_doc is null then
      return null;
    end if;
    delete from public.doc_line where doc_id = v_doc and item_id = p_item;
  else
    -- απογραφή με μεταγενέστερη ημερομηνία: αυτή η μέτρηση δεν θα καταχωρούνταν ποτέ
    select * into v_lock from public._stocktake_lock(p_company, p_date, array[p_item]);
    if found then
      raise exception 'Κλειδωμένη περίοδος: υπάρχει απογραφή ΑΠ-% (%) που περιλαμβάνει το είδος "%". Χρησιμοποιήστε μεταγενέστερη ημερομηνία.',
        v_lock.doc_no, v_lock.doc_date, v_lock.item_name;
    end if;
    select coalesce(sum(dl.qty), 0), (array_agg(dl.id order by dl.line_no, dl.id))[1], min(dl.stock_cut)
      into v_old, v_line, v_cut
      from public.doc_line dl
     where dl.doc_id = v_doc and dl.item_id = p_item;
    v_qty := round(case when coalesce(p_add, false) then v_old + p_qty else p_qty end, 4);
    if v_qty < 0 then
      raise exception 'Αρνητική μέτρηση για "%"', v_item.name;
    end if;
    if v_qty >= 100000000 then
      raise exception 'Μη έγκυρη ποσότητα';
    end if;
    if v_line is null then
      -- μέτρηση τώρα σε απογραφή παλιότερης ημερομηνίας (π.χ. ξεχασμένη από
      -- χθες): ό,τι γράφτηκε ήδη με μεταγενέστερη ημερομηνία (κινήσεις ή ανοιχτές
      -- πωλήσεις ημέρας που το κινούν) έγινε πριν από τη μέτρηση, αλλά θα
      -- μετρούσε για μετά, δηλαδή δύο φορές
      select min(m.move_date) into v_later
        from public.stock_move m
       where m.company_id = p_company and m.item_id = p_item and m.move_date > p_date;
      if v_later is null then
        select min(x.doc_date) into v_later
          from public.doc x
         where x.company_id = p_company and x.doc_type = 'sale' and x.status = 'draft' and not x.is_auto
           and (x.is_running or (x.notes = 'Πωλήσεις ημέρας' and x.channel in ('efood','wolt','box','phone','store')))
           and x.doc_date > p_date
           and exists (select 1
                         from public.doc_line xl
                         cross join lateral public._item_tree(xl.item_id) t(item_id)
                        where xl.doc_id = x.id and t.item_id = p_item);
      end if;
      if v_later is not null then
        raise exception 'Το είδος "%" έχει ήδη κινήσεις της % (μετά την ημερομηνία της απογραφής, %): μετρημένο τώρα, θα μετρούσαν δύο φορές. Μέτρησέ το σε απογραφή με τη σημερινή ημερομηνία.',
          v_item.name, to_char(v_later, 'DD/MM/YYYY'), to_char(p_date, 'DD/MM/YYYY');
      end if;
      -- πρώτη μέτρηση του είδους: ό,τι πουλήθηκε ως τώρα είναι πριν από αυτήν
      perform public._post_day_tallies(p_company, p_date, array[p_item], array[p_item]);
      v_cut := public._move_mark();
    end if;
    if v_doc is null then
      insert into public.doc (company_id, doc_type, doc_date, status, is_running, notes)
      values (p_company, 'stocktake', p_date, 'draft', true, 'Απογραφή σε εξέλιξη')
      returning id into v_doc;
    end if;
    if v_line is null then
      insert into public.doc_line (doc_id, line_no, role, item_id, qty, stock_cut)
      select v_doc, coalesce(max(dl.line_no), 0) + 1, 'item', p_item, v_qty, v_cut
        from public.doc_line dl where dl.doc_id = v_doc;
    else
      -- ίδια στιγμή με την πρώτη μέτρηση (κενή = γραμμή με το χέρι: "στην καταχώρηση")
      update public.doc_line set qty = v_qty, stock_cut = v_cut where id = v_line;
      -- η απογραφή δέχεται μία γραμμή ανά είδος
      delete from public.doc_line where doc_id = v_doc and item_id = p_item and id <> v_line;
    end if;
  end if;

  if not exists (select 1 from public.doc_line where doc_id = v_doc) then
    delete from public.doc where id = v_doc;
    return null;
  end if;
  return v_doc;
end $$;

-- ---------------------------------------------------------------------
-- Αυτόματο κλείσιμο: καταχωρεί κάθε ανοιχτή πώληση ημέρας πριν από
-- p_before. Κάθε πώληση χωριστά: μια αποτυχία δεν σταματά ούτε αναιρεί
-- τις άλλες. Οι απογραφές δεν κλείνουν ποτέ αυτόματα. Κενά ανοιχτά
-- πρόχειρα διαγράφονται σιωπηλά.
-- ---------------------------------------------------------------------
create or replace function public.close_running(p_company uuid, p_before date)
returns table(doc_id uuid, doc_no int, doc_date date, channel text, ok boolean, message text)
language plpgsql security definer
set search_path = public
as $$
declare r record;
begin
  if p_company is null or not public.is_member(p_company) then
    raise exception 'Δεν έχετε πρόσβαση στην εταιρεία';
  end if;
  if p_before is null then
    raise exception 'Χρειάζεται ημερομηνία';
  end if;
  perform public._lock_postings(p_company);

  -- skip locked: όποια επεξεργάζεται αυτή τη στιγμή άλλη συσκευή, μένει για την επόμενη φορά
  for r in
    select x.id, x.doc_no, x.doc_date, x.channel
      from public.doc x
     where x.company_id = p_company and x.doc_type = 'sale' and x.is_running
       and x.status = 'draft' and not x.is_auto and x.doc_date < p_before
     order by x.doc_date, x.channel, x.doc_no
       for update skip locked
  loop
    if not exists (select 1 from public.doc_line dl where dl.doc_id = r.id) then
      delete from public.doc x where x.id = r.id;
      continue;
    end if;
    doc_id := r.id; doc_no := r.doc_no; doc_date := r.doc_date; channel := r.channel;
    begin
      perform public._post_internal(r.id);
      ok := true;
      message := 'Καταχωρήθηκε';
    exception when others then
      ok := false;
      message := sqlerrm;
    end;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Λίστα παραστατικών: + is_running (στο τέλος, για create or replace)
-- ---------------------------------------------------------------------
create or replace view public.v_doc_list
with (security_invoker = true) as
select d.id, d.company_id, d.doc_type, d.doc_no, d.doc_date, d.status, d.channel, d.is_auto, d.source_doc_id,
       d.partner_id, p.name as partner_name, d.ref_no, d.amount,
       d.total_net, d.total_vat, d.total_gross, d.notes, d.created_at, d.posted_at,
       (select count(*) from public.doc_line l where l.doc_id = d.id) as line_count,
       (select i.name from public.doc_line l join public.item i on i.id = l.item_id
         where l.doc_id = d.id and l.role = 'output' limit 1) as produced_item_name,
       d.is_running
  from public.doc d
  left join public.partner p on p.id = d.partner_id;
grant select on public.v_doc_list to authenticated;

-- ---------------------------------------------------------------------
-- Δικαιώματα
-- ---------------------------------------------------------------------
revoke execute on function public._available_qty(uuid,date) from public, anon, authenticated;
revoke execute on function public._move_mark() from public, anon, authenticated;
revoke execute on function public._item_tree(uuid) from public, anon, authenticated;
revoke execute on function public._stocktake_lock(uuid,date,uuid[]) from public, anon, authenticated;
revoke execute on function public._explode_bom(uuid) from public, anon, authenticated;
revoke execute on function public._post_sale(public.doc) from public, anon, authenticated;
revoke execute on function public._post_production(public.doc) from public, anon, authenticated;
revoke execute on function public._assert_open(uuid) from public, anon, authenticated;
revoke execute on function public._post_day_tallies(uuid,date,uuid[],uuid[]) from public, anon, authenticated;
revoke execute on function public._post_stocktake(public.doc) from public, anon, authenticated;
revoke execute on function public._prev_stocktake(public.doc,uuid,bigint) from public, anon, authenticated;
revoke execute on function public._allocate_item(public.doc,uuid,numeric,numeric,date,bigint,bigint,int,text) from public, anon, authenticated;
revoke execute on function public._semi_stock_use(uuid,uuid,date,bigint,date,bigint) from public, anon, authenticated;
revoke execute on function public._allocate_cascade(public.doc,uuid,numeric,numeric,date,bigint,bigint) from public, anon, authenticated;
revoke execute on function public._allocate_stocktake(public.doc) from public, anon, authenticated;
revoke execute on function public._lock_postings(uuid) from public, anon, authenticated;
revoke execute on function public._post_internal(uuid) from public, anon, authenticated;
revoke execute on function public._unpost_internal(uuid) from public, anon, authenticated;
-- trigger functions (δεν καλούνται απευθείας)
revoke execute on function public.bom_check_company() from public, anon, authenticated;
revoke execute on function public.partner_price_check_company() from public, anon, authenticated;
revoke execute on function public.voice_phrase_clean() from public, anon, authenticated;

revoke execute on function public.post_document(uuid) from public, anon;
revoke execute on function public.unpost_document(uuid) from public, anon;
revoke execute on function public.tally_add(uuid,date,text,uuid,numeric) from public, anon;
revoke execute on function public.stocktake_count(uuid,date,uuid,numeric,boolean) from public, anon;
revoke execute on function public.close_running(uuid,date) from public, anon;
grant execute on function public.post_document(uuid), public.unpost_document(uuid),
  public.tally_add(uuid,date,text,uuid,numeric), public.stocktake_count(uuid,date,uuid,numeric,boolean),
  public.close_running(uuid,date) to authenticated;
