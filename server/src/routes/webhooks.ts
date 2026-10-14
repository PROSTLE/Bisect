import crypto from 'node:crypto';
import express, { Router } from 'express';
import type { Db } from '../db/index.js';
import { safeEqual } from '../lib/auth.js';
import { HttpError } from '../lib/errors.js';
import { ingestEvents } from '../services/ingest.js';
import { loadProject } from './projects.js';

export function verifyGithubSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  return safeEqual(header, expected);
}

/**
 * Translate GitHub webhook payloads into our generic ingestion events.
 * Commits dedup by SHA (the same commit pushed to several branches is recorded once), deployment
 * statuses by their GitHub id. Each deployment_status also carries the deployment's sha/ref/env, so
 * a missed `deployment` delivery still produces a usable record.
 */
export function githubToEvents(event: string, payload: any, deliveryId?: string): Record<string, unknown>[] {
  switch (event) {
    case 'push': {
      if (payload.deleted) return [];
      const branch = typeof payload.ref === 'string' ? payload.ref.replace(/^refs\/heads\//, '') : undefined;
      return (payload.commits ?? []).map((c: any) => ({
        type: 'change',
        event_id: `gh-commit-${c.id}`,
        sha: c.id,
        message: c.message,
        author: c.author?.username ?? c.author?.name,
        url: c.url,
        branch,
        files: [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])],
        occurred_at: c.timestamp,
      }));
    }
    case 'deployment': {
      const d = payload.deployment;
      if (!d) return [];
      return [
        {
          type: 'deployment',
          event_id: `gh-deployment-${d.id}`,
          deployment_id: `gh-${d.id}`,
          status: 'pending',
          commit_sha: d.sha,
          version: d.ref,
          environment: d.environment,
          deployed_by: d.creator?.login,
          notes: d.description ?? undefined,
          occurred_at: d.created_at,
        },
      ];
    }
    case 'deployment_status': {
      const s = payload.deployment_status;
      const d = payload.deployment;
      if (!s || !d) return [];
      const map: Record<string, string> = {
        pending: 'pending',
        queued: 'pending',
        in_progress: 'in_progress',
        success: 'succeeded',
        failure: 'failed',
        error: 'failed',
      };
      const status = map[s.state];
      if (!status) return []; // "inactive" = superseded by a newer deployment; not a state change for us
      return [
        {
          type: 'deployment',
          event_id: `gh-deployment-status-${s.id ?? deliveryId}`,
          deployment_id: `gh-${d.id}`,
          status,
          commit_sha: d.sha,
          version: d.ref,
          environment: s.environment ?? d.environment,
          url: s.target_url || s.log_url || undefined,
          deployed_by: d.creator?.login,
          occurred_at: s.updated_at ?? s.created_at,
        },
      ];
    }
    default:
      return [];
  }
}

export function webhookRoutes(db: Db) {
  const r = Router();
  r.post('/webhooks/github/:projectId', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
    const project = await loadProject(db, req.params.projectId);
    if (project.archived_at) throw new HttpError(409, 'archived', 'Project is archived');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!verifyGithubSignature(project.webhook_secret, body, req.get('x-hub-signature-256'))) {
      throw new HttpError(401, 'bad_signature', 'Webhook signature verification failed');
    }
    const event = req.get('x-github-event') ?? '';
    if (event === 'ping') {
      res.json({ ok: true, message: 'pong' });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'bad_json', 'Payload is not JSON (set the webhook content type to application/json)');
    }
    const events = githubToEvents(event, payload, req.get('x-github-delivery'));
    if (events.length === 0) {
      res.status(202).json({ ok: true, ignored: event });
      return;
    }
    const results = await ingestEvents(db, { projectId: project.id, source: 'github', actor: { user: null, label: 'github webhook' } }, events);
    res.json({ ok: true, event, results });
  });
  return r;
}
