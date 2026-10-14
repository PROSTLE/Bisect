import { bus } from './bus.js';

interface Viewer {
  id: string;
  name: string;
  expires: number;
}

/**
 * Who is looking at which incident right now. Clients send a heartbeat every ~20s while an incident
 * page is open; entries expire after 45s without one. In-memory, like the event bus — fine for a
 * single API instance (see README limitations).
 */
const TTL_MS = 45_000;
const byIncident = new Map<string, { projectId: string; viewers: Map<string, Viewer> }>();

function snapshot(incidentId: string) {
  const entry = byIncident.get(incidentId);
  return entry ? [...entry.viewers.values()].map(({ id, name }) => ({ id, name })) : [];
}

function changed(incidentId: string, projectId: string) {
  bus.publish('presence', projectId, { incident_id: incidentId, viewers: snapshot(incidentId) });
}

export const presence = {
  heartbeat(incidentId: string, projectId: string, user: { id: string; name: string }) {
    let entry = byIncident.get(incidentId);
    if (!entry) byIncident.set(incidentId, (entry = { projectId, viewers: new Map() }));
    const isNew = !entry.viewers.has(user.id);
    entry.viewers.set(user.id, { id: user.id, name: user.name, expires: Date.now() + TTL_MS });
    if (isNew) changed(incidentId, projectId);
  },
  leave(incidentId: string, userId: string) {
    const entry = byIncident.get(incidentId);
    if (entry?.viewers.delete(userId)) changed(incidentId, entry.projectId);
  },
  forProject(projectId: string): Record<string, { id: string; name: string }[]> {
    const out: Record<string, { id: string; name: string }[]> = {};
    for (const [incidentId, entry] of byIncident) {
      if (entry.projectId === projectId && entry.viewers.size) out[incidentId] = snapshot(incidentId);
    }
    return out;
  },
  sweep(now = Date.now()) {
    for (const [incidentId, entry] of byIncident) {
      let removed = false;
      for (const [uid, v] of entry.viewers) {
        if (v.expires < now) {
          entry.viewers.delete(uid);
          removed = true;
        }
      }
      if (removed) changed(incidentId, entry.projectId);
      if (entry.viewers.size === 0) byIncident.delete(incidentId);
    }
  },
};

setInterval(() => presence.sweep(), 15_000).unref();
