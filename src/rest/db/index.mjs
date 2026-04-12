// db/index.mjs — Database provider registry
//
// Auto-detects the provider from config, or use config.provider explicitly.
// To add a new database backend:
//   1. Create src/rest/db/mydb.mjs exporting createMyDbProvider(config)
//   2. Add a case here
//   3. See interface.mjs for the contract

import { createPostgresProvider } from './postgres.mjs';
import { createDsqlProvider } from './dsql.mjs';

export function createDb(config) {
  // Explicit provider selection
  if (config.provider === 'dsql') return createDsqlProvider(config);
  if (config.provider === 'postgres') return createPostgresProvider(config);

  // Auto-detect from config shape
  if (config.dsqlEndpoint) return createDsqlProvider(config);
  return createPostgresProvider(config);
}
