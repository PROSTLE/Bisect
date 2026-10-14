import { EventEmitter } from 'node:events';

export interface BusMessage {
  type: string; // event.recorded | incident.updated | incident.comment | incident.suspect | project.updated
  projectId: string;
  data: Record<string, unknown>;
  at: string;
}

/**
 * In-process pub/sub feeding the SSE stream.
 * Single-instance only: running several API replicas would need Postgres LISTEN/NOTIFY or Redis here.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export const bus = {
  publish(type: string, projectId: string, data: Record<string, unknown>) {
    emitter.emit('message', { type, projectId, data, at: new Date().toISOString() } satisfies BusMessage);
  },
  subscribe(fn: (msg: BusMessage) => void): () => void {
    emitter.on('message', fn);
    return () => emitter.off('message', fn);
  },
};
