import { defineRailway, github, project, service } from 'railway/iac';
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = 'fedreg-mcp-server';
export default defineRailway(() => {
  // One instance: the per-client quotas, execution caps, token buckets and caches are in-process, and
  // the regulations.gov key's hourly budget is shared by every caller, so a second replica would
  // double the effective rate against the same upstream key and split the quota accounting.
  // Railway activates a new deployment before it sends SIGTERM to the old one, so deploys overlap
  // briefly however this is set; overlapSeconds 0 keeps that as short as possible. On SIGTERM the
  // server cancels running executions and in-flight upstream calls at once, so 15 s of draining is
  // ample before SIGKILL. Railway routes the public URL to the PORT it injects (bin defaults to 8080).
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
    // @ts-expect-error -- the railway 3.18.0 types lack project `variables`; the CLI reads it.
    variables: { managed: false },
    resources: [fedregMcpServer],
  });
});
