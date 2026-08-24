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
