import { memo } from 'react';

// prop drilling, hop 2 — the sink
export const Highlight = memo(function Highlight({ text }: { text: string }) {
  return <span dangerouslySetInnerHTML={{ __html: text }} />;
});
