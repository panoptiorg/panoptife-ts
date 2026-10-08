import type { NextApiRequest, NextApiResponse } from 'next';

// Pages Router API route: one handler for every method.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.redirect(String(req.query.next ?? '/'));
}
