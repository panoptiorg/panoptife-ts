'use client';

import { useEffect, useState } from 'react';
import { renameUser } from '../../actions';

export function Profile({ id, tab }: { id: string; tab: string }) {
  const [name, setName] = useState('');
  useEffect(() => {
    // links to app/api/users/[id]/route.ts GET
    fetch('/api/users/' + id).then((r) => r.json());
  }, [id]);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        await renameUser(id, name);
      }}
    >
      <h2>{tab}</h2>
      <input value={name} onChange={(e) => setName(e.target.value)} />
    </form>
  );
}
