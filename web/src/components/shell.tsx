import { useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, LogOut } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import blenLogo from '@/assets/blen-logo.png';

// The maker's signature on every page; intentionally fixed, not operator-configurable.
const BLEN_URL = 'https://www.blencorp.com';
const BLEN_CONTACT_URL = 'https://www.blencorp.com/connect';

/** Page frame: product name above one centered card. */
export function Shell({
  title,
  description,
  action,
  children,
  wide = false,
}: {
  title: string;
  description?: ReactNode;
  /** Shown at the top right of the card, such as the sign-out button. */
  action?: ReactNode;
  children?: ReactNode;
  wide?: boolean;
}) {
  return (
    <main className="flex min-h-svh flex-col items-center gap-6 px-4 py-10 sm:py-16">
      <a href="/" className="text-muted-foreground text-sm font-medium tracking-tight">
        Federal Register MCP
      </a>
      <Card className={wide ? 'w-full max-w-2xl' : 'w-full max-w-md'}>
        <CardHeader>
          <CardTitle className="text-xl leading-tight wrap-anywhere">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
          {action && <CardAction>{action}</CardAction>}
        </CardHeader>
        {children && <CardContent className="grid gap-6">{children}</CardContent>}
      </Card>
      <Signature />
    </main>
  );
}

/** "Built by BLEN" with the BLEN logo, a way to reach BLEN, and the service policies. */
function Signature() {
  const link = 'hover:text-foreground underline underline-offset-4';
  return (
    <footer className="text-muted-foreground mt-auto flex flex-wrap items-center justify-center gap-x-3 gap-y-1 pt-4 text-xs">
      <a
        href={BLEN_URL}
        target="_blank"
        rel="noopener"
        className="hover:text-foreground flex items-center gap-2"
      >
        <img src={blenLogo} alt="BLEN" width={40} height={16} className="h-4 w-auto" />
        <span>Built by BLEN</span>
      </a>
      <span aria-hidden="true">·</span>
      <a href={BLEN_CONTACT_URL} target="_blank" rel="noopener" className={link}>
        Contact us
      </a>
      <span aria-hidden="true">·</span>
      <a href="/privacy-policy" className={link}>
        Privacy
      </a>
      <span aria-hidden="true">·</span>
      <a href="/terms" className={link}>
        Terms
      </a>
    </footer>
  );
}

export function Notice({
  kind = 'error',
  children,
}: {
  kind?: 'error' | 'success';
  children: ReactNode;
}) {
  return (
    <Alert variant={kind === 'error' ? 'destructive' : 'default'}>
      {kind === 'error' ? <CircleAlert /> : <CircleCheck />}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/** "Signed in as …" for a card's description. */
export function SignedInAs({ email }: { email: string }) {
  return (
    <>
      Signed in as <strong className="text-foreground wrap-anywhere">{email}</strong>
    </>
  );
}

/**
 * Sign-out button for a card's top right. Inside a connection, `then` is the sign-in page
 * carrying the signed query, so another account can pick the connection back up.
 */
export function SignOut({ then }: { then: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function signOut() {
    setBusy(true);
    setFailed(false);
    try {
      // A plain request, not authClient.signOut(): the auth client attaches the page's signed
      // query, which expires and would then block signing out. Leave only after success, or
      // the person would stay signed in.
      const response = await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (response.ok) return window.location.assign(then);
    } catch {
      // Network failure: fall through and let the person retry.
    }
    setBusy(false);
    setFailed(true);
  }
  return (
    <div className="grid justify-items-end gap-1">
      <Button variant="outline" size="sm" disabled={busy} onClick={signOut}>
        <LogOut />
        Sign out
      </Button>
      {failed && (
        <span role="alert" className="text-destructive max-w-32 text-right text-xs">
          Could not sign out. Try again.
        </span>
      )}
    </div>
  );
}

export function Loading() {
  return <Shell title="Loading…" />;
}
