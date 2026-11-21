// better-auth lists test tooling and UI frameworks as OPTIONAL peers. Our dev dependencies
// (vitest, react, react-dom for the portal build) would satisfy them, which pnpm then records in
// better-auth's production dependency graph, so `--prod` installs (MCPB bundle, Docker image)
// would ship Vitest, Vite and React. The server needs none of them at runtime.
const DROP = ['vitest', 'react', 'react-dom'];

module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === 'better-auth') {
        for (const name of DROP) {
          if (pkg.peerDependencies) delete pkg.peerDependencies[name];
          if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[name];
        }
      }
      return pkg;
    },
  },
};
