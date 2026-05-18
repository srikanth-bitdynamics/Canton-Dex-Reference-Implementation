// Production server entry point. Identical to testnet-server.ts —
// reads Canton ledger config from env, attaches the SQLite indexer,
// installs graceful shutdown, and structured JSON logging.
//
// Kept separate so deployments can pin a canonical filename
// (`prod-server.ts`) and so dev/testnet/prod entry points can diverge
// in the future without breaking docker-compose / start scripts.

import "./testnet-server.js";
