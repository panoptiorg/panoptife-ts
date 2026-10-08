import { Profile } from './Profile';

// Next 16: `params` and `searchParams` are Promises.
export default async function UserPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  return <Profile id={id} tab={tab ?? 'about'} />;
}
