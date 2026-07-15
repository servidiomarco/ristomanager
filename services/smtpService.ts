// SMTP configuration & mail sender. Config is stored on the
// `integration_settings` row where provider='smtp'; env vars are used only as
// a fallback so a fresh install without a DB row keeps the previous behavior.
// Same layering pattern as services/revolutService.ts.

import nodemailer, { type Transporter } from 'nodemailer';
import { queryWithRetry } from '../db.js';

export interface SmtpConfig {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    fromEmail: string;
    fromName: string;
}

const CACHE_TTL_MS = 30_000;
let cache: { config: SmtpConfig; loadedAt: number } | null = null;

function envDefaults(): SmtpConfig {
    return {
        host: process.env.SMTP_HOST || '',
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        user: process.env.SMTP_USER || '',
        password: process.env.SMTP_PASSWORD || '',
        fromEmail: process.env.SMTP_FROM_EMAIL || '',
        fromName: process.env.SMTP_FROM_NAME || '',
    };
}

async function loadFromDb(): Promise<SmtpConfig> {
    const defaults = envDefaults();
    try {
        const result = await queryWithRetry(
            `SELECT smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password,
                    smtp_from_email, smtp_from_name
             FROM integration_settings WHERE provider = 'smtp' LIMIT 1`
        );
        const row = result.rows[0];
        if (!row) return defaults;
        const host = (row.smtp_host && String(row.smtp_host).trim()) || defaults.host;
        const port = Number.isFinite(Number(row.smtp_port)) && Number(row.smtp_port) > 0
            ? Number(row.smtp_port)
            : defaults.port;
        const secure = typeof row.smtp_secure === 'boolean' ? row.smtp_secure : defaults.secure;
        const user = (row.smtp_user && String(row.smtp_user).trim()) || defaults.user;
        const password = (row.smtp_password && String(row.smtp_password)) || defaults.password;
        const fromEmail = (row.smtp_from_email && String(row.smtp_from_email).trim()) || defaults.fromEmail;
        const fromName = (row.smtp_from_name && String(row.smtp_from_name).trim()) || defaults.fromName;
        return { host, port, secure, user, password, fromEmail, fromName };
    } catch (err) {
        console.warn('[SMTP] loadFromDb failed, using env fallbacks:', (err as any)?.message || err);
        return defaults;
    }
}

async function getConfig(force = false): Promise<SmtpConfig> {
    const now = Date.now();
    if (!force && cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.config;
    const config = await loadFromDb();
    cache = { config, loadedAt: now };
    return config;
}

export function invalidateSmtpConfigCache(): void {
    cache = null;
}

export async function isSmtpConfigured(): Promise<boolean> {
    const c = await getConfig();
    return !!(c.host && c.port && c.user && c.password && c.fromEmail);
}

// Snapshot without the password. Used by GET /settings/integrations/smtp.
export async function getSmtpConfigStatus(): Promise<{
    host: string;
    port: number;
    secure: boolean;
    user: string;
    from_email: string;
    from_name: string;
    has_password: boolean;
    password_last4: string | null;
    configured: boolean;
}> {
    const c = await getConfig(true);
    return {
        host: c.host,
        port: c.port,
        secure: c.secure,
        user: c.user,
        from_email: c.fromEmail,
        from_name: c.fromName,
        has_password: !!c.password,
        password_last4: c.password ? c.password.slice(-4) : null,
        configured: !!(c.host && c.port && c.user && c.password && c.fromEmail),
    };
}

function buildTransporter(config: SmtpConfig): Transporter {
    return nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.password },
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

export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
    const config = await getConfig();
    if (!config.host || !config.port || !config.user || !config.password || !config.fromEmail) {
        throw new Error('SMTP non è configurato');
    }
    const transporter = buildTransporter(config);
    const from = config.fromName
        ? `"${config.fromName.replace(/"/g, '\\"')}" <${config.fromEmail}>`
        : config.fromEmail;
    const info = await transporter.sendMail({
        from,
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

export async function verifySmtpConnection(): Promise<{ ok: boolean; error?: string }> {
    const config = await getConfig(true);
    if (!config.host || !config.port || !config.user || !config.password) {
        return { ok: false, error: 'SMTP non è configurato' };
    }
    try {
        const transporter = buildTransporter(config);
        await transporter.verify();
        return { ok: true };
    } catch (err: any) {
        return { ok: false, error: err?.message || 'SMTP verify failed' };
    }
}
