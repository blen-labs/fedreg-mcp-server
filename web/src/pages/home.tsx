import { useEffect, useState } from 'react';
import { Landing } from '@/components/kit/landing';
import { api, type Config } from '@/lib/api';

export function Home() {
  const [config, setConfig] = useState<Config>();
  useEffect(() => {
    api<Config>('/config').then(setConfig, () => undefined);
  }, []);
  return (
    <Landing
      accountUrl={config?.mcpUrl ?? `${window.location.origin}/mcp/account`}
      publicUrl={config?.publicMcpUrl ?? `${window.location.origin}/mcp`}
    />
  );
}
