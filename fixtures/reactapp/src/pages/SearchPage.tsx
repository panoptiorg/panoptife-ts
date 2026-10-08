import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Results } from '../components/Results';

export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const [note, setNote] = useState('');
  useEffect(() => {
    setNote(`searched for ${q}`);
  }, [q]);
  return (
    <main>
      <button
        onClick={() => {
          window.location.href = q;
        }}
      >
        open
      </button>
      <aside dangerouslySetInnerHTML={{ __html: note }} />
      <Results query={q} />
    </main>
  );
}
