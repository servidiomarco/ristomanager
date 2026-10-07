import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { io as ioClient } from 'socket.io-client';
import { api } from './helpers';

// L'installatore Windows del PC della cassa (piano «plug and play», punto
// 5): lo script servito dal server con dentro il suo indirizzo, e lo
// scollegamento chiesto dal PC stesso quando si disinstalla. La prova vera
// dell'installatore si fa su una VM Windows; qui, dove c'è PowerShell
// (i runner Ubuntu della CI lo hanno), almeno la sintassi.

const TOKEN_STORICO = 'test-pp-agent-token';
const pwsh = (() => {
    try { execFileSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'pipe' }); return true; } catch { return false; }
})();

describe("installatore del PC della cassa", () => {
    let db: Client;
    let script = '';

    beforeAll(async () => {
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
    });

    afterAll(async () => {
        // Il token storico torna buono per i file dopo.
        await db.query(`UPDATE passepartout_config SET token_storico_spento = false WHERE tenant_id = 1`);
        await db.end();
    });

    it("lo script si scarica col suo server dentro, e le versioni fissate", async () => {
        const r = await api().get('/installa/cassa.ps1');
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toContain('text/plain');
        script = r.text;
        expect(script).not.toContain('__SYMPOTIA_SERVER__');
        expect(script).toContain(`irm ${process.env.TEST_BASE_URL}/installa/cassa.ps1 | iex`);
        expect(script).toMatch(/\$NodeSha256 = '[0-9a-f]{64}'/);
        expect(script).toMatch(/\$WinSWSha256 = '[0-9a-f]{64}'/);
        expect(script).toContain('/pp-agent/abbina');
        expect(script).toContain('/pp-agent/aggiornamento');
    });

    it.skipIf(!pwsh)('PowerShell lo legge senza errori di sintassi', () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'installa-')), 'cassa.ps1');
        fs.writeFileSync(file, script);
        const out = execFileSync('pwsh', ['-NoProfile', '-Command',
            `$e = $null; [System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$e) | Out-Null; ` +
            `if ($e.Count) { $e | ForEach-Object { $_.ToString() }; exit 1 } else { 'ok' }`], { encoding: 'utf8' });
        expect(out.trim()).toBe('ok');
    });

    it('il PC si scollega da sé col suo token: il token ruota e non rientra', async () => {
        expect((await api().post('/pp-agent/scollega')).status).toBe(401);
        expect((await api().post('/pp-agent/scollega').set({ Authorization: 'Bearer sbagliato' })).status).toBe(401);
        const r = await api().post('/pp-agent/scollega').set({ Authorization: `Bearer ${TOKEN_STORICO}` });
        expect(r.status).toBe(200);
        const esito = await new Promise<string>((resolve) => {
            const socket = ioClient(`${process.env.TEST_BASE_URL}/pp-agent`, {
                auth: { token: TOKEN_STORICO }, transports: ['websocket'], reconnection: false,
            });
            socket.on('connect', () => { socket.close(); resolve('collegato'); });
            socket.on('connect_error', (err) => { socket.close(); resolve(err.message); });
        });
        expect(esito).toBe('Token agente non valido');
        const cfg = (await db.query(`SELECT token_storico_spento, abbinato_at FROM passepartout_config WHERE tenant_id = 1`)).rows[0];
        expect(cfg).toMatchObject({ token_storico_spento: true, abbinato_at: null });
    });
});
