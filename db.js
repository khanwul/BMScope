import pg from 'pg'

const { Pool } = pg

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS charts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE CHECK (filename ~* '\\.(bms|bme|bml|pms)$'),
    title TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    content BYTEA NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 5242880),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`

export function createPool(url = process.env.DATABASE_URL) {
  if (!url) return null
  const connection = new URL(url)
  if (connection.hostname.endsWith('.render.com')) connection.searchParams.set('sslmode', 'verify-full')
  return new Pool({ connectionString: connection.href })
}

export const initDb = pool => pool.query(SCHEMA)
