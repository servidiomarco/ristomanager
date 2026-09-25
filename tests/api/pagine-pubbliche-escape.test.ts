import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { api } from './helpers';
import { renderContactBlockHtml, safeHttpUrl as safeHttpUrlEmail } from '../../services/emailContactBlock';

// Audit M-08 (stored XSS sull'origine pubblica condivisa) e «D-lite»
// (contesta:N-public-xss): il branding che il ristoratore scrive in
// Impostazioni → Legale arriva a pagine che vede chiunque. Qui un tenant
// «ostile» salva in telefono, mappa, sito e logo sia un'uscita
// dall'attributo sia un javascript:, e si controlla ogni punto in cui quei
// valori diventano markup:
//   - la testa SEO di /prenota/<slug> e l'informativa privacy, rese a server;
//   - le pillole della testata di /ordina (prima innerHTML con i dati grezzi);
//   - i link di sito e mappa di /prenota (prima href senza controllo);
//   - il blocco contatti delle email (prima maps_url dritto nell'href).
// Poi D-lite: uno slug di un tenant, chiesto sul dominio di UN ALTRO tenant,
// risponde 404; sull'host condiviso resta 200.
//
// Id alti e riservati come in prenota-slug.test.ts: fuori dalla portata della
// sequence, nessuna collisione con i tenant creati da altri file.
const TENANT_OSTILE = 4331;
const TENANT_ALTRO = 4332;
// Un tenant sospeso che ha ancora il suo dominio (morosità, DNS puntato su
// Railway): il dominio resta suo, non diventa «di nessuno».
const TENANT_SOSPESO = 4333;
const SLUG_OSTILE = 'escape-ostile';
const SLUG_ALTRO = 'escape-altro';
const SLUG_SOSPESO = 'escape-sospeso';
// Mai richiesti prima di questo file: la cache «host di nessuno» di
// tenantOwningPublicHost non può averli già visti.
const DOMINIO_ALTRO = 'prenota.escape-altro.test';
const DOMINIO_SOSPESO = 'prenota.escape-sospeso.test';

const BREAKOUT = '"><img src=x onerror=alert(1)>';
const JS_URL = 'javascript:alert(1)';

const legalOstile = {
    // «$&» e «$`» provano la sostituzione in prenotaSeo: con una stringa di
    // sostituzione venivano espansi e ricopiavano pezzi della pagina in <head>.
    business_name: 'Osteria $& Figli',
    business_tagline: `Dal 1990 $\` ${BREAKOUT}`,
    public_phone: BREAKOUT,
    public_address: BREAKOUT,
    maps_url: JS_URL,
    website_url: JS_URL,
    logo_url: BREAKOUT,
    company_name: BREAKOUT,
};

// Gli script inline della pagina (non il JSON-LD, che è dato e non codice).
const inlineScripts = (html: string): string[] => {
    const out: string[] = [];
    const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
        const attrs = m[1] || '';
        if (/\bsrc=|application\/ld\+json/.test(attrs)) continue;
        out.push(m[2]);
    }
    return out;
};

// Un DOM minimo, quanto basta alla testata: registra ogni scrittura di
// innerHTML, così il test vede se un dato del tenant ci è passato.
class FakeEl {
    tag: string;
    attrs: Record<string, string> = {};
    children: Array<FakeEl | { text: string }> = [];
    className = '';
    private inner = '';
    constructor(tag: string, private writes: string[]) { this.tag = tag; }
    set innerHTML(v: string) { this.inner = String(v); this.writes.push(String(v)); this.children = []; }
    get innerHTML(): string { return this.inner; }
    set textContent(v: string) { this.inner = ''; this.children = v ? [{ text: String(v) }] : []; }
    setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
    getAttribute(k: string) { return this.attrs[k] ?? null; }
    removeAttribute(k: string) { delete this.attrs[k]; }
    set href(v: string) { this.attrs.href = String(v); }
    get href(): string { return this.attrs.href; }
    set target(v: string) { this.attrs.target = String(v); }
    set rel(v: string) { this.attrs.rel = String(v); }
    appendChild<T>(c: T): T { this.children.push(c as any); return c; }
    replaceChildren(...c: any[]) { this.children = c; }
}

// Esegue renderHeaderLinks di ordina.html (con gli helper dichiarati accanto)
// contro il DOM finto. Il pezzo si ritaglia fra `const restaurantName` e la
// riga che scrive il nome in testata: funziona sulla versione vecchia come
// sulla nuova, così il test sa dire quale delle due è sicura.
const runOrdinaHeaderLinks = (script: string, branding: Record<string, unknown>) => {
    const start = script.indexOf("const restaurantName = branding.name || '';");
    const end = script.indexOf('\n    if (restaurantName) {', start);
    expect(start, 'ancora `const restaurantName` non trovata in ordina.html').toBeGreaterThan(-1);
    expect(end, 'ancora `if (restaurantName)` non trovata in ordina.html').toBeGreaterThan(start);
    const segment = script.slice(start, end);
    const writes: string[] = [];
    const host = new FakeEl('div', writes);
    const context = vm.createContext({
        branding,
        URL,
        location: { href: 'https://prenota.example.test/ordina/escape-ostile' },
        t: (key: string) => (key === 'header.directions' ? 'Indicazioni' : key),
        $: (id: string) => (id === 'headerLinks' ? host : new FakeEl('x', writes)),
        document: {
            createElement: (tag: string) => new FakeEl(tag, writes),
            createTextNode: (text: string) => ({ text: String(text) }),
        },
    });
    vm.runInContext(`${segment}\nrenderHeaderLinks();`, context);
    const anchors = host.children.filter((c): c is FakeEl => c instanceof FakeEl);
    const labels = anchors.map(a => a.children.filter((c: any) => 'text' in c).map((c: any) => c.text).join(''));
    return { host, anchors, labels, writes };
};

describe('pagine pubbliche: escape del branding e domini per tenant (audit M-08)', () => {
    let db: Client;
    let tmp: string;

    beforeAll(async () => {
        tmp = mkdtempSync(path.join(tmpdir(), 'pagine-pubbliche-'));
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await db.query(
            `INSERT INTO tenants (id, slug, name, status) VALUES
                ($1, $2, 'Tenant ostile', 'active'), ($3, $4, 'Tenant altro', 'active'), ($5, $6, 'Tenant sospeso', 'suspended')
             ON CONFLICT (id) DO NOTHING`,
            [TENANT_OSTILE, SLUG_OSTILE, TENANT_ALTRO, SLUG_ALTRO, TENANT_SOSPESO, SLUG_SOSPESO]
        );
        await db.query(`SELECT setval(pg_get_serial_sequence('tenants','id'), (SELECT MAX(id) FROM tenants))`);
        await db.query(
            `INSERT INTO app_settings (tenant_id, key, text_value) VALUES ($1, 'legal_config', $2), ($3, 'legal_config', $4)
             ON CONFLICT DO NOTHING`,
            [TENANT_OSTILE, JSON.stringify(legalOstile), TENANT_ALTRO, JSON.stringify({ business_name: 'Trattoria Altra' })]
        );
        await db.query(
            `INSERT INTO tenant_domains (domain, tenant_id, purpose) VALUES ($1, $2, 'booking'), ($3, $4, 'booking')
             ON CONFLICT DO NOTHING`,
            [DOMINIO_ALTRO, TENANT_ALTRO, DOMINIO_SOSPESO, TENANT_SOSPESO]
        );
    });

    afterAll(async () => {
        rmSync(tmp, { recursive: true, force: true });
        for (const id of [TENANT_OSTILE, TENANT_ALTRO, TENANT_SOSPESO]) {
            await db.query('DELETE FROM tenant_domains WHERE tenant_id = $1', [id]);
            await db.query('DELETE FROM app_settings WHERE tenant_id = $1', [id]);
            await db.query('DELETE FROM tenant_features WHERE tenant_id = $1', [id]);
            await db.query('DELETE FROM role_permissions WHERE tenant_id = $1', [id]);
            await db.query('DELETE FROM tenants WHERE id = $1', [id]);
        }
        await db.end();
    });

    describe('markup reso dal server', () => {
        it('/prenota/<slug>: testa SEO con i valori ostili escapati, «$&» e «$`» letterali', async () => {
            const res = await api().get(`/prenota/${SLUG_OSTILE}`);
            expect(res.status).toBe(200);
            const html = res.text;
            expect(html).not.toContain('<img src=x onerror');
            expect(html).not.toMatch(/href="\s*javascript:/i);
            // Un solo <title>, col nome così com'è scritto: prima «$&» veniva
            // sostituito dal tag <title> originale.
            expect(html.match(/<title>/g)?.length).toBe(1);
            expect(html).toContain('<title>Osteria $&amp; Figli — Prenota un tavolo</title>');
            // Nel JSON-LD i valori sono dati: si rileggono identici, e «$`»
            // non ha ricopiato l'inizio della pagina dentro la descrizione.
            const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
            expect(m, 'JSON-LD assente').toBeTruthy();
            const ld = JSON.parse(m![1].replace(/\\u003c/g, '<'));
            expect(ld.name).toBe(legalOstile.business_name);
            expect(ld.description).toBe(legalOstile.business_tagline);
            expect(ld.telephone).toBe(BREAKOUT);
        });

        it('/privacy/<slug>: l\'anagrafe ostile non esce mai grezza', async () => {
            const res = await api().get(`/privacy/${SLUG_OSTILE}`);
            expect(res.status).toBe(200);
            expect(res.text).not.toContain('<img src=x onerror');
        });

        it('il branding ostile arriva alle pagine come dato: sono loro a doverlo neutralizzare', async () => {
            // Lo stato del problema: /public/<slug>/contact e /takeaway/info
            // restituiscono i valori salvati (la validazione in scrittura è
            // fuori da questa PR), quindi la difesa vera è nelle pagine qui sotto.
            const res = await api().get(`/public/${SLUG_OSTILE}/contact`);
            expect(res.status).toBe(200);
            expect(res.body.branding.maps_url).toBe(JS_URL);
            expect(res.body.branding.website_url).toBe(JS_URL);
        });
    });

    describe('script delle pagine /ordina e /prenota', () => {
        it('gli script inline passano node --check', async () => {
            for (const url of [`/ordina/${SLUG_OSTILE}`, `/prenota/${SLUG_OSTILE}`]) {
                const res = await api().get(url);
                expect(res.status, url).toBe(200);
                const scripts = inlineScripts(res.text);
                expect(scripts.length, `${url}: nessuno script inline`).toBeGreaterThan(0);
                scripts.forEach((src, i) => {
                    const file = path.join(tmp, `${url.split('/')[1]}-${i}.js`);
                    writeFileSync(file, src);
                    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
                    expect(r.status, `${url} script #${i}: ${r.stderr}`).toBe(0);
                });
            }
        });

        it('/ordina: la testata non passa mai dati del tenant da innerHTML', async () => {
            const res = await api().get(`/ordina/${SLUG_OSTILE}`);
            const [script] = inlineScripts(res.text);
            const out = runOrdinaHeaderLinks(script, { phone: BREAKOUT, maps_url: JS_URL });
            // L'unico innerHTML ammesso è l'icona costante.
            for (const w of out.writes) {
                expect(w).not.toContain('onerror');
                expect(w).not.toContain('javascript:');
            }
            // Del telefono ostile il tel: tiene solo le cifre (l'«1» di
            // «alert(1)»), e il testo arriva come nodo di testo. La mappa
            // javascript: non diventa un link.
            expect(out.anchors).toHaveLength(1);
            expect(out.anchors[0].attrs.href).toBe('tel:1');
            expect(out.labels[0]).toBe(BREAKOUT);

            // Telefono con cifre attorno a un'uscita dall'attributo: il tel:
            // si costruisce dalle sole cifre (anche quella di «alert(1)»),
            // l'etichetta resta testo.
            const mixed = runOrdinaHeaderLinks(script, { phone: `+39 0985 ${BREAKOUT} 876578`, maps_url: 'data:text/html,<script>alert(1)</script>' });
            for (const w of mixed.writes) expect(w).not.toContain('onerror');
            expect(mixed.anchors).toHaveLength(1);
            expect(mixed.anchors[0].attrs.href).toBe('tel:+3909851876578');
            expect(mixed.labels[0]).toBe(`+39 0985 ${BREAKOUT} 876578`);
        });

        it('/ordina: con valori normali la testata resta quella di sempre', async () => {
            const res = await api().get(`/ordina/${SLUG_OSTILE}`);
            const [script] = inlineScripts(res.text);
            const out = runOrdinaHeaderLinks(script, {
                phone: '+39 0985 876578',
                maps_url: 'https://maps.app.goo.gl/pf1DjUYzkhi1sStP8',
            });
            expect(out.anchors.map(a => a.attrs.href)).toEqual([
                'tel:+390985876578',
                'https://maps.app.goo.gl/pf1DjUYzkhi1sStP8',
            ]);
            expect(out.labels).toEqual(['+39 0985 876578', 'Indicazioni']);
            expect(out.anchors[1].attrs.target).toBe('_blank');
            expect(out.anchors[1].attrs.rel).toBe('noopener');
            // Il telefono italiano senza «+» si chiama com'è scritto (cifre).
            const italiano = runOrdinaHeaderLinks(script, { phone: '0985 876578' });
            expect(italiano.anchors[0].attrs.href).toBe('tel:0985876578');
        });

        it('/prenota: sito e mappa passano da safeHttpUrl, mai dritti nell\'href', async () => {
            const res = await api().get(`/prenota/${SLUG_OSTILE}`);
            const [script] = inlineScripts(res.text);
            // Controllo mirato sui due punti dell'audit: prima erano
            // `brandLink.href = branding.website_url` e
            // `addPill(branding.maps_url, …)`.
            expect(script).not.toMatch(/brandLink\.href\s*=\s*branding\./);
            expect(script).not.toMatch(/addPill\(\s*branding\.maps_url/);
            expect(script).toMatch(/const websiteUrl = safeHttpUrl\(branding\.website_url\)/);
            expect(script).toMatch(/const mapsUrl = safeHttpUrl\(branding\.maps_url\)/);
            // E safeHttpUrl fa davvero quello che promette.
            const start = script.indexOf('const safeHttpUrl = v => {');
            const end = script.indexOf('\n    };', start);
            expect(start).toBeGreaterThan(-1);
            const src = script.slice(start, end + '\n    };'.length);
            const ctx = vm.createContext({ URL, location: { href: 'https://prenota.example.test/prenota/x' } });
            const safe = vm.runInContext(`${src}\nsafeHttpUrl`, ctx) as (v: unknown) => string | null;
            expect(safe(JS_URL)).toBeNull();
            expect(safe(' JavaScript:alert(1)')).toBeNull();
            expect(safe('java\tscript:alert(1)')).toBeNull();
            expect(safe('data:text/html,<script>alert(1)</script>')).toBeNull();
            expect(safe('')).toBeNull();
            expect(safe(undefined)).toBeNull();
            expect(safe('https://www.vecchiofrantoio.com')).toBe('https://www.vecchiofrantoio.com/');
            // Un dominio senza schema resta quello che il browser ne faceva
            // già: un link relativo alla pagina, non un link rotto.
            expect(safe('www.esempio.it')).toBe('https://prenota.example.test/prenota/www.esempio.it');
        });
    });

    describe('blocco contatti delle email', () => {
        it('escapa ogni valore e omette una mappa che non è http(s)', () => {
            for (const mapsUrl of [JS_URL, BREAKOUT, 'data:text/html,x', '/percorso/relativo', '']) {
                const html = renderContactBlockHtml({ phone: BREAKOUT, whatsapp: BREAKOUT, mapsUrl }, false);
                expect(html).not.toContain('<img src=x onerror');
                expect(html).not.toContain('javascript:');
                expect(html).not.toContain('Come raggiungerci');
                expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
            }
            const quoted = renderContactBlockHtml({ phone: '0985 876578', whatsapp: '+39 389', mapsUrl: `https://maps.example/?q=a"b<c` }, true);
            expect(quoted).toContain('href="https://maps.example/?q=a%22b%3Cc"');
            expect(quoted).toContain('Get directions');
            expect(safeHttpUrlEmail(JS_URL)).toBeNull();
            expect(safeHttpUrlEmail('www.esempio.it')).toBeNull();
        });

        it('con i dati del Frantoio il markup è identico a prima', () => {
            // Il template storico (server.ts fino a questa PR), con i valori
            // di IDENTITY_FALLBACK: le email del tenant 1 non devono cambiare.
            const id = { phone: '0985 876578', whatsapp: '+39 389 591 6494', mapsUrl: 'https://maps.app.goo.gl/pf1DjUYzkhi1sStP8' };
            const expected = `
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;">
        <tr>
          <td style="font-size:13px;line-height:1.6;color:#57534e;padding:8px 12px;border:1px solid #e7e5e4;border-radius:10px;background:#fbf9f4;">
            <strong style="color:#292524;">Contattaci direttamente:</strong><br>
            📞 <a href="tel:+390985876578" style="color:#065f46;text-decoration:none;">0985 876578</a>
            &nbsp;·&nbsp;
            💬 <a href="https://wa.me/393895916494" style="color:#065f46;text-decoration:none;">WhatsApp +39 389 591 6494</a>
            &nbsp;·&nbsp;
            📍 <a href="https://maps.app.goo.gl/pf1DjUYzkhi1sStP8" style="color:#065f46;text-decoration:none;">Come raggiungerci</a>
          </td>
        </tr>
      </table>
    `;
            expect(renderContactBlockHtml(id, false)).toBe(expected);
        });
    });

    describe('D-lite: slug di un tenant sul dominio di un altro', () => {
        it('sul dominio del tenant B le pagine del tenant A rispondono 404', async () => {
            for (const url of [`/prenota/${SLUG_OSTILE}`, `/ordina/${SLUG_OSTILE}`, `/m/${SLUG_OSTILE}`, `/privacy/${SLUG_OSTILE}`]) {
                const res = await api().get(url).set('Host', DOMINIO_ALTRO);
                expect(res.status, url).toBe(404);
            }
            const contact = await api().get(`/public/${SLUG_OSTILE}/contact`).set('Host', DOMINIO_ALTRO);
            expect(contact.status).toBe(404);
            expect(contact.body.error).toBe('unknown_slug');
        });

        it('il dominio di un tenant sospeso resta suo: niente slug altrui', async () => {
            // Prima la proprietà dell'host passava da resolveTenantByDomain,
            // che filtra status='active': a tenant sospeso il dominio tornava
            // «di nessuno» e serviva le pagine di chiunque.
            for (const url of [`/prenota/${SLUG_OSTILE}`, `/ordina/${SLUG_OSTILE}`, `/m/${SLUG_OSTILE}`]) {
                const res = await api().get(url).set('Host', DOMINIO_SOSPESO);
                expect(res.status, url).toBe(404);
            }
            const contact = await api().get(`/public/${SLUG_OSTILE}/contact`).set('Host', DOMINIO_SOSPESO);
            expect(contact.status).toBe(404);
            const sitemap = await api().get('/sitemap.xml').set('Host', DOMINIO_SOSPESO);
            expect(sitemap.status).toBe(200);
            expect(sitemap.text).not.toContain(`/prenota/${SLUG_OSTILE}</loc>`);
            expect(sitemap.text).not.toContain(`/prenota/${SLUG_ALTRO}</loc>`);
        });

        it('il punto finale dell\'FQDN non rende il dominio «di nessuno»', async () => {
            // «prenota.escape-altro.test.» è lo stesso host: prima mancava la
            // cache e tenant_domains e serviva ogni slug.
            for (const url of [`/prenota/${SLUG_OSTILE}`, `/ordina/${SLUG_OSTILE}`]) {
                const res = await api().get(url).set('Host', `${DOMINIO_ALTRO}.`);
                expect(res.status, url).toBe(404);
            }
            const own = await api().get(`/prenota/${SLUG_ALTRO}`).set('Host', `${DOMINIO_ALTRO}.`);
            expect(own.status).toBe(200);
            expect(own.text).toContain('<title>Trattoria Altra — Prenota un tavolo</title>');
        });

        it('sull\'host condiviso lo stesso slug resta servito', async () => {
            const page = await api().get(`/prenota/${SLUG_OSTILE}`);
            expect(page.status).toBe(200);
            const contact = await api().get(`/public/${SLUG_OSTILE}/contact`);
            expect(contact.status).toBe(200);
        });

        it('sul suo dominio il tenant B serve le sue pagine, con e senza slug', async () => {
            const withSlug = await api().get(`/prenota/${SLUG_ALTRO}`).set('Host', DOMINIO_ALTRO);
            expect(withSlug.status).toBe(200);
            expect(withSlug.text).toContain('<title>Trattoria Altra — Prenota un tavolo</title>');
            const bare = await api().get('/prenota').set('Host', DOMINIO_ALTRO);
            expect(bare.status).toBe(200);
            expect(bare.text).toContain('<title>Trattoria Altra — Prenota un tavolo</title>');
            const contact = await api().get(`/public/${SLUG_ALTRO}/contact`).set('Host', DOMINIO_ALTRO);
            expect(contact.status).toBe(200);
            expect(contact.body.branding.name).toBe('Trattoria Altra');
        });

        it('la sitemap del dominio del tenant B elenca solo le sue pagine', async () => {
            const own = await api().get('/sitemap.xml').set('Host', DOMINIO_ALTRO);
            expect(own.status).toBe(200);
            expect(own.text).toContain(`/prenota/${SLUG_ALTRO}</loc>`);
            expect(own.text).not.toContain(`/prenota/${SLUG_OSTILE}</loc>`);
            const shared = await api().get('/sitemap.xml');
            expect(shared.text).toContain(`/prenota/${SLUG_OSTILE}</loc>`);
            expect(shared.text).toContain(`/prenota/${SLUG_ALTRO}</loc>`);
        });
    });
});
