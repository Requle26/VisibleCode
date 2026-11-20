import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { app, listen, server } from '../backend/server/index.mjs';

const vite = await createServer({
  root: fileURLToPath(new URL('./', import.meta.url)),
  mode: 'local-dev',
  server: { middlewareMode: true, hmr: { server } },
  appType: 'spa',
});

app.use(vite.middlewares);
listen(Number(process.env.PORT ?? 5180));
