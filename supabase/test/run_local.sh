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
  -f supabase/migrations/0004_voice.sql
sudo -u postgres psql -d pizza_test -f supabase/test/01_scenario.sql
sudo -u postgres psql -d pizza_test -f supabase/test/02_voice.sql
# το 0004 πρέπει να ξανατρέχει χωρίς σφάλμα, και πάνω σε υπάρχοντα δεδομένα
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pizza_test -f supabase/migrations/0004_voice.sql
echo "OK: το 0004_voice.sql ξανατρέχει χωρίς σφάλμα"

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
