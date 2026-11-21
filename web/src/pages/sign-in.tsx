import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/kit/notice';
import { Shell } from '@/components/kit/shell';
import { authClient } from '@/lib/auth';
import { useFlow } from '@/lib/flow';
import { brand } from '@/brand';
import { errorMessage } from '@/components/kit/error-page';

export function SignIn() {
  const { oauthQuery, next, keep } = useFlow();
  // A failed Google sign-in returns here with ?error=<code>; the pending connection is kept.
  const [error, setError] = useState<string | undefined>(() => {
    const code = new URLSearchParams(window.location.search).get('error');
    return code ? errorMessage(code) : undefined;
  });
  const [busy, setBusy] = useState(false);
  async function google() {
    if (busy) return;
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
      description={oauthQuery ? `Sign in to connect your AI assistant to ${brand.name}.` : `Sign in to ${brand.accountPurpose}.`}
    >
      {error && <Notice>{error}</Notice>}
      <Button type="button" variant="outline" className="w-full" aria-disabled={busy} onClick={() => void google()}>
        Continue with Google
      </Button>
    </Shell>
  );
}
