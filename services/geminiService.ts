import { GoogleGenAI } from "@google/genai";
import { Reservation, Dish, Table } from "../types";
import { authApiService } from "./authApiService";

const API_URL = import.meta.env.VITE_API_URL || "https://ristomanager-production.up.railway.app";

// gemini-2.5-flash restituisce 404 "no longer available to new users" con le
// chiavi API recenti (stesso motivo per cui aiReplyService usa gemini-3.5-flash,
// verificato il 2026-08-13). Tenere allineati i due percorsi.
const GEMINI_MODEL = 'gemini-3.5-flash';

const getAiClient = () => {
  return new GoogleGenAI({ apiKey: process.env.API_KEY });
};

/**
 * Telemetria consumi Gemini. Legge usageMetadata dalla risposta e lo manda al
 * backend (tabella ai_token_usage), che la pagina "Consumi AI" aggrega.
 * Fire-and-forget: non deve mai far fallire né rallentare la generazione, quindi
 * ogni errore viene silenziato. `response` è il ritorno di generateContent.
 */
const reportGeminiUsage = (feature: string, model: string, response: any): void => {
  try {
    const usage = response?.usageMetadata;
    if (!usage) return;
    const token = authApiService.getAccessToken();
    if (!token) return; // Senza sessione non c'è dove/come registrarlo.
    const body = {
      provider: 'gemini',
      feature,
      model,
      prompt_tokens: usage.promptTokenCount ?? 0,
      output_tokens: usage.candidatesTokenCount ?? 0,
      total_tokens: usage.totalTokenCount ?? 0,
    };
    // keepalive: il POST sopravvive anche se l'utente naviga via subito dopo.
    void fetch(`${API_URL}/ai-usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => { /* telemetria best-effort */ });
  } catch {
    /* mai propagare: la telemetria non deve rompere la feature */
  }
};

export const generateRestaurantReport = async (
  reservations: Reservation[],
  tables: Table[],
  dishes: Dish[]
): Promise<string> => {
  try {
    const ai = getAiClient();

    const dataContext = `
      Dati Ristorante:
      - Totale Tavoli: ${tables.length}
      - Totale Prenotazioni Attive: ${reservations.length}
      - Piatti nel Menu: ${dishes.length}
      
      Dettaglio Prenotazioni (campione):
      ${JSON.stringify(reservations.slice(0, 10))}
    `;

    const prompt = `
      Sei un esperto consulente di gestione ristoranti. Analizza i seguenti dati (in formato JSON/testo) e genera un report conciso e professionale in Italiano.
      
      ${dataContext}
      
      Il report deve includere:
      1. Un riassunto della situazione attuale.
      2. Suggerimenti per ottimizzare l'occupazione dei tavoli.
      3. Analisi di eventuali trend basata sui dati forniti (es. orari di punta).
      4. Un tono motivazionale per lo staff.
      
      Usa formattazione Markdown.
    `;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
    });

    reportGeminiUsage('dashboard_report', GEMINI_MODEL, response);
    return response.text || "Impossibile generare il report al momento.";
  } catch (error) {
    console.error("Errore Gemini:", error);
    return "Errore durante la comunicazione con l'assistente AI. Verifica la tua chiave API.";
  }
};

export const suggestBanquetMenu = async (
  budget: number,
  guests: number,
  preferences: string
): Promise<string> => {
    try {
        const ai = getAiClient();
        const response = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: `Crea una proposta di menu per un banchetto di ${guests} persone con un budget di €${budget} a persona.
            Preferenze cliente: ${preferences}.
            Restituisci il menu formattato bene in Markdown con antipasti, primi, secondi e dolci, includendo i prezzi stimati per piatto.`
        });
        reportGeminiUsage('banquet_menu', GEMINI_MODEL, response);
        return response.text || "Nessun suggerimento disponibile.";
    } catch (e) {
        console.error(e);
        return "Errore generazione menu.";
    }
}