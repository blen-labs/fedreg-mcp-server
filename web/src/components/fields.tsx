import type * as React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** A labeled input with optional help text. */
export function Field({
  id,
  label,
  help,
  ...props
}: React.ComponentProps<typeof Input> & {
  id: string;
  label: React.ReactNode;
  help?: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} aria-describedby={help ? `${id}-help` : undefined} {...props} />
      {help && (
        <p id={`${id}-help`} className="text-muted-foreground text-xs">
          {help}
        </p>
      )}
    </div>
  );
}

/** A link to another site, opened in a new tab. */
function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-4">
      {children}
    </a>
  );
}

/** The regulations.gov API key input used on the key page and the account page. */
export function KeyField({
  label,
  required,
  value,
  onChange,
}: {
  label: string;
  required: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field
      id="apiKey"
      label={label}
      type="password"
      autoComplete="off"
      minLength={40}
      maxLength={40}
      pattern="[A-Za-z0-9]{40}"
      required={required}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      help={
        <>
          Get your free key from{' '}
          <ExternalLink href="https://open.gsa.gov/api/regulationsgov/">regulations.gov API documentation</ExternalLink>.
          Paste only the key here. Saving runs one small regulations.gov request to check it.
        </>
      }
    />
  );
}
