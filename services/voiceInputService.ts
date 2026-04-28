import { Shift } from '../types';

export interface ParsedReservation {
  customer_name?: string;
  guests?: number;
  reservation_time?: string;
  shift?: Shift;
  phone?: string;
  notes?: string;
}

// Check browser support for Web Speech API
export const isVoiceSupported = (): boolean => {
  return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
};

// Start voice recognition and return the transcript
export const startListening = (): Promise<string> => {
  return new Promise((resolve, reject) => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      reject(new Error('Voice recognition not supported'));
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'it-IT';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      resolve(transcript);
    };

    recognition.onerror = (event: any) => {
      reject(new Error(event.error));
    };

    recognition.onend = () => {
      // Recognition ended without result
    };

    recognition.start();
  });
};

// Helper: convert Italian number words to digits
const wordToNumber = (word: string): number => {
  const numbers: Record<string, number> = {
    'uno': 1, 'una': 1, 'un': 1,
    'due': 2,
    'tre': 3,
    'quattro': 4,
    'cinque': 5,
    'sei': 6,
    'sette': 7,
    'otto': 8,
    'nove': 9,
    'dieci': 10,
    'undici': 11,
    'dodici': 12,
    'tredici': 13,
    'quattordici': 14,
    'quindici': 15,
    'sedici': 16,
    'diciassette': 17,
    'diciotto': 18,
    'diciannove': 19,
    'venti': 20
  };
  return numbers[word.toLowerCase()] || parseInt(word) || 2;
};

// Helper: format date for datetime-local input (YYYY-MM-DDTHH:MM)
const formatDateForInput = (date: Date, hours?: number, minutes?: number): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const h = String(hours ?? date.getHours()).padStart(2, '0');
  const m = String(minutes ?? date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${h}:${m}`;
};

// Parse Italian text to extract reservation data
export const parseReservationText = (text: string): ParsedReservation => {
  const result: ParsedReservation = {};
  const lowerText = text.toLowerCase();

  // Words that signal end of name
  const stopWords = [
    'domani', 'oggi', 'dopodomani', 'sera', 'pranzo', 'cena',
    'alle', 'ore', 'per', 'persone', 'persona', 'coperti', 'coperto',
    'tavolo', 'in', 'il', 'la', 'lo', 'gli', 'le', 'un', 'una',
    'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica',
    'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi',
    '\\d' // numbers
  ];
  const stopWordsPattern = new RegExp(`\\s+(${stopWords.join('|')})`, 'i');

  // Extract name: multiple patterns to catch different phrasings
  // Pattern 1: "prenotazione per [nome]" or "per [nome]"
  // Pattern 2: "a nome [nome]" or "nome [nome]"
  // Pattern 3: "prenotazione [nome]" (without "per")
  const namePatterns = [
    /(?:prenotazione\s+)?per\s+([a-zàèéìòùA-Z][a-zàèéìòùA-Z\s]+?)(?=\s+(?:domani|oggi|dopodomani|sera|pranzo|cena|alle|ore|per\s+\d|in\s+\d|\d+\s*person|\d+\s*copert|tavolo|$))/i,
    /a\s+nome\s+([a-zàèéìòùA-Z][a-zàèéìòùA-Z\s]+?)(?=\s+(?:domani|oggi|dopodomani|sera|pranzo|cena|alle|ore|per\s+\d|in\s+\d|\d+\s*person|\d+\s*copert|tavolo|$))/i,
    /nome\s+([a-zàèéìòùA-Z][a-zàèéìòùA-Z\s]+?)(?=\s+(?:domani|oggi|dopodomani|sera|pranzo|cena|alle|ore|per\s+\d|in\s+\d|\d+\s*person|\d+\s*copert|tavolo|$))/i,
    // Fallback: simpler patterns
    /(?:prenotazione\s+)?per\s+([a-zàèéìòùA-Z]+(?:\s+[a-zàèéìòùA-Z]+)?)/i,
    /a\s+nome\s+([a-zàèéìòùA-Z]+(?:\s+[a-zàèéìòùA-Z]+)?)/i,
    /nome\s+([a-zàèéìòùA-Z]+(?:\s+[a-zàèéìòùA-Z]+)?)/i,
  ];

  for (const pattern of namePatterns) {
    const match = lowerText.match(pattern);
    if (match && match[1]) {
      // Clean up and capitalize
      let name = match[1].trim();
      // Remove any trailing stop words that might have been captured
      name = name.replace(stopWordsPattern, '').trim();
      // Skip if name is a stop word itself
      if (stopWords.some(sw => name.toLowerCase() === sw)) continue;
      // Skip if name is too short (likely not a real name)
      if (name.length < 2) continue;

      // Capitalize first letter of each word
      result.customer_name = name
        .split(' ')
        .filter(w => w.length > 0)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
      break;
    }
  }

  // Extract guests: "[n] persone", "[n] coperti", "in [n]", "per [n]"
  const guestPatterns = [
    /(\d+)\s*(?:persone|persona|coperti|coperto|ospiti|ospite|posti|posto)/i,
    /(?:in|per)\s+(\d+)(?:\s|$)/i,
    /(uno|una|un|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|tredici|quattordici|quindici|sedici|diciassette|diciotto|diciannove|venti)\s*(?:persone|persona|coperti|coperto|ospiti|ospite|posti|posto)?/i
  ];

  for (const pattern of guestPatterns) {
    const match = lowerText.match(pattern);
    if (match && match[1]) {
      const num = match[1];
      result.guests = isNaN(Number(num)) ? wordToNumber(num) : Number(num);
      break;
    }
  }

  // Extract date
  const today = new Date();
  let targetDate: Date | null = null;

  if (lowerText.includes('oggi')) {
    targetDate = new Date(today);
  } else if (lowerText.includes('domani')) {
    targetDate = new Date(today);
    targetDate.setDate(today.getDate() + 1);
  } else if (lowerText.includes('dopodomani')) {
    targetDate = new Date(today);
    targetDate.setDate(today.getDate() + 2);
  } else {
    // Try to match day of week
    const dayNames: Record<string, number> = {
      'lunedì': 1, 'lunedi': 1,
      'martedì': 2, 'martedi': 2,
      'mercoledì': 3, 'mercoledi': 3,
      'giovedì': 4, 'giovedi': 4,
      'venerdì': 5, 'venerdi': 5,
      'sabato': 6,
      'domenica': 0
    };

    for (const [dayName, dayNum] of Object.entries(dayNames)) {
      if (lowerText.includes(dayName)) {
        targetDate = new Date(today);
        const currentDay = today.getDay();
        let daysUntil = dayNum - currentDay;
        if (daysUntil <= 0) daysUntil += 7; // Next week
        targetDate.setDate(today.getDate() + daysUntil);
        break;
      }
    }
  }

  // Extract time: "alle [ora]", "ore [ora]", "[ora]:[minuti]"
  let hours: number | undefined;
  let minutes: number | undefined;

  const timePatterns = [
    /(?:alle|ore|all')\s*(\d{1,2})(?:[:\.](\d{2}))?/i,
    /(\d{1,2})[:\.](\d{2})/,
    /(\d{1,2})\s*(?:e\s*(?:mezza|mezzo|trenta|quindici|quarantacinque))/i
  ];

  for (const pattern of timePatterns) {
    const match = lowerText.match(pattern);
    if (match) {
      hours = parseInt(match[1]);
      if (match[2]) {
        minutes = parseInt(match[2]);
      } else if (lowerText.includes('mezza') || lowerText.includes('mezzo') || lowerText.includes('trenta')) {
        minutes = 30;
      } else if (lowerText.includes('quindici')) {
        minutes = 15;
      } else if (lowerText.includes('quarantacinque')) {
        minutes = 45;
      } else {
        minutes = 0;
      }
      break;
    }
  }

  // If no date specified but we have a time, default to today
  if (!targetDate && hours !== undefined) {
    targetDate = new Date(today);
  }

  // Build reservation_time if we have date info
  if (targetDate) {
    result.reservation_time = formatDateForInput(
      targetDate,
      hours ?? (lowerText.includes('pranzo') ? 13 : lowerText.includes('cena') || lowerText.includes('sera') ? 20 : undefined),
      minutes ?? 0
    );
  }

  // Determine shift from time or keywords
  if (lowerText.includes('pranzo') || lowerText.includes('mezzogiorno')) {
    result.shift = Shift.LUNCH;
  } else if (lowerText.includes('cena') || lowerText.includes('sera')) {
    result.shift = Shift.DINNER;
  } else if (hours !== undefined) {
    // Infer shift from time
    result.shift = (hours >= 11 && hours < 17) ? Shift.LUNCH : Shift.DINNER;
  }

  // Extract phone number (10 digits, possibly with spaces)
  const phoneMatch = text.match(/(\d[\d\s]{8,12}\d)/);
  if (phoneMatch) {
    result.phone = phoneMatch[1].replace(/\s/g, '');
  }

  // Extract notes - anything after "nota:", "note:", "con", etc.
  const notesMatch = lowerText.match(/(?:nota|note|con|richiesta|richieste)[:\s]+(.+?)(?:\.|$)/);
  if (notesMatch) {
    result.notes = notesMatch[1].trim();
  }

  return result;
};
