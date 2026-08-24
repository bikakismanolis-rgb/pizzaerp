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
