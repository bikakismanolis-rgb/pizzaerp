-- Pizza ERP: όλα τα migrations με τη σειρά (για επικόλληση στο Supabase SQL Editor)
-- Δημιουργήθηκε από τα supabase/migrations/000*.sql. Μην το επεξεργάζεσαι χειροκίνητα.

-- ===== supabase/migrations/0001_schema.sql =====
-- =====================================================================
-- Pizza ERP - 0001 schema
-- Πίνακες, περιορισμοί, triggers, Row Level Security
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Βοηθητικά
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Εταιρεία & μέλη
-- ---------------------------------------------------------------------
create table public.company (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  vat_no      text,
  address     text,
  phone       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.company_member (
  company_id  uuid not null references public.company(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null default 'owner' check (role in ('owner','staff')),
  created_at  timestamptz not null default now(),
  primary key (company_id, user_id)
);
create index on public.company_member (user_id);

-- Είναι ο τρέχων χρήστης μέλος της εταιρείας; (security definer για να μην
-- κάνει αναδρομή το RLS του company_member)
create or replace function public.is_member(p_company uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.company_member m
    where m.company_id = p_company and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_owner(p_company uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.company_member m
    where m.company_id = p_company and m.user_id = auth.uid() and m.role = 'owner'
  );
$$;

-- ---------------------------------------------------------------------
-- Είδη
-- ---------------------------------------------------------------------
create table public.item (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.company(id) on delete cascade,
  code           text not null,
  name           text not null,
  item_type      text not null check (item_type in ('raw','semi','finished')),
  category       text,
  unit           text not null default 'τεμ',
  vat_rate       numeric(5,2) not null default 13,
  sale_price     numeric(12,4) not null default 0,
  avg_cost       numeric(14,6) not null default 0,
  make_to_order  boolean not null default false,
  pack_name      text,
  pack_qty       numeric(12,4),
  min_stock      numeric(12,4),
  is_active      boolean not null default true,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (company_id, code)
);
create index on public.item (company_id, item_type);
create trigger item_updated_at before update on public.item
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Συναλλασσόμενοι (πελάτες / προμηθευτές)
-- ---------------------------------------------------------------------
create table public.partner (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.company(id) on delete cascade,
  code         text not null,
  name         text not null,
  is_customer  boolean not null default false,
  is_supplier  boolean not null default false,
  vat_no       text,
  phone        text,
  email        text,
  address      text,
  city         text,
  notes        text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, code),
  check (is_customer or is_supplier)
);
create index on public.partner (company_id);
create trigger partner_updated_at before update on public.partner
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Τιμοκατάλογος ανά πελάτη (κάθε ξενοδοχείο έχει τις δικές του τιμές).
-- Αν δεν υπάρχει γραμμή, ισχύει το item.sale_price.
-- ---------------------------------------------------------------------
create table public.partner_price (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.company(id) on delete cascade,
  partner_id  uuid not null references public.partner(id) on delete cascade,
  item_id     uuid not null references public.item(id) on delete cascade,
  price       numeric(12,4) not null check (price >= 0),
  updated_at  timestamptz not null default now(),
  unique (partner_id, item_id)
);
create index on public.partner_price (company_id, partner_id);
create trigger partner_price_updated_at before update on public.partner_price
  for each row execute function public.set_updated_at();

-- Τιμή είδους για συγκεκριμένο πελάτη (ή γενική τιμή)
create or replace function public.item_price_for(p_item uuid, p_partner uuid default null)
returns numeric
language sql stable
set search_path = public
as $$
  select coalesce(
    (select pp.price from public.partner_price pp where pp.item_id = p_item and pp.partner_id = p_partner),
    (select i.sale_price from public.item i where i.id = p_item)
  );
$$;

-- ---------------------------------------------------------------------
-- Συνταγές (BOM)
-- ---------------------------------------------------------------------
create table public.bom (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.company(id) on delete cascade,
  item_id     uuid not null references public.item(id) on delete cascade,
  name        text not null default 'Βασική',
  output_qty  numeric(12,4) not null check (output_qty > 0),
  is_default  boolean not null default true,
  is_active   boolean not null default true,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on public.bom (company_id, item_id);
-- μόνο μία προεπιλεγμένη ενεργή συνταγή ανά είδος
create unique index bom_one_default_per_item on public.bom (item_id) where is_default and is_active;
create trigger bom_updated_at before update on public.bom
  for each row execute function public.set_updated_at();

create table public.bom_line (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.company(id) on delete cascade,
  bom_id             uuid not null references public.bom(id) on delete cascade,
  line_no            int not null default 1,
  component_item_id  uuid not null references public.item(id),
  qty                numeric(12,4) not null check (qty > 0),
  notes              text,
  unique (bom_id, component_item_id)
);
create index on public.bom_line (bom_id);

-- Κανόνες συνταγής: πρώτη ύλη δεν έχει συνταγή, ημιέτοιμο καταναλώνει μόνο
-- πρώτες ύλες, έτοιμο καταναλώνει πρώτες ύλες + ημιέτοιμα. Άρα ακριβώς δύο
-- επίπεδα και κανένας κύκλος.
create or replace function public.bom_validate()
returns trigger language plpgsql as $$
declare
  v_product_type   text;
  v_component_type text;
  v_bom_company    uuid;
begin
  select i.item_type, b.company_id into v_product_type, v_bom_company
    from public.bom b join public.item i on i.id = b.item_id
   where b.id = new.bom_id;
  select item_type into v_component_type from public.item where id = new.component_item_id;

  if v_bom_company <> new.company_id then
    raise exception 'Η γραμμή συνταγής ανήκει σε άλλη εταιρεία από τη συνταγή';
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
create trigger bom_line_validate before insert or update on public.bom_line
  for each row execute function public.bom_validate();

-- ---------------------------------------------------------------------
-- Αρίθμηση παραστατικών
-- ---------------------------------------------------------------------
create table public.doc_counter (
  company_id  uuid not null references public.company(id) on delete cascade,
  doc_type    text not null,
  last_no     int  not null default 0,
  primary key (company_id, doc_type)
);

create or replace function public.next_doc_no(p_company uuid, p_type text)
returns int
language plpgsql security definer
set search_path = public
as $$
declare v_no int;
begin
  if not public.is_member(p_company) then
    raise exception 'Δεν έχετε πρόσβαση στην εταιρεία';
  end if;
  insert into public.doc_counter (company_id, doc_type, last_no)
  values (p_company, p_type, 1)
  on conflict (company_id, doc_type)
  do update set last_no = public.doc_counter.last_no + 1
  returning last_no into v_no;
  return v_no;
end $$;

-- ---------------------------------------------------------------------
-- Παραστατικά
-- ---------------------------------------------------------------------
create table public.doc (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.company(id) on delete cascade,
  doc_type       text not null check (doc_type in ('purchase','sale','production','stocktake','receipt','payment')),
  doc_no         int  not null,
  doc_date       date not null default current_date,
  status         text not null default 'draft' check (status in ('draft','posted')),
  partner_id     uuid references public.partner(id),
  channel        text check (channel in ('wholesale','efood','phone','store')),
  bom_id         uuid references public.bom(id),
  source_doc_id  uuid references public.doc(id) on delete cascade,  -- αυτόματη παραγωγή από πώληση
  is_auto        boolean not null default false,
  ref_no         text,                                                -- αρ. παραστατικού προμηθευτή
  amount         numeric(12,2),                                       -- είσπραξη / πληρωμή
  total_net      numeric(12,2) not null default 0,
  total_vat      numeric(12,2) not null default 0,
  total_gross    numeric(12,2) not null default 0,
  notes          text,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  posted_at      timestamptz,
  unique (company_id, doc_type, doc_no)
);
create index on public.doc (company_id, doc_type, doc_date);
create index on public.doc (company_id, partner_id);
create index on public.doc (source_doc_id);
create trigger doc_updated_at before update on public.doc
  for each row execute function public.set_updated_at();

create or replace function public.doc_before_insert()
returns trigger language plpgsql as $$
begin
  if new.doc_no is null then
    new.doc_no := public.next_doc_no(new.company_id, new.doc_type);
  end if;
  return new;
end $$;
create trigger doc_before_insert before insert on public.doc
  for each row execute function public.doc_before_insert();

create table public.doc_line (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.company(id) on delete cascade,
  doc_id         uuid not null references public.doc(id) on delete cascade,
  line_no        int  not null default 1,
  role           text not null default 'item' check (role in ('item','output','input')),
  item_id        uuid not null references public.item(id),
  qty            numeric(12,4) not null default 0,
  unit_price     numeric(12,4) not null default 0,
  discount_pct   numeric(5,2)  not null default 0,
  vat_rate       numeric(5,2)  not null default 0,
  net            numeric(12,2) not null default 0,
  vat            numeric(12,2) not null default 0,
  gross          numeric(12,2) not null default 0,
  unit_cost      numeric(14,6),          -- συμπληρώνεται στην καταχώρηση
  total_cost     numeric(14,4),          -- συμπληρώνεται στην καταχώρηση
  expected_qty   numeric(12,4),          -- απογραφή: αναμενόμενο
  diff_qty       numeric(12,4),          -- απογραφή: μετρημένο - αναμενόμενο
  diff_value     numeric(14,4),          -- απογραφή: αξία διαφοράς (θετικό = έλλειμμα = επιβάρυνση)
  notes          text
);
create index on public.doc_line (doc_id);
create index on public.doc_line (company_id, item_id);

-- company_id από το παραστατικό + υπολογισμός αξιών γραμμής
create or replace function public.doc_line_before_write()
returns trigger language plpgsql as $$
declare v_company uuid;
begin
  select company_id into v_company from public.doc where id = new.doc_id;
  new.company_id := v_company;
  new.net   := round(new.qty * new.unit_price * (1 - coalesce(new.discount_pct,0)/100), 2);
  new.vat   := round(new.net * coalesce(new.vat_rate,0)/100, 2);
  new.gross := new.net + new.vat;
  return new;
end $$;
create trigger doc_line_before_write before insert or update on public.doc_line
  for each row execute function public.doc_line_before_write();

-- ---------------------------------------------------------------------
-- Κινήσεις αποθήκης (γράφονται ΜΟΝΟ από τις functions καταχώρησης)
-- ---------------------------------------------------------------------
create table public.stock_move (
  id           bigserial primary key,
  company_id   uuid not null references public.company(id) on delete cascade,
  doc_id       uuid not null references public.doc(id) on delete cascade,
  doc_line_id  uuid references public.doc_line(id) on delete cascade,
  item_id      uuid not null references public.item(id),
  move_date    date not null,
  move_type    text not null check (move_type in ('purchase_in','sale_out','prod_consume','prod_output','stocktake_adj')),
  qty          numeric(14,4) not null,      -- με πρόσημο: + εισαγωγή, - εξαγωγή
  unit_cost    numeric(14,6) not null default 0,
  total_cost   numeric(14,4) not null default 0,  -- qty * unit_cost (με πρόσημο)
  created_at   timestamptz not null default now()
);
create index on public.stock_move (company_id, item_id, move_date, id);
create index on public.stock_move (doc_id);

-- ---------------------------------------------------------------------
-- Κινήσεις συναλλασσομένων
-- ---------------------------------------------------------------------
create table public.partner_move (
  id           bigserial primary key,
  company_id   uuid not null references public.company(id) on delete cascade,
  partner_id   uuid not null references public.partner(id),
  doc_id       uuid not null references public.doc(id) on delete cascade,
  ledger       text not null check (ledger in ('customer','supplier')),
  move_date    date not null,
  debit        numeric(12,2) not null default 0,
  credit       numeric(12,2) not null default 0,
  created_at   timestamptz not null default now()
);
create index on public.partner_move (company_id, partner_id, ledger, move_date, id);
create index on public.partner_move (doc_id);

-- ---------------------------------------------------------------------
-- Επιμερισμοί διαφορών απογραφής σε παραγωγές
-- production_doc_id NULL = ανεπιμέριστο υπόλοιπο (φύρα / απώλεια)
-- ---------------------------------------------------------------------
create table public.cost_alloc (
  id                 bigserial primary key,
  company_id         uuid not null references public.company(id) on delete cascade,
  stocktake_doc_id   uuid not null references public.doc(id) on delete cascade,
  production_doc_id  uuid references public.doc(id) on delete cascade,
  component_item_id  uuid not null references public.item(id),
  produced_item_id   uuid references public.item(id),
  level              int  not null check (level in (1,2,3)),  -- 1 πρώτη ύλη, 2 ημιέτοιμο, 3 έτοιμο
  source             text not null check (source in ('count','cascade')),
  qty_alloc          numeric(14,4),
  cost_alloc         numeric(14,4) not null,
  created_at         timestamptz not null default now()
);
create index on public.cost_alloc (stocktake_doc_id);
create index on public.cost_alloc (production_doc_id);
create index on public.cost_alloc (company_id, component_item_id);

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.company        enable row level security;
alter table public.company_member enable row level security;
alter table public.item           enable row level security;
alter table public.partner        enable row level security;
alter table public.partner_price  enable row level security;
alter table public.bom            enable row level security;
alter table public.bom_line       enable row level security;
alter table public.doc_counter    enable row level security;
alter table public.doc            enable row level security;
alter table public.doc_line       enable row level security;
alter table public.stock_move     enable row level security;
alter table public.partner_move   enable row level security;
alter table public.cost_alloc     enable row level security;

-- company: βλέπουν τα μέλη, αλλάζουν οι owners, δημιουργία μόνο μέσω create_company()
create policy company_select on public.company for select to authenticated using (public.is_member(id));
create policy company_update on public.company for update to authenticated using (public.is_owner(id)) with check (public.is_owner(id));

create policy member_select on public.company_member for select to authenticated using (public.is_member(company_id));
create policy member_insert on public.company_member for insert to authenticated with check (public.is_owner(company_id));
create policy member_delete on public.company_member for delete to authenticated using (public.is_owner(company_id) and user_id <> auth.uid());

-- βασικά αρχεία: πλήρης πρόσβαση στα μέλη
create policy item_all     on public.item     for all to authenticated using (public.is_member(company_id)) with check (public.is_member(company_id));
create policy partner_all  on public.partner  for all to authenticated using (public.is_member(company_id)) with check (public.is_member(company_id));
create policy partner_price_all on public.partner_price for all to authenticated using (public.is_member(company_id)) with check (public.is_member(company_id));
create policy bom_all      on public.bom      for all to authenticated using (public.is_member(company_id)) with check (public.is_member(company_id));
create policy bom_line_all on public.bom_line for all to authenticated using (public.is_member(company_id)) with check (public.is_member(company_id));

create policy counter_select on public.doc_counter for select to authenticated using (public.is_member(company_id));

-- παραστατικά: ο client γράφει μόνο σε πρόχειρα (draft). Καταχώρηση / ακύρωση
-- μόνο μέσω post_document() / unpost_document().
create policy doc_select on public.doc for select to authenticated using (public.is_member(company_id));
create policy doc_insert on public.doc for insert to authenticated with check (public.is_member(company_id) and status = 'draft' and not is_auto);
create policy doc_update on public.doc for update to authenticated using (public.is_member(company_id) and status = 'draft') with check (public.is_member(company_id) and status = 'draft');
create policy doc_delete on public.doc for delete to authenticated using (public.is_member(company_id) and status = 'draft');

create policy doc_line_select on public.doc_line for select to authenticated using (public.is_member(company_id));
create policy doc_line_write on public.doc_line for insert to authenticated
  with check (exists (select 1 from public.doc d where d.id = doc_id and public.is_member(d.company_id) and d.status = 'draft'));
create policy doc_line_update on public.doc_line for update to authenticated
  using (exists (select 1 from public.doc d where d.id = doc_id and public.is_member(d.company_id) and d.status = 'draft'))
  with check (exists (select 1 from public.doc d where d.id = doc_id and public.is_member(d.company_id) and d.status = 'draft'));
create policy doc_line_delete on public.doc_line for delete to authenticated
  using (exists (select 1 from public.doc d where d.id = doc_id and public.is_member(d.company_id) and d.status = 'draft'));

-- κινήσεις: μόνο ανάγνωση
create policy stock_move_select   on public.stock_move   for select to authenticated using (public.is_member(company_id));
create policy partner_move_select on public.partner_move for select to authenticated using (public.is_member(company_id));
create policy cost_alloc_select   on public.cost_alloc   for select to authenticated using (public.is_member(company_id));

-- Δικαιώματα (η Supabase τα δίνει ήδη μέσω default privileges, το επαναλαμβάνουμε ρητά)
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- ===== supabase/migrations/0002_functions.sql =====
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
revoke execute on function public.item_price_for(uuid,uuid) from public, anon;
grant execute on function public.item_price_for(uuid,uuid) to authenticated;
grant execute on function public.create_company(text,text), public.post_document(uuid), public.unpost_document(uuid),
  public.explode_bom(uuid), public.item_on_hand(uuid,date), public.is_member(uuid), public.is_owner(uuid) to authenticated;

-- ===== supabase/migrations/0003_views.sql =====
-- =====================================================================
-- Pizza ERP - 0003 views (αναφορές)
-- Όλες με security_invoker ώστε να σέβονται το RLS των πινάκων.
-- =====================================================================

-- Υπόλοιπα αποθήκης ανά είδος
create or replace view public.v_stock_balance
with (security_invoker = true) as
select i.id as item_id, i.company_id, i.code, i.name, i.item_type, i.category, i.unit,
       i.avg_cost, i.min_stock, i.is_active, i.make_to_order,
       coalesce(s.qty, 0)   as on_hand,
       coalesce(s.value, 0) as stock_value,
       (i.min_stock is not null and coalesce(s.qty, 0) < i.min_stock) as below_min
  from public.item i
  left join (
    select item_id, sum(qty) as qty, sum(total_cost) as value
      from public.stock_move group by item_id
  ) s on s.item_id = i.id;

-- Καρτέλα είδους με προοδευτικό υπόλοιπο
create or replace view public.v_item_ledger
with (security_invoker = true) as
select m.id, m.company_id, m.item_id, m.move_date, m.move_type, m.qty, m.unit_cost, m.total_cost,
       m.doc_id, d.doc_type, d.doc_no, d.partner_id, p.name as partner_name, d.is_auto,
       sum(m.qty) over (partition by m.item_id order by m.move_date, m.id) as running_qty
  from public.stock_move m
  join public.doc d on d.id = m.doc_id
  left join public.partner p on p.id = d.partner_id;

-- Υπόλοιπα συναλλασσομένων
create or replace view public.v_partner_balance
with (security_invoker = true) as
select p.id as partner_id, p.company_id, p.code, p.name, p.is_customer, p.is_supplier, p.is_active,
       coalesce(sum(case when m.ledger = 'customer' then m.debit - m.credit end), 0) as customer_balance,  -- + μας χρωστάει
       coalesce(sum(case when m.ledger = 'supplier' then m.credit - m.debit end), 0) as supplier_balance   -- + του χρωστάμε
  from public.partner p
  left join public.partner_move m on m.partner_id = p.id
 group by p.id;

-- Καρτέλα συναλλασσόμενου
create or replace view public.v_partner_ledger
with (security_invoker = true) as
select m.id, m.company_id, m.partner_id, m.ledger, m.move_date, m.debit, m.credit,
       m.doc_id, d.doc_type, d.doc_no, d.ref_no, d.notes,
       sum(case when m.ledger = 'customer' then m.debit - m.credit else m.credit - m.debit end)
         over (partition by m.partner_id, m.ledger order by m.move_date, m.id) as running_balance
  from public.partner_move m
  join public.doc d on d.id = m.doc_id;

-- Πωλήσεις ανά πελάτη / κανάλι / είδος / μήνα, με κόστος πωληθέντων
create or replace view public.v_sales_by_partner_item
with (security_invoker = true) as
select d.company_id, d.partner_id, p.name as partner_name, d.channel,
       l.item_id, i.name as item_name, i.item_type,
       date_trunc('month', d.doc_date)::date as month,
       sum(l.qty)        as qty,
       sum(l.net)        as net,
       sum(l.vat)        as vat,
       sum(l.total_cost) as cogs,
       sum(l.net) - sum(coalesce(l.total_cost, 0)) as gross_profit
  from public.doc d
  join public.doc_line l on l.doc_id = d.id and l.role = 'item'
  join public.item i on i.id = l.item_id
  left join public.partner p on p.id = d.partner_id
 where d.doc_type = 'sale' and d.status = 'posted'
 group by d.company_id, d.partner_id, p.name, d.channel, l.item_id, i.name, i.item_type, date_trunc('month', d.doc_date);

-- Αγορές ανά προμηθευτή / είδος / μήνα
create or replace view public.v_purchases_by_partner_item
with (security_invoker = true) as
select d.company_id, d.partner_id, p.name as partner_name,
       l.item_id, i.name as item_name, i.unit,
       date_trunc('month', d.doc_date)::date as month,
       sum(l.qty) as qty,
       sum(l.net) as net,
       sum(l.vat) as vat,
       case when sum(l.qty) > 0 then sum(l.net) / sum(l.qty) end as avg_price
  from public.doc d
  join public.doc_line l on l.doc_id = d.id
  join public.item i on i.id = l.item_id
  join public.partner p on p.id = d.partner_id
 where d.doc_type = 'purchase' and d.status = 'posted'
 group by d.company_id, d.partner_id, p.name, l.item_id, i.name, i.unit, date_trunc('month', d.doc_date);

-- Κόστος παραγωγών: βασικό (μέσα κόστη τη στιγμή) + επιμερισμοί απογραφής = πραγματικό
create or replace view public.v_production_cost
with (security_invoker = true) as
select d.id as doc_id, d.company_id, d.doc_no, d.doc_date, d.is_auto, d.source_doc_id,
       o.item_id, i.name as item_name, i.item_type,
       o.qty as produced_qty,
       coalesce(o.total_cost, 0)                        as base_cost,
       coalesce(a.alloc, 0)                             as alloc_cost,
       coalesce(o.total_cost, 0) + coalesce(a.alloc, 0) as actual_cost,
       case when o.qty > 0 then coalesce(o.total_cost, 0) / o.qty end as base_unit_cost,
       case when o.qty > 0 then (coalesce(o.total_cost, 0) + coalesce(a.alloc, 0)) / o.qty end as actual_unit_cost,
       (a.alloc is not null) as is_final   -- έχει "κλείσει" από απογραφή
  from public.doc d
  join public.doc_line o on o.doc_id = d.id and o.role = 'output'
  join public.item i on i.id = o.item_id
  left join (
    select production_doc_id, sum(cost_alloc) as alloc
      from public.cost_alloc where production_doc_id is not null group by production_doc_id
  ) a on a.production_doc_id = d.id
 where d.doc_type = 'production' and d.status = 'posted';

-- Πραγματικό κόστος ανά είδος ανά μήνα
create or replace view public.v_item_cost_monthly
with (security_invoker = true) as
select company_id, item_id, item_name, item_type,
       date_trunc('month', doc_date)::date as month,
       sum(produced_qty) as produced_qty,
       sum(base_cost)    as base_cost,
       sum(alloc_cost)   as alloc_cost,
       sum(actual_cost)  as actual_cost,
       case when sum(produced_qty) > 0 then sum(actual_cost) / sum(produced_qty) end as actual_unit_cost,
       bool_and(is_final) as is_final
  from public.v_production_cost
 group by company_id, item_id, item_name, item_type, date_trunc('month', doc_date);

-- Αποτέλεσμα απογραφής ανά είδος
create or replace view public.v_stocktake_result
with (security_invoker = true) as
select d.id as doc_id, d.company_id, d.doc_no, d.doc_date, d.status,
       l.item_id, i.name as item_name, i.item_type, i.unit,
       l.expected_qty, l.qty as counted_qty, l.diff_qty, l.unit_cost, l.diff_value,
       coalesce(a.allocated, 0)   as allocated_value,
       coalesce(a.unallocated, 0) as unallocated_value
  from public.doc d
  join public.doc_line l on l.doc_id = d.id
  join public.item i on i.id = l.item_id
  left join (
    select stocktake_doc_id, component_item_id,
           sum(case when production_doc_id is not null then cost_alloc else 0 end) as allocated,
           sum(case when production_doc_id is null then cost_alloc else 0 end)     as unallocated
      from public.cost_alloc
     where source = 'count'
     group by stocktake_doc_id, component_item_id
  ) a on a.stocktake_doc_id = d.id and a.component_item_id = l.item_id
 where d.doc_type = 'stocktake';

-- Λίστα παραστατικών με ονόματα (για τις οθόνες λίστας)
create or replace view public.v_doc_list
with (security_invoker = true) as
select d.id, d.company_id, d.doc_type, d.doc_no, d.doc_date, d.status, d.channel, d.is_auto, d.source_doc_id,
       d.partner_id, p.name as partner_name, d.ref_no, d.amount,
       d.total_net, d.total_vat, d.total_gross, d.notes, d.created_at, d.posted_at,
       (select count(*) from public.doc_line l where l.doc_id = d.id) as line_count,
       (select i.name from public.doc_line l join public.item i on i.id = l.item_id
         where l.doc_id = d.id and l.role = 'output' limit 1) as produced_item_name
  from public.doc d
  left join public.partner p on p.id = d.partner_id;

grant select on public.v_stock_balance, public.v_item_ledger, public.v_partner_balance, public.v_partner_ledger,
  public.v_sales_by_partner_item, public.v_purchases_by_partner_item, public.v_production_cost,
  public.v_item_cost_monthly, public.v_stocktake_result, public.v_doc_list to authenticated;

-- ===== supabase/migrations/0004_voice.sql =====
-- =====================================================================
-- Pizza ERP - 0004 voice ("Πες το")
-- Άλλα ονόματα (aliases), κανάλια wolt/box, ανοιχτά πρόχειρα (μετρητής
-- ημέρας, απογραφή σε εξέλιξη), αυτόματο ζυμάρι (backflush δύο επιπέδων).
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

alter table public.doc drop constraint if exists doc_running_check;
alter table public.doc add constraint doc_running_check
  check (not is_running or (status = 'draft' and doc_type in ('sale','stocktake')));

-- ένα ανοιχτό πρόχειρο ανά εταιρεία / τύπο / ημέρα / κανάλι
create unique index if not exists doc_one_running_draft
  on public.doc (company_id, doc_type, doc_date, (coalesce(channel, '')))
  where is_running and status = 'draft';

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
-- Παραγωγή: ημιέτοιμο "κατά παραγγελία" (π.χ. ζυμάρι) στις αναλώσεις
-- -> πρώτα αυτόματη παραγωγή του, μετά ανάλωση. Πώληση λιανικής ->
-- αυτόματη παραγωγή πίτσας -> αυτόματη παραγωγή ζυμαριού. Το ημιέτοιμο
-- περιέχει μόνο πρώτες ύλες, άρα η αναδρομή σταματά εκεί.
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
    -- αυτόματο ημιέτοιμο: παράγεται ακριβώς όσο αναλώνεται
    if l.ctype = 'semi' and l.cmto then
      select id into v_bom from public.bom where item_id = l.item_id and is_default and is_active limit 1;
      if v_bom is null then
        raise exception 'Το ημιέτοιμο "%" φτιάχνεται αυτόματα αλλά δεν έχει ενεργή συνταγή', l.cname;
      end if;
      insert into public.doc (company_id, doc_type, doc_date, status, bom_id, source_doc_id, is_auto, notes, created_by)
      values (d.company_id, 'production', d.doc_date, 'draft', v_bom, d.id, true,
              'Αυτόματη παραγωγή από ΠΑ-' || d.doc_no, d.created_by)
      returning id into v_prod;
      insert into public.doc_line (doc_id, line_no, role, item_id, qty) values (v_prod, 1, 'output', l.item_id, l.qty);
      perform public._explode_bom(v_prod);
      perform public._post_internal(v_prod);
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
-- Καταχώρηση: κλείνει και το ανοιχτό πρόχειρο (is_running = false)
-- ---------------------------------------------------------------------
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
  perform public._post_internal(p_doc);
end $$;

-- ---------------------------------------------------------------------
-- Ακύρωση: οι αυτόματες παραγωγές (πώλησης ή παραγωγής) ακυρώνονται
-- αναδρομικά και διαγράφονται. Παραγωγή που έχει επιμερισμούς από
-- καταχωρημένη απογραφή δεν ακυρώνεται (θα χάνονταν οι επιμερισμοί).
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
begin
  select * into d from public.doc where id = p_doc for update;
  if not found or d.status <> 'posted' then
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
    raise exception 'Η αυτόματη παραγωγή ακυρώνεται μαζί με το παραστατικό που τη δημιούργησε';
  end if;
  perform public._unpost_internal(p_doc);
end $$;

-- ---------------------------------------------------------------------
-- Μετρητής ημέρας: +/- ποσότητα ενός ετοίμου στην ανοιχτή πώληση της
-- ημέρας για ένα κανάλι λιανικής. Επιστρέφει το id της πώλησης ή null αν
-- άδειασε (και διαγράφηκε).
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

  -- σειριοποίηση ανά εταιρεία / ημέρα / κανάλι (πολλές συσκευές ταυτόχρονα)
  perform pg_advisory_xact_lock(hashtextextended(format('tally|%s|%s|%s', p_company, p_date, p_channel), 0));

  select x.id into v_doc
    from public.doc x
   where x.company_id = p_company and x.doc_type = 'sale' and x.doc_date = p_date
     and x.channel = p_channel and x.is_running and x.status = 'draft'
   limit 1
     for update;

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
-- ημέρας (p_add: πρόσθεση στη μέτρηση, p_qty null: αφαίρεση γραμμής).
-- Επιστρέφει το id της απογραφής ή null αν άδειασε (και διαγράφηκε).
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

  perform pg_advisory_xact_lock(hashtextextended(format('stocktake|%s|%s', p_company, p_date), 0));

  select x.id into v_doc
    from public.doc x
   where x.company_id = p_company and x.doc_type = 'stocktake' and x.doc_date = p_date
     and x.is_running and x.status = 'draft'
   order by x.created_at, x.id
   limit 1
     for update;

  if p_qty is null then
    if v_doc is null then
      return null;
    end if;
    delete from public.doc_line where doc_id = v_doc and item_id = p_item;
  else
    select coalesce(sum(dl.qty), 0), (array_agg(dl.id order by dl.line_no, dl.id))[1]
      into v_old, v_line
      from public.doc_line dl
     where dl.doc_id = v_doc and dl.item_id = p_item;
    v_qty := round(case when coalesce(p_add, false) then v_old + p_qty else p_qty end, 4);
    if v_qty < 0 then
      raise exception 'Αρνητική μέτρηση για "%"', v_item.name;
    end if;
    if v_qty >= 100000000 then
      raise exception 'Μη έγκυρη ποσότητα';
    end if;
    if v_doc is null then
      insert into public.doc (company_id, doc_type, doc_date, status, is_running, notes)
      values (p_company, 'stocktake', p_date, 'draft', true, 'Απογραφή σε εξέλιξη')
      returning id into v_doc;
    end if;
    if v_line is null then
      insert into public.doc_line (doc_id, line_no, role, item_id, qty)
      select v_doc, coalesce(max(dl.line_no), 0) + 1, 'item', p_item, v_qty
        from public.doc_line dl where dl.doc_id = v_doc;
    else
      update public.doc_line set qty = v_qty where id = v_line;
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
revoke execute on function public._post_production(public.doc) from public, anon, authenticated;
revoke execute on function public._post_internal(uuid) from public, anon, authenticated;
revoke execute on function public._unpost_internal(uuid) from public, anon, authenticated;

revoke execute on function public.post_document(uuid) from public, anon;
revoke execute on function public.unpost_document(uuid) from public, anon;
revoke execute on function public.tally_add(uuid,date,text,uuid,numeric) from public, anon;
revoke execute on function public.stocktake_count(uuid,date,uuid,numeric,boolean) from public, anon;
revoke execute on function public.close_running(uuid,date) from public, anon;
grant execute on function public.post_document(uuid), public.unpost_document(uuid),
  public.tally_add(uuid,date,text,uuid,numeric), public.stocktake_count(uuid,date,uuid,numeric,boolean),
  public.close_running(uuid,date) to authenticated;

