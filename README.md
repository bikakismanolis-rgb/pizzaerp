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
    supabase/migrations/0004_voice.sql      "Πες το": aliases, κανάλια wolt/box, μετρητής ημέρας,
                                            απογραφή σε εξέλιξη, αυτόματο ζυμάρι (backflush δύο επιπέδων)
    supabase/apply_all.sql            όλα τα migrations σε ένα αρχείο (νέα εγκατάσταση, SQL Editor)
    supabase/test/                    τοπικά σενάρια δοκιμής (δεν εφαρμόζονται στη Supabase)

## Τοπική δοκιμή του schema

Χρειάζεται PostgreSQL 15+ τοπικά.

    ./supabase/test/run_local.sh

Ξαναχτίζει τη βάση `pizza_test`, εφαρμόζει τα migrations και τρέχει τα σενάρια:

- `01_scenario.sql`: αγορές, παραγωγή ζυμαριού, παραγωγή κατεψυγμένων, πώληση
  χονδρικής, πώληση efood με backflush, είσπραξη, απογραφή με επιμερισμό,
  κλειδώματα, ακυρώσεις. Τυπώνει `ΟΛΑ ΟΚ`.
- `02_voice.sql`: aliases, κανάλια, μετρητής ημέρας (`tally_add`), απογραφή σε
  εξέλιξη (`stocktake_count`), αυτόματο κλείσιμο ημερών (`close_running`),
  αυτόματο ζυμάρι (πώληση → αυτόματη πίτσα → αυτόματο ζυμάρι) με ακυρώσεις,
  κόστη και επιμερισμό απογραφής. Τυπώνει `ΟΛΑ ΟΚ (φωνή)`.

Στο τέλος ξαναεφαρμόζει το `0004_voice.sql` πάνω στα δεδομένα, για να φανεί ότι
ξανατρέχει χωρίς σφάλμα.

## Εφαρμογή στη Supabase

- **Νέα εγκατάσταση:** τα migrations `0001`–`0004` με τη σειρά (SQL editor ή
  Supabase CLI / MCP), ή όλα μαζί με το `supabase/apply_all.sql`.
- **Υπάρχουσα εγκατάσταση** (έχει ήδη `0001`–`0003`): εφαρμόζεται **μόνο** το
  `supabase/migrations/0004_voice.sql`. Ξανατρέχει χωρίς πρόβλημα αν εφαρμοστεί
  δεύτερη φορά. (Το `apply_all.sql` δεν είναι για υπάρχουσα βάση.)

Το `supabase/test/` ΔΕΝ εφαρμόζεται στη Supabase.

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
| `item_price_for(p_item, p_partner)` | Τιμή είδους για πελάτη (ειδική τιμή ή γενική `sale_price`) |
| `tally_add(p_company, p_date, p_channel, p_item, p_delta)` | Μετρητής ημέρας: +/− ποσότητα ετοίμου στην ανοιχτή πώληση της ημέρας για κανάλι λιανικής (`efood`, `wolt`, `box`, `phone`, `store`). Επιστρέφει το id της πώλησης, ή `null` αν άδειασε και διαγράφηκε |
| `stocktake_count(p_company, p_date, p_item, p_qty, p_add)` | Απογραφή σε εξέλιξη της ημέρας: ορίζει τη μέτρηση ενός είδους (με `p_add = true` την προσθέτει)· `p_qty = null` βγάζει το είδος. Επιστρέφει το id της απογραφής, ή `null` αν άδειασε |
| `close_running(p_company, p_before)` | Καταχωρεί μία-μία τις ανοιχτές πωλήσεις ημέρας με ημερομηνία πριν από `p_before` (οι απογραφές δεν κλείνουν αυτόματα). Επιστρέφει γραμμές `doc_id, doc_no, doc_date, channel, ok, message` |

Ανοιχτά πρόχειρα (`doc.is_running`): ένα ανά εταιρεία / τύπο / ημέρα / κανάλι. Το
"κλείσιμο ημέρας" ή απογραφής είναι απλό `post_document`. Ημιέτοιμο με
`make_to_order` (π.χ. ζυμάρι) παράγεται αυτόματα όποτε αναλώνεται (σε πώληση
λιανικής μέσω της αυτόματης παραγωγής της πίτσας, ή σε χειροκίνητη παραγωγή) και
ακυρώνεται μαζί με το παραστατικό που το δημιούργησε.

Αναφορές: `v_stock_balance`, `v_item_ledger`, `v_partner_balance`, `v_partner_ledger`,
`v_sales_by_partner_item`, `v_purchases_by_partner_item`, `v_production_cost`,
`v_item_cost_monthly`, `v_stocktake_result`, `v_doc_list`.
