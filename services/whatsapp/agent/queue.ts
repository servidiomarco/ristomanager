// L'agente che parte da solo: la coda dei messaggi in arrivo e il giro che
// la svuota.
//
// Un messaggio WhatsApp in arrivo mette (o sposta avanti) una riga «pending»
// in agent_runs; lo scheduler (server.ts, lock dedicato) prende le righe
// scadute e per ognuna fa i controlli che costano zero — finestra di 24 ore,
// pausa, staff che sta già scrivendo, limiti, ringraziamenti, risponditori
// automatici — e solo dopo chiama il modello. Poi, secondo la modalità:
// - draft: la risposta resta in bozza nell'inbox, la invia lo staff;
// - reply: la risposta parte da sola; le modifiche alle prenotazioni restano
//   proposte da confermare, con la push «Da confermare»;
// - actions: come reply, ma prenota, sposta e annulla da solo dove
//   l'idoneità passa (autonomy.ts); ogni azione finisce nel registro col
//   tasto «Annulla». Un locale che scende a bozze (budget, blacklist,
//   WhatsApp scollegato) non esegue niente: un'azione senza poterla dire al
//   cliente è peggio di una proposta.
// Prima di spedire si ricontrolla: se nel frattempo il cliente ha scritto
// ancora o lo staff ha risposto, il giro non spedisce (ci pensa il giro dopo).

import { queryWithRetry, runWithTenantContext } from '../../../db.js';
import { phoneDigitsVariants, phoneMatchKey } from '../../../utils/text.js';
import { sendToRoles as pushSendToRoles } from '../../pushService.js';
import { getTenantLocale, sqlTimeZone } from '../../tenantLocale.js';
import { COST_USD_SQL, USD_EUR } from '../../aiPricing.js';
import { isServiceNode } from '../../topology.js';
import { whatsappDeps } from '../deps.js';
import { onInbound } from '../inbound.js';
import { sendWhatsAppText } from '../outbound.js';
import { isWhatsAppReady } from '../config.js';
import { isWindowOpen } from '../window.js';
import { getAgentPolicy, type AgentMode, type WhatsAppAgentPolicy } from '../settings.js';
import { runAgent } from './run.js';
import { recordAutoAction } from './autonomy.js';
import { AgentError, type AgentAction, type AgentContext, type AgentProposal, type AgentResult, type AgentUsage } from './types.js';

/** Quello che sta in server.ts. */
export interface AgentQueueDeps {
    /** L'AI dei messaggi è accesa e il locale ha l'add-on WhatsApp. */
    isAiEnabled: (tenantId: number) => Promise<boolean>;
    /** Il contesto del giro (storia, prenotazioni, rubrica, regole…), lo
     *  stesso che usa la bacchetta; null se non c'è un messaggio del cliente. */
    buildContext: (tenantId: number, phoneKey: string) => Promise<AgentContext | null>;
    /** Salva la proposta (le vecchie in attesa decadono) e ne dà l'id. */
    saveProposal: (tenantId: number, phoneKey: string, proposal: AgentProposal, reply: string | null, reservationId: number | null) => Promise<number | null>;
    isBlacklisted: (tenantId: number, phone: string) => Promise<boolean>;
    /** La riga «Per cambiarla: <link>» nella lingua dell'ospite, se il
     *  locale ha acceso «La tua prenotazione»; null altrimenti. */
    manageSuffix?: (tenantId: number, reservationId: number) => Promise<string | null>;
}
let deps: AgentQueueDeps | null = null;

export const AGENT_AUTO_FEATURE = 'whatsapp_agent_auto';

// I test accorciano l'attesa: in produzione 20 secondi sono pochi per chi
// scrive in tre righe, ma un test non può aspettarli.
const debounceMs = (policy: WhatsAppAgentPolicy) =>
    process.env.WA_AGENT_DEBOUNCE_MS ? Number(process.env.WA_AGENT_DEBOUNCE_MS) : policy.debounce_seconds * 1000;
const maxWaitMs = (policy: WhatsAppAgentPolicy) =>
    process.env.WA_AGENT_DEBOUNCE_MS ? Number(process.env.WA_AGENT_DEBOUNCE_MS) * 3 : policy.max_wait_seconds * 1000;

// ---------------------------------------------------------------------------
// Messa in coda
// ---------------------------------------------------------------------------

export function configureAgentQueue(d: AgentQueueDeps): void {
    deps = d;
    onInbound(enqueueInbound);
}

async function enqueueInbound(tenantId: number, row: any, message: { channel: string }): Promise<void> {
    if (!deps || isServiceNode) return;
    // Solo WhatsApp: agli SMS si risponde a mano.
    if (message.channel !== 'whatsapp') return;
    const policy = await getAgentPolicy(tenantId);
    if (policy.mode === 'off') return;
    if (!(await deps.isAiEnabled(tenantId))) return;
    const key = phoneMatchKey(row.from_phone || row.from_phone_digits);
    if (!key) return;
    await queryWithRetry(
        `INSERT INTO agent_runs (tenant_id, phone_digits, status, mode, due_at, first_inbound_at, last_inbound_id, inbound_count)
         VALUES ($1, $2, 'pending', $3, NOW() + ($4::int * interval '1 millisecond'), NOW(), $5, 1)
         ON CONFLICT (tenant_id, phone_digits) WHERE status = 'pending' DO UPDATE
            SET due_at = LEAST(NOW() + ($4::int * interval '1 millisecond'),
                               agent_runs.first_inbound_at + ($6::int * interval '1 millisecond')),
                -- I webhook si lavorano in parallelo: il terzo messaggio può
                -- arrivare qui prima del secondo. Conta il più recente.
                last_inbound_id = GREATEST(agent_runs.last_inbound_id, EXCLUDED.last_inbound_id),
                inbound_count = agent_runs.inbound_count + 1`,
        [tenantId, key, policy.mode, Math.round(debounceMs(policy)), row.id, Math.round(maxWaitMs(policy))]
    );
}

// ---------------------------------------------------------------------------
// Il giro dello scheduler
// ---------------------------------------------------------------------------

/** Prende le righe scadute e le lavora. Gira dentro il lock dello scheduler
 *  e senza contesto tenant (vede tutti i ristoranti): ogni riga si lavora
 *  nel contesto del suo. */
export async function agentQueueTick(): Promise<void> {
    if (!deps || isServiceNode) return;
    // Un giro rimasto «running» (processo riavviato a metà) torna in coda,
    // fino a tre tentativi; poi si arrende e lo dice.
    await queryWithRetry(
        `UPDATE agent_runs SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
                due_at = NOW(), error = CASE WHEN attempts >= 3 THEN 'troppi tentativi' ELSE error END
          WHERE status = 'running' AND claimed_at < NOW() - interval '5 minutes' AND NOT simulated
            AND NOT EXISTS (SELECT 1 FROM agent_runs p WHERE p.tenant_id = agent_runs.tenant_id
                              AND p.phone_digits = agent_runs.phone_digits AND p.status = 'pending')`
    );
    const claimed = await queryWithRetry(
        `UPDATE agent_runs SET status = 'running', claimed_at = NOW(), attempts = attempts + 1
          WHERE id IN (SELECT id FROM agent_runs WHERE status = 'pending' AND due_at <= NOW() AND NOT simulated
                        ORDER BY due_at LIMIT 5 FOR UPDATE SKIP LOCKED)
          RETURNING *`
    );
    for (const run of claimed.rows) {
        await runWithTenantContext(Number(run.tenant_id), () => processRun(run)).catch(async (err: any) => {
            console.error('[agent-queue] giro fallito:', err?.message || err);
            await queryWithRetry(
                `UPDATE agent_runs SET status = 'failed', finished_at = NOW(), error = $2 WHERE id = $1`,
                [run.id, String(err?.message || err).slice(0, 500)]
            ).catch(() => {});
        });
    }
}

// ---------------------------------------------------------------------------
// Un giro
// ---------------------------------------------------------------------------

// Un risponditore automatico di un'altra azienda («Grazie per aver
// contattato GELATO LAB», al Frantoio il 20/09/2026): mai rispondergli, due
// bot che si rispondono non si fermano più.
const AUTO_REPLY_RE = /grazie per (averci|aver) contattat|risposta automatica|messaggio automatico|thank you for contacting|thanks for contacting|auto.?reply|automatic reply|this is an automated|al momento non (siamo|sono) disponibil|vi risponderemo (al più presto|appena possibile)/i;
// «ok», «grazie», «perfetto», un'emoji: non chiedono niente. «Ciao» no: da
// un cliente nuovo è un saluto che aspetta risposta.
const THANKS_ONLY_RE = /^(?:ok(?:ay|ei)?|grazie(?: mille| ancora| a voi)?|perfetto|va bene|benissimo|ottimo|a dopo|a domani|a stasera|a presto|thanks?(?: you)?|thank you|great|perfect|see you|[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+)[\s!.,😊🙏👍❤️]*$/iu;
// Una risposta che dà per fatta una modifica: senza una scrittura eseguita è
// una «conferma fantasma» e non deve partire.
const CLAIMS_DONE_RE = /\b(ho|abbiamo) (annullato|spostato|prenotato|modificato|confermato|cancellato)\b|\bè (stata )?(annullata|confermata|modificata|spostata|cancellata)\b|\b(i have|i've|we have|we've) (cancelled|canceled|booked|moved|changed|confirmed)\b|\bis (now )?(cancelled|canceled|confirmed|booked)\b/i;

export interface RunOutcome {
    status: 'done' | 'skipped' | 'superseded' | 'failed';
    outcome?: 'replied' | 'drafted' | 'no_reply' | 'would_reply';
    skip_reason?: string;
    reply?: string | null;
    proposals?: AgentProposal[];
    /** Le azioni eseguite da sole (o, nel simulatore, che eseguirebbe). */
    actions?: Array<Pick<AgentAction, 'tool' | 'summary' | 'simulated'> & { id?: number | null }>;
    skipped?: string | null;
}

interface FinishExtra {
    draft?: string | null;
    proposalId?: number | null;
    usage?: AgentUsage | null;
    replyMessageId?: number | null;
    error?: string | null;
}

async function finish(runId: number, o: RunOutcome & FinishExtra) {
    await queryWithRetry(
        `UPDATE agent_runs
            SET status = $2, outcome = $3, skip_reason = $4, draft_text = $5,
                draft_state = CASE WHEN $5::text IS NULL THEN NULL ELSE 'new' END,
                proposal_id = $6, usage = $7::jsonb, reply_message_id = $8, error = $9, finished_at = NOW()
          WHERE id = $1`,
        [runId, o.status, o.outcome ?? null, o.skip_reason ?? null, o.draft ?? null, o.proposalId ?? null,
         o.usage ? JSON.stringify(o.usage) : null, o.replyMessageId ?? null, o.error ?? null]
    );
}

function notifyActivity(tenantId: number, phoneKey: string) {
    try { whatsappDeps().broadcastToAll(tenantId, 'agent:activity', { phone_digits: phoneKey }); } catch { /* best effort */ }
}

async function pauseConversation(tenantId: number, phoneKey: string, until: Date | null, reason: string) {
    await queryWithRetry(
        `INSERT INTO agent_conversation_state (tenant_id, phone_digits, paused_until, pause_reason, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (tenant_id, phone_digits) DO UPDATE
            SET paused_until = EXCLUDED.paused_until, pause_reason = EXCLUDED.pause_reason, updated_at = NOW()`,
        [tenantId, phoneKey, until ? until.toISOString() : null, reason]
    );
}

/** I controlli che non costano niente: un motivo per non far partire il
 *  giro, o null. Restituisce anche la modalità effettiva (un locale oltre
 *  il budget del giorno, o un cliente in blacklist, passa a sole bozze). */
async function preflight(run: any, policy: WhatsAppAgentPolicy, simulate: boolean): Promise<{ skip: string | null; mode: AgentMode; phone: string | null; note?: string }> {
    const tenantId = Number(run.tenant_id);
    const variants = phoneDigitsVariants(run.phone_digits);
    let mode: AgentMode = policy.mode;
    let note: string | undefined;

    const lastIn = (await queryWithRetry(
        `SELECT id, body, sent_at, channel, from_phone FROM outbound_messages
          WHERE tenant_id = $1 AND direction = 'inbound' AND from_phone_digits = ANY($2::text[])
          ORDER BY sent_at DESC, id DESC LIMIT 1`,
        [tenantId, variants]
    )).rows[0];
    if (!lastIn) return { skip: 'nessun messaggio del cliente', mode, phone: null };
    const phone = String(lastIn.from_phone || `+${run.phone_digits}`);
    if (!simulate && !(await isWindowOpen(tenantId, phone, 10 * 60_000))) return { skip: 'finestra di 24 ore chiusa', mode, phone };

    const paused = (await queryWithRetry(
        `SELECT paused_until, pause_reason FROM agent_conversation_state
          WHERE tenant_id = $1 AND phone_digits = $2
            AND ((paused_until IS NULL AND pause_reason IS NOT NULL) OR paused_until > NOW())`,
        [tenantId, run.phone_digits]
    )).rows[0];
    if (paused) return { skip: `conversazione in pausa (${paused.pause_reason})`, mode, phone };

    if (!simulate) {
        const staff = await queryWithRetry(
            `SELECT 1 FROM outbound_messages
              WHERE tenant_id = $1 AND direction = 'outbound' AND kind = 'staff'
                AND to_phone_digits = ANY($2::text[])
                AND sent_at > LEAST(NOW() - ($3::int * interval '1 minute'), $4::timestamptz)
              LIMIT 1`,
            [tenantId, variants, policy.staff_quiet_minutes, run.first_inbound_at]
        );
        if (staff.rowCount) return { skip: 'lo staff sta già scrivendo', mode, phone };

        const risposte = await queryWithRetry(
            `SELECT count(*)::int AS n FROM outbound_messages
              WHERE tenant_id = $1 AND direction = 'outbound' AND kind = 'agent'
                AND to_phone_digits = ANY($2::text[]) AND sent_at > NOW() - interval '24 hours'`,
            [tenantId, variants]
        );
        if (risposte.rows[0].n >= policy.max_replies_per_thread_24h) return { skip: 'troppe risposte in questa conversazione', mode, phone };

        const tz = sqlTimeZone((await getTenantLocale(tenantId)).timezone);
        const giorno = `(date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`;
        const giri = await queryWithRetry(
            `SELECT count(*)::int AS n FROM agent_runs
              WHERE tenant_id = $1 AND created_at >= ${giorno} AND status = 'done' AND NOT simulated`,
            [tenantId]
        );
        if (giri.rows[0].n >= policy.max_runs_per_day) return { skip: 'limite di giri del giorno', mode, phone };
        const spesa = await queryWithRetry(
            `SELECT COALESCE(sum(${COST_USD_SQL}), 0)::float AS usd FROM ai_token_usage
              WHERE tenant_id = $1 AND feature = $2 AND created_at >= ${giorno}`,
            [tenantId, AGENT_AUTO_FEATURE]
        );
        if (Number(spesa.rows[0].usd) * USD_EUR >= policy.daily_budget_eur && mode !== 'draft') {
            mode = 'draft';
            note = 'budget del giorno superato: solo bozze';
        }
    }

    const body = String(lastIn.body || '').trim();
    if (AUTO_REPLY_RE.test(body)) {
        await pauseConversation(tenantId, run.phone_digits, new Date(Date.now() + 7 * 24 * 3600_000), 'bot_suspected');
        return { skip: 'risponditore automatico', mode, phone };
    }
    if (THANKS_ONLY_RE.test(body)) {
        // Un «sì» o un «ok» dopo una domanda dell'agente è una risposta: va
        // letto. Solo dopo un messaggio che non chiedeva niente si tace.
        const prima = (await queryWithRetry(
            `SELECT body FROM outbound_messages
              WHERE tenant_id = $1 AND direction = 'outbound' AND to_phone_digits = ANY($2::text[]) AND sent_at < $3
              ORDER BY sent_at DESC LIMIT 1`,
            [tenantId, variants, lastIn.sent_at]
        )).rows[0];
        if (!prima || !String(prima.body || '').trim().endsWith('?')) return { skip: 'non serve una risposta', mode, phone };
    }

    if (mode !== 'draft' && deps && await deps.isBlacklisted(tenantId, phone).catch(() => false)) {
        mode = 'draft';
        note = 'cliente in blacklist: solo bozza';
    }
    if (mode !== 'draft' && !simulate && !(await isWhatsAppReady(tenantId))) {
        mode = 'draft';
        note = 'WhatsApp non collegato: solo bozza';
    }
    return { skip: null, mode, phone, note };
}

/** È arrivato un altro messaggio, o lo staff ha risposto, dopo che il giro
 *  è partito? Allora non si spedisce. */
async function superseded(run: any): Promise<boolean> {
    const variants = phoneDigitsVariants(run.phone_digits);
    const r = await queryWithRetry(
        `SELECT 1 FROM outbound_messages
          WHERE tenant_id = $1 AND (
                (direction = 'inbound' AND from_phone_digits = ANY($2::text[]) AND id > COALESCE($3::int, 0))
             OR (direction = 'outbound' AND kind = 'staff' AND to_phone_digits = ANY($2::text[]) AND sent_at > $4::timestamptz))
          LIMIT 1`,
        [run.tenant_id, variants, run.last_inbound_id, run.claimed_at ?? new Date().toISOString()]
    );
    return (r.rowCount ?? 0) > 0;
}

async function recordUsage(tenantId: number, usage: AgentUsage) {
    if (usage.calls === 0) return;
    await queryWithRetry(
        `INSERT INTO ai_token_usage (provider, feature, model, prompt_tokens, output_tokens, total_tokens, user_email, tenant_id)
         VALUES ('anthropic', $1, $2, $3, $4, $5, NULL, $6)`,
        [AGENT_AUTO_FEATURE, usage.model, usage.promptTokens, usage.outputTokens, usage.totalTokens, tenantId]
    ).catch(err => console.error('ai_token_usage insert (whatsapp_agent_auto) failed:', err));
}

function pushToStaff(tenantId: number, phoneKey: string, title: string, body: string) {
    pushSendToRoles(tenantId, ['OWNER', 'GENERAL_MANAGER', 'MANAGER', 'RECEPTION'], {
        category: 'message',
        title,
        body,
        url: `/?view=MESSAGGI&phone=${encodeURIComponent(phoneKey)}`,
        tag: `agent-${phoneKey}`,
    }, { excludeUserId: null }).catch(err => console.warn('[agent-queue] push fallita:', err?.message || err));
}

/** Lavora un giro. Con `simulate` nessun invio e nessuna proposta salvata:
 *  serve al simulatore delle Impostazioni. */
export async function processRun(run: any, opts: { simulate?: boolean } = {}): Promise<RunOutcome> {
    const simulate = opts.simulate === true;
    const tenantId = Number(run.tenant_id);
    const key = String(run.phone_digits);
    const policy = await getAgentPolicy(tenantId);
    const done = async (o: RunOutcome, extra: FinishExtra = {}) => {
        await finish(Number(run.id), { ...o, ...extra });
        notifyActivity(tenantId, key);
        return o;
    };

    if (!deps) return done({ status: 'skipped', skip_reason: 'agente non configurato' });
    if (!simulate && (policy.mode === 'off' || !(await deps.isAiEnabled(tenantId)))) {
        return done({ status: 'skipped', skip_reason: 'agente spento' });
    }

    const pre = await preflight(run, simulate ? { ...policy, mode: run.mode || 'reply' } : policy, simulate);
    if (pre.skip) return done({ status: 'skipped', skip_reason: pre.skip });

    const ctx = await deps.buildContext(tenantId, key);
    if (!ctx) return done({ status: 'skipped', skip_reason: 'nessun messaggio del cliente' });
    // L'autonomia vale solo se la modalità effettiva, dopo i controlli, è
    // ancora «Azioni».
    if (pre.mode === 'actions') {
        const a = policy.auto_actions;
        ctx.autonomy = { create: a.create, modify: a.modify, cancel: a.cancel, notes: a.notes, confirmCancel: policy.confirm_cancel };
    }
    if (simulate) ctx.dryRun = true;

    let result: AgentResult;
    try {
        result = await runAgent(ctx);
    } catch (err: any) {
        if (err instanceof AgentError && err.kind === 'no_knowledge') {
            return done({ status: 'skipped', skip_reason: 'nessuna regola della casa' });
        }
        return done({ status: 'failed', skip_reason: 'errore del modello' }, { error: String(err?.message || err).slice(0, 500) });
    }
    if (!simulate) await recordUsage(tenantId, result.usage);

    // Le azioni eseguite vanno nel registro subito, qualunque cosa succeda
    // alla risposta: la prenotazione è già cambiata.
    const acted = result.actions.filter(a => !a.simulated);
    const actionRows: NonNullable<RunOutcome['actions']> = [];
    for (const a of result.actions) {
        const id = a.simulated ? null : await recordAutoAction(tenantId, key, Number(run.id) || null, a, result.reply).catch(err => {
            console.error('[agent-queue] registro azione fallito:', err?.message || err);
            return null;
        });
        actionRows.push({ tool: a.tool, summary: a.summary, simulated: a.simulated, id });
        // Note: gli strumenti di prenotazione e le allergie avvisano da sé;
        // una nota aggiunta da sola lo staff la deve sapere.
        if (!a.simulated && a.tool === 'add_reservation_note') {
            pushToStaff(tenantId, key, "Nota dall'agente WhatsApp", `${ctx.phone}: ${a.summary}`);
        }
    }

    if (result.skipped) return done({ status: 'done', outcome: 'no_reply', skipped: result.skipped, proposals: [], actions: actionRows }, { usage: result.usage });
    // Superato da un messaggio nuovo: non si spedisce, ci pensa il giro dopo.
    // Ma se una prenotazione è già cambiata il cliente lo deve sapere adesso.
    if (!simulate && acted.length === 0 && await superseded(run)) return done({ status: 'superseded', reply: result.reply }, { usage: result.usage });

    let mode = pre.mode;
    let note = pre.note;
    // Conferma fantasma: il testo dà per fatta una modifica che nessuno
    // strumento ha eseguito. Non parte: diventa bozza, e lo staff lo sa.
    if (mode !== 'draft' && result.reply && result.actions.length === 0 && CLAIMS_DONE_RE.test(result.reply)) {
        mode = 'draft';
        note = 'la risposta dava per fatta una modifica non eseguita';
        if (!simulate) pushToStaff(tenantId, key, 'Bozza da controllare', `${ctx.phone}: ${result.reply.slice(0, 120)}`);
    }

    let proposalId: number | null = null;
    if (!simulate && result.proposals[0]) {
        proposalId = await deps.saveProposal(tenantId, key, result.proposals[0], result.reply, ctx.reservation?.id ?? null);
        pushToStaff(tenantId, key, 'Da confermare', `${ctx.phone}: ${result.proposals[0].summary}`);
    }

    // Dopo una prenotazione creata o spostata da solo, il link per gestirla:
    // la risposta dell'agente è la conferma che il cliente si tiene.
    let reply = result.reply;
    const gestibile = acted.find(a => a.tool === 'create_reservation' || a.tool === 'modify_reservation');
    if (reply && gestibile?.after && deps.manageSuffix) {
        const suffix = await deps.manageSuffix(tenantId, gestibile.after.id).catch(() => null);
        if (suffix && !reply.includes(suffix)) reply = `${reply}\n${suffix}`;
    }

    if (mode === 'draft' || !reply) {
        if (acted.length > 0 && reply) pushToStaff(tenantId, key, 'Risposta da inviare', `${ctx.phone}: l'agente ha agito, la risposta è in bozza`);
        return done(
            { status: 'done', outcome: 'drafted', reply, proposals: result.proposals, actions: actionRows, skip_reason: note },
            { draft: reply, proposalId, usage: result.usage }
        );
    }
    if (simulate) {
        return done({ status: 'done', outcome: 'would_reply', reply, proposals: result.proposals, actions: actionRows, skip_reason: note }, { usage: result.usage });
    }
    try {
        const reservationRef = acted[0]?.after?.id ?? ctx.reservation?.id ?? null;
        const sent = await sendWhatsAppText(tenantId, pre.phone!, reply, reservationRef, undefined, undefined, 'agent');
        let replyMessageId: number | null = null;
        if (sent.sid) {
            const m = await queryWithRetry(`SELECT id FROM outbound_messages WHERE tenant_id = $1 AND provider_sid = $2 LIMIT 1`, [tenantId, sent.sid]);
            replyMessageId = m.rows[0]?.id ?? null;
        }
        return done({ status: 'done', outcome: 'replied', reply, proposals: result.proposals, actions: actionRows }, { proposalId, usage: result.usage, replyMessageId });
    } catch (err: any) {
        // L'invio non è riuscito: la risposta resta in bozza, non si perde.
        if (acted.length > 0) pushToStaff(tenantId, key, 'Risposta da inviare', `${ctx.phone}: l'agente ha agito ma la risposta non è partita`);
        return done(
            { status: 'done', outcome: 'drafted', reply, proposals: result.proposals, actions: actionRows, skip_reason: 'invio non riuscito: resta in bozza' },
            { draft: reply, proposalId, usage: result.usage, error: String(err?.message || err).slice(0, 500) }
        );
    }
}

/** Il simulatore: un messaggio da un numero finto, tutta la catena, niente
 *  invio. */
export async function simulateRun(tenantId: number, phoneKey: string, mode: AgentMode): Promise<RunOutcome & { run_id: number }> {
    const r = await queryWithRetry(
        `INSERT INTO agent_runs (tenant_id, phone_digits, status, mode, simulated, due_at, claimed_at, attempts)
         VALUES ($1, $2, 'running', $3, TRUE, NOW(), NOW(), 1) RETURNING *`,
        [tenantId, phoneKey, mode === 'off' ? 'reply' : mode]
    );
    const run = r.rows[0];
    const o = await processRun(run, { simulate: true });
    return { ...o, run_id: Number(run.id) };
}
