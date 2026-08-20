// Entitlements commerciali (Fase C1) — letture di tenant_features.
//
// Modulo condiviso fra server.ts (middleware requireFeature, webhook senza
// JWT) e auth/authRoutes.ts (login e /auth/me espongono le feature al
// frontend): vive in services/ perché importarlo da server.ts creerebbe un
// ciclo con auth/.
//
// È il livello commerciale SOPRA i flag operativi di app_settings
// (voice_agent_enabled, public_bookings_enabled…): quelli dicono se il
// ristoratore ha acceso il canale, l'entitlement dice se il canale gli è
// stato venduto. Feature assente a DB = non venduta = spenta.
import { queryWithRetry } from '../db.js';

export const TENANT_FEATURES = ['voice', 'whatsapp', 'web_booking', 'pay_at_table'] as const;
export type TenantFeature = (typeof TENANT_FEATURES)[number];
export type TenantFeatureMap = Record<TenantFeature, boolean>;

const ALL_DISABLED: TenantFeatureMap = { voice: false, whatsapp: false, web_booking: false, pay_at_table: false };

// Cache per tenant con TTL breve, stesso schema di identityCache
// (businessIdentity in server.ts): gli entitlement si leggono su ogni
// richiesta dei canali (webhook voce/WhatsApp inclusi) e cambiano di rado —
// un giro a DB per richiesta sarebbe solo latenza. 60s è il ritardo massimo
// con cui un toggle fatto da un ALTRO processo diventa visibile; il PUT
// locale invalida subito (invalidateTenantFeaturesCache).
const featuresCache = new Map<number, { features: TenantFeatureMap; refreshedAt: number }>();
const FEATURES_TTL_MS = 60_000;

export async function getTenantFeatures(tenantId: number): Promise<TenantFeatureMap> {
    const cached = featuresCache.get(tenantId);
    if (cached && Date.now() - cached.refreshedAt <= FEATURES_TTL_MS) {
        return cached.features;
    }
    try {
        const result = await queryWithRetry(
            'SELECT feature, enabled FROM tenant_features WHERE tenant_id = $1',
            [tenantId]
        );
        const features: TenantFeatureMap = { ...ALL_DISABLED };
        for (const row of result.rows) {
            if ((TENANT_FEATURES as readonly string[]).includes(row.feature)) {
                features[row.feature as TenantFeature] = Boolean(row.enabled);
            }
        }
        featuresCache.set(tenantId, { features, refreshedAt: Date.now() });
        return features;
    } catch (err) {
        // Stale-if-error: un blip del DB non deve spegnere i canali del
        // ristorante in servizio. Senza nemmeno una copia in cache si chiude
        // (tutto spento): meglio negare un add-on che regalarlo.
        console.error('[entitlements] lettura tenant_features fallita:', (err as any)?.message || err);
        return cached ? cached.features : { ...ALL_DISABLED };
    }
}

export async function isFeatureEnabledForTenant(tenantId: number, feature: TenantFeature): Promise<boolean> {
    return (await getTenantFeatures(tenantId))[feature];
}

// Da chiamare dopo ogni scrittura su tenant_features: il processo che ha
// fatto il PUT deve vedere subito il nuovo stato, senza aspettare il TTL.
export function invalidateTenantFeaturesCache(tenantId: number): void {
    featuresCache.delete(tenantId);
}
