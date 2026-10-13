import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { KeyField } from '@/components/fields';
import { Loading, Notice, Shell, SignedInAs, SignOut } from '@/components/shell';
import { api, type Connection, type Keys } from '@/lib/api';
import { useFlow } from '@/lib/flow';
import { useLoad } from '@/lib/use-load';

/** Better Auth's post-login step: choose the regulations.gov API key this connection uses. */
export function Connect() {
  const { oauthQuery } = useFlow();
  const { data, error: loadError } = useLoad(
    () => api<Connection & Keys>(`/connect?${new URLSearchParams({ oauth_query: oauthQuery })}`),
    `${window.location.pathname}${window.location.search}`,
  );
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function send(decision: 'continue' | 'deny') {
    setBusy(true);
    setError(undefined);
    try {
      const { url } = await api<{ url: string }>('/connect', {
        oauth_query: oauthQuery,
        decision,
        ...(apiKey ? { apiKey } : {}),
      });
      window.location.assign(url);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    }
  }
  if (loadError)
    return (
      <Shell title="Unable to continue">
        <Notice>{loadError}</Notice>
      </Shell>
    );
  if (!data) return <Loading />;
  return (
    <Shell
      title={`Connect ${data.client}`}
      description={<SignedInAs email={data.email} />}
      action={<SignOut then={`/sign-in?${oauthQuery}`} />}
    >
      {error && <Notice>{error}</Notice>}
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void send('continue');
        }}
      >
        <div className="grid gap-3">
          <h2 className="flex items-center gap-2 font-medium">
            <KeyRound className="size-4" />
            regulations.gov API key
          </h2>
          <p className="text-muted-foreground text-sm">
            Use your personal key for this connection. It stays encrypted on this server and is never
            shown to your AI assistant.
          </p>
          <KeyField
            label={data.personal.connected ? 'Replace your personal key' : 'Your key'}
            required={false}
            value={apiKey}
            onChange={setApiKey}
          />
          <p className="text-muted-foreground text-xs">Federal Register and eCFR work without a key.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy}>
            Continue
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => send('deny')}>
            Cancel
          </Button>
        </div>
      </form>
    </Shell>
  );
}
