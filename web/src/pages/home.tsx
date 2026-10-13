import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Shell } from '@/components/shell';
import { api, type Config } from '@/lib/api';

function ConnectorUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border px-3 py-2">
      <code className="min-w-0 flex-1 truncate text-sm">{url}</code>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Copy URL"
        onClick={async () => {
          // The clipboard is unavailable outside secure contexts; the URL stays selectable.
          await navigator.clipboard
            ?.writeText(url)
            .then(() => setCopied(true))
            .catch(() => undefined);
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

export function Home() {
  const [config, setConfig] = useState<Config>();
  useEffect(() => {
    api<Config>('/config').then(setConfig, () => undefined);
  }, []);
  const accountUrl = config?.mcpUrl ?? `${window.location.origin}/mcp/account`;
  const publicUrl = config?.publicMcpUrl ?? `${window.location.origin}/mcp`;
  return (
    <Shell
      title="Connect Federal Register to your AI assistant"
      description="Search Federal Register, eCFR, and regulations.gov from your AI assistant."
    >
      <p className="text-muted-foreground text-sm">
        Add one of these URLs as a custom connector (remote MCP server) in ChatGPT, Claude, Gemini or
        another assistant.
      </p>
      <div className="grid gap-2">
        <h2 className="text-sm font-medium">With your regulations.gov key</h2>
        <p className="text-muted-foreground text-sm">
          Sign in with Google when you connect, then add your regulations.gov API key. Includes
          Federal Register and eCFR.
        </p>
        <ConnectorUrl url={accountUrl} />
      </div>
      <div className="grid gap-2">
        <h2 className="text-sm font-medium">Without signing in</h2>
        <p className="text-muted-foreground text-sm">Federal Register and eCFR. No account needed.</p>
        <ConnectorUrl url={publicUrl} />
      </div>
      <p className="text-muted-foreground text-xs">
        Keys are encrypted and used only by this server; your assistant never receives them.{' '}
        <a className="underline underline-offset-4" href="/account">
          Manage your account
        </a>
        . Independent integration; not a U.S. government service.
      </p>
    </Shell>
  );
}
