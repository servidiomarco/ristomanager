// Il cane da guardia dell'uplink (lato CLOUD) — lezione del 23/09: il
// socket del nodo è rimasto muto 90 minuti e nessuno se n'è accorto finché
// il titolare non ha aperto la card per caso. Con l'ibrido acceso, un nodo
// che non si fa vivo è un incidente in incubazione: qui lo si dice a chi
// comanda, con una push, senza aspettare che qualcuno guardi.
//
// La regola: per ogni tenant con la modalità ibrida accesa, se il nodo non
// batte da oltre la soglia (5 minuti — copre anche il caso «istanza appena
// deployata e il nodo non si è mai presentato», che è esattamente com'è
// passata inosservata l'assenza di oggi) parte UNA push per serie di
// silenzio a OWNER/GENERAL_MANAGER; al rientro, una push di sollievo. Mai
// pioggia: l'allarme si riarma solo dopo un rientro.

import { queryWithRetry, runAsPlatform, runWithTenantContext } from '../db.js';
import { getSalaNodeStatus } from './salaNodeBridge.js';
import { sendToRoles } from './pushService.js';
import { isServiceNode } from './topology.js';

const TICK_MS = 60_000;
const SILENCE_MS = Math.max(60_000, Number(process.env.SALA_NODE_ALARM_AFTER_MS) || 5 * 60_000);

// Stato per tenant: da quando lo consideriamo muto, e se abbiamo già
// suonato. In memoria: a ogni deploy si riparte dall'osservazione, non
// dalla storia — è il comportamento giusto per un allarme.
const silenceSince = new Map<number, number>();
const alarmed = new Set<number>();

const tick = async (): Promise<void> => runAsPlatform(async () => {
    // I tenant con l'ibrido acceso: flag operativo E add-on venduto.
    const rows = await queryWithRetry(
        `SELECT s.tenant_id
         FROM app_settings s
         JOIN tenant_features f ON f.tenant_id = s.tenant_id AND f.feature = 'sala_node' AND f.enabled
         JOIN tenants t ON t.id = s.tenant_id AND t.status = 'active'
         WHERE s.key = 'sala_node_enabled' AND s.value = true`,
        []
    ).catch(() => ({ rows: [] as any[] }));
    const now = Date.now();
    for (const row of rows.rows) {
        const tenantId = Number(row.tenant_id);
        const status = getSalaNodeStatus(tenantId);
        if (status.online) {
            if (alarmed.has(tenantId)) {
                alarmed.delete(tenantId);
                console.log(`[node-watchdog] nodo del tenant ${tenantId} rientrato`);
                await runWithTenantContext(tenantId, () => sendToRoles(tenantId, ['OWNER', 'GENERAL_MANAGER'], {
                    category: 'service',
                    title: 'Nodo di sala rientrato',
                    body: 'L’uplink del nodo è tornato: repliche in riallineamento.',
                    url: '/?view=SETTINGS',
                    tag: 'sala-node-uplink',
                })).catch(() => { /* push best-effort */ });
            }
            silenceSince.delete(tenantId);
            continue;
        }
        if (!silenceSince.has(tenantId)) silenceSince.set(tenantId, now);
        const muteFor = now - (silenceSince.get(tenantId) ?? now);
        if (muteFor >= SILENCE_MS && !alarmed.has(tenantId)) {
            alarmed.add(tenantId);
            const minuti = Math.round(muteFor / 60_000);
            console.warn(`[node-watchdog] nodo del tenant ${tenantId} muto da ${minuti} min: allarme`);
            await runWithTenantContext(tenantId, () => sendToRoles(tenantId, ['OWNER', 'GENERAL_MANAGER'], {
                category: 'service',
                title: 'Nodo di sala non si fa vivo',
                body: `L’uplink del nodo tace da ${minuti} minuti: gli schermi lavorano dal cloud. Controllare il PC di sala.`,
                url: '/?view=SETTINGS',
                tag: 'sala-node-uplink',
            })).catch(() => { /* push best-effort */ });
        }
    }
});

export const startSalaNodeWatchdog = (): void => {
    if (isServiceNode) return; // il cane abita sul cloud
    const timer = setInterval(() => void tick().catch(err =>
        console.error('[node-watchdog] tick fallito:', (err as any)?.message || err)), TICK_MS);
    if (typeof timer.unref === 'function') timer.unref();
};
