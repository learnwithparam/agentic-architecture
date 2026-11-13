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

-- Each importer sees and writes only its own rows. Lines hang off a shipment,
-- so protecting shipments and documents is enough.
ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments FORCE ROW LEVEL SECURITY;
CREATE POLICY only_this_importer ON shipments
  USING (importer_id = current_setting('app.importer', true))
  WITH CHECK (importer_id = current_setting('app.importer', true));

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY only_this_importer ON documents
  USING (importer_id = current_setting('app.importer', true))
  WITH CHECK (importer_id = current_setting('app.importer', true));
