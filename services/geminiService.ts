import { GoogleGenAI } from "@google/genai";
import { Reservation, Dish, Table } from "../types";

const getAiClient = () => {
  return new GoogleGenAI({ apiKey: process.env.API_KEY });
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
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

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
            model: 'gemini-2.5-flash',
            contents: `Crea una proposta di menu per un banchetto di ${guests} persone con un budget di €${budget} a persona.
            Preferenze cliente: ${preferences}.
            Restituisci il menu formattato bene in Markdown con antipasti, primi, secondi e dolci, includendo i prezzi stimati per piatto.`
        });
        return response.text || "Nessun suggerimento disponibile.";
    } catch (e) {
        console.error(e);
        return "Errore generazione menu.";
    }
}