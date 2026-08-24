# Pizza ERP

Ελαφρύ mini-ERP για βιοτεχνία πίτσας: είδη, συνταγές (BOM δύο επιπέδων), αγορές, πωλήσεις (λιανική με backflush και χονδρική), παραγωγές, απογραφές με επιμερισμό διαφορών στο κόστος, καρτέλες πελατών/προμηθευτών.

- Σχεδιασμός: [docs/DESIGN.md](docs/DESIGN.md)
- Backend: Supabase (Postgres + Auth + RLS). Migrations στο `supabase/migrations/`.
- Frontend: React + Vite + Tailwind (έρχεται), deploy στο Vercel.

## Δομή

    docs/DESIGN.md                    έγγραφο σχεδιασμού
    supabase/migrations/0001_schema.sql     πίνακες, triggers, RLS
    supabase/migrations/0002_functions.sql  create_company, post/unpost, κοστολόγηση
    supabase/migrations/0003_views.sql      αναφορές
    supabase/test/                    τοπικό σενάριο δοκιμής (δεν εφαρμόζεται στη Supabase)

## Τοπική δοκιμή του schema

Χρειάζεται PostgreSQL 15+ τοπικά.

    ./supabase/test/run_local.sh

Ξαναχτίζει τη βάση `pizza_test`, εφαρμόζει τα migrations και τρέχει το σενάριο
(αγορές, παραγωγή ζυμαριού, παραγωγή κατεψυγμένων, πώληση χονδρικής, πώληση
efood με backflush, είσπραξη, απογραφή με επιμερισμό, κλειδώματα, ακυρώσεις).
Στο τέλος πρέπει να τυπώσει `ΟΛΑ ΟΚ`.

## Εφαρμογή στη Supabase

Τα τρία αρχεία migrations εφαρμόζονται με τη σειρά (SQL editor ή Supabase CLI /
MCP). Το `supabase/test/` ΔΕΝ εφαρμόζεται στη Supabase.

## API προς το frontend

Ο client (supabase-js) γράφει απευθείας σε `item`, `partner`, `bom`, `bom_line`
και σε πρόχειρα (`draft`) `doc` / `doc_line`. Για όλα τα υπόλοιπα καλεί RPC:

| RPC | Τι κάνει |
|---|---|
| `create_company(p_name, p_vat_no)` | Δημιουργεί εταιρεία, ο χρήστης γίνεται owner |
| `post_document(p_doc)` | Καταχώρηση: κινήσεις αποθήκης / συναλλασσομένων, κοστολόγηση |
| `unpost_document(p_doc)` | Ακύρωση καταχώρησης (αν η περίοδος είναι ανοιχτή) |
| `explode_bom(p_doc)` | Γεμίζει τις γραμμές ανάλωσης μιας πρόχειρης παραγωγής από τη συνταγή |
| `item_on_hand(p_item, p_until)` | Υπόλοιπο είδους (μέχρι ημερομηνία) |

Αναφορές: `v_stock_balance`, `v_item_ledger`, `v_partner_balance`, `v_partner_ledger`,
`v_sales_by_partner_item`, `v_purchases_by_partner_item`, `v_production_cost`,
`v_item_cost_monthly`, `v_stocktake_result`, `v_doc_list`.
