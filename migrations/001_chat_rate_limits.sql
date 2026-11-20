CREATE TABLE IF NOT EXISTS chat_rate_buckets (
  bucket_key text PRIMARY KEY,
  count integer NOT NULL DEFAULT 0,
  reset_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_rate_buckets_reset_at_idx
  ON chat_rate_buckets (reset_at);
