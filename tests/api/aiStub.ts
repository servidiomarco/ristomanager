import http from 'node:http';

// Uno stub locale dell'API di Anthropic con una coda di risposte preparate:
// ogni richiesta prende la prossima e viene registrata (corpo e header), così
// un test sa cosa il server ha mandato al modello e decide cosa riceve in
// cambio. Gira solo nel job «Test API (report AI, stub locale)» di ci.yml:
//   TEST_AI_STUB=1 ANTHROPIC_API_KEY=stub ANTHROPIC_BASE_URL=http://127.0.0.1:47649

export const AI_STUB_PORT = (() => {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/?$/.exec(process.env.ANTHROPIC_BASE_URL || '');
    return m && process.env.ANTHROPIC_API_KEY ? Number(m[1]) : 0;
})();

export type StubReply = { content: any[]; stop_reason?: string };

export const stubText = (t: string): StubReply => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });

export const stubCalls = (...calls: Array<[string, string, Record<string, any>]>): StubReply => ({
    content: calls.map(([id, name, input]) => ({ type: 'tool_use', id, name, input })),
    stop_reason: 'tool_use',
});

export interface AiStub {
    received: Array<{ body: any; headers: http.IncomingHttpHeaders }>;
    /** Svuota le richieste registrate e mette in coda le risposte. */
    load: (...replies: StubReply[]) => void;
    /** L'ultimo messaggio della richiesta n (di solito gli esiti degli strumenti). */
    lastMessage: (n: number) => any;
    /** L'esito dello strumento `toolUseId` mandato al modello, già letto dal JSON. */
    toolResult: (toolUseId: string) => any;
    close: () => Promise<void>;
}

export async function startAiStub(): Promise<AiStub> {
    const received: AiStub['received'] = [];
    const queue: StubReply[] = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            let parsed: any = null;
            try { parsed = JSON.parse(body); } catch { /* resta null */ }
            received.push({ body: parsed, headers: req.headers });
            const r = queue.shift() ?? stubText('Va bene.');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: `msg_stub_${received.length}`, type: 'message', role: 'assistant', model: 'stub',
                content: r.content, stop_reason: r.stop_reason ?? 'end_turn', stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 5 },
            }));
        });
    });
    await new Promise<void>(resolve => server.listen(AI_STUB_PORT, '127.0.0.1', () => resolve()));
    return {
        received,
        load: (...replies) => {
            received.length = 0;
            queue.splice(0, queue.length, ...replies);
        },
        lastMessage: n => {
            const msgs = received[n].body.messages;
            return msgs[msgs.length - 1];
        },
        toolResult: id => {
            for (const r of received) {
                for (const m of r.body?.messages ?? []) {
                    if (!Array.isArray(m.content)) continue;
                    const b = m.content.find((x: any) => x.type === 'tool_result' && x.tool_use_id === id);
                    if (b) return JSON.parse(b.content);
                }
            }
            return undefined;
        },
        close: () => new Promise<void>(resolve => server.close(() => resolve())),
    };
}
