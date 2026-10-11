// Le campagne WhatsApp: consensi, segmenti, invio, rotte.
export { recordMarketingConsent, isStopMessage, registerStopHook, STOP_PAYLOAD, type ConsentSource } from './consent.js';
export { normalizeSegment, segmentRecipients, type CampaignSegment } from './segments.js';
export { campaignUnitCostCents, estimateCostCents } from './pricing.js';
export { configureCampaigns, campaignsTick, CAMPAIGN_KIND, type CampaignDeps } from './send.js';
export { createCampaignsRouter } from './routes.js';
