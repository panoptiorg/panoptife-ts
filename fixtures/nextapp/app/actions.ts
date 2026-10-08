'use server';

import { pool } from '../lib/db';

// A server action: reachable by a direct POST, so every parameter is untrusted.
export async function renameUser(id: string, name: string) {
  await pool.query(`update users set name = '${name}' where id = '${id}'`);
}
