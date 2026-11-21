import { defineRailway, github, project, service } from 'railway/iac';
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = 'fedreg-mcp-server';
export default defineRailway(() => {
  // One instance: per-client quotas, execution caps and caches are in-process, and the
  // regulations.gov key's hourly budget is shared by every caller (see deploy/railway.toml).
  const fedregMcpServer = service('fedreg-mcp-server', {
    // Railway builds and deploys main from GitHub.
    source: github('blen-labs/fedreg-mcp-server', { branch: 'main' }),
    build: { buildEnvironment: 'V3', builder: 'DOCKERFILE', dockerfilePath: 'deploy/Dockerfile' },
    healthcheck: '/health',
    healthcheckTimeout: 30,
    // Restart policy: Railway's default (on failure, 10 retries), which it stores as unset.
    deploy: { startCommand: 'node dist/bin.js --http', overlapSeconds: 0, drainingSeconds: 15 },
    replicas: { 'us-east4-eqdc4a': 1 },
    domains: ['fedreg.mcp.blenlabs.com'],
  });

  return project('fedreg-mcp-server', {
    // Secrets stay set in Railway. Without this, IaC would manage every service variable.
    // @ts-expect-error -- the railway 3.17.0 types lack project `variables`; the CLI reads it.
    variables: { managed: false },
    resources: [fedregMcpServer],
  });
});
