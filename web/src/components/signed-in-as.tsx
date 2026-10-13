import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth';

/**
 * "Signed in as … · Sign out". `returnTo` is where to go once signed out; during a connection
 * it is the sign-in page with the signed query, so the connection resumes with another account.
 */
export function SignedInAs({ email, returnTo }: { email: string; returnTo: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>
        Signed in as <strong className="text-foreground">{email}</strong>.
      </span>
      <Button
        variant="link"
        className="h-auto p-0"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await authClient.signOut();
          } finally {
            window.location.assign(returnTo);
          }
        }}
      >
        Sign out
      </Button>
    </span>
  );
}
