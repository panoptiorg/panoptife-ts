import axios from 'axios';
import { useState } from 'react';

export function SignupPage() {
  const [name, setName] = useState('');
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        await axios.post('/api/users', { name });
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} />
    </form>
  );
}
