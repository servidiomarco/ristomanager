// Il prezzo battuto viene dal listino della comanda (dish_prices), ma nessuna
// superficie lo ha mai scritto dopo il backfill al boot: cambiare il prezzo in
// anagrafica (scheda piatto o import Passepartout) lasciava il listino fermo
// al valore vecchio, e la battuta addebitava un prezzo diverso da quello che
// palmare e cassa mostrano. Sui piatti al peso il buco urla (6/09, filetto:
// anteprima a €/kg nuovo, conto al €/kg vecchio). Da oggi ogni scrittura del
// prezzo aggiorna anche il listino di default (server.ts); qui si sanano le
// righe già divergenti. Solo il listino di default: non è mai esistita una UI
// per differenziare gli altri, quindi ogni riga qui dentro è nata dal
// backfill dell'anagrafica — riallinearla non cancella scelte di nessuno.
export const up = (pgm) => {
  pgm.sql(`
    UPDATE dish_prices dp
       SET price_cents = GREATEST(0, ROUND(d.price * 100))::int
      FROM dishes d, menu_price_lists pl
     WHERE dp.dish_id = d.id
       AND dp.tenant_id = d.tenant_id
       AND dp.price_list_id = pl.id
       AND pl.tenant_id = dp.tenant_id
       AND pl.is_default
       AND dp.price_cents <> GREATEST(0, ROUND(d.price * 100))::int;
  `);
};

export const down = () => {
  // I valori vecchi erano il bug: non c'è niente da ripristinare.
};
