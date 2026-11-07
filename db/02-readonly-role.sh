#!/bin/bash
# Creates a READ-ONLY role the bot uses for live-data SQL questions.
# Even if the LLM writes a bad query, this role can only SELECT
# from the allowed tables, and every query is cut off after 3 seconds.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE ROLE bot_reader LOGIN PASSWORD '${BOT_READER_PASSWORD:-bot_reader_dev}';
    GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO bot_reader;
    GRANT USAGE ON SCHEMA public TO bot_reader;
    GRANT SELECT ON products, orders TO bot_reader;
    ALTER ROLE bot_reader SET default_transaction_read_only = on;
    ALTER ROLE bot_reader SET statement_timeout = '3s';
EOSQL
