// Il lato CLOUD dello stream inverso (tappa 4 ibrido, fase 4a): quando un
// nodo di sala è agganciato al bridge, il cloud CONSUMA i suoi eventi
// locali — pull con cursore via RPC `node:pull` sullo stesso socket,
// righe correnti via `node:rows`, applicazione con l'inbox transazionale
// condiviso (replicaApply). Il cursore vive in replication_cursor con
// stream='node'; l'import (origin='replica') fa partire i broadcast dai
// handler del dispatcher, così i client del cloud (back-office, dispositivi
// fuori dalla LAN) vedono in tempo quasi-reale ciò che nasce in sala.
//
// Il polling è volutamente semplice (ogni pochi secondi finché il nodo è
// connesso): il volume di un servizio è qualche migliaio di eventi, e il
// recupero dopo un outage è lo stesso giro con più batch.

import type { Socket } from 'socket.io';
import pool, { runAsPlatform } from '../db.js';
import { applyReplicaBatch, type ReplicaEvent, type WantedRows, type FetchedRows } from './replicaApply.js';

const PULL_LIMIT = 500;
const POLL_MS = Math.max(500, Number(process.env.SALA_NODE_UPSTREAM_POLL_MS) || 3_000);
const RPC_TIMEOUT_MS = 10_000;

const rpc = async (socket: Socket, event: string, payload: any): Promise<any> => {
    const res = await socket.timeout(RPC_TIMEOUT_MS).emitWithAck(event, payload);
    if (res?.error) throw new Error(`${event}: ${res.error}`);
    return res;
};

/** Consuma lo stream del nodo finché il socket vive. Ritorna lo stop,
 *  chiamato dal bridge alla disconnessione. */
export const startNodeUpstream = (tenantId: number, socket: Socket): (() => void) => {
    let running = false;
    let stopped = false;
    let lastErrorLogged = 0;

    const pullOnce = async (): Promise<boolean> => runAsPlatform(async () => {
        const cur = await pool.query(
            `SELECT applied_seq FROM replication_cursor WHERE tenant_id = $1 AND stream = 'node'`,
            [tenantId]
        );
        const after = Number(cur.rows[0]?.applied_seq ?? 0);
        const body = await rpc(socket, 'node:pull', { after, limit: PULL_LIMIT });
        const events: ReplicaEvent[] = Array.isArray(body?.events) ? body.events : [];
        if (events.length === 0) return false;
        await applyReplicaBatch({
            tenantId,
            events,
            cursorStream: 'node',
            fetchRows: (wanted: WantedRows): Promise<FetchedRows> => rpc(socket, 'node:rows', wanted),
        });
        console.log(`[upstream] applicati ${events.length} eventi del nodo (tenant ${tenantId}), cursore a ${events[events.length - 1].seq}`);
        return true;
    });

    const drain = async () => {
        if (running || stopped || !socket.connected) return;
        running = true;
        try {
            while (!stopped && await pullOnce()) { /* si drena a batch pieni */ }
        } catch (err: any) {
            if (Date.now() - lastErrorLogged > 60_000) {
                lastErrorLogged = Date.now();
                console.warn(`[upstream] giro fallito per il tenant ${tenantId} (si riprova):`, err?.message || err);
            }
        } finally {
            running = false;
        }
    };

    const timer = setInterval(() => void drain(), POLL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    void drain();

    return () => {
        stopped = true;
        clearInterval(timer);
    };
};
