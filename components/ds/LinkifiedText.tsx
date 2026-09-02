import React from 'react';

/* ---------------------------------------------------------------------------
   LinkifiedText — rende cliccabili URL e indirizzi email dentro testo semplice.

   Nato per i corpi email in Messaggi: le email solo-testo (e quelle in
   archivio prima di body_html) arrivano con i link come stringhe nude.
   Il colore resta currentColor così il link segue la bolla che lo ospita
   (bianco su bolla piena in uscita, testo primario in entrata).
--------------------------------------------------------------------------- */

// Un solo gruppo di cattura: con String.split le corrispondenze finiscono
// agli indici dispari. L'ultima classe esclude la punteggiatura di chiusura
// («vedi https://esempio.it.») dal link.
const LINK_RE = /((?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;

const hrefFor = (match: string): string => {
  if (match.startsWith('http')) return match;
  if (match.startsWith('www.')) return `https://${match}`;
  return `mailto:${match}`;
};

export const LinkifiedText: React.FC<{ text: string }> = ({ text }) => (
  <>
    {text.split(LINK_RE).map((part, i) => {
      if (!part) return null;
      if (i % 2 === 1) {
        return (
          <a
            key={i}
            href={hrefFor(part)}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            {part}
          </a>
        );
      }
      return <React.Fragment key={i}>{part}</React.Fragment>;
    })}
  </>
);
