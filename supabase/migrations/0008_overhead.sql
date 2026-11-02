-- =====================================================================
-- Pizza ERP - 0008 γενικά έξοδα (ρεύμα, αέριο, μισθοί, ενοίκιο...) ανά μήνα
--
-- Ένα ποσό ανά κατηγορία ανά μήνα, χωρίς ΦΠΑ. Δεν αγγίζει αποθήκη ούτε
-- κόστη κινήσεων: το καθαρό κέρδος ανά είδος (πωλήσεις − υλικά − μερίδιο
-- γενικών εξόδων) το βγάζει η αναφορά «Κέρδος», με επιμερισμό ανά τεμάχιο
-- ή ανά κόστος υλικών (το διαλέγει ο ιδιοκτήτης στην οθόνη).
--
-- Τα βλέπει και τα αλλάζει μόνο ο ιδιοκτήτης (μέσα είναι και οι μισθοί).
-- Δεν αλλάζει καμία υπάρχουσα function. Ξανατρέχει χωρίς σφάλμα.
-- =====================================================================

create table if not exists public.overhead (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.company(id) on delete cascade,
  month       date not null,
  category    text not null,
  amount      numeric(12,2) not null,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint overhead_month_check check (month = date_trunc('month', month)::date),
  constraint overhead_category_check check (char_length(btrim(category)) between 1 and 40),
  constraint overhead_amount_check check (amount >= 0 and amount < 10000000),
  constraint overhead_notes_check check (notes is null or char_length(notes) <= 200),
  unique (company_id, month, category)
);
create index if not exists overhead_company_month on public.overhead (company_id, month);
drop trigger if exists overhead_updated_at on public.overhead;
create trigger overhead_updated_at before update on public.overhead
  for each row execute function public.set_updated_at();

alter table public.overhead enable row level security;
drop policy if exists overhead_select on public.overhead;
create policy overhead_select on public.overhead for select to authenticated using (public.is_owner(company_id));
drop policy if exists overhead_insert on public.overhead;
create policy overhead_insert on public.overhead for insert to authenticated with check (public.is_owner(company_id));
drop policy if exists overhead_update on public.overhead;
create policy overhead_update on public.overhead for update to authenticated
  using (public.is_owner(company_id)) with check (public.is_owner(company_id));
drop policy if exists overhead_delete on public.overhead;
create policy overhead_delete on public.overhead for delete to authenticated using (public.is_owner(company_id));
revoke all on public.overhead from anon, authenticated;
grant select, insert, update, delete on public.overhead to authenticated;

-- σύνολο ανά μήνα (για την αρχική και την αναφορά)
create or replace view public.v_overhead_month
with (security_invoker = true) as
select company_id, month, sum(amount) as total, count(*) as lines
  from public.overhead
 group by company_id, month;
revoke all on public.v_overhead_month from anon;
grant select on public.v_overhead_month to authenticated;
