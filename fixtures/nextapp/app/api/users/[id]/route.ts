import { pool } from '../../../../lib/db';

// Next 15+: `params` is a Promise; `await` is transparent to the flow model.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { rows } = await pool.query(`select * from users where id = '${id}'`);
  return Response.json(rows[0] ?? null);
}

async function remove(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await pool.query(`delete from users where id = '${id}'`);
  return new Response(null, { status: 204 });
}

export { remove as DELETE };
