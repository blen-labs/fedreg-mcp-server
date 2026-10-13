import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { KeyField } from '@/components/fields';
import { Loading, Notice, Shell } from '@/components/shell';
import { SignedInAs } from '@/components/signed-in-as';
import { api, type Keys } from '@/lib/api';
import { useLoad } from '@/lib/use-load';

function KeyCard({
  title,
  description,
  connected,
  editable,
  onChanged,
}: {
  title: string;
  description: string;
  connected: boolean;
  editable: boolean;
  onChanged: (notice: string) => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  /** Runs a change; the server's warning, if any, replaces the success notice. */
  async function run(action: () => Promise<{ warning?: string }>, notice: string) {
    setBusy(true);
    setError(undefined);
    try {
      const result = await action();
      setApiKey('');
      onChanged(result.warning ?? notice);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {title}
          <Badge variant={connected ? 'default' : 'outline'}>
            {connected ? 'Key saved' : 'No key'}
          </Badge>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {editable && (
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api('/keys', { apiKey }), 'Key saved. regulations.gov accepted it.');
            }}
          >
            {error && <Notice>{error}</Notice>}
            <KeyField
              label={connected ? 'Replace key' : 'regulations.gov API key'}
              required
              value={apiKey}
              onChange={setApiKey}
            />
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={busy}>
                Check and save
              </Button>
              {connected && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => api('/keys/delete', {}),
                      'Key removed. Federal Register and eCFR remain available.',
                    )
                  }
                >
                  Remove key
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      )}
    </Card>
  );
}

export function Account() {
  const { data, error, reload } = useLoad(() => api<Keys>('/account'), '/account');
  const [notice, setNotice] = useState<string>();
  if (error)
    return (
      <Shell title="Your account">
        <Notice>{error}</Notice>
      </Shell>
    );
  if (!data) return <Loading />;
  return (
    <Shell
      wide
      title="Your account"
      description={<SignedInAs email={data.email} returnTo="/" />}
    >
      {notice && <Notice kind="success">{notice}</Notice>}
      <KeyCard
        title="Personal key"
        description="Used by your regulations.gov connections. It is never displayed again."
        connected={data.personal.connected}
        editable
        onChanged={(message) => {
          setNotice(message);
          reload();
        }}
      />
    </Shell>
  );
}
