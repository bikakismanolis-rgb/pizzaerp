# Pizza ERP — Web app

React + Vite + TypeScript + Tailwind, με Supabase (Postgres + Auth + RLS) στο backend.

## Ρυθμίσεις

Δημιούργησε αρχείο `.env` (υπάρχει ήδη `.env.example`):

```
VITE_SUPABASE_URL=https://gvqanbrexbrjtnlkbepo.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...
```

Το publishable/anon key είναι σχεδιασμένο να είναι δημόσιο (η ασφάλεια γίνεται με RLS στη βάση).

## Απαιτήσεις

Node 18 ή νεότερο (δοκιμασμένο σε 20.15 και 22). Το toolchain είναι Vite 5 + Tailwind 3 + React 18.

## Τοπική εκτέλεση

```
cd web
npm install
npm run dev
```

Αν είχες τρέξει προηγούμενη έκδοση, σβήσε πρώτα `node_modules` και `package-lock.json` και ξανακάνε `npm install`.

Άνοιξε http://localhost:5173. Πρώτη φορά: κάνε εγγραφή με email/κωδικό, μετά δημιούργησε την επιχείρηση.

## Build

```
npm run build      # παράγει το dist/
npm run preview    # τοπική προεπισκόπηση του build
```

## Deploy στο Vercel

1. Ανέβασε το repo στο GitHub.
2. Στο Vercel: New Project → import το repo.
3. **Root Directory:** `web` (το app είναι σε υποφάκελο).
4. Framework preset: Vite. Build command `npm run build`, output `dist` (τα βρίσκει μόνο του).
5. Environment Variables: πρόσθεσε `VITE_SUPABASE_URL` και `VITE_SUPABASE_ANON_KEY`.
6. Deploy. Το `vercel.json` φροντίζει το SPA routing (όλα τα paths → index.html).

## Δομή

```
src/
  lib/          supabase client, types, format, labels, docs helpers
  context/      Auth, Company, MasterData (είδη/συναλλασσόμενοι για pickers)
  components/   Layout, UI (toast/modal/inputs), Combo, Pickers
  pages/        Login, CompanySetup, Dashboard, Items, Partners, DailySales
    docs/       ένας editor ανά τύπο παραστατικού (+ DocShell, useDocEditor)
    reports/    υπόλοιπα, καρτέλες, πωλήσεις, αγορές, κόστος, απογραφές
```

## Ροή χρήσης (σύντομα)

1. **Είδη**: φτιάξε πρώτες ύλες (αλεύρι, τυρί...), μετά ημιέτοιμα (ζυμάρια) με συνταγή, μετά έτοιμα προϊόντα (πίτσες) με συνταγή. Στις πίτσες λιανικής τσέκαρε «Φτιάχνεται κατά παραγγελία».
2. **Πελάτες & προμηθευτές**: ξενοδοχεία, μύλος, τυροκομείο. Στους πελάτες, tab «Τιμές» για ειδικό τιμοκατάλογο.
3. **Αγορές**: καταχώρησε τιμολόγια προμηθευτών.
4. **Παραγωγές**: ζυμάρια και κατεψυγμένες για χονδρική.
5. **Πωλήσεις ημέρας**: λιανική efood/τηλέφωνο (backflush).
6. **Πωλήσεις**: χονδρική στα ξενοδοχεία.
7. **Απογραφή** (τέλος μήνα): μετράς, το σύστημα ρίχνει τις διαφορές στο κόστος.
8. **Αναφορές**: υπόλοιπα, καρτέλες, κόστος, κερδοφορία.
