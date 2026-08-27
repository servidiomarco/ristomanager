// Avviso sonoro dei monitor di cucina e passe. Sintetizzato al volo con la
// WebAudio API invece di un file: niente asset da servire e da tenere in
// cache, e il suono parte senza attese anche alla prima riproduzione.
//
// Solo frontend: non è incluso in tsconfig.server.json e non va importato dal
// server (AudioContext non esiste in Node).

let ctx: AudioContext | null = null;

// I browser tengono l'AudioContext sospeso finché l'utente non interagisce
// con la pagina: il primo tocco qualsiasi (scelta partita, una spunta) lo
// sblocca. Se il permesso non c'è ancora, il monitor resta visivo e basta.
export const chime = (): void => {
  try {
    ctx = ctx ?? new AudioContext();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t = ctx.currentTime;
    // Due note brevi in salita: si distingue dal rumore di fondo di una
    // cucina meglio di un beep singolo, senza essere un allarme.
    for (const [freq, at] of [[740, 0], [988, 0.12]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + at);
      gain.gain.exponentialRampToValueAtTime(0.25, t + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t + at);
      osc.stop(t + at + 0.32);
    }
  } catch {
    /* niente audio: solo l'avviso visivo */
  }
};
