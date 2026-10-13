import type * as React from 'react';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import blenLogo from '@/assets/blen-logo.png';

// The maker's signature on every page; intentionally fixed, not operator-configurable.
const BLEN_URL = 'https://www.blencorp.com';
const BLEN_CONTACT_URL = 'https://www.blencorp.com/connect';

/** Page frame: product name above one centered card. */
export function Shell({
  title,
  description,
  children,
  wide = false,
}: {
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <main className="flex min-h-svh flex-col items-center gap-6 px-4 py-10 sm:py-16">
      <a href="/" className="text-muted-foreground text-sm font-medium tracking-tight">
        Federal Register MCP
      </a>
      <Card className={wide ? 'w-full max-w-2xl' : 'w-full max-w-md'}>
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
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
  children: React.ReactNode;
}) {
  return (
    <Alert variant={kind === 'error' ? 'destructive' : 'default'}>
      {kind === 'error' ? <CircleAlert /> : <CircleCheck />}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export function Loading() {
  return <Shell title="Loading…" />;
}
