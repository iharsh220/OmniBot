import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import api from './server/app.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

const DASH_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://kick.com; media-src 'self' https: data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests";
const WIDGET_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; media-src 'self' https: data:; object-src 'none'; base-uri 'none'";

function setPageHeaders(res, csp, frame = 'DENY') {
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Frame-Options', frame);
  res.setHeader('Cache-Control', 'no-store');
}

const app = express();
app.set('trust proxy', true);
app.use(api);
app.get(['/', '/index.html'], (_req, res) => { setPageHeaders(res, DASH_CSP); res.sendFile(path.join(PUBLIC, 'index.html')); });
app.get('/login', (_req, res) => { setPageHeaders(res, DASH_CSP); res.sendFile(path.join(PUBLIC, 'login.html')); });
app.get(['/w/:id', '/demo', '/widget.html'], (_req, res) => { setPageHeaders(res, WIDGET_CSP, 'SAMEORIGIN'); res.sendFile(path.join(PUBLIC, 'widget.html')); });
app.use(express.static(PUBLIC, { extensions: ['html'], index: false }));
app.use((_req, res) => res.status(404).send('Not found'));

export default app;