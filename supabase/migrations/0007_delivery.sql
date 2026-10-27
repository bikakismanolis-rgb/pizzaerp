-- =====================================================================
-- Pizza ERP - 0007 διανομείς: εφαρμογή στο κινητό του διανομέα, πού είναι
-- η παραγγελία για τον πελάτη, ταμείο διανομέα
--
-- Ο διανομέας δεν έχει λογαριασμό: παίρνει δικό του σύνδεσμο (/d/<token>)
-- από το μαγαζί, όπως τα ξενοδοχεία. Βλέπει τις έτοιμες για διανομή,
-- «Την παίρνω» (= έφυγε, όπως το «Έφυγε» της κουζίνας), «Παραδόθηκε».
-- Θέση (προαιρετικά, online_shop.driver_tracking): μόνο η τελευταία, μόνο
-- όσο έχει παραγγελίες στον δρόμο, σβήνει μόλις τις παραδώσει όλες. Ο
-- πελάτης τη βλέπει μόνο για τη δική του παραγγελία, όσο έρχεται.
-- Μετρητά: ό,τι παρέδωσε με πληρωμή μετρητά μένει «στον διανομέα» ως την
-- εκκαθάριση από το μαγαζί.
--
-- Θέλει τα 0005 και 0006. Δεν αλλάζει καμία υπάρχουσα function. Ξανατρέχει
-- χωρίς σφάλμα.
-- =====================================================================

create table if not exists public.driver (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.company(id) on delete cascade,
  name        text not null,
  phone       text,
  token       uuid,
  is_active   boolean not null default true,
  last_lat    double precision,
  last_lng    double precision,
  last_acc    real,
  last_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint driver_name_check check (char_length(btrim(name)) between 1 and 40),
  constraint driver_pos_check check ((last_lat is null) = (last_lng is null)
    and (last_lat is null or (last_lat between -90 and 90 and last_lng between -180 and 180)))
);
create unique index if not exists driver_token on public.driver (token) where token is not null;
create index if not exists driver_company on public.driver (company_id);
drop trigger if exists driver_updated_at on public.driver;
create trigger driver_updated_at before update on public.driver
  for each row execute function public.set_updated_at();

alter table public.driver enable row level security;
drop policy if exists driver_select on public.driver;
create policy driver_select on public.driver for select to authenticated using (public.is_member(company_id));
drop policy if exists driver_insert on public.driver;
create policy driver_insert on public.driver for insert to authenticated with check (public.is_owner(company_id));
drop policy if exists driver_update on public.driver;
create policy driver_update on public.driver for update to authenticated
  using (public.is_owner(company_id)) with check (public.is_owner(company_id));
drop policy if exists driver_delete on public.driver;
create policy driver_delete on public.driver for delete to authenticated using (public.is_owner(company_id));
revoke all on public.driver from anon, authenticated;
grant select on public.driver to authenticated;
-- ο σύνδεσμος και η θέση μόνο μέσω functions
grant insert (company_id, name, phone, is_active), update (name, phone, is_active), delete on public.driver to authenticated;

alter table public.online_shop add column if not exists driver_tracking boolean not null default false;

alter table public.online_order add column if not exists driver_id uuid references public.driver(id) on delete set null;
alter table public.online_order add column if not exists delivered_at timestamptz;
alter table public.online_order add column if not exists cash_settled_at timestamptz;
create index if not exists online_order_driver on public.online_order (driver_id, status);

-- ---------------------------------------------------------------------
-- Για το μαγαζί
-- ---------------------------------------------------------------------

-- σύνδεσμος του διανομέα: 'get' (φτιάχνει αν δεν υπάρχει), 'rotate', 'off'
create or replace function public.driver_link(p_driver uuid, p_action text default 'get')
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare d public.driver%rowtype;
begin
  select * into d from public.driver where id = p_driver for update;
  if not found or not public.is_owner(d.company_id) then
    raise exception 'Μόνο ο ιδιοκτήτης φτιάχνει συνδέσμους διανομέων';
  end if;
  if p_action = 'off' then
    update public.driver set token = null, last_lat = null, last_lng = null, last_acc = null, last_at = null where id = d.id;
    return null;
  elsif p_action = 'rotate' or d.token is null then
    update public.driver set token = gen_random_uuid() where id = d.id returning token into d.token;
  end if;
  return d.token;
end $$;

-- η κουζίνα: «Έφυγε με τον Νίκο» (το απλό «Έφυγε» μένει το order_done)
create or replace function public.order_send(p_order uuid, p_driver uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  o public.online_order%rowtype;
  d public.driver%rowtype;
begin
  select * into o from public.online_order where id = p_order for update;
  if not found or not public.is_member(o.company_id) then
    raise exception 'Δεν βρέθηκε η παραγγελία';
  end if;
  select * into d from public.driver where id = p_driver and company_id = o.company_id;
  if not found or not d.is_active then
    raise exception 'Δεν βρέθηκε ο διανομέας';
  end if;
  if o.mode <> 'delivery' then
    raise exception 'Η #% είναι για παραλαβή από το μαγαζί.', o.order_no;
  end if;
  if o.status = 'accepted' then
    update public.online_order set status = 'done', done_at = now(), driver_id = d.id, handled_by = auth.uid() where id = o.id;
  elsif o.status = 'done' and o.delivered_at is null then
    update public.online_order set driver_id = d.id where id = o.id;
  else
    raise exception 'Η παραγγελία #% %.', o.order_no,
      case when o.delivered_at is not null then 'έχει ήδη παραδοθεί' else public._order_state_text(o.status) end;
  end if;
  return jsonb_build_object('order_no', o.order_no, 'driver', d.name);
end $$;

-- εκκαθάριση: τα μετρητά του διανομέα παραδόθηκαν στο ταμείο
create or replace function public.driver_settle(p_driver uuid)
returns numeric
language plpgsql security definer
set search_path = public
as $$
declare
  d public.driver%rowtype;
  v numeric;
begin
  select * into d from public.driver where id = p_driver;
  if not found or not public.is_member(d.company_id) then
    raise exception 'Δεν βρέθηκε ο διανομέας';
  end if;
  with x as (
    update public.online_order set cash_settled_at = now()
     where driver_id = d.id and delivered_at is not null and payment = 'cash' and cash_settled_at is null
       and status = 'done'
    returning total)
  select coalesce(sum(total), 0) into v from x;
  return v;
end $$;

-- σήμερα ανά διανομέα: στον δρόμο, παραδόσεις, μετρητά που κρατά
create or replace view public.v_driver_today
with (security_invoker = true) as
select d.company_id, d.id as driver_id, d.name, d.phone, d.is_active, d.token is not null as has_link, d.last_at,
       count(o.id) filter (where o.status = 'done' and o.delivered_at is null) as on_way,
       count(o.id) filter (where o.delivered_at >= date_trunc('day', now() at time zone 'Europe/Athens') at time zone 'Europe/Athens') as delivered_today,
       coalesce(sum(o.total) filter (where o.status = 'done' and o.delivered_at is not null and o.payment = 'cash'
                                       and o.cash_settled_at is null), 0) as cash_open
  from public.driver d
  left join public.online_order o on o.driver_id = d.id
 group by d.company_id, d.id;
revoke all on public.v_driver_today from anon;
grant select on public.v_driver_today to authenticated;

-- ---------------------------------------------------------------------
-- Για τον διανομέα (σύνδεσμος, χωρίς λογαριασμό)
-- ---------------------------------------------------------------------
create or replace function public._driver_by_token(p_token uuid)
returns public.driver
language plpgsql stable
set search_path = public
as $$
declare d public.driver%rowtype;
begin
  select * into d from public.driver where token = p_token and token is not null and is_active;
  if not found then
    raise exception 'Ο σύνδεσμος δεν ισχύει πια. Ζήτησε νέο από το μαγαζί.';
  end if;
  return d;
end $$;

create or replace function public._driver_order_json(o public.online_order)
returns jsonb
language sql stable
set search_path = public
as $$
  select jsonb_build_object(
           'id', o.id, 'order_no', o.order_no, 'status', o.status, 'customer_name', o.customer_name,
           'phone', o.phone, 'address', o.address, 'notes', o.notes, 'total', o.total, 'payment', o.payment,
           'pay_status', o.pay_status, 'created_at', o.created_at, 'accepted_at', o.accepted_at,
           'ready_minutes', o.ready_minutes, 'done_at', o.done_at,
           'lines', coalesce((select jsonb_agg(jsonb_build_object('name', l.name, 'qty', l.qty, 'line_no', l.line_no,
                                                                  'parent_line', l.parent_line, 'note', l.note) order by l.line_no)
                                from public.online_order_line l where l.order_id = o.id), '[]'::jsonb));
$$;

-- όλη η οθόνη του διανομέα σε μία κλήση
create or replace function public.driver_app(p_token uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  d public.driver%rowtype := public._driver_by_token(p_token);
  s public.online_shop%rowtype;
  v_day timestamptz := date_trunc('day', now() at time zone 'Europe/Athens') at time zone 'Europe/Athens';
begin
  select * into s from public.online_shop where company_id = d.company_id;
  return jsonb_build_object(
    'driver', jsonb_build_object('name', d.name),
    'shop', jsonb_build_object('name', s.title, 'phone', s.phone, 'tracking', coalesce(s.driver_tracking, false)),
    -- έτοιμες (ή «έφυγε» από την κουζίνα χωρίς διανομέα), για διανομή
    'ready', coalesce((select jsonb_agg(public._driver_order_json(o) order by o.accepted_at, o.order_no)
                         from public.online_order o
                        where o.company_id = d.company_id and o.mode = 'delivery'
                          and (o.status = 'accepted' or (o.status = 'done' and o.driver_id is null and o.delivered_at is null
                                                         and o.done_at > now() - interval '3 hours'))), '[]'::jsonb),
    'mine', coalesce((select jsonb_agg(public._driver_order_json(o) order by o.done_at, o.order_no)
                        from public.online_order o
                       where o.driver_id = d.id and o.status = 'done' and o.delivered_at is null), '[]'::jsonb),
    'delivered_today', (select count(*) from public.online_order o where o.driver_id = d.id and o.delivered_at >= v_day),
    'cash_open', (select coalesce(sum(o.total), 0) from public.online_order o
                   where o.driver_id = d.id and o.status = 'done' and o.delivered_at is not null
                     and o.payment = 'cash' and o.cash_settled_at is null));
end $$;

-- «Την παίρνω»: έφυγε με αυτόν τον διανομέα
create or replace function public.driver_take(p_token uuid, p_order uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  d public.driver%rowtype := public._driver_by_token(p_token);
  o public.online_order%rowtype;
begin
  select * into o from public.online_order where id = p_order and company_id = d.company_id for update;
  if not found or o.mode <> 'delivery' then
    raise exception 'Δεν βρέθηκε η παραγγελία';
  end if;
  if o.driver_id = d.id and o.status = 'done' and o.delivered_at is null then
    return jsonb_build_object('order_no', o.order_no, 'already', true);
  end if;
  if o.driver_id is not null and o.driver_id <> d.id and o.status = 'done' then
    raise exception 'Την #% την πήρε άλλος διανομέας.', o.order_no;
  end if;
  if o.status = 'accepted' then
    update public.online_order set status = 'done', done_at = now(), driver_id = d.id where id = o.id;
  elsif o.status = 'done' and o.delivered_at is null then
    update public.online_order set driver_id = d.id where id = o.id;
  else
    raise exception 'Η παραγγελία #% %.', o.order_no,
      case when o.delivered_at is not null then 'έχει ήδη παραδοθεί' else public._order_state_text(o.status) end;
  end if;
  return jsonb_build_object('order_no', o.order_no);
end $$;

-- «Δεν την πήρα τελικά»: γυρίζει στις έτοιμες
create or replace function public.driver_release(p_token uuid, p_order uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  d public.driver%rowtype := public._driver_by_token(p_token);
  o public.online_order%rowtype;
begin
  select * into o from public.online_order where id = p_order and driver_id = d.id for update;
  if not found or o.status <> 'done' or o.delivered_at is not null then
    raise exception 'Η παραγγελία δεν είναι στον δρόμο με εσένα.';
  end if;
  update public.online_order set status = 'accepted', done_at = null, driver_id = null where id = o.id;
  perform public._driver_clear_pos(d.id);
  return jsonb_build_object('order_no', o.order_no);
end $$;

-- θέση: σβήνει όταν δεν έχει πια τίποτα στον δρόμο
create or replace function public._driver_clear_pos(p_driver uuid)
returns void
language sql
set search_path = public
as $$
  update public.driver set last_lat = null, last_lng = null, last_acc = null, last_at = null
   where id = p_driver and last_lat is not null
     and not exists (select 1 from public.online_order o where o.driver_id = p_driver and o.status = 'done' and o.delivered_at is null);
$$;

-- «Παραδόθηκε»
create or replace function public.driver_delivered(p_token uuid, p_order uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  d public.driver%rowtype := public._driver_by_token(p_token);
  o public.online_order%rowtype;
begin
  select * into o from public.online_order where id = p_order and driver_id = d.id for update;
  if not found or o.status <> 'done' then
    raise exception 'Η παραγγελία δεν είναι στον δρόμο με εσένα.';
  end if;
  if o.delivered_at is null then
    update public.online_order set delivered_at = now() where id = o.id;
  end if;
  perform public._driver_clear_pos(d.id);
  return jsonb_build_object('order_no', o.order_no, 'cash', case when o.payment = 'cash' then o.total else 0 end);
end $$;

-- θέση του διανομέα (μόνο αν το μαγαζί το έχει ανοίξει και έχει παραγγελίες στον δρόμο)
create or replace function public.driver_ping(p_token uuid, p_lat double precision, p_lng double precision, p_acc real default null)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  d public.driver%rowtype := public._driver_by_token(p_token);
begin
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'Μη έγκυρη θέση';
  end if;
  if not exists (select 1 from public.online_shop s where s.company_id = d.company_id and s.driver_tracking) then
    return false;
  end if;
  if not exists (select 1 from public.online_order o where o.driver_id = d.id and o.status = 'done' and o.delivered_at is null) then
    perform public._driver_clear_pos(d.id);
    return false;
  end if;
  update public.driver
     set last_lat = round(p_lat::numeric, 5), last_lng = round(p_lng::numeric, 5),
         last_acc = least(greatest(coalesce(p_acc, 0), 0), 100000), last_at = now()
   where id = d.id;
  return true;
end $$;

-- ---------------------------------------------------------------------
-- Για τον πελάτη: ποιος τη φέρνει, πού είναι (μόνο όσο έρχεται)
-- ---------------------------------------------------------------------
create or replace function public.order_track(p_token uuid)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
           'driver', d.name,
           'delivered_at', o.delivered_at,
           'pos', case when s.driver_tracking and o.status = 'done' and o.delivered_at is null
                            and d.last_at > now() - interval '3 minutes'
                       then jsonb_build_object('lat', d.last_lat, 'lng', d.last_lng, 'acc', d.last_acc, 'at', d.last_at) end)
    from public.online_order o
    join public.online_shop s on s.company_id = o.company_id
    left join public.driver d on d.id = o.driver_id
   where o.token = p_token and o.mode = 'delivery';
$$;

-- =====================================================================
-- Δικαιώματα
-- =====================================================================
revoke execute on function public._driver_by_token(uuid) from public, anon, authenticated;
revoke execute on function public._driver_order_json(public.online_order) from public, anon, authenticated;
revoke execute on function public._driver_clear_pos(uuid) from public, anon, authenticated;

revoke execute on function public.driver_app(uuid), public.driver_take(uuid, uuid), public.driver_release(uuid, uuid),
  public.driver_delivered(uuid, uuid), public.driver_ping(uuid, double precision, double precision, real),
  public.order_track(uuid) from public;
grant execute on function public.driver_app(uuid), public.driver_take(uuid, uuid), public.driver_release(uuid, uuid),
  public.driver_delivered(uuid, uuid), public.driver_ping(uuid, double precision, double precision, real),
  public.order_track(uuid) to anon, authenticated;

revoke execute on function public.driver_link(uuid, text), public.order_send(uuid, uuid), public.driver_settle(uuid) from public, anon;
grant execute on function public.driver_link(uuid, text), public.order_send(uuid, uuid), public.driver_settle(uuid) to authenticated;
