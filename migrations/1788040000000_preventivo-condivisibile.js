/* Link pubblico del preventivo banchetto: share_token opaco (32 char
 * base64url ≈ 192 bit), generato alla prima condivisione. Il token È la
 * capability — la pagina /preventivo/<token> non chiede login, come
 * /pay/<token> e /scontrino/<token>.
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE banquet_menus ADD COLUMN share_token VARCHAR(64);`);
    pgm.sql(`CREATE UNIQUE INDEX banquet_menus_share_token ON banquet_menus (share_token) WHERE share_token IS NOT NULL;`);
};

export const down = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS banquet_menus_share_token;`);
    pgm.sql(`ALTER TABLE banquet_menus DROP COLUMN IF EXISTS share_token;`);
};
