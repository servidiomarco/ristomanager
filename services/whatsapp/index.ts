// Il modulo WhatsApp: chi manda per quale ristorante, cosa arriva dai
// webhook, quali template. server.ts importa da qui.

export { configureWhatsApp, type WhatsAppDeps } from './deps.js';
export {
    envTenantIds, getSender, isWhatsAppReady, getSmsSender, isSmsReady,
    backendBaseUrl, twilioWebhookAuthToken,
} from './config.js';
export { statusCallbackUrl } from './callbacks.js';
export { sendWhatsAppText, sendTwilioSms, logOutboundMessage } from './outbound.js';
export {
    processInbound, onInbound, logInboundMessage, resolveReservationByPhone, describeInboundMedia,
    type InboundHook,
} from './inbound.js';
export { handleTwilioWhatsAppInbound, validateTwilioSignature } from './webhooks.js';
export { pickTemplate, type PickedTemplate } from './templates/registry.js';
export { TEMPLATE_CATALOG, templateEnvKey, type TemplateDef } from './templates/catalog.js';
export { twilioMediaAuthHeader, parseTwilioInbound, twilioSignature } from './providers/twilio.js';
export type {
    WhatsAppSender, TwilioSender, OutboundConfirmationResult, WhatsAppTemplateOpts, InboundMessage,
} from './types.js';
export { createWhatsAppRouter } from './routes.js';
export { isWindowOpen, lastInboundAt, WINDOW_MS } from './window.js';
export { configureReservationButtons, type ReservationButtonDeps } from './buttons.js';
export { publicWhatsAppLink, waMeUrl } from './entry.js';
export { getRemindersPolicy } from './settings.js';
export {
    configureWhatsAppMedia, fetchInboundMedia, MediaFetchError, agentMessageBody, photosForAgent,
    isTranscriptionConfigured, type AgentImage,
} from './media/index.js';
export { getMediaPolicy } from './settings.js';
export { notifyTakeawayReady } from './takeawayReady.js';
export { getTakeawayPolicy } from './settings.js';
export {
    recordMarketingConsent, registerStopHook, configureCampaigns, campaignsTick, type ConsentSource,
} from './campaigns/index.js';
export { handleMetaWebhook, handleMetaWebhookVerify } from './webhooks.js';
export { invalidateSenderCache, metaGraphBase } from './config.js';
