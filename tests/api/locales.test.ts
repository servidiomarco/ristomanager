import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { api } from './helpers';

// Card #33 → PR /ordina bilingue: la route /locales/:lang/:file serve SOLO i
// dizionari delle pagine pubbliche del backend (prenota, ordina), su
// whitelist chiusa: lingua o file fuori lista → 404, mai il filesystem.
describe('locales pubblici', () => {
    it('serve i dizionari di prenota e ordina in it e en', async () => {
        for (const lang of ['it', 'en']) {
            for (const file of ['prenota.json', 'ordina.json']) {
                const res = await api().get(`/locales/${lang}/${file}`);
                expect(res.status, `${lang}/${file}`).toBe(200);
                expect(res.body.meta?.title, `${lang}/${file}`).toBeTruthy();
            }
        }
    });

    it('rifiuta lingue fuori whitelist', async () => {
        const res = await api().get('/locales/fr/ordina.json');
        expect(res.status).toBe(404);
    });

    it('rifiuta file fuori whitelist (paytable è servito da Vercel, non da qui)', async () => {
        expect((await api().get('/locales/en/paytable.json')).status).toBe(404);
        expect((await api().get('/locales/en/package.json')).status).toBe(404);
    });

    it('non attraversa il filesystem', async () => {
        const res = await api().get('/locales/en/..%2F..%2Fpackage.json');
        expect(res.status).toBe(404);
    });

    // Guardia di sincronia per TUTTE le namespace in public/locales (anche
    // paytable, che viaggia con la SPA): stesse chiavi e stessi placeholder
    // {{var}} tra it e en. Una chiave solo da una parte = testo che a una
    // lingua manca in silenzio.
    it('it e en hanno le stesse chiavi e gli stessi placeholder', () => {
        const base = path.join(process.cwd(), 'public', 'locales');
        const flatten = (obj: Record<string, unknown>, prefix = ''): Map<string, string> => {
            const out = new Map<string, string>();
            for (const [k, v] of Object.entries(obj)) {
                if (v && typeof v === 'object') {
                    for (const [ck, cv] of flatten(v as Record<string, unknown>, prefix + k + '.')) out.set(ck, cv);
                } else {
                    out.set(prefix + k, String(v));
                }
            }
            return out;
        };
        const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) || []).sort().join(',');

        const files = fs.readdirSync(path.join(base, 'it')).filter(f => f.endsWith('.json'));
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
            const itDict = flatten(JSON.parse(fs.readFileSync(path.join(base, 'it', file), 'utf8')));
            const enPath = path.join(base, 'en', file);
            expect(fs.existsSync(enPath), `${file}: manca la versione en`).toBe(true);
            const enDict = flatten(JSON.parse(fs.readFileSync(enPath, 'utf8')));

            expect([...enDict.keys()].sort(), `${file}: chiavi diverse`).toEqual([...itDict.keys()].sort());
            for (const [key, itVal] of itDict) {
                expect(placeholders(enDict.get(key) ?? ''), `${file} → ${key}: placeholder diversi`)
                    .toBe(placeholders(itVal));
                expect((enDict.get(key) ?? '').trim(), `${file} → ${key}: vuota in en`).not.toBe('');
            }
        }
    });
});
