import { Router } from 'express';
import { requireRole } from '../lib/auth.js';
import { bus } from '../lib/bus.js';

/** Server-Sent Events: one-way push is all the UI needs, and it works through any HTTP proxy. */
export function streamRoutes() {
  const r = Router();
  r.get('/stream', requireRole('viewer'), (req, res) => {
    const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : null;
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const unsubscribe = bus.subscribe((msg) => {
      if (projectId && msg.projectId !== projectId) return;
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
  return r;
}
