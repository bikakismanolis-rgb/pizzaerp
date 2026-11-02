-- =====================================================================
-- Pizza ERP - 0005 online παραγγελίες ("site")
-- Ο πελάτης παραγγέλνει από τη σελίδα του μαγαζιού (/s/<slug>), χωρίς
-- λογαριασμό. Η παραγγελία περιμένει στην οθόνη «Παραγγελίες». Με την
-- αποδοχή γίνεται κανονική πώληση με κανάλι 'site' που καταχωρείται αμέσως
-- (backflush, κόστος, κλειδώματα απογραφής όπως κάθε πώληση). Απόρριψη:
-- καμία κίνηση. Ακύρωση μετά την αποδοχή: η πώληση ακυρώνεται, αν δεν
-- κλειδώνει (αλλιώς μένει και το λέει).
-- Δεν αλλάζει καμία function των 0001-0004: οι online πωλήσεις δεν είναι
-- «Πωλήσεις ημέρας» (μετρητής), είναι μία πώληση ανά παραγγελία.
-- Ο επισκέπτης (anon) δεν διαβάζει κανέναν πίνακα: μόνο τρεις functions
-- (shop_menu, place_order, order_status) με συγκεκριμένα πεδία. Κόστη,
-- τιμές πελατών, προμηθευτές και αποθήκη δεν φαίνονται ποτέ.
-- Ξανατρέχει χωρίς σφάλμα (if not exists / create or replace).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Κανάλι 'site'. Ο αρχικός περιορισμός μπορεί να έχει αυτόματο όνομα
-- (βάση πριν από το 0004), οπότε σβήνουμε κάθε check που αφορά μόνο τη
-- στήλη channel και τον ξαναφτιάχνουμε.
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
  check (channel in ('wholesale','efood','wolt','box','phone','store','site'));

-- ---------------------------------------------------------------------
-- Είδη: ποια φαίνονται στο site, και μια μικρή περιγραφή για τον πελάτη
-- ---------------------------------------------------------------------
alter table public.item add column if not exists online boolean not null default false;
alter table public.item add column if not exists description text;
alter table public.item drop constraint if exists item_description_check;
alter table public.item add constraint item_description_check
  check (description is null or char_length(description) <= 300);

-- ---------------------------------------------------------------------
-- Το site του μαγαζιού: ένα ανά εταιρεία. Ανοιχτό = open_until στο μέλλον
-- (κλείνει μόνο του στην ώρα closes_at, για να μη μείνει ανοιχτό τη νύχτα).
-- ---------------------------------------------------------------------
create table if not exists public.online_shop (
  company_id       uuid primary key references public.company(id) on delete cascade,
  slug             text not null,
  title            text not null,
  phone            text,
  note             text,
  delivery         boolean not null default true,
  pickup           boolean not null default true,
  delivery_fee     numeric(8,2) not null default 0,
  min_order        numeric(8,2) not null default 0,
  closes_at        time not null default '23:30',
  open_until       timestamptz,
  -- για τη σύγκριση "τι θα πλήρωνες σε πλατφόρμα" (προαιρετικό)
  compare_fee_pct  numeric(5,2),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint online_shop_slug_check check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 40),
  constraint online_shop_title_check check (char_length(btrim(title)) between 1 and 80),
  constraint online_shop_phone_check check (phone is null or char_length(phone) <= 30),
  constraint online_shop_note_check check (note is null or char_length(note) <= 300),
  constraint online_shop_mode_check check (delivery or pickup),
  constraint online_shop_fee_check check (delivery_fee between 0 and 100),
  constraint online_shop_min_check check (min_order between 0 and 1000),
  constraint online_shop_compare_check check (compare_fee_pct is null or compare_fee_pct between 0 and 60)
);
create unique index if not exists online_shop_slug on public.online_shop (slug);

create or replace function public.online_shop_clean()
returns trigger language plpgsql as $$
begin
  new.slug  := lower(btrim(new.slug));
  new.title := btrim(regexp_replace(new.title, '\s+', ' ', 'g'));
  new.phone := nullif(btrim(coalesce(new.phone, '')), '');
  new.note  := nullif(btrim(coalesce(new.note, '')), '');
  return new;
end $$;
drop trigger if exists online_shop_clean on public.online_shop;
create trigger online_shop_clean before insert or update on public.online_shop
  for each row execute function public.online_shop_clean();
drop trigger if exists online_shop_updated_at on public.online_shop;
create trigger online_shop_updated_at before update on public.online_shop
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Παραγγελίες. Αριθμός ανά ημέρα (#1, #2... όπως τα λέει η κουζίνα).
-- Οι τιμές γραμμής είναι με ΦΠΑ, όπως τις είδε ο πελάτης.
-- Τα γράφουν μόνο οι functions.
-- ---------------------------------------------------------------------
create table if not exists public.online_order (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.company(id) on delete cascade,
  order_date     date not null,
  order_no       int  not null,
  token          uuid not null default gen_random_uuid(),
  status         text not null default 'new',
  mode           text not null,
  payment        text not null,
  customer_name  text not null,
  phone          text not null,
  address        text,
  notes          text,
  items_total    numeric(10,2) not null,
  delivery_fee   numeric(8,2)  not null default 0,
  total          numeric(10,2) not null,
  ready_minutes  int,
  reason         text,
  sale_doc_id    uuid references public.doc(id) on delete set null,
  -- αν η πώληση δεν καταχωρήθηκε στην αποδοχή (π.χ. είδος χωρίς συνταγή)
  stock_note     text,
  handled_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  accepted_at    timestamptz,
  done_at        timestamptz,
  closed_at      timestamptz,
  updated_at     timestamptz not null default now(),
  constraint online_order_status_check check (status in ('new','accepted','done','rejected','cancelled')),
  constraint online_order_mode_check check (mode in ('delivery','pickup')),
  constraint online_order_payment_check check (payment in ('cash','card')),
  constraint online_order_minutes_check check (ready_minutes is null or ready_minutes between 5 and 240),
  unique (company_id, order_date, order_no),
  unique (token)
);
create index if not exists online_order_company_status on public.online_order (company_id, status, created_at);
create index if not exists online_order_company_phone on public.online_order (company_id, phone, created_at);
create index if not exists online_order_sale_doc on public.online_order (sale_doc_id);
drop trigger if exists online_order_updated_at on public.online_order;
create trigger online_order_updated_at before update on public.online_order
  for each row execute function public.set_updated_at();

create table if not exists public.online_order_line (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.company(id) on delete cascade,
  order_id    uuid not null references public.online_order(id) on delete cascade,
  line_no     int  not null,
  item_id     uuid not null references public.item(id),
  name        text not null,
  qty         int  not null,
  unit_price  numeric(10,2) not null,
  note        text,
  constraint online_order_line_qty_check check (qty between 1 and 50),
  constraint online_order_line_note_check check (note is null or char_length(note) <= 100)
);
create index if not exists online_order_line_order on public.online_order_line (order_id);

-- ---------------------------------------------------------------------
-- Δικαιώματα: μέλη βλέπουν· γράφουν μόνο οι functions. Ο επισκέπτης
-- (anon) τίποτα απευθείας.
-- ---------------------------------------------------------------------
alter table public.online_shop       enable row level security;
alter table public.online_order      enable row level security;
alter table public.online_order_line enable row level security;

drop policy if exists online_shop_select on public.online_shop;
create policy online_shop_select on public.online_shop for select to authenticated using (public.is_member(company_id));
drop policy if exists online_shop_insert on public.online_shop;
create policy online_shop_insert on public.online_shop for insert to authenticated with check (public.is_owner(company_id));
drop policy if exists online_shop_update on public.online_shop;
create policy online_shop_update on public.online_shop for update to authenticated
  using (public.is_owner(company_id)) with check (public.is_owner(company_id));
drop policy if exists online_shop_delete on public.online_shop;
create policy online_shop_delete on public.online_shop for delete to authenticated using (public.is_owner(company_id));

drop policy if exists online_order_select on public.online_order;
create policy online_order_select on public.online_order for select to authenticated using (public.is_member(company_id));
drop policy if exists online_order_line_select on public.online_order_line;
create policy online_order_line_select on public.online_order_line for select to authenticated using (public.is_member(company_id));

revoke all on public.online_shop, public.online_order, public.online_order_line from anon, authenticated;
grant select, insert, update, delete on public.online_shop to authenticated;
grant select on public.online_order, public.online_order_line to authenticated;

-- ζωντανή ενημέρωση της οθόνης «Παραγγελίες» (Supabase Realtime, σέβεται το RLS)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'online_order') then
    alter publication supabase_realtime add table public.online_order;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Βοηθητικά. Η ώρα του μαγαζιού είναι πάντα ώρα Ελλάδας.
-- ---------------------------------------------------------------------

-- Ως πότε μένει ανοιχτό αν ανοίξει τώρα: ως τη σημερινή ώρα κλεισίματος
-- (ώρα πριν τις 6 το πρωί = μετά τα μεσάνυχτα). Αν άνοιξε μετά την ώρα
-- κλεισίματος, για δύο ώρες.
create or replace function public._shop_open_until(p_closes time)
returns timestamptz
language plpgsql stable
set search_path = public
as $$
declare
  v_now timestamp := now() at time zone 'Europe/Athens';
  v_end timestamp;
begin
  v_end := v_now::date + p_closes;
  if p_closes < time '06:00' and v_now::time >= time '06:00' then
    v_end := v_end + interval '1 day';
  end if;
  if v_end <= v_now then
    v_end := v_now + interval '2 hours';
  end if;
  return v_end at time zone 'Europe/Athens';
end $$;

-- "Η παραγγελία #12 ..." για τα μηνύματα
create or replace function public._order_state_text(p_status text)
returns text
language sql immutable
as $$
  select case p_status
    when 'new'       then 'δεν έχει γίνει ακόμα δεκτή'
    when 'accepted'  then 'έχει ήδη γίνει δεκτή'
    when 'done'      then 'έχει ήδη φύγει'
    when 'rejected'  then 'έχει απορριφθεί'
    when 'cancelled' then 'έχει ακυρωθεί'
    else p_status
  end;
$$;

-- ---------------------------------------------------------------------
-- Για τον επισκέπτη: το μενού του μαγαζιού. null αν δεν υπάρχει.
-- Κατηγορίες με τη σειρά των κωδικών (όπως τα έχει το μαγαζί).
-- ---------------------------------------------------------------------
create or replace function public.shop_menu(p_slug text)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
           'name', s.title,
           'phone', s.phone,
           'note', s.note,
           'open', coalesce(s.open_until > now(), false),
           'closes_at', to_char(s.closes_at, 'HH24:MI'),
           'delivery', s.delivery,
           'pickup', s.pickup,
           'delivery_fee', s.delivery_fee,
           'min_order', s.min_order,
           'items', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', x.id, 'name', x.name, 'description', x.description,
                      'category', x.category, 'price', x.price)
                    order by x.cat_first, x.code)
               from (select i.id, i.name, i.description, i.category, i.code,
                            round(i.sale_price * (1 + i.vat_rate / 100), 2) as price,
                            min(i.code) over (partition by coalesce(i.category, '')) as cat_first
                       from public.item i
                      where i.company_id = s.company_id and i.online and i.is_active
                        and i.item_type = 'finished' and i.sale_price > 0) x), '[]'::jsonb))
    from public.online_shop s
   where s.slug = lower(btrim(coalesce(p_slug, '')));
$$;

-- ---------------------------------------------------------------------
-- Για τον επισκέπτη: νέα παραγγελία. p_order:
--   { name, phone, mode: delivery|pickup, address, payment: cash|card,
--     notes, lines: [{ item_id, qty, note }] }
-- Οι τιμές βγαίνουν εδώ (ό,τι στείλει ο browser για τιμές αγνοείται).
-- Όρια κατά της κατάχρησης: έως 3 ανεπιβεβαίωτες και 6 την ώρα ανά
-- τηλέφωνο, έως 40 ανεπιβεβαίωτες ανά μαγαζί.
-- Επιστρέφει { token, order_no }: το token ανοίγει τη σελίδα κατάστασης.
-- ---------------------------------------------------------------------
create or replace function public.place_order(p_slug text, p_order jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  s        public.online_shop%rowtype;
  v_name   text;
  v_raw    text;
  v_phone  text;
  v_mode   text;
  v_addr   text;
  v_pay    text;
  v_notes  text;
  v_lines  jsonb;
  l        jsonb;
  it       public.item%rowtype;
  v_qty    int;
  v_note   text;
  v_price  numeric;
  v_ids    uuid[] := '{}';
  v_names  text[] := '{}';
  v_qtys   int[] := '{}';
  v_prices numeric[] := '{}';
  v_notesl text[] := '{}';
  v_sum    numeric := 0;
  v_count  int := 0;
  v_fee    numeric := 0;
  v_date   date := (now() at time zone 'Europe/Athens')::date;
  v_no     int;
  v_id     uuid;
  v_token  uuid;
  n        int;
begin
  if p_order is null or jsonb_typeof(p_order) <> 'object' or length(p_order::text) > 20000 then
    raise exception 'Μη έγκυρη παραγγελία';
  end if;
  select * into s from public.online_shop where slug = lower(btrim(coalesce(p_slug, '')));
  if not found then
    raise exception 'Δεν βρέθηκε το κατάστημα';
  end if;
  if not coalesce(s.open_until > now(), false) then
    raise exception 'Το κατάστημα δεν δέχεται online παραγγελίες αυτή τη στιγμή.%',
      coalesce(' Τηλέφωνο: ' || s.phone, '');
  end if;

  -- στοιχεία πελάτη
  v_name := btrim(regexp_replace(coalesce(p_order->>'name', ''), '\s+', ' ', 'g'));
  if char_length(v_name) < 2 or char_length(v_name) > 60 then
    raise exception 'Γράψε το όνομά σου.';
  end if;
  v_raw := btrim(coalesce(p_order->>'phone', ''));
  v_phone := regexp_replace(v_raw, '[^0-9]', '', 'g');
  if v_phone ~ '^0030[0-9]{10}$' then
    v_phone := substr(v_phone, 5);
  elsif v_phone ~ '^30[0-9]{10}$' and v_raw ~ '^\+' then
    v_phone := substr(v_phone, 3);
  elsif v_raw ~ '^(\+|00)' then
    -- ξένο κινητό (τουρίστες): με το διεθνές πρόθεμα
    v_phone := regexp_replace(v_phone, '^00', '');
    if v_phone !~ '^[1-9][0-9]{7,14}$' then
      raise exception 'Γράψε ένα σωστό τηλέφωνο.';
    end if;
    v_phone := '+' || v_phone;
  end if;
  if v_phone !~ '^(\+[0-9]{8,15}|[26][0-9]{9})$' then
    raise exception 'Γράψε ένα σωστό τηλέφωνο (10 ψηφία).';
  end if;

  v_mode := coalesce(p_order->>'mode', '');
  if v_mode not in ('delivery', 'pickup') then
    raise exception 'Διάλεξε διανομή ή παραλαβή.';
  end if;
  if v_mode = 'delivery' and not s.delivery then
    raise exception 'Το κατάστημα δεν κάνει διανομή μέσω του site. Διάλεξε παραλαβή.';
  end if;
  if v_mode = 'pickup' and not s.pickup then
    raise exception 'Το κατάστημα δέχεται μόνο παραγγελίες για διανομή.';
  end if;
  v_addr := nullif(btrim(regexp_replace(coalesce(p_order->>'address', ''), '\s+', ' ', 'g')), '');
  if v_mode = 'delivery' and (v_addr is null or char_length(v_addr) < 5) then
    raise exception 'Γράψε τη διεύθυνση για τη διανομή.';
  end if;
  if char_length(coalesce(v_addr, '')) > 200 then
    raise exception 'Η διεύθυνση είναι πολύ μεγάλη.';
  end if;
  if v_mode = 'pickup' then
    v_addr := null;
  end if;
  v_pay := coalesce(p_order->>'payment', 'cash');
  if v_pay not in ('cash', 'card') then
    raise exception 'Διάλεξε τρόπο πληρωμής.';
  end if;
  v_notes := nullif(btrim(coalesce(p_order->>'notes', '')), '');
  if char_length(coalesce(v_notes, '')) > 300 then
    raise exception 'Οι σημειώσεις είναι πολύ μεγάλες.';
  end if;

  -- γραμμές
  v_lines := p_order->'lines';
  if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'Το καλάθι είναι άδειο.';
  end if;
  if jsonb_array_length(v_lines) > 30 then
    raise exception 'Πάρα πολλές γραμμές. Για μεγάλη παραγγελία πάρε τηλέφωνο στο κατάστημα.';
  end if;
  for l in select e.value from jsonb_array_elements(v_lines) e loop
    if jsonb_typeof(l) <> 'object'
       or coalesce(l->>'item_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(l->>'qty', '') !~ '^[0-9]{1,2}$' then
      raise exception 'Μη έγκυρη γραμμή παραγγελίας.';
    end if;
    v_qty := (l->>'qty')::int;
    if v_qty < 1 or v_qty > 50 then
      raise exception 'Μη έγκυρη ποσότητα.';
    end if;
    v_note := nullif(btrim(regexp_replace(coalesce(l->>'note', ''), '\s+', ' ', 'g')), '');
    if char_length(coalesce(v_note, '')) > 100 then
      raise exception 'Η σημείωση γραμμής είναι πολύ μεγάλη.';
    end if;
    select * into it from public.item where id = (l->>'item_id')::uuid and company_id = s.company_id;
    if not found or not it.online or not it.is_active or it.item_type <> 'finished' or it.sale_price <= 0 then
      raise exception 'Κάποιο είδος δεν είναι πια διαθέσιμο%. Ανανέωσε τη σελίδα.',
        case when found then ' («' || it.name || '»)' else '' end;
    end if;
    v_price := round(it.sale_price * (1 + it.vat_rate / 100), 2);
    v_ids := v_ids || it.id;
    v_names := v_names || it.name;
    v_qtys := v_qtys || v_qty;
    v_prices := v_prices || v_price;
    v_notesl := v_notesl || v_note;
    v_sum := v_sum + v_qty * v_price;
    v_count := v_count + v_qty;
  end loop;
  if v_count > 100 then
    raise exception 'Πολύ μεγάλη παραγγελία. Πάρε τηλέφωνο στο κατάστημα.';
  end if;
  if v_sum < s.min_order then
    raise exception 'Η ελάχιστη παραγγελία είναι % €.', to_char(s.min_order, 'FM999990.00');
  end if;
  if v_mode = 'delivery' then
    v_fee := s.delivery_fee;
  end if;

  -- όρια και αρίθμηση: μία παραγγελία τη φορά ανά μαγαζί
  perform pg_advisory_xact_lock(hashtextextended(format('order|%s', s.company_id), 0));
  select count(*) into n from public.online_order
   where company_id = s.company_id and phone = v_phone and status = 'new';
  if n >= 3 then
    raise exception 'Έχεις ήδη παραγγελίες που περιμένουν επιβεβαίωση. Περίμενε λίγο ή πάρε τηλέφωνο στο κατάστημα.';
  end if;
  select count(*) into n from public.online_order
   where company_id = s.company_id and phone = v_phone and created_at > now() - interval '1 hour';
  if n >= 6 then
    raise exception 'Πολλές παραγγελίες από αυτό το τηλέφωνο. Πάρε τηλέφωνο στο κατάστημα.';
  end if;
  select count(*) into n from public.online_order where company_id = s.company_id and status = 'new';
  if n >= 40 then
    raise exception 'Το κατάστημα έχει πολλές παραγγελίες αυτή τη στιγμή. Δοκίμασε σε λίγο ή πάρε τηλέφωνο.';
  end if;

  select coalesce(max(o.order_no), 0) + 1 into v_no
    from public.online_order o where o.company_id = s.company_id and o.order_date = v_date;

  insert into public.online_order (company_id, order_date, order_no, mode, payment, customer_name, phone,
                                   address, notes, items_total, delivery_fee, total, handled_by)
  values (s.company_id, v_date, v_no, v_mode, v_pay, v_name, v_phone,
          v_addr, v_notes, round(v_sum, 2), v_fee, round(v_sum + v_fee, 2), null)
  returning id, token into v_id, v_token;

  insert into public.online_order_line (company_id, order_id, line_no, item_id, name, qty, unit_price, note)
  select s.company_id, v_id, x.ord, x.item_id, x.name, x.qty, x.price, x.note
    from unnest(v_ids, v_names, v_qtys, v_prices, v_notesl) with ordinality
         as x(item_id, name, qty, price, note, ord);

  return jsonb_build_object('token', v_token, 'order_no', v_no);
end $$;

-- ---------------------------------------------------------------------
-- Για τον επισκέπτη: κατάσταση της παραγγελίας του (με το token)
-- ---------------------------------------------------------------------
create or replace function public.order_status(p_token uuid)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
           'order_no', o.order_no,
           'order_date', o.order_date,
           'status', o.status,
           'mode', o.mode,
           'payment', o.payment,
           'name', o.customer_name,
           'items_total', o.items_total,
           'delivery_fee', o.delivery_fee,
           'total', o.total,
           'ready_minutes', o.ready_minutes,
           'reason', o.reason,
           'created_at', o.created_at,
           'accepted_at', o.accepted_at,
           'done_at', o.done_at,
           'shop', jsonb_build_object('name', s.title, 'phone', s.phone, 'slug', s.slug),
           'lines', coalesce((select jsonb_agg(jsonb_build_object('name', l.name, 'qty', l.qty, 'price', l.unit_price, 'note', l.note)
                                               order by l.line_no)
                                from public.online_order_line l where l.order_id = o.id), '[]'::jsonb))
    from public.online_order o
    join public.online_shop s on s.company_id = o.company_id
   where o.token = p_token;
$$;

-- ---------------------------------------------------------------------
-- Για το προσωπικό: άνοιγμα / κλείσιμο του site. Επιστρέφει ως πότε
-- μένει ανοιχτό (null = κλειστό).
-- ---------------------------------------------------------------------
create or replace function public.shop_set_open(p_company uuid, p_open boolean)
returns timestamptz
language plpgsql security definer
set search_path = public
as $$
declare v_until timestamptz;
begin
  if p_company is null or not public.is_member(p_company) then
    raise exception 'Δεν έχετε πρόσβαση στην εταιρεία';
  end if;
  update public.online_shop
     set open_until = case when coalesce(p_open, false) then public._shop_open_until(closes_at) end
   where company_id = p_company
  returning open_until into v_until;
  if not found then
    raise exception 'Δεν έχει στηθεί ακόμα το site. Άνοιξε τις «Ρυθμίσεις site».';
  end if;
  return v_until;
end $$;

-- ---------------------------------------------------------------------
-- Για το προσωπικό: αποδοχή. Γράφει την πώληση (κανάλι site, τιμές της
-- παραγγελίας χωρίς ΦΠΑ) και την καταχωρεί αμέσως. Αν η καταχώρηση δεν
-- περάσει (π.χ. πίτσα χωρίς συνταγή), η παραγγελία γίνεται δεκτή κανονικά
-- και η πώληση μένει πρόχειρη με το μήνυμα στο stock_note: ο πελάτης δεν
-- περιμένει την αποθήκη.
-- ---------------------------------------------------------------------
create or replace function public.order_accept(p_order uuid, p_minutes int default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  o      public.online_order%rowtype;
  v_doc  uuid;
  v_no   int;
  v_note text;
begin
  select * into o from public.online_order where id = p_order for update;
  if not found or not public.is_member(o.company_id) then
    raise exception 'Δεν βρέθηκε η παραγγελία';
  end if;
  if o.status <> 'new' then
    raise exception 'Η παραγγελία #% %.', o.order_no, public._order_state_text(o.status);
  end if;
  if p_minutes is not null and (p_minutes < 5 or p_minutes > 240) then
    raise exception 'Ο χρόνος πρέπει να είναι από 5 ως 240 λεπτά';
  end if;

  perform public._lock_postings(o.company_id);
  insert into public.doc (company_id, doc_type, doc_date, status, channel, notes)
  values (o.company_id, 'sale', o.order_date, 'draft', 'site',
          format('Online παραγγελία #%s (%s)', o.order_no, to_char(o.order_date, 'DD/MM')))
  returning id, doc_no into v_doc, v_no;
  insert into public.doc_line (doc_id, line_no, role, item_id, qty, unit_price, vat_rate)
  select v_doc, row_number() over (order by min(ol.line_no)), 'item', ol.item_id, sum(ol.qty),
         round(ol.unit_price / (1 + i.vat_rate / 100), 4), i.vat_rate
    from public.online_order_line ol
    join public.item i on i.id = ol.item_id
   where ol.order_id = o.id
   group by ol.item_id, ol.unit_price, i.vat_rate;

  begin
    perform public._post_internal(v_doc);
  exception when others then
    v_note := sqlerrm;
  end;

  update public.online_order
     set status = 'accepted', accepted_at = now(), ready_minutes = p_minutes,
         sale_doc_id = v_doc, stock_note = v_note, handled_by = auth.uid()
   where id = o.id;
  return jsonb_build_object('order_no', o.order_no, 'doc_id', v_doc, 'doc_no', v_no, 'stock_note', v_note);
end $$;

-- ---------------------------------------------------------------------
-- Για το προσωπικό: απόρριψη (μόνο νέα παραγγελία· καμία κίνηση)
-- ---------------------------------------------------------------------
create or replace function public.order_reject(p_order uuid, p_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  o public.online_order%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into o from public.online_order where id = p_order for update;
  if not found or not public.is_member(o.company_id) then
    raise exception 'Δεν βρέθηκε η παραγγελία';
  end if;
  if o.status <> 'new' then
    raise exception 'Η παραγγελία #% %.', o.order_no, public._order_state_text(o.status);
  end if;
  if char_length(coalesce(v_reason, '')) > 200 then
    raise exception 'Ο λόγος είναι πολύ μεγάλος';
  end if;
  update public.online_order
     set status = 'rejected', reason = v_reason, closed_at = now(), handled_by = auth.uid()
   where id = o.id;
  return jsonb_build_object('order_no', o.order_no);
end $$;

-- ---------------------------------------------------------------------
-- Για το προσωπικό: «έφυγε» (παραδόθηκε στον διανομέα / στον πελάτη)
-- ---------------------------------------------------------------------
create or replace function public.order_done(p_order uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare o public.online_order%rowtype;
begin
  select * into o from public.online_order where id = p_order for update;
  if not found or not public.is_member(o.company_id) then
    raise exception 'Δεν βρέθηκε η παραγγελία';
  end if;
  if o.status <> 'accepted' then
    raise exception 'Η παραγγελία #% %.', o.order_no, public._order_state_text(o.status);
  end if;
  update public.online_order set status = 'done', done_at = now(), handled_by = auth.uid() where id = o.id;
  return jsonb_build_object('order_no', o.order_no);
end $$;

-- ---------------------------------------------------------------------
-- Για το προσωπικό: ακύρωση μετά την αποδοχή (ο πελάτης δεν ήρθε, άλλαξε
-- γνώμη). Η πώληση ακυρώνεται και σβήνεται, εκτός αν κλειδώνει (π.χ. τη
-- μέτρησε ήδη απογραφή): τότε μένει, και το note το λέει.
-- ---------------------------------------------------------------------
create or replace function public.order_cancel(p_order uuid, p_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  o        public.online_order%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_status text;
  v_no     int;
  v_note   text;
begin
  select * into o from public.online_order where id = p_order for update;
  if not found or not public.is_member(o.company_id) then
    raise exception 'Δεν βρέθηκε η παραγγελία';
  end if;
  if o.status not in ('accepted', 'done') then
    raise exception 'Η παραγγελία #% %.', o.order_no, public._order_state_text(o.status);
  end if;
  if char_length(coalesce(v_reason, '')) > 200 then
    raise exception 'Ο λόγος είναι πολύ μεγάλος';
  end if;

  perform public._lock_postings(o.company_id);
  if o.sale_doc_id is not null then
    select d.status, d.doc_no into v_status, v_no from public.doc d where d.id = o.sale_doc_id for update;
    if found then
      begin
        if v_status = 'posted' then
          perform public._unpost_internal(o.sale_doc_id);
        end if;
        delete from public.doc where id = o.sale_doc_id;
      exception when others then
        v_note := format('Η πώληση ΠΩ-%s έμεινε: %s', v_no, sqlerrm);
      end;
    end if;
  end if;

  update public.online_order
     set status = 'cancelled', reason = v_reason, closed_at = now(), stock_note = v_note, handled_by = auth.uid()
   where id = o.id;
  return jsonb_build_object('order_no', o.order_no, 'note', v_note);
end $$;

-- ---------------------------------------------------------------------
-- Μήνας: πόσες παραγγελίες ήρθαν απευθείας (για το "τι γλίτωσες")
-- ---------------------------------------------------------------------
create or replace view public.v_online_month
with (security_invoker = true) as
select o.company_id,
       date_trunc('month', o.order_date)::date as month,
       count(*) filter (where o.status in ('accepted', 'done')) as orders,
       coalesce(sum(o.total) filter (where o.status in ('accepted', 'done')), 0) as total,
       count(*) filter (where o.status = 'rejected') as rejected,
       count(*) filter (where o.status = 'cancelled') as cancelled
  from public.online_order o
 group by o.company_id, date_trunc('month', o.order_date);
revoke all on public.v_online_month from anon;
grant select on public.v_online_month to authenticated;

-- ---------------------------------------------------------------------
-- Δικαιώματα functions (η Supabase δίνει execute σε όλους εξ ορισμού)
-- ---------------------------------------------------------------------
revoke execute on function public._shop_open_until(time) from public, anon, authenticated;
revoke execute on function public._order_state_text(text) from public, anon, authenticated;
revoke execute on function public.online_shop_clean() from public, anon, authenticated;

revoke execute on function public.shop_menu(text) from public;
revoke execute on function public.place_order(text, jsonb) from public;
revoke execute on function public.order_status(uuid) from public;
grant execute on function public.shop_menu(text), public.place_order(text, jsonb), public.order_status(uuid)
  to anon, authenticated;

revoke execute on function public.shop_set_open(uuid, boolean) from public, anon;
revoke execute on function public.order_accept(uuid, int) from public, anon;
revoke execute on function public.order_reject(uuid, text) from public, anon;
revoke execute on function public.order_done(uuid) from public, anon;
revoke execute on function public.order_cancel(uuid, text) from public, anon;
grant execute on function public.shop_set_open(uuid, boolean), public.order_accept(uuid, int),
  public.order_reject(uuid, text), public.order_done(uuid), public.order_cancel(uuid, text)
  to authenticated;
