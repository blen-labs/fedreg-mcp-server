import { ExternalLink, Field } from '@/components/kit/field';

/** The regulations.gov API key input used on the key page and the account page. */
export function KeyField({
  label,
  required,
  value,
  onChange,
  error,
}: {
  label: string;
  required: boolean;
  value: string;
  onChange: (value: string) => void;
  /** Why the last save failed, read with the field. */
  error?: string;
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
      title="40 letters and digits"
      required={required}
      error={error}
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
