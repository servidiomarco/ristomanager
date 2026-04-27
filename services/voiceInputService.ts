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

// Start voice recognition and return the transcribed text
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

    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      resolve(transcript);
    };

    recognition.onerror = (event: any) => {
      reject(new Error(event.error));
    };

    recognition.onend = () => {
      // If no result was captured, reject
    };

    recognition.start();
  });
};

// Parse Italian text to extract reservation data
export const parseReservationText = (text: string): ParsedReservation => {
  const result: ParsedReservation = {};
  const lowerText = text.toLowerCase();

  console.log('Voice input received:', text);
  console.log('Lowercase:', lowerText);

  // Extract name using multiple strategies
  const stopWords = ['oggi', 'domani', 'dopodomani', 'sera', 'stasera', 'pranzo', 'cena', 'alle', 'ore', 'per', 'in', 'persone', 'persona', 'coperti', 'coperto', 'ospiti', 'tavolo', 'prenotazione', '\\d'];

  // Strategy 1: "per [nome]", "a nome [nome]", "nome [nome]"
  let nameMatch = lowerText.match(/(?:per|a nome|nome)\s+([a-zA-ZàèéìòùÀÈÉÌÒÙ]+(?:\s+[a-zA-ZàèéìòùÀÈÉÌÒÙ]+)?)/i);

  // Strategy 2: "prenotazione [nome]" or "prenotazione per [nome]"
  if (!nameMatch) {
    nameMatch = lowerText.match(/prenotazione\s+(?:per\s+)?([a-zA-ZàèéìòùÀÈÉÌÒÙ]+(?:\s+[a-zA-ZàèéìòùÀÈÉÌÒÙ]+)?)/i);
  }

  // Strategy 3: Name at the beginning of the phrase (before any keyword)
  if (!nameMatch) {
    const stopWordsPattern = stopWords.join('|');
    nameMatch = lowerText.match(new RegExp(`^([a-zA-ZàèéìòùÀÈÉÌÒÙ]+(?:\\s+[a-zA-ZàèéìòùÀÈÉÌÒÙ]+)?)\\s+(?:${stopWordsPattern})`, 'i'));
  }

  if (nameMatch) {
    // Filter out stop words from the captured name
    const words = nameMatch[1].trim().split(/\s+/)
      .filter(word => !stopWords.includes(word.toLowerCase()))
      .slice(0, 3);

    if (words.length > 0) {
      result.customer_name = words
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
      console.log('Name extracted:', result.customer_name);
    }
  }

  // Extract guests: "[n] persone" or "[n] coperti" or "in [n]"
  const guestPatterns = [
    /(\d+)\s*(?:persone|persona|coperti|coperto|ospiti|ospite|pax)/i,
    /(?:per|in)\s+(\d+)(?:\s|$)/i,
    /(due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici)\s*(?:persone|coperti|ospiti|pax)?/i
  ];

  for (const pattern of guestPatterns) {
    const match = lowerText.match(pattern);
    if (match) {
      const num = match[1];
      result.guests = isNaN(Number(num)) ? wordToNumber(num) : Number(num);
      console.log('Guests extracted:', result.guests);
      break;
    }
  }

  // Extract date
  const today = new Date();
  if (lowerText.includes('oggi')) {
    result.reservation_time = formatDateForInput(today);
    console.log('Date: oggi');
  } else if (lowerText.includes('domani')) {
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    result.reservation_time = formatDateForInput(tomorrow);
    console.log('Date: domani');
  } else if (lowerText.includes('dopodomani')) {
    const dayAfter = new Date(today);
    dayAfter.setDate(today.getDate() + 2);
    result.reservation_time = formatDateForInput(dayAfter);
    console.log('Date: dopodomani');
  }

  // Extract time - multiple patterns
  let hours: string | null = null;
  let minutes: string = '00';

  // Pattern 1: "alle 20:30" or "ore 20:30" or "alle 20 30" or "20:30"
  let timeMatch = lowerText.match(/(?:alle|ore|alle ore)?\s*(\d{1,2})[:\s](\d{2})/);
  if (timeMatch) {
    hours = timeMatch[1];
    minutes = timeMatch[2];
    console.log('Time pattern 1 matched:', hours, minutes);
  }

  // Pattern 2: "alle 20 e 30" or "alle venti e trenta"
  if (!hours) {
    timeMatch = lowerText.match(/(?:alle|ore)\s*(\d{1,2}|venti|ventuno|diciannove|diciotto)\s*e\s*(\d{1,2}|trenta|mezza|quindici|quarantacinque)/i);
    if (timeMatch) {
      hours = convertTimeWord(timeMatch[1]);
      minutes = convertMinuteWord(timeMatch[2]);
      console.log('Time pattern 2 matched:', hours, minutes);
    }
  }

  // Pattern 3: "alle 20" or "ore 20" (just hour, no minutes)
  if (!hours) {
    timeMatch = lowerText.match(/(?:alle|ore|alle ore)\s*(\d{1,2}|venti|ventuno|diciannove|diciotto|tredici|quattordici)(?!\s*\d)/i);
    if (timeMatch) {
      hours = convertTimeWord(timeMatch[1]);
      console.log('Time pattern 3 matched:', hours);
    }
  }

  if (hours) {
    const paddedHours = hours.padStart(2, '0');
    const paddedMinutes = minutes.padStart(2, '0');
    console.log('Final time:', paddedHours + ':' + paddedMinutes);

    // If we have a date, append the time
    if (result.reservation_time) {
      result.reservation_time = result.reservation_time.substring(0, 11) + `${paddedHours}:${paddedMinutes}`;
    } else {
      // Use today's date with the extracted time
      const dateWithTime = formatDateForInput(today);
      result.reservation_time = dateWithTime.substring(0, 11) + `${paddedHours}:${paddedMinutes}`;
    }
  }

  // Determine shift from time or keywords
  if (lowerText.includes('pranzo') || lowerText.includes('mezzogiorno')) {
    result.shift = Shift.LUNCH;
    console.log('Shift: LUNCH');
  } else if (lowerText.includes('cena') || lowerText.includes('sera') || lowerText.includes('stasera')) {
    result.shift = Shift.DINNER;
    console.log('Shift: DINNER');
  } else if (timeMatch) {
    const hour = parseInt(timeMatch[1]);
    result.shift = (hour >= 11 && hour < 17) ? Shift.LUNCH : Shift.DINNER;
    console.log('Shift from time:', result.shift);
  }

  // Extract phone (10 digits, possibly with spaces)
  const phoneMatch = text.match(/(\d[\d\s]{9,})/);
  if (phoneMatch) {
    const cleanPhone = phoneMatch[1].replace(/\s/g, '');
    if (cleanPhone.length >= 10) {
      result.phone = cleanPhone;
      console.log('Phone extracted:', result.phone);
    }
  }

  console.log('Final parsed result:', result);
  return result;
};

// Helper: convert Italian word to number (for guests)
const wordToNumber = (word: string): number => {
  const numbers: Record<string, number> = {
    'uno': 1, 'una': 1, 'due': 2, 'tre': 3, 'quattro': 4,
    'cinque': 5, 'sei': 6, 'sette': 7, 'otto': 8, 'nove': 9,
    'dieci': 10, 'undici': 11, 'dodici': 12
  };
  return numbers[word.toLowerCase()] || 2;
};

// Helper: convert time word to hour string
const convertTimeWord = (word: string): string => {
  const hours: Record<string, string> = {
    'dodici': '12', 'tredici': '13', 'quattordici': '14', 'quindici': '15',
    'sedici': '16', 'diciassette': '17', 'diciotto': '18', 'diciannove': '19',
    'venti': '20', 'ventuno': '21', 'ventidue': '22', 'ventitre': '23'
  };
  return hours[word.toLowerCase()] || word;
};

// Helper: convert minute word to minute string
const convertMinuteWord = (word: string): string => {
  const mins: Record<string, string> = {
    'mezza': '30', 'trenta': '30', 'quindici': '15', 'quarantacinque': '45',
    'quaranta': '40', 'venti': '20', 'dieci': '10', 'cinque': '05'
  };
  return mins[word.toLowerCase()] || word;
};

// Helper: format date for datetime-local input (YYYY-MM-DDTHH:MM) in Rome timezone
const formatDateForInput = (date: Date): string => {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  };

  const formatter = new Intl.DateTimeFormat('it-IT', options);
  const parts = formatter.formatToParts(date);

  const year = parts.find(p => p.type === 'year')?.value || '';
  const month = parts.find(p => p.type === 'month')?.value || '';
  const day = parts.find(p => p.type === 'day')?.value || '';
  const hour = parts.find(p => p.type === 'hour')?.value || '';
  const minute = parts.find(p => p.type === 'minute')?.value || '';

  return `${year}-${month}-${day}T${hour}:${minute}`;
};
