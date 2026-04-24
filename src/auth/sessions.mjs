export async function createSession(pool, { userId, provider, prt }) {
  const { rows } = await pool.query(
    'INSERT INTO auth.sessions (user_id, provider, prt) VALUES ($1, $2, $3) RETURNING id',
    [userId, provider, prt]
  );
  return { sid: rows[0].id };
}

export async function resolveSession(pool, sid) {
  const { rows } = await pool.query(
    'SELECT user_id, provider, prt, revoked FROM auth.sessions WHERE id = $1',
    [sid]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    userId: row.user_id,
    provider: row.provider,
    prt: row.prt,
    revoked: row.revoked,
  };
}

export async function updateSessionPrt(pool, sid, newPrt) {
  await pool.query(
    'UPDATE auth.sessions SET prt = $1, updated_at = now() WHERE id = $2',
    [newPrt, sid]
  );
}

export async function revokeSession(pool, sid) {
  await pool.query(
    'UPDATE auth.sessions SET revoked = true, updated_at = now() WHERE id = $1',
    [sid]
  );
}

export async function revokeUserSessions(pool, userId) {
  await pool.query(
    'UPDATE auth.sessions SET revoked = true, updated_at = now() WHERE user_id = $1 AND revoked = false',
    [userId]
  );
}
