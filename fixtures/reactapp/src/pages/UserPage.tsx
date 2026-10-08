import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

interface User {
  name: string;
  homepage: string;
}

export default function UserPage() {
  const { id } = useParams();
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_URL}/api/users/${id}`)
      .then((r) => r.json())
      .then((u: User) => setUser(u));
  }, [id]);
  return <a href={user?.homepage}>{user?.name}</a>;
}
