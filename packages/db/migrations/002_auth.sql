-- Authentication (NFR §8.2).
--
-- The API previously trusted an X-Actor-User-Id header, which any caller can set.
-- Identity is now derived exclusively from a signed token, and the user's secret is
-- stored only as a salted hash so a database copy cannot be replayed as credentials.

ALTER TABLE users ADD COLUMN auth_secret_hash TEXT;
ALTER TABLE users ADD COLUMN auth_secret_salt TEXT;

-- Secrets that predate authentication must be re-provisioned explicitly rather than
-- silently inheriting a usable credential.
CREATE INDEX IF NOT EXISTS idx_users_auth ON users(id, auth_secret_hash);