import Markdown, { defaultUrlTransform } from 'react-markdown';
import { Shell } from '@/components/shell';
import privacy from '../../../legal/privacy-policy.md?raw';
import terms from '../../../legal/terms.md?raw';

export function Policy({ kind }: { kind: 'privacy' | 'terms' }) {
  return (
    <Shell wide title={kind === 'privacy' ? 'Privacy policy' : 'Terms of service'}>
      <article className="policy text-sm"><Markdown urlTransform={(url) => {
        if (url === './privacy-policy.md') return '/privacy-policy';
        if (url === '../LICENSE' || url === '../SECURITY.md')
          return `https://github.com/blen-labs/fedreg-mcp-server/blob/main/${url.slice(3)}`;
        return defaultUrlTransform(url);
      }}>{kind === 'privacy' ? privacy : terms}</Markdown></article>
    </Shell>
  );
}
