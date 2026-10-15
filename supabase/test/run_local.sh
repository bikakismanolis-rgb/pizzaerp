#!/usr/bin/env bash
# Τοπική δοκιμή: ξαναχτίζει τη βάση pizza_test και τρέχει migrations + σενάρια
set -e
cd "$(dirname "$0")/../.."
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
