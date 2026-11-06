-- Creates the SELECT-only login the weekly review uses, scoped to exactly
-- the tables it reads. Run once as the cluster admin, from the deploy host:
--
--   docker compose exec -T db psql -U admin -d postgres \
--     -v ro_password="'<generated password>'" < sql/readonly-role.sql
--
-- Re-running is safe. Rotating the password: ALTER ROLE weekly_review_ro PASSWORD '...';
\set ON_ERROR_STOP on

SELECT 'CREATE ROLE weekly_review_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'weekly_review_ro') \gexec
ALTER ROLE weekly_review_ro PASSWORD :ro_password;
-- Every session is read-only even if a grant is ever widened by mistake.
ALTER ROLE weekly_review_ro SET default_transaction_read_only = on;
ALTER ROLE weekly_review_ro SET statement_timeout = '15s';
ALTER ROLE weekly_review_ro CONNECTION LIMIT 8;

\connect macro_tracker
GRANT CONNECT ON DATABASE macro_tracker TO weekly_review_ro;
GRANT USAGE ON SCHEMA public TO weekly_review_ro;
GRANT SELECT ON users, entries, nutrition_day_completeness, macro_targets,
  weight_entries, waist_entries, oura_documents TO weekly_review_ro;
-- Column-level would be tighter for users/oura_documents; the review reads
-- only id/email/timezone and the score/steps fields.

\connect spending
GRANT CONNECT ON DATABASE spending TO weekly_review_ro;
GRANT USAGE ON SCHEMA public TO weekly_review_ro;
GRANT SELECT ON users, transactions, tags TO weekly_review_ro;

\connect daily_checklist
GRANT CONNECT ON DATABASE daily_checklist TO weekly_review_ro;
GRANT USAGE ON SCHEMA public TO weekly_review_ro;
GRANT SELECT ON daily_app_state TO weekly_review_ro;

\connect common_week
GRANT CONNECT ON DATABASE common_week TO weekly_review_ro;
GRANT USAGE ON SCHEMA public TO weekly_review_ro;
GRANT SELECT ON users, households, household_members, planning_items,
  child_profiles, weekly_reviews TO weekly_review_ro;
