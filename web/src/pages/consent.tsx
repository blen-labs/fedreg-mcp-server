import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/kit/notice';
import { Loading, Shell, SignedInAs, SignOut } from '@/components/kit/shell';
import { api, type Connection } from '@/lib/api';
import { useFlow } from '@/lib/flow';
import { useLoad } from '@/lib/use-load';

interface Consent extends Connection {
  email: string;
  key: { personal: boolean };
}

export function Consent() {
  const { oauthQuery } = useFlow();
  const { data, error: loadError } = useLoad(
    () => api<Consent>(`/consent?${new URLSearchParams({ oauth_query: oauthQuery })}`),
    `${window.location.pathname}${window.location.search}`,
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function decide(accept: boolean) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const { url } = await api<{ url: string }>('/consent', { oauth_query: oauthQuery, accept });
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
  const access = data.key.personal ? 'read regulatory data using your personal regulations.gov API key. The key stays on this server.' : 'read Federal Register and eCFR data. Add a regulations.gov key in your account to enable that source.';
  return (
    <Shell
      title={`Authorize ${data.client}`}
      description={<SignedInAs email={data.email} />}
      action={<SignOut then={`/sign-in?${oauthQuery}`} />}
    >
      {error && <Notice>{error}</Notice>}
      <p className="text-sm">
        Allow <strong>{data.client}</strong> to {access}
      </p>
      <p className="text-muted-foreground text-sm">
        After you allow, you return to{' '}
        <strong className="text-foreground">{data.destination}</strong>. Only continue if you
        started this connection there.
      </p>
      {data.local && (
        <Notice>
          This app returns to your own computer. Any program running on it can receive this
          connection, so only allow it if you just started the connection from an app you trust.
        </Notice>
      )}
      <div className="flex flex-wrap gap-3">
        <Button aria-disabled={busy} onClick={() => void decide(true)}>
          Allow
        </Button>
        <Button variant="outline" aria-disabled={busy} onClick={() => void decide(false)}>
          Cancel
        </Button>
      </div>
      <a
        className="text-muted-foreground text-sm underline underline-offset-4"
        href={`/connect?${oauthQuery}`}
      >
        Use a different key
      </a>
    </Shell>
  );
}
