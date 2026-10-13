import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Notice, Shell } from '@/components/shell';
import { authClient } from '@/lib/auth';
import { useFlow } from '@/lib/flow';

export function SignIn() {
  const { oauthQuery, next, keep } = useFlow();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function google() {
    setBusy(true);
    setError(undefined);
    try {
      const { error } = await authClient.signIn.social({
        provider: 'google',
        errorCallbackURL: `/sign-in${keep}`,
        ...(oauthQuery ? {} : { callbackURL: next }),
      });
      if (!error) return;
    } catch { /* A failed network request keeps the form usable. */ }
    setBusy(false);
    setError('Google sign-in could not start. Try again.');
  }
  return (
    <Shell
      title={oauthQuery ? 'Sign in to connect' : 'Your account'}
      description={oauthQuery ? 'Sign in to connect your AI assistant to Federal Register MCP.' : 'Sign in to manage your regulations.gov API key.'}
    >
      {error && <Notice>{error}</Notice>}
      <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={google}>
        Continue with Google
      </Button>
    </Shell>
  );
}
