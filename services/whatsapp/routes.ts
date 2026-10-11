// Le rotte del modulo WhatsApp, montate su /whatsapp: quello che serve alla
// sezione Impostazioni › WhatsApp. Le rotte dell'inbox e dell'agente
// (/messages/*) restano in server.ts finché le fasi dell'agente non le
// spostano qui.

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { authenticate, requirePermission } from '../../auth/authMiddleware.js';
import { isFeatureEnabledForTenant } from '../entitlements.js';
import { envTenantIds, getSender, isSmsReady } from './config.js';
import { tenantWebhookToken } from './callbacks.js';
import { templateStatus } from './templates/status.js';
import { whatsappUsage } from './usage.js';

// L'add-on WhatsApp, chiuso se non si riesce a leggerlo: queste rotte
// mostrano numeri e costi di un canale che il locale potrebbe non avere.
const requireWhatsApp = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (await isFeatureEnabledForTenant(req.tenantId!, 'whatsapp')) return next();
    } catch (err: any) {
        console.error('[whatsapp] lettura add-on fallita:', err?.message || err);
    }
    res.status(403).json({ error: 'feature_not_enabled', feature: 'whatsapp' });
};

export function createWhatsAppRouter(): express.Router {
    const router = express.Router();
    const read = [authenticate, requirePermission('settings:view'), requireWhatsApp];

    /** Il numero del ristorante: chi lo gestisce, se manda, dove arrivano i webhook. */
    router.get('/status', ...read, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const sender = await getSender(tenantId);
            const token = await tenantWebhookToken(tenantId);
            // Come /settings/webhook-info: dietro il proxy l'host della
            // richiesta è il dominio del backend che i provider chiamano.
            const base = `${req.protocol}://${req.get('host')}`;
            res.json({
                connected: sender != null,
                provider: sender?.provider ?? null,
                source: sender?.source ?? null,
                phone: sender ? sender.from.replace(/^whatsapp:/, '') : null,
                shared_env_sender: envTenantIds().has(tenantId),
                sms_ready: isSmsReady(tenantId),
                webhooks: token ? {
                    inbound: `${base}/webhook/t/${token}/twilio-whatsapp`,
                    status: `${base}/webhook/t/${token}/twilio-whatsapp-status`,
                } : null,
            });
        } catch (err: any) {
            console.error('GET /whatsapp/status error:', err);
            res.status(500).json({ error: 'Errore nel leggere lo stato di WhatsApp' });
        }
    });

    /** Il catalogo dei template con lo stato di approvazione. */
    router.get('/templates', ...read, async (req, res) => {
        try {
            res.json({ templates: await templateStatus(req.tenantId!) });
        } catch (err: any) {
            console.error('GET /whatsapp/templates error:', err);
            res.status(500).json({ error: 'Errore nel leggere i template' });
        }
    });

    /** Messaggi e spesa AI del mese. */
    router.get('/usage', ...read, async (req, res) => {
        try {
            res.json(await whatsappUsage(req.tenantId!));
        } catch (err: any) {
            console.error('GET /whatsapp/usage error:', err);
            res.status(500).json({ error: 'Errore nel leggere i consumi' });
        }
    });

    return router;
}
