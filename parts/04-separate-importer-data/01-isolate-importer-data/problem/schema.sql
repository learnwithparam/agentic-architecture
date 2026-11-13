-- The platform's tables. The check runs this file as the role "platform", which owns the tables.
-- Every row that belongs to one importer has an importer_id, for example 'ridgeway'.
-- The platform sets the importer for each connection from the agent's token:
--   SELECT set_config('app.importer', 'ridgeway', false);

CREATE TABLE shipments (
  id text PRIMARY KEY,
  importer_id text NOT NULL,
  container text NOT NULL,
  status text NOT NULL
);

CREATE TABLE invoice_lines (
  id text PRIMARY KEY,
  shipment_id text NOT NULL REFERENCES shipments (id),
  importer_id text NOT NULL,
  description text NOT NULL,
  value_cents integer NOT NULL
);

CREATE TABLE documents (
  id text PRIMARY KEY,
  shipment_id text NOT NULL REFERENCES shipments (id),
  importer_id text NOT NULL,
  kind text NOT NULL,
  body text NOT NULL
);

-- Shared by every importer: the tariff belongs to customs, not to a client.
CREATE TABLE tariff_codes (
  code text PRIMARY KEY,
  description text NOT NULL
);

-- TODO: keep each importer's rows apart, in the database itself.
-- For each table with an importer_id: enable row-level security, force it, and add a policy
-- that shows and accepts only rows where importer_id = current_setting('app.importer', true).
