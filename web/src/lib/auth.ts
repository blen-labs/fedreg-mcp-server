import { createAuthClient } from 'better-auth/react';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';

// Same origin as the server. The OAuth plugin attaches the page's signed authorization
// query to auth requests, so signing in resumes the pending connection.
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [oauthProviderClient()],
});
