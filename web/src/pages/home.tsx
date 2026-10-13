import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Shell } from '@/components/shell';
import { api, type Config } from '@/lib/api';

export function Home() {
  const [config, setConfig] = useState<Config>();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api<Config>('/config').then(setConfig, () => undefined);
  }, []);
  const url = config?.mcpUrl ?? `${window.location.origin}/mcp`;
  return (
    <Shell
      title="Connect Federal Register to your AI assistant"
      description="Search Federal Register, eCFR, and regulations.gov from your AI assistant."
    >
      <ol className="text-muted-foreground grid list-decimal gap-2 pl-5 text-sm">
        <li>
          Add this URL as a custom connector (remote MCP server) in ChatGPT, Claude, Gemini or
          another assistant.
        </li>
        <li>Start the connection. Sign in with Google.</li>
        <li>
          Add your regulations.gov API key and authorize. Federal Register and eCFR work without a key.
        </li>
      </ol>
      <div className="flex items-center gap-2 rounded-md border px-3 py-2">
        <code className="flex-1 truncate text-sm">{url}</code>
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
