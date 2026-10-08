import { exec } from 'node:child_process';
import type { NextRequest } from 'next/server';

// GET /api/run?cmd=… — a query parameter straight into a shell.
export async function GET(request: NextRequest) {
  const cmd = request.nextUrl.searchParams.get('cmd') ?? '';
  exec(`ls ${cmd}`);
  return Response.json({ ok: true });
}
