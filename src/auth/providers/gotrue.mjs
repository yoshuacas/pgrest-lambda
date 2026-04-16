import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { ensureAuthSchema } from '../schema.mjs';

// Pre-computed: bcrypt.hashSync('dummy-password', 10)
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMye'
  + 'Ih9cvl6j5iHLbWb4Or/JtqKMZBHFwOC';

export function createGoTrueProvider(config, db) {
  async function signUp(email, password) {
    const pool = await db.getPool();
    await ensureAuthSchema(pool);

    const reasons = [];
    if (password.length < 8) reasons.push('length');
    if (!/[A-Z]/.test(password)) reasons.push('uppercase');
    if (!/[a-z]/.test(password)) reasons.push('lowercase');
    if (!/[0-9]/.test(password)) reasons.push('number');
    if (reasons.length > 0) {
      const err = new Error('Weak password');
      err.code = 'weak_password';
      err.reasons = reasons;
      throw err;
    }

    const hash = await bcrypt.hash(password, 10);

    let result;
    try {
      result = await pool.query(
        `INSERT INTO auth.users (email, encrypted_password)
         VALUES ($1, $2)
         RETURNING id, email, app_metadata, user_metadata, created_at`,
        [email, hash]
      );
    } catch (err) {
      if (err.code === '23505') {
        const dup = new Error('User already registered');
        dup.code = 'user_already_exists';
        throw dup;
      }
      throw err;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      app_metadata: row.app_metadata,
      user_metadata: row.user_metadata,
      created_at: row.created_at,
    };
  }

  async function signIn(email, password) {
    const pool = await db.getPool();
    await ensureAuthSchema(pool);

    const result = await pool.query(
      `SELECT id, email, encrypted_password, app_metadata,
              user_metadata, created_at
       FROM auth.users WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      await bcrypt.compare(password, DUMMY_HASH);
      const err = new Error('Invalid credentials');
      err.code = 'invalid_grant';
      throw err;
    }

    const row = result.rows[0];
    const match = await bcrypt.compare(password, row.encrypted_password);
    if (!match) {
      const err = new Error('Invalid credentials');
      err.code = 'invalid_grant';
      throw err;
    }

    const opaqueToken = crypto.randomBytes(16).toString('base64url');

    await pool.query(
      `INSERT INTO auth.refresh_tokens (token, user_id)
       VALUES ($1, $2)`,
      [opaqueToken, row.id]
    );

    return {
      user: {
        id: row.id,
        email: row.email,
        app_metadata: row.app_metadata,
        user_metadata: row.user_metadata,
        created_at: row.created_at,
      },
      providerTokens: { refreshToken: opaqueToken },
    };
  }

  async function refreshToken(opaqueToken) {
    const pool = await db.getPool();
    await ensureAuthSchema(pool);

    const tokenResult = await pool.query(
      `SELECT id, token, user_id, revoked
       FROM auth.refresh_tokens WHERE token = $1`,
      [opaqueToken]
    );

    if (tokenResult.rows.length === 0) {
      const err = new Error('Invalid refresh token');
      err.code = 'invalid_grant';
      throw err;
    }

    const tokenRow = tokenResult.rows[0];

    if (tokenRow.revoked) {
      await pool.query(
        `UPDATE auth.refresh_tokens SET revoked = true,
           updated_at = now() WHERE user_id = $1
           AND revoked = false`,
        [tokenRow.user_id]
      );
      const err = new Error('Invalid refresh token');
      err.code = 'invalid_grant';
      throw err;
    }

    const newToken = crypto.randomBytes(16).toString('base64url');

    // Revoke old token before inserting the new one so a concurrent
    // request reusing the same token sees revoked=true and triggers
    // family revocation instead of obtaining a second valid session.
    await pool.query(
      `UPDATE auth.refresh_tokens SET revoked = true,
         updated_at = now() WHERE id = $1`,
      [tokenRow.id]
    );

    await pool.query(
      `INSERT INTO auth.refresh_tokens (token, user_id, parent)
       VALUES ($1, $2, $3)`,
      [newToken, tokenRow.user_id, opaqueToken]
    );

    const userResult = await pool.query(
      `SELECT id, email, app_metadata, user_metadata, created_at
       FROM auth.users WHERE id = $1`,
      [tokenRow.user_id]
    );

    const user = userResult.rows[0];
    if (!user) {
      const err = new Error('User not found');
      err.code = 'user_not_found';
      throw err;
    }
    return {
      user: {
        id: user.id,
        email: user.email,
        app_metadata: user.app_metadata,
        user_metadata: user.user_metadata,
        created_at: user.created_at,
      },
      providerTokens: { refreshToken: newToken },
    };
  }

  async function getUser(userId) {
    const pool = await db.getPool();
    await ensureAuthSchema(pool);

    const result = await pool.query(
      `SELECT id, email, app_metadata, user_metadata, created_at
       FROM auth.users WHERE id = $1`,
      [userId]
    );

    const row = result.rows[0];
    if (!row) {
      const err = new Error('User not found');
      err.code = 'user_not_found';
      throw err;
    }
    return {
      id: row.id,
      email: row.email,
      app_metadata: row.app_metadata,
      user_metadata: row.user_metadata,
      created_at: row.created_at,
    };
  }

  async function signOut(userId) {
    const pool = await db.getPool();
    await ensureAuthSchema(pool);

    await pool.query(
      `UPDATE auth.refresh_tokens SET revoked = true,
         updated_at = now() WHERE user_id = $1
         AND revoked = false`,
      [userId]
    );
  }

  const provider = { signUp, signIn, refreshToken, getUser, signOut };
  return { provider, _setClient: null };
}
