#!/usr/bin/env bash
# Τοπική δοκιμή: ξαναχτίζει τις βάσεις pizza_test (νέα εγκατάσταση) και
# pizza_upgrade (υπάρχουσα εγκατάσταση 0001–0003 με δεδομένα -> 0004) και
# τρέχει τα σενάρια
set -e
cd "$(dirname "$0")/../.."

echo "== νέα εγκατάσταση (pizza_test) =="
sudo -u postgres psql -q -c "drop database if exists pizza_test;" -c "create database pizza_test;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pizza_test \
  -f supabase/test/00_local_prelude.sql \
  -f supabase/migrations/0001_schema.sql \
  -f supabase/migrations/0002_functions.sql \
  -f supabase/migrations/0003_views.sql \
  -f supabase/migrations/0004_voice.sql \
  -f supabase/migrations/0005_online.sql \
  -f supabase/migrations/0006_pay_fiscal.sql
sudo -u postgres psql -d pizza_test -f supabase/test/01_scenario.sql
sudo -u postgres psql -d pizza_test -f supabase/test/02_voice.sql
sudo -u postgres psql -d pizza_test -f supabase/test/04_orders.sql
sudo -u postgres psql -d pizza_test -f supabase/test/05_pay_fiscal.sql
sudo -u postgres psql -d pizza_test -f supabase/test/06_loyalty_privacy.sql
# το 0004 και το 0005 πρέπει να ξανατρέχουν χωρίς σφάλμα, και πάνω σε
# υπάρχοντα δεδομένα (και online πωλήσεις)
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pizza_test -f supabase/migrations/0004_voice.sql
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pizza_test -f supabase/migrations/0005_online.sql
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pizza_test -f supabase/migrations/0006_pay_fiscal.sql
echo "OK: τα 0004, 0005 και 0006 ξανατρέχουν χωρίς σφάλμα"

echo "== αναβάθμιση (pizza_upgrade): 0001–0003 + δεδομένα με τις παλιές functions -> 0004 =="
sudo -u postgres psql -q -c "drop database if exists pizza_upgrade;" -c "create database pizza_upgrade;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pizza_upgrade \
  -f supabase/test/00_local_prelude.sql \
  -f supabase/migrations/0001_schema.sql \
  -f supabase/migrations/0002_functions.sql \
  -f supabase/migrations/0003_views.sql
sudo -u postgres psql -d pizza_upgrade -f supabase/test/01_scenario.sql
sudo -u postgres psql -d pizza_upgrade -f supabase/test/03_upgrade_before.sql
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pizza_upgrade -f supabase/migrations/0004_voice.sql
sudo -u postgres psql -d pizza_upgrade -f supabase/test/03_upgrade_after.sql
sudo -u postgres psql -d pizza_upgrade -f supabase/test/02_voice.sql
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pizza_upgrade -f supabase/migrations/0004_voice.sql
echo "OK: αναβάθμιση 0001–0003 + δεδομένα -> 0004, και ξανά 0004"
# μετά το 0005 πάνω στα ίδια δεδομένα: online παραγγελίες, και ξανά 0004 / 0005
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pizza_upgrade -f supabase/migrations/0005_online.sql
sudo -u postgres psql -d pizza_upgrade -f supabase/test/04_orders.sql
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pizza_upgrade -f supabase/migrations/0004_voice.sql
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pizza_upgrade -f supabase/migrations/0005_online.sql
echo "OK: αναβάθμιση -> 0005, και ξανά 0004 / 0005"
# μετά το 0006 πάνω στα ίδια δεδομένα (και online παραγγελίες): πληρωμές,
# παραστατικά (το 04 πάνω στο 0006 το τρέχει ήδη η νέα εγκατάσταση)
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pizza_upgrade -f supabase/migrations/0006_pay_fiscal.sql
sudo -u postgres psql -d pizza_upgrade -f supabase/test/05_pay_fiscal.sql
sudo -u postgres psql -d pizza_upgrade -f supabase/test/06_loyalty_privacy.sql
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pizza_upgrade -f supabase/migrations/0005_online.sql
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pizza_upgrade -f supabase/migrations/0006_pay_fiscal.sql
echo "OK: αναβάθμιση -> 0006, και ξανά 0005 / 0006"
