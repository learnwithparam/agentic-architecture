-- Agent memory: past rulings and broker notes, found by meaning with pgvector.
-- An embedding is a list of numbers for the meaning of a note. Close lists mean close meanings.
-- A ruling that a newer one replaced has superseded_by set, for example 'mem-r1'.
CREATE TABLE memory (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  importer_id text NOT NULL,
  kind text NOT NULL,
  note text NOT NULL,
  embedding vector(8) NOT NULL,
  superseded_by text
);

-- Saves a note for the importer this connection works for, and gives back its id.
CREATE FUNCTION remember(note_kind text, note_text text, note_embedding vector)
RETURNS text LANGUAGE sql AS $$
  INSERT INTO memory (importer_id, kind, note, embedding)
  VALUES (current_setting('app.importer', true), note_kind, note_text, note_embedding)
  RETURNING id;
$$;

-- Finds the notes closest in meaning to the question, best match first.
-- TODO: only this importer's notes may be candidates, and never a superseded ruling.
CREATE FUNCTION recall(question vector, how_many integer)
RETURNS TABLE (id text, kind text, note text) LANGUAGE sql AS $$
  SELECT memory.id, memory.kind, memory.note
  FROM memory
  ORDER BY memory.embedding <-> question
  LIMIT how_many;
$$;
