'use strict';

// Avvia solo il servizio Polipo (senza finestra): l'interfaccia si apre nel browser.
//   npm run server        ->  http://127.0.0.1:5723/

const path = require('path');
const { startServer } = require('../src/server');

(async () => {
  const dataDir = process.env.POLIPO_DATA || path.join(__dirname, '..', 'data');
  const srv = await startServer({ dataDir, port: Number(process.env.PORT) || 5723 });
  console.log(`Polipo in esecuzione su ${srv.url}  (dati in ${dataDir})`);
  const stop = async () => {
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
