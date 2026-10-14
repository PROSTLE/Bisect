import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import type { Db } from './db/index.js';
import { authenticate } from './lib/auth.js';
import { errorHandler } from './lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { recordRoutes } from './routes/records.js';
import { streamRoutes } from './routes/stream.js';
import { warroomRoutes } from './routes/warroom.js';
import { webhookRoutes } from './routes/webhooks.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // React inline style attributes + Google Fonts CSS
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const securityHeaders: express.RequestHandler = (_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
};

export function createApp(db: Db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders);

  // Webhooks need the raw body for HMAC verification, so they are mounted before the JSON parser.
  app.use('/api', webhookRoutes(db));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', authenticate(db));

  app.get('/api/health', async (_req, res) => {
    await db.query('SELECT 1');
    res.json({ ok: true, database: db.kind });
  });
  app.use('/api', authRoutes(db), projectRoutes(db), recordRoutes(db), warroomRoutes(db), streamRoutes());
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'No such API route' } });
  });

  // In production the API also serves the built React app. Hashed assets are immutable; everything
  // else (index.html, icons) is revalidated so a deploy is picked up immediately.
  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    app.use(
      express.static(config.webDist, {
        index: false,
        setHeaders: (res, file) =>
          res.setHeader('Cache-Control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache'),
      }),
    );
    app.get('/{*splat}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(config.webDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
