import { Highlight } from './Highlight';

// prop drilling, hop 1
export function Results({ query }: { query: string }) {
  return (
    <section>
      <h2>Results</h2>
      <Highlight text={query} />
    </section>
  );
}
