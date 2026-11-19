// Local development server: `npm run dev` → http://localhost:3002
// Same Express app as on Netlify, plus static files from public/. Data goes to data/store.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const PORT = Number(process.env.PORT) || 3002;
// Locally, login must come back to localhost (the .env may hold the Netlify URL).
process.env.APP_URL = process.env.LOCAL_APP_URL || `http://localhost:${PORT}`;
process.env.DATA_DIR ||= path.join(ROOT, 'data');
// Local-only secret if none is set (on Netlify APP_SECRET is required).
if (!process.env.APP_SECRET) {
  const f = path.join(process.env.DATA_DIR, 'secret.key');
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  process.env.APP_SECRET = fs.readFileSync(f, 'utf8').trim();
}

const { default: express } = await import('express');
const { default: api } = await import('./app.js');

const PUBLIC = path.join(ROOT, 'public');
const server = express();
server.use(api);
// Same rewrites as netlify.toml
server.get('/login', (_req, res) => res.sendFile(path.join(PUBLIC, 'login.html')));
server.get(['/w/:id', '/demo'], (_req, res) => res.sendFile(path.join(PUBLIC, 'widget.html')));
server.use(express.static(PUBLIC, { extensions: ['html'], index: 'index.html' }));
server.use((_req, res) => res.status(404).send('Not found'));

server.listen(PORT, () => {
  console.log(`\n  OmniChat (local) → ${process.env.APP_URL}`);
  console.log(`  Data            → ${path.join(process.env.DATA_DIR, 'store.json')}\n`);
});
