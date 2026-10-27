-- =====================================================================
-- Pizza ERP - 0006 πληρωμές online, παραστατικά, extras, υπηρεσίες,
-- CAPTCHA, παραγγελίες ξενοδοχείων από σύνδεσμο
--
-- Πληρωμές online (Viva, Stripe, δοκιμαστική): η παραγγελία περιμένει την
-- πληρωμή (awaiting_payment) και φτάνει στην κουζίνα μόλις πληρωθεί. Τα
-- κλειδιά των παρόχων τα διαβάζουν μόνο οι Edge Functions (service_role),
-- ποτέ ο browser. Απόρριψη / ακύρωση πληρωμένης → επιστροφή χρημάτων.
--
-- Παραστατικά (απόδειξη, τιμολόγιο, πιστωτικά): νόμιμα τα εκδίδει μόνο
-- αδειοδοτημένος πάροχος (ή ταμειακή / timologio της ΑΑΔΕ). Εδώ: τα
-- στοιχεία τους, η αρίθμηση, και η σύνδεση με τον πάροχο (Edge Function
-- fiscal-issue). «manual»: το παραστατικό βγήκε από την ταμειακή / άλλο
-- πρόγραμμα και γράφεται εδώ ο αριθμός του. «test»: δοκιμαστικός πάροχος,
-- χωρίς φορολογική αξία.
--
-- Επιβράβευση: έκπτωση στην πρώτη απευθείας παραγγελία (καλωσόρισμα) και
-- σε κάθε Ν-οστή από το ίδιο τηλέφωνο, γραμμένη ως έκπτωση στις γραμμές
-- της πώλησης. Πηγή της παραγγελίας (QR σακούλας, φυλλάδιο). Απόρρητο:
-- διαγραφή στοιχείων πελάτη κατόπιν αιτήματος, και αυτόματα μετά από 24 μήνες.
--
-- Extras (π.χ. «extra μοτσαρέλα»): έτοιμα είδη με συνταγή που μπαίνουν
-- πάνω σε πίτσα· γραμμές της παραγγελίας με parent_line. Υπηρεσίες (π.χ.
-- μεταφορικά): είδη χωρίς απόθεμα· τα μεταφορικά γίνονται γραμμή της πώλησης.
--
-- Αλλάζει μία function του 0004: _post_sale (οι υπηρεσίες δεν κινούν
-- αποθήκη). Και τις place_order / order_accept / order_reject /
-- order_cancel / shop_menu / order_status / shop_set_open του 0005.
-- Ξανατρέχει χωρίς σφάλμα.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Ποιος καλεί: η Edge Function με το κλειδί service_role (όχι ο browser)
-- ---------------------------------------------------------------------
create or replace function public._is_service()
returns boolean
language sql stable
as $$
  select coalesce(
           (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
           nullif(current_setting('request.jwt.claim.role', true), '')
         ) = 'service_role';
$$;

-- ---------------------------------------------------------------------
-- Είδη: extra (πάνω σε πίτσα) και υπηρεσία (χωρίς απόθεμα)
-- ---------------------------------------------------------------------
alter table public.item add column if not exists is_extra boolean not null default false;
alter table public.item add column if not exists is_service boolean not null default false;
alter table public.item drop constraint if exists item_extra_check;
alter table public.item add constraint item_extra_check check (not is_extra or item_type = 'finished');
alter table public.item drop constraint if exists item_service_check;
alter table public.item add constraint item_service_check
  check (not is_service or (item_type = 'finished' and not make_to_order and not is_extra));

-- ---------------------------------------------------------------------
-- Πελάτες: στοιχεία τιμολόγησης και σύνδεσμος παραγγελιών (ξενοδοχεία)
-- ---------------------------------------------------------------------
alter table public.partner add column if not exists tax_office text;
alter table public.partner add column if not exists postal_code text;
alter table public.partner add column if not exists country text not null default 'GR';
alter table public.partner add column if not exists order_token uuid;
create unique index if not exists partner_order_token on public.partner (order_token) where order_token is not null;
alter table public.partner drop constraint if exists partner_country_check;
alter table public.partner add constraint partner_country_check check (country ~ '^[A-Z]{2}$');

-- ---------------------------------------------------------------------
-- Site: τρόποι πληρωμής, πάροχος online, CAPTCHA, είδος «μεταφορικά»
-- ---------------------------------------------------------------------
alter table public.online_shop add column if not exists pay_cash boolean not null default true;
alter table public.online_shop add column if not exists pay_card_door boolean not null default true;
alter table public.online_shop add column if not exists pay_provider text not null default 'none';
alter table public.online_shop add column if not exists pay_live boolean not null default false;
alter table public.online_shop add column if not exists captcha_site_key text;
alter table public.online_shop add column if not exists delivery_item_id uuid references public.item(id) on delete set null;
alter table public.online_shop drop constraint if exists online_shop_pay_check;
alter table public.online_shop add constraint online_shop_pay_check
  check (pay_provider in ('none','test','viva','stripe') and (pay_cash or pay_card_door or pay_provider <> 'none'));
alter table public.online_shop drop constraint if exists online_shop_captcha_check;
alter table public.online_shop add constraint online_shop_captcha_check
  check (captcha_site_key is null or captcha_site_key ~ '^[A-Za-z0-9_-]{8,100}$');

-- επιβράβευση (κλειστή εξ ορισμού): % στην πρώτη απευθείας παραγγελία ενός
-- τηλεφώνου, και % σε κάθε loyalty_every-οστή (π.χ. κάθε 5η −20%)
alter table public.online_shop add column if not exists welcome_pct numeric(4,1);
alter table public.online_shop add column if not exists loyalty_every int;
alter table public.online_shop add column if not exists loyalty_pct numeric(4,1);
alter table public.online_shop drop constraint if exists online_shop_discount_check;
alter table public.online_shop add constraint online_shop_discount_check
  check ((welcome_pct is null or welcome_pct between 1 and 50)
     and (loyalty_every is null or loyalty_every between 2 and 50)
     and (loyalty_pct is null or loyalty_pct between 1 and 50)
     and ((loyalty_every is null) = (loyalty_pct is null)));

-- ---------------------------------------------------------------------
-- Παραγγελίες: online πληρωμή, αναμονή πληρωμής, extras
-- ---------------------------------------------------------------------
alter table public.online_order add column if not exists pay_status text not null default 'none';
alter table public.online_order add column if not exists paid_at timestamptz;
alter table public.online_order drop constraint if exists online_order_status_check;
alter table public.online_order add constraint online_order_status_check
  check (status in ('awaiting_payment','new','accepted','done','rejected','cancelled','expired'));
alter table public.online_order drop constraint if exists online_order_payment_check;
alter table public.online_order add constraint online_order_payment_check check (payment in ('cash','card','online'));
alter table public.online_order drop constraint if exists online_order_pay_status_check;
alter table public.online_order add constraint online_order_pay_status_check
  check (pay_status in ('none','pending','failed','paid','refund_pending','refunded','refund_failed'));

-- έκπτωση (καλωσόρισμα / επιβράβευση) στα είδη, όχι στα μεταφορικά:
-- total = items_total - discount + delivery_fee. source: από πού ήρθε (QR)
alter table public.online_order add column if not exists discount_kind text;
alter table public.online_order add column if not exists discount_pct numeric(4,1) not null default 0;
alter table public.online_order add column if not exists discount numeric(10,2) not null default 0;
alter table public.online_order add column if not exists source text;
alter table public.online_order drop constraint if exists online_order_discount_check;
alter table public.online_order add constraint online_order_discount_check
  check ((discount_kind is null and discount_pct = 0 and discount = 0)
      or (discount_kind in ('welcome','loyalty') and discount_pct between 1 and 50 and discount >= 0));
alter table public.online_order drop constraint if exists online_order_source_check;
alter table public.online_order add constraint online_order_source_check
  check (source is null or source ~ '^[a-z0-9_-]{1,20}$');
create index if not exists online_order_company_created on public.online_order (company_id, created_at);

alter table public.online_order_line add column if not exists parent_line int;

-- ---------------------------------------------------------------------
-- Κλειδιά παρόχων (Viva, Stripe, CAPTCHA, πάροχος παραστατικών). Κανένα
-- δικαίωμα για τον browser: τα γράφει ο owner μέσω secret_set, τα
-- διαβάζει μόνο ο server (service_role) μέσω _secrets.
-- ---------------------------------------------------------------------
create table if not exists public.integration_secret (
  company_id  uuid not null references public.company(id) on delete cascade,
  name        text not null,
  value       text not null,
  updated_at  timestamptz not null default now(),
  primary key (company_id, name),
  constraint integration_secret_name_check check (name ~ '^[a-z][a-z0-9_]{1,39}$'),
  constraint integration_secret_value_check check (char_length(value) between 1 and 4000)
);
alter table public.integration_secret enable row level security;
revoke all on public.integration_secret from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Πληρωμές: μία γραμμή ανά προσπάθεια (συνεδρία στον πάροχο)
-- ---------------------------------------------------------------------
create table if not exists public.online_payment (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.company(id) on delete cascade,
  order_id        uuid not null references public.online_order(id) on delete cascade,
  provider        text not null,
  provider_ref    text not null,
  transaction_id  text,
  amount          numeric(10,2) not null,
  status          text not null default 'pending',
  error           text,
  raw             jsonb,
  created_at      timestamptz not null default now(),
  paid_at         timestamptz,
  refunded_at     timestamptz,
  updated_at      timestamptz not null default now(),
  constraint online_payment_provider_check check (provider in ('test','viva','stripe')),
  constraint online_payment_status_check check (status in ('pending','failed','paid','refund_pending','refunded','refund_failed')),
  unique (provider, provider_ref)
);
create index if not exists online_payment_order on public.online_payment (order_id);
drop trigger if exists online_payment_updated_at on public.online_payment;
create trigger online_payment_updated_at before update on public.online_payment
  for each row execute function public.set_updated_at();

alter table public.online_payment enable row level security;
drop policy if exists online_payment_select on public.online_payment;
create policy online_payment_select on public.online_payment for select to authenticated using (public.is_member(company_id));
revoke all on public.online_payment from anon, authenticated;
grant select on public.online_payment to authenticated;

-- ---------------------------------------------------------------------
-- Παραστατικά: ρυθμίσεις και έγγραφα
-- ---------------------------------------------------------------------
create table if not exists public.fiscal_settings (
  company_id          uuid primary key references public.company(id) on delete cascade,
  provider            text not null default 'none',
  live                boolean not null default false,
  auto_receipt        boolean not null default false,
  series_receipt      text not null default 'ΑΛΠ',
  series_invoice      text not null default 'ΤΠ',
  series_credit       text not null default 'ΠΤ',
  series_credit_retail text not null default 'ΠΛ',
  issuer_activity     text,
  issuer_tax_office   text,
  issuer_city         text,
  issuer_postal_code  text,
  updated_at          timestamptz not null default now(),
  constraint fiscal_settings_provider_check check (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  constraint fiscal_settings_series_check check (
    char_length(series_receipt) between 1 and 10 and char_length(series_invoice) between 1 and 10
    and char_length(series_credit) between 1 and 10 and char_length(series_credit_retail) between 1 and 10)
);
drop trigger if exists fiscal_settings_updated_at on public.fiscal_settings;
create trigger fiscal_settings_updated_at before update on public.fiscal_settings
  for each row execute function public.set_updated_at();
alter table public.fiscal_settings enable row level security;
drop policy if exists fiscal_settings_select on public.fiscal_settings;
create policy fiscal_settings_select on public.fiscal_settings for select to authenticated using (public.is_member(company_id));
drop policy if exists fiscal_settings_insert on public.fiscal_settings;
create policy fiscal_settings_insert on public.fiscal_settings for insert to authenticated with check (public.is_owner(company_id));
drop policy if exists fiscal_settings_update on public.fiscal_settings;
create policy fiscal_settings_update on public.fiscal_settings for update to authenticated
  using (public.is_owner(company_id)) with check (public.is_owner(company_id));
revoke all on public.fiscal_settings from anon, authenticated;
grant select, insert, update on public.fiscal_settings to authenticated;

-- kind: receipt (απόδειξη λιανικής), invoice (τιμολόγιο πώλησης),
-- credit_invoice / credit_receipt (πιστωτικά, ολόκληρα, συσχετισμένα).
-- Ο αριθμός μπαίνει τη στιγμή της έκδοσης (όχι στο πρόχειρο), για να μη
-- μένουν κενά· σε σφάλμα του παρόχου κρατιέται για τη νέα προσπάθεια.
create table if not exists public.fiscal_doc (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.company(id) on delete cascade,
  kind            text not null,
  mydata_type     text not null,
  series          text,
  number          int,
  issue_date      date not null default ((now() at time zone 'Europe/Athens')::date),
  sale_doc_id     uuid references public.doc(id) on delete set null,
  online_order_id uuid references public.online_order(id) on delete set null,
  related_id      uuid references public.fiscal_doc(id),
  partner_id      uuid references public.partner(id),
  customer        jsonb,
  lines           jsonb not null,
  vat_breakdown   jsonb not null,
  total_net       numeric(12,2) not null,
  total_vat       numeric(12,2) not null,
  total_gross     numeric(12,2) not null,
  payment_method  text not null,
  status          text not null default 'draft',
  provider        text not null,
  provider_ref    text,
  mark            text,
  uid             text,
  qr_url          text,
  pdf_url         text,
  error           text,
  raw             jsonb,
  public_token    uuid not null default gen_random_uuid(),
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  issued_at       timestamptz,
  updated_at      timestamptz not null default now(),
  constraint fiscal_doc_kind_check check (kind in ('receipt','invoice','credit_invoice','credit_receipt')),
  constraint fiscal_doc_status_check check (status in ('draft','sending','issued','error')),
  constraint fiscal_doc_payment_check check (payment_method in ('cash','card','online','iris','bank','credit')),
  constraint fiscal_doc_issued_check check (status <> 'issued' or (number is not null and series is not null)),
  unique (company_id, series, number),
  unique (public_token)
);
create index if not exists fiscal_doc_company_date on public.fiscal_doc (company_id, issue_date desc);
create index if not exists fiscal_doc_sale on public.fiscal_doc (sale_doc_id);
create index if not exists fiscal_doc_order on public.fiscal_doc (online_order_id);
create index if not exists fiscal_doc_related on public.fiscal_doc (related_id);
drop trigger if exists fiscal_doc_updated_at on public.fiscal_doc;
create trigger fiscal_doc_updated_at before update on public.fiscal_doc
  for each row execute function public.set_updated_at();
alter table public.fiscal_doc enable row level security;
drop policy if exists fiscal_doc_select on public.fiscal_doc;
create policy fiscal_doc_select on public.fiscal_doc for select to authenticated using (public.is_member(company_id));
revoke all on public.fiscal_doc from anon, authenticated;
grant select on public.fiscal_doc to authenticated;

create table if not exists public.fiscal_counter (
  company_id  uuid not null references public.company(id) on delete cascade,
  series      text not null,
  last_no     int not null default 0,
  primary key (company_id, series)
);
alter table public.fiscal_counter enable row level security;
drop policy if exists fiscal_counter_select on public.fiscal_counter;
create policy fiscal_counter_select on public.fiscal_counter for select to authenticated using (public.is_member(company_id));
revoke all on public.fiscal_counter from anon, authenticated;
grant select on public.fiscal_counter to authenticated;

-- ---------------------------------------------------------------------
-- Παραγγελίες ξενοδοχείων από σύνδεσμο: γίνονται πρόχειρη πώληση χονδρικής
-- ---------------------------------------------------------------------
create table if not exists public.b2b_order (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.company(id) on delete cascade,
  partner_id      uuid not null references public.partner(id) on delete cascade,
  doc_id          uuid references public.doc(id) on delete set null,
  wanted_date     date,
  note            text,
  created_at      timestamptz not null default now(),
  seen_at         timestamptz,
  constraint b2b_order_note_check check (note is null or char_length(note) <= 300)
);
create index if not exists b2b_order_company on public.b2b_order (company_id, created_at desc);
create index if not exists b2b_order_partner on public.b2b_order (partner_id, created_at desc);
alter table public.b2b_order enable row level security;
drop policy if exists b2b_order_select on public.b2b_order;
create policy b2b_order_select on public.b2b_order for select to authenticated using (public.is_member(company_id));
revoke all on public.b2b_order from anon, authenticated;
grant select on public.b2b_order to authenticated;

-- =====================================================================
-- Κλειδιά
-- =====================================================================

-- ο owner γράφει / σβήνει (κενό = σβήσιμο)· δεν διαβάζεται ποτέ πίσω
create or replace function public.secret_set(p_company uuid, p_name text, p_value text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if p_company is null or not public.is_owner(p_company) then
    raise exception 'Μόνο ο ιδιοκτήτης αλλάζει τα κλειδιά';
  end if;
  if p_name is null or p_name !~ '^[a-z][a-z0-9_]{1,39}$' then
    raise exception 'Μη έγκυρο όνομα κλειδιού';
  end if;
  if p_value is null or btrim(p_value) = '' then
    delete from public.integration_secret where company_id = p_company and name = p_name;
  else
    insert into public.integration_secret (company_id, name, value) values (p_company, p_name, btrim(p_value))
    on conflict (company_id, name) do update set value = excluded.value, updated_at = now();
  end if;
end $$;

-- ποια κλειδιά έχουν μπει (χωρίς τιμές)
create or replace function public.secret_names(p_company uuid)
returns table(name text, updated_at timestamptz)
language sql stable security definer
set search_path = public
as $$
  select s.name, s.updated_at from public.integration_secret s
   where s.company_id = p_company and public.is_member(p_company)
   order by s.name;
$$;

-- μόνο για τον server
create or replace function public.service_secrets(p_company uuid)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select coalesce(jsonb_object_agg(s.name, s.value), '{}'::jsonb)
    from public.integration_secret s where s.company_id = p_company;
$$;

-- =====================================================================
-- Πώληση: οι υπηρεσίες (μεταφορικά) δεν κινούν αποθήκη. Ίδια με το 0004
-- κατά τα άλλα.
-- =====================================================================
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
    select dl.*, i.make_to_order, i.is_service, i.name as iname
      from public.doc_line dl join public.item i on i.id = dl.item_id
     where dl.doc_id = d.id and dl.role = 'item'
     order by dl.line_no
  loop
    if l.qty <= 0 then
      raise exception 'Μη έγκυρη ποσότητα στη γραμμή %', l.line_no;
    end if;

    if l.is_service then
      -- υπηρεσία: έσοδο χωρίς κίνηση αποθήκης
      update public.doc_line set unit_cost = 0, total_cost = 0 where id = l.id;
    else
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
    end if;
    v_net := v_net + l.net;
    v_vat := v_vat + l.vat;
  end loop;

  update public.doc set total_net = v_net, total_vat = v_vat, total_gross = v_net + v_vat where id = d.id;
  if d.partner_id is not null then
    insert into public.partner_move (company_id, partner_id, doc_id, ledger, move_date, debit, credit)
    values (d.company_id, d.partner_id, d.id, 'customer', d.doc_date, v_net + v_vat, 0);
  end if;
end $$;

-- =====================================================================
-- Μενού για τον επισκέπτη: + τρόποι πληρωμής, CAPTCHA, extras
-- =====================================================================
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
           'pay_cash', s.pay_cash,
           'pay_card_door', s.pay_card_door,
           'pay_online', s.pay_provider <> 'none',
           'pay_test', s.pay_provider = 'test',
           'captcha_site_key', s.captcha_site_key,
           'welcome_pct', s.welcome_pct,
           'loyalty_every', s.loyalty_every,
           'loyalty_pct', s.loyalty_pct,
           -- για τη σελίδα απορρήτου: ποιος κρατά τα στοιχεία
           'company', (select jsonb_build_object('name', c.name, 'vat_no', c.vat_no, 'address', c.address)
                         from public.company c where c.id = s.company_id),
           'items', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', x.id, 'name', x.name, 'description', x.description,
                      'category', x.category, 'price', x.price, 'extras_ok', x.make_to_order)
                    order by x.cat_first, x.code)
               from (select i.id, i.name, i.description, i.category, i.code, i.make_to_order,
                            round(i.sale_price * (1 + i.vat_rate / 100), 2) as price,
                            min(i.code) over (partition by coalesce(i.category, '')) as cat_first
                       from public.item i
                      where i.company_id = s.company_id and i.online and i.is_active and not i.is_extra
                        and not i.is_service and i.item_type = 'finished' and i.sale_price > 0) x), '[]'::jsonb),
           'extras', coalesce((
             select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name,
                      'price', round(i.sale_price * (1 + i.vat_rate / 100), 2)) order by i.code)
               from public.item i
              where i.company_id = s.company_id and i.online and i.is_active and i.is_extra
                and i.item_type = 'finished' and i.sale_price > 0), '[]'::jsonb))
    from public.online_shop s
   where s.slug = lower(btrim(coalesce(p_slug, '')));
$$;

-- =====================================================================
-- Νέα παραγγελία: + extras, τρόποι πληρωμής του μαγαζιού, online πληρωμή
-- (μόνο μέσω server: η παραγγελία περιμένει την πληρωμή), CAPTCHA (αν το
-- μαγαζί έχει κλειδί, μόνο μέσω server που έχει ελέγξει το token).
-- p_order: { name, phone, mode, address, payment: cash|card|online, notes,
--   source, lines: [{ item_id, qty, note, extras: [item_id, ...] }] }
-- Έκπτωση (αν το μαγαζί έχει): καλωσόρισμα στην πρώτη παραγγελία του
-- τηλεφώνου, επιβράβευση σε κάθε Ν-οστή. Μία έκπτωση ανά παραγγελία.
-- Επιστρέφει { token, order_no, order_id, total, discount }.
-- =====================================================================
create or replace function public.place_order(p_slug text, p_order jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  s          public.online_shop%rowtype;
  v_name     text;
  v_raw      text;
  v_phone    text;
  v_mode     text;
  v_addr     text;
  v_pay      text;
  v_notes    text;
  v_lines    jsonb;
  l          jsonb;
  x          jsonb;
  it         public.item%rowtype;
  ex         public.item%rowtype;
  v_qty      int;
  v_note     text;
  v_price    numeric;
  v_ids      uuid[] := '{}';
  v_names    text[] := '{}';
  v_qtys     int[] := '{}';
  v_prices   numeric[] := '{}';
  v_notesl   text[] := '{}';
  v_parents  int[] := '{}';
  v_seen     uuid[];
  v_ln       int := 0;
  v_parent   int;
  v_sum      numeric := 0;
  v_count    int := 0;
  v_prev     int;
  v_dkind    text;
  v_dpct     numeric := 0;
  v_disc     numeric := 0;
  v_src      text;
  v_fee      numeric := 0;
  v_date     date := (now() at time zone 'Europe/Athens')::date;
  v_status   text := 'new';
  v_pstatus  text := 'none';
  v_no       int;
  v_id       uuid;
  v_token    uuid;
  n          int;
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
  if s.captcha_site_key is not null and not public._is_service() then
    raise exception 'Χρειάζεται ο έλεγχος «δεν είμαι ρομπότ». Ανανέωσε τη σελίδα και δοκίμασε ξανά.';
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
  if v_pay not in ('cash', 'card', 'online') then
    raise exception 'Διάλεξε τρόπο πληρωμής.';
  end if;
  if v_pay = 'cash' and not s.pay_cash then
    raise exception 'Το κατάστημα δεν δέχεται μετρητά στις online παραγγελίες.';
  end if;
  if v_pay = 'card' and not s.pay_card_door then
    raise exception 'Το κατάστημα δεν δέχεται πληρωμή με κάρτα στην παράδοση.';
  end if;
  if v_pay = 'online' then
    if s.pay_provider = 'none' then
      raise exception 'Το κατάστημα δεν δέχεται online πληρωμή.';
    end if;
    if not public._is_service() then
      raise exception 'Η online πληρωμή γίνεται μόνο από τη σελίδα του μαγαζιού.';
    end if;
    v_status := 'awaiting_payment';
    v_pstatus := 'pending';
  end if;
  -- από πού ήρθε (QR σακούλας, φυλλάδιο...)· άγνωστο = τίποτα
  v_src := lower(btrim(coalesce(p_order->>'source', '')));
  if v_src !~ '^[a-z0-9_-]{1,20}$' then
    v_src := null;
  end if;
  v_notes := nullif(btrim(coalesce(p_order->>'notes', '')), '');
  if char_length(coalesce(v_notes, '')) > 300 then
    raise exception 'Οι σημειώσεις είναι πολύ μεγάλες.';
  end if;

  -- γραμμές (και τα extras κάτω από την πίτσα τους)
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
    if not found or not it.online or not it.is_active or it.item_type <> 'finished' or it.sale_price <= 0
       or it.is_extra or it.is_service then
      raise exception 'Κάποιο είδος δεν είναι πια διαθέσιμο%. Ανανέωσε τη σελίδα.',
        case when found then ' («' || it.name || '»)' else '' end;
    end if;
    v_price := round(it.sale_price * (1 + it.vat_rate / 100), 2);
    v_ln := v_ln + 1;
    v_parent := v_ln;
    v_ids := v_ids || it.id;
    v_names := v_names || it.name;
    v_qtys := v_qtys || v_qty;
    v_prices := v_prices || v_price;
    v_notesl := v_notesl || v_note;
    v_parents := v_parents || null::int;
    v_sum := v_sum + v_qty * v_price;
    v_count := v_count + v_qty;

    x := l->'extras';
    if x is not null and jsonb_typeof(x) <> 'null' then
      if jsonb_typeof(x) <> 'array' or jsonb_array_length(x) > 10 then
        raise exception 'Μη έγκυρα extra.';
      end if;
      if jsonb_array_length(x) > 0 and not it.make_to_order then
        raise exception 'Το «%» δεν παίρνει extra.', it.name;
      end if;
      v_seen := '{}';
      for x in select e.value from jsonb_array_elements(l->'extras') e loop
        if jsonb_typeof(x) <> 'string'
           or (x #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          raise exception 'Μη έγκυρα extra.';
        end if;
        select * into ex from public.item where id = (x #>> '{}')::uuid and company_id = s.company_id;
        if not found or not ex.is_extra or not ex.online or not ex.is_active or ex.sale_price <= 0 then
          raise exception 'Κάποιο extra δεν είναι πια διαθέσιμο%. Ανανέωσε τη σελίδα.',
            case when found then ' («' || ex.name || '»)' else '' end;
        end if;
        continue when ex.id = any(v_seen);
        v_seen := v_seen || ex.id;
        v_price := round(ex.sale_price * (1 + ex.vat_rate / 100), 2);
        v_ln := v_ln + 1;
        v_ids := v_ids || ex.id;
        v_names := v_names || ex.name;
        v_qtys := v_qtys || v_qty;
        v_prices := v_prices || v_price;
        v_notesl := v_notesl || null::text;
        v_parents := v_parents || v_parent;
        v_sum := v_sum + v_qty * v_price;
      end loop;
    end if;
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
  -- πληρωμές που δεν ολοκληρώθηκαν ποτέ
  update public.online_order set status = 'expired'
   where company_id = s.company_id and status = 'awaiting_payment' and created_at < now() - interval '3 hours';
  select count(*) into n from public.online_order
   where company_id = s.company_id and phone = v_phone
     and (status = 'new' or (status = 'awaiting_payment' and created_at > now() - interval '30 minutes'));
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

  -- επιβράβευση: πόσες έχει ήδη αυτό το τηλέφωνο (όχι απορριφθείσες,
  -- ακυρωμένες, ληγμένες ή με αποτυχημένη / εγκαταλειμμένη πληρωμή)
  if s.welcome_pct is not null or s.loyalty_every is not null then
    select count(*) into v_prev from public.online_order
     where company_id = s.company_id and phone = v_phone
       and (status in ('new', 'accepted', 'done')
            or (status = 'awaiting_payment' and pay_status = 'pending' and created_at > now() - interval '30 minutes'));
    if v_prev = 0 and s.welcome_pct is not null then
      v_dkind := 'welcome';
      v_dpct := s.welcome_pct;
    elsif s.loyalty_every is not null and (v_prev + 1) % s.loyalty_every = 0 then
      v_dkind := 'loyalty';
      v_dpct := s.loyalty_pct;
    end if;
    v_disc := round(v_sum * v_dpct / 100, 2);
  end if;

  select coalesce(max(o.order_no), 0) + 1 into v_no
    from public.online_order o where o.company_id = s.company_id and o.order_date = v_date;

  insert into public.online_order (company_id, order_date, order_no, status, mode, payment, pay_status, customer_name, phone,
                                   address, notes, items_total, delivery_fee, total, handled_by,
                                   discount_kind, discount_pct, discount, source)
  values (s.company_id, v_date, v_no, v_status, v_mode, v_pay, v_pstatus, v_name, v_phone,
          v_addr, v_notes, round(v_sum, 2), v_fee, round(v_sum - v_disc + v_fee, 2), null,
          v_dkind, v_dpct, v_disc, v_src)
  returning id, token into v_id, v_token;

  insert into public.online_order_line (company_id, order_id, line_no, item_id, name, qty, unit_price, note, parent_line)
  select s.company_id, v_id, x2.ord, x2.item_id, x2.name, x2.qty, x2.price, x2.note, x2.parent
    from unnest(v_ids, v_names, v_qtys, v_prices, v_notesl, v_parents) with ordinality
         as x2(item_id, name, qty, price, note, parent, ord);

  return jsonb_build_object('token', v_token, 'order_no', v_no, 'order_id', v_id,
                            'total', round(v_sum - v_disc + v_fee, 2), 'discount', v_disc);
end $$;

-- =====================================================================
-- Κατάσταση για τον πελάτη: + πληρωμή, απόδειξη, extras
-- =====================================================================
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
           'pay_status', o.pay_status,
           'pay_test', s.pay_provider = 'test',
           'name', o.customer_name,
           'items_total', o.items_total,
           'delivery_fee', o.delivery_fee,
           'total', o.total,
           'ready_minutes', o.ready_minutes,
           'reason', o.reason,
           'created_at', o.created_at,
           'accepted_at', o.accepted_at,
           'done_at', o.done_at,
           'paid_at', o.paid_at,
           'discount', o.discount,
           'discount_pct', o.discount_pct,
           'discount_kind', o.discount_kind,
           -- κάρτα επιβράβευσης: πόσες μετράνε από αυτό το τηλέφωνο (και η τωρινή)
           'loyalty', case when s.loyalty_every is not null and o.phone <> '' then jsonb_build_object(
                        'every', s.loyalty_every, 'pct', s.loyalty_pct,
                        'count', (select count(*) from public.online_order o2
                                   where o2.company_id = o.company_id and o2.phone = o.phone
                                     and o2.status in ('new', 'accepted', 'done'))) end,
           'receipt', (select f.public_token from public.fiscal_doc f
                        where f.online_order_id = o.id and f.kind = 'receipt' and f.status = 'issued'
                          and not exists (select 1 from public.fiscal_doc c
                                           where c.related_id = f.id and c.status = 'issued')
                        order by f.issued_at desc limit 1),
           'shop', jsonb_build_object('name', s.title, 'phone', s.phone, 'slug', s.slug),
           'lines', coalesce((select jsonb_agg(jsonb_build_object('name', l.name, 'qty', l.qty, 'price', l.unit_price,
                                                                  'note', l.note, 'line_no', l.line_no, 'parent_line', l.parent_line)
                                               order by l.line_no)
                                from public.online_order_line l where l.order_id = o.id), '[]'::jsonb))
    from public.online_order o
    join public.online_shop s on s.company_id = o.company_id
   where o.token = p_token;
$$;

-- =====================================================================
-- Μεταφορικά: είδος-υπηρεσία της εταιρείας (φτιάχνεται την πρώτη φορά,
-- με ΦΠΑ 24%· ο ΦΠΑ αλλάζει στο είδος, π.χ. αν ο λογιστής πει 13%)
-- =====================================================================
create or replace function public._delivery_item(p_company uuid)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v      uuid;
  v_code text;
  k      int := 0;
begin
  select s.delivery_item_id into v from public.online_shop s where s.company_id = p_company;
  if v is not null and exists (select 1 from public.item i where i.id = v and i.company_id = p_company and i.is_service) then
    return v;
  end if;
  select i.id into v from public.item i where i.company_id = p_company and i.is_service and i.code like 'ΥΠ-ΜΕΤ%' order by i.code limit 1;
  if v is null then
    loop
      v_code := 'ΥΠ-ΜΕΤ' || case when k = 0 then '' else '-' || k end;
      exit when not exists (select 1 from public.item i where i.company_id = p_company and i.code = v_code);
      k := k + 1;
    end loop;
    insert into public.item (company_id, code, name, item_type, category, unit, vat_rate, sale_price, is_service)
    values (p_company, v_code, 'Μεταφορικά', 'finished', 'Υπηρεσίες', 'τεμ', 24, 0, true)
    returning id into v;
  end if;
  update public.online_shop set delivery_item_id = v where company_id = p_company;
  return v;
end $$;

-- =====================================================================
-- Αποδοχή: + extras (γραμμές της πώλησης, κινούν τη συνταγή τους) και
-- μεταφορικά (γραμμή υπηρεσίας, χωρίς αποθήκη). Ίδια με το 0005 κατά τα άλλα.
-- =====================================================================
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
  v_del  uuid;
  v_vat  numeric;
  v_diff numeric;
  v_net  numeric;
  v_got  numeric;
  ln     record;
  k      int;
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
          format('Online παραγγελία #%s (%s)', o.order_no, to_char(o.order_date, 'DD/MM'))
          || case o.discount_kind when 'welcome' then format(' · έκπτωση καλωσορίσματος %s%%', trim_scale(o.discount_pct))
                                  when 'loyalty' then format(' · έκπτωση επιβράβευσης %s%%', trim_scale(o.discount_pct))
                                  else '' end)
  returning id, doc_no into v_doc, v_no;
  -- η έκπτωση στις γραμμές των ειδών (όχι στα μεταφορικά)
  insert into public.doc_line (doc_id, line_no, role, item_id, qty, unit_price, discount_pct, vat_rate)
  select v_doc, row_number() over (order by min(ol.line_no)), 'item', ol.item_id, sum(ol.qty),
         round(ol.unit_price / (1 + i.vat_rate / 100), 4), o.discount_pct, i.vat_rate
    from public.online_order_line ol
    join public.item i on i.id = ol.item_id
   where ol.order_id = o.id
   group by ol.item_id, ol.unit_price, i.vat_rate;
  if o.delivery_fee > 0 then
    v_del := public._delivery_item(o.company_id);
    select i.vat_rate into v_vat from public.item i where i.id = v_del;
    insert into public.doc_line (doc_id, line_no, role, item_id, qty, unit_price, vat_rate)
    select v_doc, coalesce(max(dl.line_no), 0) + 1, 'item', v_del, 1, round(o.delivery_fee / (1 + v_vat / 100), 4), v_vat
      from public.doc_line dl where dl.doc_id = v_doc;
  end if;

  -- η πώληση (και η απόδειξη) = ακριβώς ό,τι πληρώνει ο πελάτης: τα
  -- στρογγυλέματα του ΦΠΑ ανά γραμμή (και της έκπτωσης) μπαίνουν στην τιμή
  -- (4 δεκαδικά) μιας γραμμής είδους, πριν από την καταχώρηση
  select o.total - sum(dl.gross) into v_diff from public.doc_line dl where dl.doc_id = v_doc;
  if v_diff <> 0 and abs(v_diff) <= 0.10 then
    <<fix>>
    for ln in select dl.id, dl.qty, dl.unit_price, dl.discount_pct, dl.vat_rate, dl.gross from public.doc_line dl
               where dl.doc_id = v_doc and dl.item_id is distinct from v_del and dl.qty > 0 and dl.discount_pct < 100
               order by dl.gross desc loop
      for k in -2..2 loop
        v_net := round((ln.gross + v_diff) / (1 + ln.vat_rate / 100), 2) + k * 0.01;
        continue when v_net <= 0 or v_net + round(v_net * ln.vat_rate / 100, 2) <> ln.gross + v_diff;
        update public.doc_line
           set unit_price = round(v_net / (ln.qty * (1 - ln.discount_pct / 100)), 4)
         where id = ln.id
        returning gross into v_got;
        exit fix when v_got = ln.gross + v_diff;
        update public.doc_line set unit_price = ln.unit_price where id = ln.id;
      end loop;
    end loop;
  end if;

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

-- πληρωμένη online → επιστροφή χρημάτων (την κάνει ο server: pay-refund)
create or replace function public._order_refund_mark(p_order uuid)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  update public.online_payment set status = 'refund_pending', error = null
   where order_id = p_order and status in ('paid', 'refund_failed');
  if found then
    update public.online_order set pay_status = 'refund_pending' where id = p_order;
    return true;
  end if;
  return false;
end $$;

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
  return jsonb_build_object('order_no', o.order_no, 'refund', public._order_refund_mark(o.id));
end $$;

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
  return jsonb_build_object('order_no', o.order_no, 'note', v_note, 'refund', public._order_refund_mark(o.id));
end $$;

-- ξανά επιστροφή μετά από αποτυχία· true = περιμένει επιστροφή (για τον server)
create or replace function public.order_refund_request(p_order uuid)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare o public.online_order%rowtype;
begin
  select * into o from public.online_order where id = p_order for update;
  if not found or not public.is_member(o.company_id) then
    raise exception 'Δεν βρέθηκε η παραγγελία';
  end if;
  if o.pay_status = 'refund_failed' then
    perform public._order_refund_mark(o.id);
    return true;
  end if;
  return o.pay_status = 'refund_pending';
end $$;

-- =====================================================================
-- Πληρωμές: μόνο για τον server (Edge Functions με service_role)
-- =====================================================================

-- ό,τι χρειάζεται το checkout πριν από την παραγγελία
create or replace function public.shop_checkout_info(p_slug text)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object('company_id', s.company_id, 'slug', s.slug, 'title', s.title,
                            'captcha_required', s.captcha_site_key is not null,
                            'pay_provider', s.pay_provider, 'pay_live', s.pay_live)
    from public.online_shop s where s.slug = lower(btrim(coalesce(p_slug, '')));
$$;

-- ρυθμίσεις πληρωμών μιας εταιρείας (για τα webhooks, που δεν έχουν παραγγελία)
create or replace function public.shop_pay_settings(p_company uuid)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object('company_id', s.company_id, 'slug', s.slug, 'pay_provider', s.pay_provider, 'pay_live', s.pay_live)
    from public.online_shop s where s.company_id = p_company;
$$;

-- η παραγγελία για νέα / ξανά πληρωμή (με id ή με το token του πελάτη)
create or replace function public.payment_context(p_order uuid default null, p_token uuid default null)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object('order_id', o.id, 'company_id', o.company_id, 'order_no', o.order_no, 'token', o.token,
                            'total', o.total, 'status', o.status, 'pay_status', o.pay_status, 'payment', o.payment,
                            'customer_name', o.customer_name, 'phone', o.phone,
                            'shop', jsonb_build_object('slug', s.slug, 'title', s.title,
                                                       'pay_provider', s.pay_provider, 'pay_live', s.pay_live))
    from public.online_order o join public.online_shop s on s.company_id = o.company_id
   where (p_order is not null and o.id = p_order) or (p_order is null and p_token is not null and o.token = p_token)
   limit 1;
$$;

create or replace function public.payment_start(p_order uuid, p_provider text, p_ref text, p_amount numeric)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  o public.online_order%rowtype;
  v uuid;
begin
  select * into o from public.online_order where id = p_order for update;
  if not found then
    raise exception 'Δεν βρέθηκε η παραγγελία';
  end if;
  if o.status not in ('awaiting_payment', 'expired') or o.payment <> 'online' or o.pay_status not in ('pending', 'failed') then
    raise exception 'Η παραγγελία #% δεν περιμένει πληρωμή.', o.order_no;
  end if;
  if abs(p_amount - o.total) > 0.005 then
    raise exception 'Λάθος ποσό πληρωμής';
  end if;
  insert into public.online_payment (company_id, order_id, provider, provider_ref, amount)
  values (o.company_id, o.id, p_provider, p_ref, p_amount)
  returning id into v;
  update public.online_order set status = 'awaiting_payment', pay_status = 'pending' where id = o.id;
  return v;
end $$;

-- η συνεδρία πληρωμής δεν ξεκίνησε: η παραγγελία δεν μένει να περιμένει
create or replace function public.payment_abort(p_order uuid, p_error text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  update public.online_order set status = 'expired', pay_status = 'failed', reason = left(p_error, 200)
   where id = p_order and status = 'awaiting_payment' and pay_status in ('pending', 'failed');
end $$;

-- ο πάροχος επιβεβαίωσε την πληρωμή (webhook ή επιστροφή του πελάτη)
create or replace function public.payment_confirm(p_provider text, p_ref text, p_transaction text, p_amount numeric, p_raw jsonb default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  p public.online_payment%rowtype;
  o public.online_order%rowtype;
  v_refund boolean := false;
begin
  select * into p from public.online_payment where provider = p_provider and provider_ref = p_ref for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown');
  end if;
  select * into o from public.online_order where id = p.order_id for update;
  if p.status in ('paid', 'refund_pending', 'refunded', 'refund_failed') then
    return jsonb_build_object('ok', true, 'already', true, 'token', o.token, 'order_no', o.order_no, 'refund', p.status = 'refund_pending');
  end if;
  if p_amount is null or abs(p_amount - p.amount) > 0.005 then
    update public.online_payment set status = 'failed', error = format('Άλλο ποσό από τον πάροχο: %s', p_amount), raw = p_raw
     where id = p.id;
    return jsonb_build_object('ok', false, 'reason', 'amount', 'token', o.token);
  end if;
  update public.online_payment set status = 'paid', transaction_id = p_transaction, paid_at = now(), error = null, raw = p_raw
   where id = p.id;

  if exists (select 1 from public.online_payment x
              where x.order_id = o.id and x.id <> p.id and x.status in ('paid', 'refund_pending', 'refunded', 'refund_failed')) then
    -- δεύτερη πληρωμή της ίδιας παραγγελίας: επιστρέφεται
    update public.online_payment set status = 'refund_pending' where id = p.id;
    v_refund := true;
  elsif o.status in ('awaiting_payment', 'expired') then
    update public.online_order set status = 'new', pay_status = 'paid', paid_at = now(), reason = null where id = o.id;
  elsif o.status in ('rejected', 'cancelled') then
    update public.online_payment set status = 'refund_pending' where id = p.id;
    update public.online_order set pay_status = 'refund_pending', paid_at = now() where id = o.id;
    v_refund := true;
  else
    update public.online_order set pay_status = 'paid', paid_at = coalesce(paid_at, now()) where id = o.id;
  end if;
  return jsonb_build_object('ok', true, 'token', o.token, 'order_no', o.order_no, 'refund', v_refund);
end $$;

create or replace function public.payment_failed(p_provider text, p_ref text, p_error text default null, p_raw jsonb default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  p public.online_payment%rowtype;
  o public.online_order%rowtype;
begin
  select * into p from public.online_payment where provider = p_provider and provider_ref = p_ref for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown');
  end if;
  select * into o from public.online_order where id = p.order_id for update;
  if p.status = 'pending' then
    update public.online_payment set status = 'failed', error = left(p_error, 500), raw = p_raw where id = p.id;
    if o.pay_status = 'pending' and not exists (select 1 from public.online_payment x
                                                  where x.order_id = o.id and x.status = 'pending' and x.id <> p.id) then
      update public.online_order set pay_status = 'failed' where id = o.id;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'token', o.token);
end $$;

-- πού επιστρέφει ο πελάτης μετά τον πάροχο (π.χ. Viva: μόνο orderCode)
create or replace function public.payment_lookup(p_provider text, p_ref text)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object('order_id', o.id, 'company_id', o.company_id, 'token', o.token, 'slug', s.slug,
                            'payment_id', p.id, 'status', p.status, 'amount', p.amount)
    from public.online_payment p
    join public.online_order o on o.id = p.order_id
    join public.online_shop s on s.company_id = o.company_id
   where p.provider = p_provider and p.provider_ref = p_ref;
$$;

-- επιστροφές που περιμένουν (μιας παραγγελίας)
create or replace function public.refunds_due(p_order uuid)
returns table(payment_id uuid, company_id uuid, provider text, provider_ref text, transaction_id text, amount numeric)
language sql stable security definer
set search_path = public
as $$
  select p.id, p.company_id, p.provider, p.provider_ref, p.transaction_id, p.amount
    from public.online_payment p where p.order_id = p_order and p.status = 'refund_pending';
$$;

create or replace function public.payment_refunded(p_payment uuid, p_ok boolean, p_error text default null, p_raw jsonb default null)
returns void
language plpgsql security definer
set search_path = public
as $$
declare p public.online_payment%rowtype;
begin
  select * into p from public.online_payment where id = p_payment for update;
  if not found or p.status <> 'refund_pending' then
    return;
  end if;
  if p_ok then
    update public.online_payment set status = 'refunded', refunded_at = now(), error = null, raw = p_raw where id = p.id;
  else
    update public.online_payment set status = 'refund_failed', error = left(p_error, 500), raw = p_raw where id = p.id;
  end if;
  update public.online_order o
     set pay_status = case
           when exists (select 1 from public.online_payment x where x.order_id = o.id and x.status = 'refund_pending') then 'refund_pending'
           when exists (select 1 from public.online_payment x where x.order_id = o.id and x.status = 'refund_failed') then 'refund_failed'
           when exists (select 1 from public.online_payment x where x.order_id = o.id and x.status = 'paid') then 'paid'
           else 'refunded' end
   where o.id = p.order_id;
end $$;

-- =====================================================================
-- Παραστατικά
-- =====================================================================

-- ΑΦΜ: 9 ψηφία με σωστό ψηφίο ελέγχου
create or replace function public._afm_valid(p text)
returns boolean
language plpgsql immutable
as $$
declare
  s int := 0;
  i int;
begin
  if p is null or p !~ '^[0-9]{9}$' or p = '000000000' then
    return false;
  end if;
  for i in 1..8 loop
    s := s + substr(p, i, 1)::int * (2 ^ (9 - i))::int;
  end loop;
  return (s % 11) % 10 = substr(p, 9, 1)::int;
end $$;

create or replace function public._fiscal_label(p_kind text)
returns text
language sql immutable
as $$
  select case p_kind when 'receipt' then 'απόδειξη' when 'invoice' then 'τιμολόγιο'
                     when 'credit_invoice' then 'πιστωτικό τιμολόγιο' when 'credit_receipt' then 'πιστωτικό λιανικής'
                     else p_kind end;
$$;

-- Πρόχειρο παραστατικό από πώληση (τιμολόγιο / απόδειξη), από online
-- παραγγελία (απόδειξη), ή πιστωτικό ενός εκδομένου. Γραμμές, σύνολα,
-- πελάτης υπολογίζονται εδώ. Ο αριθμός μπαίνει στην έκδοση.
create or replace function public.fiscal_prepare(p_kind text, p_sale_doc uuid default null, p_order uuid default null, p_related uuid default null)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  d        public.doc%rowtype;
  o        public.online_order%rowtype;
  r        public.fiscal_doc%rowtype;
  v_old    public.fiscal_doc%rowtype;
  pt       public.partner%rowtype;
  st       public.fiscal_settings%rowtype;
  v_comp   uuid;
  v_lines  jsonb;
  v_vat    jsonb;
  v_net    numeric;
  v_tvat   numeric;
  v_gross  numeric;
  v_cust   jsonb;
  v_pay    text;
  v_type   text;
  v_series text;
  v_id     uuid;
begin
  if p_kind not in ('receipt', 'invoice', 'credit_invoice', 'credit_receipt') then
    raise exception 'Άγνωστο είδος παραστατικού';
  end if;

  -- πηγή
  if p_kind in ('credit_invoice', 'credit_receipt') then
    select * into r from public.fiscal_doc where id = p_related;
    if not found or not public.is_member(r.company_id) then
      raise exception 'Δεν βρέθηκε το παραστατικό';
    end if;
    v_type := case p_kind when 'credit_invoice' then 'invoice' else 'receipt' end;
    if r.status <> 'issued' or r.kind <> v_type then
      raise exception 'Πιστωτικό γίνεται μόνο για εκδομένο %.', public._fiscal_label(v_type);
    end if;
    select * into v_old from public.fiscal_doc where related_id = r.id order by created_at desc limit 1;
    if found then
      if v_old.status in ('draft', 'error') then
        return v_old.id;
      end if;
      raise exception 'Υπάρχει ήδη πιστωτικό για το %-%.', r.series, r.number;
    end if;
    v_comp := r.company_id;
  elsif p_order is not null then
    if p_kind <> 'receipt' then
      raise exception 'Από online παραγγελία βγαίνει απόδειξη';
    end if;
    select * into o from public.online_order where id = p_order;
    if not found or not public.is_member(o.company_id) then
      raise exception 'Δεν βρέθηκε η παραγγελία';
    end if;
    if o.status not in ('accepted', 'done') or o.sale_doc_id is null then
      raise exception 'Απόδειξη βγαίνει όταν η παραγγελία έχει γίνει δεκτή.';
    end if;
    select * into d from public.doc where id = o.sale_doc_id;
    v_comp := o.company_id;
  else
    select * into d from public.doc where id = p_sale_doc;
    if not found or not public.is_member(d.company_id) then
      raise exception 'Δεν βρέθηκε η πώληση';
    end if;
    if d.doc_type <> 'sale' or d.status <> 'posted' then
      raise exception 'Το παραστατικό βγαίνει από καταχωρημένη πώληση.';
    end if;
    v_comp := d.company_id;
    select * into o from public.online_order where sale_doc_id = d.id limit 1;
  end if;

  select * into st from public.fiscal_settings where company_id = v_comp;
  if not found or st.provider = 'none' then
    raise exception 'Δεν έχει ρυθμιστεί πάροχος παραστατικών (Ρυθμίσεις → Παραστατικά).';
  end if;

  if r.id is not null then
    v_lines := r.lines; v_vat := r.vat_breakdown; v_net := r.total_net; v_tvat := r.total_vat; v_gross := r.total_gross;
    v_cust := r.customer; v_pay := r.payment_method;
  else
    -- ένα παραστατικό (τιμολόγιο ή απόδειξη) ανά πώληση, εκτός αν πιστώθηκε
    select * into v_old from public.fiscal_doc f
     where f.sale_doc_id = d.id and f.kind in ('receipt', 'invoice')
       and not exists (select 1 from public.fiscal_doc c where c.related_id = f.id and c.status = 'issued')
     order by f.created_at desc limit 1;
    if found then
      if v_old.kind = p_kind and v_old.status in ('draft', 'error') then
        return v_old.id;
      end if;
      raise exception 'Για αυτή την πώληση υπάρχει ήδη %.',
        public._fiscal_label(v_old.kind) || coalesce(' ' || v_old.series || '-' || v_old.number, ' (σε εξέλιξη)');
    end if;
    if p_kind = 'invoice' then
      if d.partner_id is null then
        raise exception 'Το τιμολόγιο θέλει πελάτη στην πώληση.';
      end if;
      select * into pt from public.partner where id = d.partner_id;
      if pt.country = 'GR' and not public._afm_valid(pt.vat_no) then
        raise exception 'Ο πελάτης «%» χρειάζεται σωστό ΑΦΜ (9 ψηφία) για τιμολόγιο.', pt.name;
      end if;
      if pt.country <> 'GR' and coalesce(btrim(pt.vat_no), '') = '' then
        raise exception 'Ο πελάτης «%» χρειάζεται ΑΦΜ / VAT για τιμολόγιο.', pt.name;
      end if;
      v_cust := jsonb_build_object('name', pt.name, 'vat_no', pt.vat_no, 'tax_office', pt.tax_office,
                                   'address', pt.address, 'city', pt.city, 'postal_code', pt.postal_code,
                                   'country', pt.country, 'email', pt.email, 'phone', pt.phone);
      v_pay := 'credit';
    else
      v_cust := null;
      v_pay := case when o.id is null then 'cash' when o.payment = 'online' then 'online'
                    when o.payment = 'card' then 'card' else 'cash' end;
    end if;
    select jsonb_agg(jsonb_build_object('line_no', dl.line_no, 'item_id', dl.item_id, 'code', i.code,
                       'description', i.name, 'unit', i.unit, 'qty', dl.qty, 'unit_price', dl.unit_price,
                       'discount_pct', dl.discount_pct, 'vat_rate', dl.vat_rate, 'net', dl.net, 'vat', dl.vat,
                       'gross', dl.gross, 'is_service', i.is_service) order by dl.line_no),
           sum(dl.net), sum(dl.vat), sum(dl.gross)
      into v_lines, v_net, v_tvat, v_gross
      from public.doc_line dl join public.item i on i.id = dl.item_id
     where dl.doc_id = d.id and dl.role = 'item';
    if v_lines is null then
      raise exception 'Η πώληση δεν έχει γραμμές';
    end if;
    select jsonb_agg(jsonb_build_object('vat_rate', z.vat_rate, 'net', z.net, 'vat', z.vat, 'gross', z.gross) order by z.vat_rate)
      into v_vat
      from (select dl.vat_rate, sum(dl.net) net, sum(dl.vat) vat, sum(dl.gross) gross
              from public.doc_line dl where dl.doc_id = d.id and dl.role = 'item' group by dl.vat_rate) z;
  end if;

  v_type := case p_kind when 'receipt' then '11.1' when 'invoice' then '1.1' when 'credit_invoice' then '5.1' else '11.4' end;
  v_series := case p_kind when 'receipt' then st.series_receipt when 'invoice' then st.series_invoice
                          when 'credit_invoice' then st.series_credit else st.series_credit_retail end;

  insert into public.fiscal_doc (company_id, kind, mydata_type, series, sale_doc_id, online_order_id, related_id, partner_id,
                                 customer, lines, vat_breakdown, total_net, total_vat, total_gross, payment_method, provider)
  values (v_comp, p_kind, v_type, v_series,
          coalesce(r.sale_doc_id, d.id), coalesce(r.online_order_id, o.id), r.id, coalesce(r.partner_id, d.partner_id),
          v_cust, v_lines, v_vat, v_net, v_tvat, v_gross, v_pay, st.provider)
  returning id into v_id;
  return v_id;
end $$;

-- Βγήκε από την ταμειακή / άλλο πρόγραμμα: γράφεται ο αριθμός του
create or replace function public.fiscal_record_manual(p_id uuid, p_number int, p_mark text default null, p_series text default null)
returns void
language plpgsql security definer
set search_path = public
as $$
declare f public.fiscal_doc%rowtype;
begin
  select * into f from public.fiscal_doc where id = p_id for update;
  if not found or not public.is_member(f.company_id) then
    raise exception 'Δεν βρέθηκε το παραστατικό';
  end if;
  if f.provider <> 'manual' then
    raise exception 'Αυτό το παραστατικό εκδίδεται από τον πάροχο, όχι με το χέρι.';
  end if;
  if f.status = 'issued' then
    raise exception 'Το παραστατικό έχει ήδη αριθμό.';
  end if;
  if p_number is null or p_number < 1 then
    raise exception 'Γράψε τον αριθμό του παραστατικού.';
  end if;
  if p_mark is not null and btrim(p_mark) !~ '^[0-9]{6,20}$' then
    raise exception 'Το ΜΑΡΚ είναι αριθμός (από το παραστατικό).';
  end if;
  update public.fiscal_doc
     set series = coalesce(nullif(btrim(p_series), ''), series), number = p_number,
         mark = nullif(btrim(coalesce(p_mark, '')), ''), status = 'issued', issued_at = now(), error = null
   where id = f.id;
end $$;

-- για τον server: ο χρήστης είναι μέλος και το παραστατικό περιμένει έκδοση
create or replace function public.fiscal_check(p_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare f public.fiscal_doc%rowtype;
begin
  select * into f from public.fiscal_doc where id = p_id;
  if not found or not public.is_member(f.company_id) then
    raise exception 'Δεν βρέθηκε το παραστατικό';
  end if;
  return jsonb_build_object('id', f.id, 'status', f.status, 'provider', f.provider);
end $$;

-- για τον server: αριθμός (αν δεν έχει), «σε έκδοση», όλα τα στοιχεία
create or replace function public.fiscal_begin(p_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  f   public.fiscal_doc%rowtype;
  c   public.company%rowtype;
  st  public.fiscal_settings%rowtype;
  r   public.fiscal_doc%rowtype;
  v_no int;
begin
  select * into f from public.fiscal_doc where id = p_id for update;
  if not found then
    raise exception 'Δεν βρέθηκε το παραστατικό';
  end if;
  if f.status = 'issued' then
    return jsonb_build_object('already', true, 'doc', to_jsonb(f));
  end if;
  if f.status = 'sending' and f.updated_at > now() - interval '2 minutes' then
    raise exception 'Το παραστατικό εκδίδεται ήδη. Περίμενε λίγο.';
  end if;
  if f.provider = 'manual' then
    raise exception 'Αυτό το παραστατικό γράφεται με το χέρι (αριθμός από την ταμειακή).';
  end if;
  if f.number is null then
    insert into public.fiscal_counter (company_id, series, last_no) values (f.company_id, f.series, 1)
    on conflict (company_id, series) do update set last_no = public.fiscal_counter.last_no + 1
    returning last_no into v_no;
    f.number := v_no;
  end if;
  update public.fiscal_doc set number = f.number, status = 'sending', error = null where id = f.id
  returning * into f;
  select * into c from public.company where id = f.company_id;
  select * into st from public.fiscal_settings where company_id = f.company_id;
  if f.related_id is not null then
    select * into r from public.fiscal_doc where id = f.related_id;
  end if;
  return jsonb_build_object(
    'doc', to_jsonb(f),
    'issuer', jsonb_build_object('name', c.name, 'vat_no', c.vat_no, 'address', c.address, 'phone', c.phone,
                                 'activity', st.issuer_activity, 'tax_office', st.issuer_tax_office,
                                 'city', st.issuer_city, 'postal_code', st.issuer_postal_code),
    'settings', jsonb_build_object('provider', st.provider, 'live', st.live),
    'related', case when r.id is null then null else jsonb_build_object('series', r.series, 'number', r.number,
                    'mark', r.mark, 'issue_date', r.issue_date, 'mydata_type', r.mydata_type) end);
end $$;

-- για τον server: αποτέλεσμα του παρόχου
create or replace function public.fiscal_done(p_id uuid, p_ok boolean, p_result jsonb)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if p_ok then
    update public.fiscal_doc
       set status = 'issued', issued_at = now(), error = null,
           mark = p_result->>'mark', uid = p_result->>'uid', qr_url = p_result->>'qr_url',
           pdf_url = p_result->>'pdf_url', provider_ref = p_result->>'provider_ref',
           number = coalesce((p_result->>'number')::int, number), raw = p_result->'raw'
     where id = p_id and status = 'sending';
  else
    update public.fiscal_doc
       set status = 'error', error = left(coalesce(p_result->>'error', 'Άγνωστο σφάλμα του παρόχου'), 1000), raw = p_result->'raw'
     where id = p_id and status = 'sending';
  end if;
end $$;

-- σβήσιμο πρόχειρου· με αριθμό μόνο αν είναι ο τελευταίος της σειράς
-- (αλλιώς θα έμενε κενό στην αρίθμηση)
create or replace function public.fiscal_discard(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  f public.fiscal_doc%rowtype;
  v_last int;
begin
  select * into f from public.fiscal_doc where id = p_id for update;
  if not found or not public.is_member(f.company_id) then
    raise exception 'Δεν βρέθηκε το παραστατικό';
  end if;
  if f.status not in ('draft', 'error') then
    raise exception 'Εκδομένο παραστατικό δεν σβήνεται· για ακύρωση φτιάξε πιστωτικό.';
  end if;
  if f.number is not null then
    select last_no into v_last from public.fiscal_counter where company_id = f.company_id and series = f.series for update;
    if v_last is distinct from f.number then
      raise exception 'Έχει ήδη αριθμό %-% και υπάρχουν επόμενοι· ξαναδοκίμασε την έκδοση.', f.series, f.number;
    end if;
    update public.fiscal_counter set last_no = last_no - 1 where company_id = f.company_id and series = f.series;
  end if;
  delete from public.fiscal_doc where id = f.id;
end $$;

-- για τον πελάτη (σύνδεσμος της απόδειξης): μόνο εκδομένα
create or replace function public.fiscal_public(p_token uuid)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
           'kind', f.kind, 'mydata_type', f.mydata_type, 'series', f.series, 'number', f.number,
           'issue_date', f.issue_date, 'issued_at', f.issued_at, 'mark', f.mark, 'uid', f.uid, 'qr_url', f.qr_url,
           'pdf_url', f.pdf_url, 'test', f.provider = 'test', 'customer', f.customer, 'lines', f.lines,
           'vat_breakdown', f.vat_breakdown, 'total_net', f.total_net, 'total_vat', f.total_vat,
           'total_gross', f.total_gross, 'payment_method', f.payment_method,
           'related', (select jsonb_build_object('series', r.series, 'number', r.number, 'mark', r.mark)
                         from public.fiscal_doc r where r.id = f.related_id),
           'issuer', jsonb_build_object('name', c.name, 'vat_no', c.vat_no, 'address', c.address, 'phone', c.phone,
                                        'activity', st.issuer_activity, 'tax_office', st.issuer_tax_office,
                                        'city', st.issuer_city, 'postal_code', st.issuer_postal_code))
    from public.fiscal_doc f
    join public.company c on c.id = f.company_id
    left join public.fiscal_settings st on st.company_id = f.company_id
   where f.public_token = p_token and f.status = 'issued';
$$;

-- =====================================================================
-- Παραγγελίες ξενοδοχείων από σύνδεσμο
-- =====================================================================

-- p_action: 'get' (φτιάχνει αν δεν υπάρχει), 'rotate' (νέος, ο παλιός
-- σταματά), 'off' (κανένας)
create or replace function public.partner_order_link(p_partner uuid, p_action text default 'get')
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare pt public.partner%rowtype;
begin
  select * into pt from public.partner where id = p_partner for update;
  if not found or not public.is_member(pt.company_id) then
    raise exception 'Δεν βρέθηκε ο πελάτης';
  end if;
  if not pt.is_customer then
    raise exception 'Σύνδεσμο παραγγελιών έχουν μόνο οι πελάτες';
  end if;
  if p_action = 'off' then
    update public.partner set order_token = null where id = pt.id;
    return null;
  elsif p_action = 'rotate' or pt.order_token is null then
    update public.partner set order_token = gen_random_uuid() where id = pt.id returning order_token into pt.order_token;
  end if;
  return pt.order_token;
end $$;

-- είδη που βλέπει ο πελάτης: όσα έχουν δική του τιμή, και τα έτοιμα που
-- δεν φτιάχνονται κατά παραγγελία (π.χ. κατεψυγμένες)
create or replace function public._b2b_items(p_company uuid, p_partner uuid)
returns table(item_id uuid, name text, unit text, price numeric, vat_rate numeric, code text)
language sql stable
set search_path = public
as $$
  select i.id, i.name, i.unit, public.item_price_for(i.id, p_partner), i.vat_rate, i.code
    from public.item i
   where i.company_id = p_company and i.is_active and i.item_type = 'finished' and not i.is_extra and not i.is_service
     and (exists (select 1 from public.partner_price pp where pp.partner_id = p_partner and pp.item_id = i.id)
          or not i.make_to_order)
     and public.item_price_for(i.id, p_partner) > 0;
$$;

create or replace function public.b2b_menu(p_token uuid)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
           'company', c.name, 'phone', coalesce(s.phone, c.phone), 'partner', pt.name,
           'items', coalesce((select jsonb_agg(jsonb_build_object('id', b.item_id, 'name', b.name, 'unit', b.unit,
                                 'price', b.price, 'vat_rate', b.vat_rate,
                                 'last_qty', (select dl.qty from public.doc_line dl join public.doc d on d.id = dl.doc_id
                                               where d.partner_id = pt.id and d.doc_type = 'sale' and d.status = 'posted'
                                                 and dl.item_id = b.item_id and dl.role = 'item'
                                               order by d.doc_date desc, d.doc_no desc limit 1))
                                 order by b.code)
                                from public._b2b_items(pt.company_id, pt.id) b), '[]'::jsonb),
           'recent', coalesce((select jsonb_agg(jsonb_build_object('created_at', x.created_at, 'wanted_date', x.wanted_date,
                                  'doc_no', d.doc_no, 'status', d.status) order by x.created_at desc)
                                 from (select * from public.b2b_order bo where bo.partner_id = pt.id
                                        order by bo.created_at desc limit 5) x
                                 left join public.doc d on d.id = x.doc_id), '[]'::jsonb))
    from public.partner pt
    join public.company c on c.id = pt.company_id
    left join public.online_shop s on s.company_id = pt.company_id
   where pt.order_token = p_token and pt.is_active and pt.is_customer;
$$;

-- p_order: { lines: [{ item_id, qty }], note, wanted_date }
-- Γίνεται πρόχειρη πώληση χονδρικής με τις τιμές του πελάτη, για έλεγχο
-- και καταχώρηση από το μαγαζί.
create or replace function public.b2b_order_place(p_token uuid, p_order jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  pt      public.partner%rowtype;
  l       jsonb;
  b       record;
  v_qty   numeric;
  v_note  text;
  v_date  date;
  v_today date := (now() at time zone 'Europe/Athens')::date;
  v_no    int;
  v_doc   uuid;
  v_ln    int := 0;
  n       int;
begin
  select * into pt from public.partner where order_token = p_token and order_token is not null and is_active and is_customer;
  if not found then
    raise exception 'Ο σύνδεσμος δεν ισχύει πια. Ζήτησε νέο από το μαγαζί.';
  end if;
  if p_order is null or jsonb_typeof(p_order) <> 'object' or length(p_order::text) > 20000
     or jsonb_typeof(p_order->'lines') is distinct from 'array' then
    raise exception 'Μη έγκυρη παραγγελία';
  end if;
  if jsonb_array_length(p_order->'lines') = 0 or jsonb_array_length(p_order->'lines') > 50 then
    raise exception 'Η παραγγελία θέλει από 1 έως 50 γραμμές.';
  end if;
  v_note := nullif(btrim(coalesce(p_order->>'note', '')), '');
  if char_length(coalesce(v_note, '')) > 300 then
    raise exception 'Η σημείωση είναι πολύ μεγάλη.';
  end if;
  if coalesce(p_order->>'wanted_date', '') <> '' then
    if (p_order->>'wanted_date') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Μη έγκυρη ημερομηνία.';
    end if;
    v_date := (p_order->>'wanted_date')::date;
    if v_date < v_today or v_date > v_today + 60 then
      raise exception 'Η ημερομηνία παράδοσης πρέπει να είναι από σήμερα έως 60 μέρες μετά.';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(format('b2b|%s', pt.id), 0));
  select count(*) into n from public.b2b_order where partner_id = pt.id and created_at > now() - interval '1 hour';
  if n >= 5 then
    raise exception 'Πολλές παραγγελίες σε λίγη ώρα. Πάρε τηλέφωνο στο μαγαζί.';
  end if;

  -- αρίθμηση όπως το next_doc_no (εδώ δεν υπάρχει μέλος εταιρείας)
  insert into public.doc_counter (company_id, doc_type, last_no) values (pt.company_id, 'sale', 1)
  on conflict (company_id, doc_type) do update set last_no = public.doc_counter.last_no + 1
  returning last_no into v_no;
  insert into public.doc (company_id, doc_type, doc_no, doc_date, status, partner_id, channel, notes)
  values (pt.company_id, 'sale', v_no, coalesce(v_date, v_today), 'draft', pt.id, 'wholesale',
          'Από τον σύνδεσμο παραγγελιών' || coalesce(': ' || v_note, ''))
  returning id into v_doc;

  for l in select e.value from jsonb_array_elements(p_order->'lines') e loop
    if jsonb_typeof(l) <> 'object'
       or coalesce(l->>'item_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(l->>'qty', '') !~ '^[0-9]{1,6}(\.[0-9]{1,3})?$' then
      raise exception 'Μη έγκυρη γραμμή παραγγελίας.';
    end if;
    v_qty := (l->>'qty')::numeric;
    continue when v_qty = 0;
    select * into b from public._b2b_items(pt.company_id, pt.id) x where x.item_id = (l->>'item_id')::uuid;
    if not found then
      raise exception 'Κάποιο είδος δεν είναι πια διαθέσιμο. Ανανέωσε τη σελίδα.';
    end if;
    v_ln := v_ln + 1;
    insert into public.doc_line (doc_id, line_no, role, item_id, qty, unit_price, vat_rate)
    values (v_doc, v_ln, 'item', b.item_id, v_qty, b.price, b.vat_rate);
  end loop;
  if v_ln = 0 then
    raise exception 'Η παραγγελία είναι άδεια.';
  end if;
  update public.doc d
     set total_net = z.net, total_vat = z.vat, total_gross = z.net + z.vat
    from (select sum(net) net, sum(vat) vat from public.doc_line where doc_id = v_doc) z
   where d.id = v_doc;

  insert into public.b2b_order (company_id, partner_id, doc_id, wanted_date, note)
  values (pt.company_id, pt.id, v_doc, v_date, v_note);
  return jsonb_build_object('doc_no', v_no, 'lines', v_ln);
end $$;

-- «το είδα»: φεύγει από τη λίστα της οθόνης Παραγγελίες
create or replace function public.b2b_seen(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare v uuid;
begin
  select company_id into v from public.b2b_order where id = p_id;
  if v is null or not public.is_member(v) then
    raise exception 'Δεν βρέθηκε η παραγγελία';
  end if;
  update public.b2b_order set seen_at = now() where id = p_id and seen_at is null;
end $$;

-- =====================================================================
-- Πελάτες του site, πηγή παραγγελιών, απόρρητο
-- =====================================================================

-- από πού ήρθαν οι παραγγελίες του μήνα (QR σακούλας, φυλλάδιο, '' = χωρίς)
create or replace view public.v_online_source
with (security_invoker = true) as
select o.company_id,
       date_trunc('month', o.order_date)::date as month,
       coalesce(o.source, '') as source,
       count(*) as orders,
       coalesce(sum(o.total), 0) as total
  from public.online_order o
 where o.status in ('accepted', 'done')
 group by o.company_id, date_trunc('month', o.order_date), coalesce(o.source, '');
revoke all on public.v_online_source from anon;
grant select on public.v_online_source to authenticated;

-- οι πελάτες του site ανά τηλέφωνο (για το μαγαζί· όχι όσοι διαγράφηκαν)
create or replace view public.v_site_customer
with (security_invoker = true) as
select o.company_id,
       o.phone,
       (array_agg(o.customer_name order by o.created_at desc))[1] as name,
       (array_agg(o.address order by o.created_at desc) filter (where o.address is not null))[1] as address,
       count(*) filter (where o.status in ('accepted', 'done')) as orders,
       coalesce(sum(o.total) filter (where o.status in ('accepted', 'done')), 0) as total,
       min(o.created_at) as first_at,
       max(o.created_at) as last_at
  from public.online_order o
 where o.phone <> ''
 group by o.company_id, o.phone;
revoke all on public.v_site_customer from anon;
grant select on public.v_site_customer to authenticated;

-- σβήνει τα στοιχεία των παραγγελιών που διάλεξε το where (όνομα, τηλέφωνο,
-- διεύθυνση, σημειώσεις, ό,τι έστειλε ο πάροχος πληρωμών). Η πώληση μένει.
create or replace function public._forget_orders(p_ids uuid[])
returns int
language plpgsql
set search_path = public
as $$
declare n int;
begin
  update public.online_order_line set note = null where order_id = any(p_ids) and note is not null;
  update public.online_payment set raw = null where order_id = any(p_ids) and raw is not null;
  update public.online_order
     set customer_name = 'Διαγράφηκε', phone = '', address = null, notes = null
   where id = any(p_ids);
  get diagnostics n = row_count;
  return n;
end $$;

-- «σβήστε τα στοιχεία μου»: όλες οι παραγγελίες ενός τηλεφώνου (ο owner)
create or replace function public.customer_forget(p_company uuid, p_phone text)
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  v_phone text := btrim(coalesce(p_phone, ''));
  v_ids   uuid[];
begin
  if p_company is null or not public.is_owner(p_company) then
    raise exception 'Μόνο ο ιδιοκτήτης σβήνει στοιχεία πελατών';
  end if;
  if v_phone = '' then
    raise exception 'Γράψε το τηλέφωνο του πελάτη';
  end if;
  if exists (select 1 from public.online_order where company_id = p_company and phone = v_phone
               and status in ('awaiting_payment', 'new', 'accepted')) then
    raise exception 'Ο πελάτης έχει παραγγελία σε εξέλιξη· σβήσε τα στοιχεία του όταν τελειώσει.';
  end if;
  select array_agg(id) into v_ids from public.online_order where company_id = p_company and phone = v_phone;
  if v_ids is null then
    raise exception 'Δεν βρέθηκαν παραγγελίες με αυτό το τηλέφωνο';
  end if;
  return public._forget_orders(v_ids);
end $$;

-- αυτόματα: στοιχεία πελατών παλιότερα από 24 μήνες (τρέχει όταν ανοίγει το site)
create or replace function public._privacy_cleanup(p_company uuid)
returns int
language plpgsql
set search_path = public
as $$
declare v_ids uuid[];
begin
  select array_agg(id) into v_ids from public.online_order
   where company_id = p_company and created_at < now() - interval '24 months' and phone <> ''
     and status not in ('awaiting_payment', 'new', 'accepted');
  if v_ids is null then
    return 0;
  end if;
  return public._forget_orders(v_ids);
end $$;

-- άνοιγμα / κλείσιμο του site (όπως στο 0005) + το καθάρισμα των παλιών
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
  if coalesce(p_open, false) then
    perform public._privacy_cleanup(p_company);
  end if;
  return v_until;
end $$;

-- =====================================================================
-- Δικαιώματα
-- =====================================================================
revoke execute on function public._forget_orders(uuid[]) from public, anon, authenticated;
revoke execute on function public._privacy_cleanup(uuid) from public, anon, authenticated;
revoke execute on function public.customer_forget(uuid, text) from public, anon;
grant execute on function public.customer_forget(uuid, text) to authenticated;
revoke execute on function public._is_service() from public, anon, authenticated;
revoke execute on function public._delivery_item(uuid) from public, anon, authenticated;
revoke execute on function public._order_refund_mark(uuid) from public, anon, authenticated;
revoke execute on function public._afm_valid(text) from public, anon, authenticated;
revoke execute on function public._fiscal_label(text) from public, anon, authenticated;
revoke execute on function public._b2b_items(uuid, uuid) from public, anon, authenticated;
revoke execute on function public._post_sale(public.doc) from public, anon, authenticated;

-- επισκέπτης (και χρήστης)
revoke execute on function public.shop_menu(text), public.place_order(text, jsonb), public.order_status(uuid),
  public.fiscal_public(uuid), public.b2b_menu(uuid), public.b2b_order_place(uuid, jsonb) from public;
grant execute on function public.shop_menu(text), public.place_order(text, jsonb), public.order_status(uuid),
  public.fiscal_public(uuid), public.b2b_menu(uuid), public.b2b_order_place(uuid, jsonb) to anon, authenticated, service_role;

-- προσωπικό
revoke execute on function public.secret_set(uuid, text, text), public.secret_names(uuid),
  public.order_accept(uuid, int), public.order_reject(uuid, text), public.order_cancel(uuid, text),
  public.order_refund_request(uuid), public.fiscal_prepare(text, uuid, uuid, uuid),
  public.fiscal_record_manual(uuid, int, text, text), public.fiscal_check(uuid), public.fiscal_discard(uuid),
  public.partner_order_link(uuid, text), public.b2b_seen(uuid) from public, anon;
grant execute on function public.secret_set(uuid, text, text), public.secret_names(uuid),
  public.order_accept(uuid, int), public.order_reject(uuid, text), public.order_cancel(uuid, text),
  public.order_refund_request(uuid), public.fiscal_prepare(text, uuid, uuid, uuid),
  public.fiscal_record_manual(uuid, int, text, text), public.fiscal_check(uuid), public.fiscal_discard(uuid),
  public.partner_order_link(uuid, text), public.b2b_seen(uuid) to authenticated;

-- μόνο ο server
revoke execute on function public.service_secrets(uuid), public.shop_checkout_info(text), public.shop_pay_settings(uuid),
  public.payment_context(uuid, uuid), public.payment_start(uuid, text, text, numeric), public.payment_abort(uuid, text),
  public.payment_confirm(text, text, text, numeric, jsonb), public.payment_failed(text, text, text, jsonb),
  public.payment_lookup(text, text), public.refunds_due(uuid), public.payment_refunded(uuid, boolean, text, jsonb),
  public.fiscal_begin(uuid), public.fiscal_done(uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.service_secrets(uuid), public.shop_checkout_info(text), public.shop_pay_settings(uuid),
  public.payment_context(uuid, uuid), public.payment_start(uuid, text, text, numeric), public.payment_abort(uuid, text),
  public.payment_confirm(text, text, text, numeric, jsonb), public.payment_failed(text, text, text, jsonb),
  public.payment_lookup(text, text), public.refunds_due(uuid), public.payment_refunded(uuid, boolean, text, jsonb),
  public.fiscal_begin(uuid), public.fiscal_done(uuid, boolean, jsonb) to service_role;
