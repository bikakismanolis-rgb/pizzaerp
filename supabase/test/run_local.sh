#!/usr/bin/env bash
# Τοπική δοκιμή: ξαναχτίζει τη βάση pizza_test και τρέχει migrations + σενάριο
set -e
cd "$(dirname "$0")/../.."
sudo -u postgres psql -q -c "drop database if exists pizza_test;" -c "create database pizza_test;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pizza_test \
  -f supabase/test/00_local_prelude.sql \
  -f supabase/migrations/0001_schema.sql \
  -f supabase/migrations/0002_functions.sql \
  -f supabase/migrations/0003_views.sql
sudo -u postgres psql -d pizza_test -f supabase/test/01_scenario.sql
