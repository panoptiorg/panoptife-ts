// A private folder: not routable, so no endpoint.
export default function Hidden({ params }: { params: Promise<{ x: string }> }) {
  return <p>{String(params)}</p>;
}
