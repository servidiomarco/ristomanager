// Email dispatcher — either raw SMTP (nodemailer) or Resend's HTTPS API.
// Which one is used is decided by `email_provider` on the integration_settings
// row (defaults to 'smtp' for backward compat). Resend is preferred on
// Railway US-West because outbound port 465/587 to Aruba times out at the
// egress. Config is layered exactly like services/revolutService.ts: DB row
// wins, per-field fallback to env vars.
//
// File is still called smtpService.ts for git-diff clarity; contents cover
// both transports.

import nodemailer, { type Transporter } from 'nodemailer';
import { queryWithRetry } from '../db.js';

export type EmailProvider = 'smtp' | 'resend';

export interface EmailConfig {
    provider: EmailProvider;
    // SMTP transport fields — used only when provider === 'smtp'
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    // Resend transport field — used only when provider === 'resend'
    resendApiKey: string;
    // From address — shared by both transports
    fromEmail: string;
    fromName: string;
    // Optional Reply-To. Routes replies to a mailbox that can capture them
    // (e.g. reply@reply.<domain>) instead of the From address, which is often
    // a subdomain that doesn't accept mail.
    replyTo: string;
    // Svix signing secret for the Resend inbound webhook (email.received).
    // Read here so /webhook/resend-inbound can verify without duplicating
    // the config plumbing. Not used by outbound sends.
    resendInboundSecret: string;
}

// Una entry per tenant (Fase B3.6): ogni ristorante manda dal proprio
// mittente, con le proprie credenziali SMTP/Resend.
const CACHE_TTL_MS = 30_000;
const cache = new Map<number, { config: EmailConfig; loadedAt: number }>();

function envDefaults(): EmailConfig {
    const providerEnv = (process.env.EMAIL_PROVIDER || '').toLowerCase();
    return {
        provider: providerEnv === 'resend' ? 'resend' : 'smtp',
        host: process.env.SMTP_HOST || '',
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        user: process.env.SMTP_USER || '',
        password: process.env.SMTP_PASSWORD || '',
        resendApiKey: process.env.RESEND_API_KEY || '',
        fromEmail: process.env.SMTP_FROM_EMAIL || process.env.EMAIL_FROM || '',
        fromName: process.env.SMTP_FROM_NAME || process.env.EMAIL_FROM_NAME || '',
        replyTo: process.env.SMTP_REPLY_TO || '',
        resendInboundSecret: process.env.RESEND_INBOUND_SECRET || '',
    };
}

async function loadFromDb(tenantId: number): Promise<EmailConfig> {
    const defaults = envDefaults();
    try {
        const result = await queryWithRetry(
            `SELECT email_provider, resend_api_key, resend_inbound_secret,
                    smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password,
                    smtp_from_email, smtp_from_name, smtp_reply_to
             FROM integration_settings WHERE tenant_id = $1 AND provider = 'smtp' LIMIT 1`,
            [tenantId]
        );
        const row = result.rows[0];
        if (!row) return defaults;
        const providerRaw = (row.email_provider && String(row.email_provider).trim()) || defaults.provider;
        const provider: EmailProvider = providerRaw === 'resend' ? 'resend' : 'smtp';
        const host = (row.smtp_host && String(row.smtp_host).trim()) || defaults.host;
        const port = Number.isFinite(Number(row.smtp_port)) && Number(row.smtp_port) > 0
            ? Number(row.smtp_port)
            : defaults.port;
        const secure = typeof row.smtp_secure === 'boolean' ? row.smtp_secure : defaults.secure;
        const user = (row.smtp_user && String(row.smtp_user).trim()) || defaults.user;
        const password = (row.smtp_password && String(row.smtp_password)) || defaults.password;
        const resendApiKey = (row.resend_api_key && String(row.resend_api_key).trim()) || defaults.resendApiKey;
        const fromEmail = (row.smtp_from_email && String(row.smtp_from_email).trim()) || defaults.fromEmail;
        const fromName = (row.smtp_from_name && String(row.smtp_from_name).trim()) || defaults.fromName;
        const replyTo = (row.smtp_reply_to && String(row.smtp_reply_to).trim()) || defaults.replyTo;
        const resendInboundSecret = (row.resend_inbound_secret && String(row.resend_inbound_secret).trim()) || defaults.resendInboundSecret;
        return { provider, host, port, secure, user, password, resendApiKey, fromEmail, fromName, replyTo, resendInboundSecret };
    } catch (err) {
        console.warn('[Email] loadFromDb failed, using env fallbacks:', (err as any)?.message || err);
        return defaults;
    }
}

async function getConfig(tenantId: number, force = false): Promise<EmailConfig> {
    const now = Date.now();
    const cached = cache.get(tenantId);
    if (!force && cached && now - cached.loadedAt < CACHE_TTL_MS) return cached.config;
    const config = await loadFromDb(tenantId);
    cache.set(tenantId, { config, loadedAt: now });
    return config;
}

export function invalidateSmtpConfigCache(): void {
    cache.clear();
}

function isProviderConfigured(c: EmailConfig): boolean {
    if (!c.fromEmail) return false;
    if (c.provider === 'resend') return !!c.resendApiKey;
    return !!(c.host && c.port && c.user && c.password);
}

export async function isSmtpConfigured(tenantId: number): Promise<boolean> {
    const c = await getConfig(tenantId);
    return isProviderConfigured(c);
}

export interface SmtpStatus {
    provider: EmailProvider;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    from_email: string;
    from_name: string;
    reply_to: string;
    has_password: boolean;
    password_last4: string | null;
    has_resend_api_key: boolean;
    resend_api_key_last4: string | null;
    has_resend_inbound_secret: boolean;
    resend_inbound_secret_last4: string | null;
    configured: boolean;
}

export async function getSmtpConfigStatus(tenantId: number): Promise<SmtpStatus> {
    const c = await getConfig(tenantId, true);
    return {
        provider: c.provider,
        host: c.host,
        port: c.port,
        secure: c.secure,
        user: c.user,
        from_email: c.fromEmail,
        from_name: c.fromName,
        reply_to: c.replyTo,
        has_password: !!c.password,
        password_last4: c.password ? c.password.slice(-4) : null,
        has_resend_api_key: !!c.resendApiKey,
        resend_api_key_last4: c.resendApiKey ? c.resendApiKey.slice(-4) : null,
        has_resend_inbound_secret: !!c.resendInboundSecret,
        resend_inbound_secret_last4: c.resendInboundSecret ? c.resendInboundSecret.slice(-4) : null,
        configured: isProviderConfigured(c),
    };
}

// Exposed for the inbound webhook: it needs the Resend API key to fetch the
// full email body (webhooks only carry metadata) and the Svix secret to
// verify each POST. Returns null when the corresponding value is missing.
export async function getResendInboundContext(tenantId: number): Promise<{ apiKey: string; signingSecret: string } | null> {
    const c = await getConfig(tenantId);
    if (!c.resendApiKey || !c.resendInboundSecret) return null;
    return { apiKey: c.resendApiKey, signingSecret: c.resendInboundSecret };
}

function buildTransporter(config: EmailConfig): Transporter {
    return nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.password },
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 20_000,
    });
}

export interface SendMailInput {
    to: string;
    subject: string;
    text: string;
    html?: string;
}

export interface SendMailResult {
    messageId: string;
    accepted: string[];
    rejected: string[];
}

function buildFromHeader(config: EmailConfig): string {
    return config.fromName
        ? `"${config.fromName.replace(/"/g, '\\"')}" <${config.fromEmail}>`
        : config.fromEmail;
}

async function sendViaSmtp(config: EmailConfig, input: SendMailInput): Promise<SendMailResult> {
    const transporter = buildTransporter(config);
    const info = await transporter.sendMail({
        from: buildFromHeader(config),
        replyTo: config.replyTo || undefined,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
    });
    return {
        messageId: String(info.messageId ?? ''),
        accepted: (info.accepted as string[]) ?? [],
        rejected: (info.rejected as string[]) ?? [],
    };
}

// Resend REST API — https://resend.com/docs/api-reference/emails/send-email
async function sendViaResend(config: EmailConfig, input: SendMailInput): Promise<SendMailResult> {
    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config.resendApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: buildFromHeader(config),
            reply_to: config.replyTo || undefined,
            to: [input.to],
            subject: input.subject,
            text: input.text,
            html: input.html,
        }),
    });
    const bodyText = await response.text();
    let parsed: any;
    try { parsed = JSON.parse(bodyText); } catch { parsed = bodyText; }
    if (!response.ok) {
        const detail = typeof parsed === 'string' ? parsed : (parsed?.message || JSON.stringify(parsed));
        throw new Error(`Resend ${response.status}: ${detail}`);
    }
    return {
        messageId: String(parsed?.id ?? ''),
        accepted: [input.to],
        rejected: [],
    };
}

export async function sendMail(tenantId: number, input: SendMailInput): Promise<SendMailResult> {
    const config = await getConfig(tenantId);
    if (!isProviderConfigured(config)) {
        throw new Error('Email non è configurato');
    }
    return config.provider === 'resend'
        ? sendViaResend(config, input)
        : sendViaSmtp(config, input);
}

// Best-effort connectivity check. For SMTP it opens the TCP handshake and
// TLS negotiation. For Resend it hits the account endpoint with the API key.
export async function verifySmtpConnection(tenantId: number): Promise<{ ok: boolean; error?: string }> {
    const config = await getConfig(tenantId, true);
    if (!isProviderConfigured(config)) {
        return { ok: false, error: 'Email non è configurato' };
    }
    if (config.provider === 'resend') {
        try {
            const r = await fetch('https://api.resend.com/domains', {
                headers: { 'Authorization': `Bearer ${config.resendApiKey}` },
            });
            if (!r.ok) {
                const t = await r.text();
                return { ok: false, error: `Resend ${r.status}: ${t.slice(0, 200)}` };
            }
            return { ok: true };
        } catch (err: any) {
            return { ok: false, error: err?.message || 'Resend verify failed' };
        }
    }
    try {
        const transporter = buildTransporter(config);
        await transporter.verify();
        return { ok: true };
    } catch (err: any) {
        return { ok: false, error: err?.message || 'SMTP verify failed' };
    }
}
