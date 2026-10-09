import React from 'react';
import { Phone, MapPin, MessageCircle, Globe } from 'lucide-react';

/* La carta d'identità del ristorante in fondo alle pagine pubbliche React
   (preventivo, «La tua prenotazione»): chi parla e come raggiungerlo con un
   tocco. I dati arrivano già pronti da publicBusinessCard in server.ts. */

export interface PublicBusiness {
  name: string;
  tagline: string | null;
  phone: string | null;
  whatsapp: string | null;
  address: string | null;
  maps_url: string | null;
  website_url: string | null;
  logo_url: string | null;
}

export const PublicBusinessCard: React.FC<{ business: PublicBusiness }> = ({ business }) => (
  <div className="mt-4 rounded-[var(--ds-radius)] bg-[var(--ds-surface)] px-5 py-4 shadow-[var(--ds-shadow-card)]">
    <p className="text-[14px] font-semibold text-[var(--ds-text-primary)]">{business.name}</p>
    {business.tagline && (
      <p className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">{business.tagline}</p>
    )}
    {business.address && (
      business.maps_url ? (
        <a
          href={business.maps_url}
          target="_blank"
          rel="noopener"
          className="mt-2 inline-flex min-h-11 items-center justify-center gap-1 text-[var(--ds-text-secondary)] underline decoration-[var(--ds-border-strong)] underline-offset-2"
        >
          <MapPin className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />{business.address}
        </a>
      ) : (
        <p className="mt-2 inline-flex min-h-11 items-center justify-center gap-1 text-[var(--ds-text-secondary)]">
          <MapPin className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />{business.address}
        </p>
      )
    )}
    <p className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1">
      {business.phone && (
        <a href={`tel:${business.phone.replace(/\s+/g, '')}`} className="inline-flex min-h-11 items-center gap-1.5 text-[var(--ds-text-secondary)]">
          <Phone className="h-3.5 w-3.5" aria-hidden />{business.phone}
        </a>
      )}
      {business.whatsapp && (
        <a
          href={`https://wa.me/${business.whatsapp.replace(/\D/g, '').replace(/^00/, '')}`}
          target="_blank"
          rel="noopener"
          className="inline-flex min-h-11 items-center gap-1.5 text-[var(--ds-text-secondary)]"
        >
          <MessageCircle className="h-3.5 w-3.5" aria-hidden />WhatsApp
        </a>
      )}
      {business.website_url && (
        <a
          href={business.website_url}
          target="_blank"
          rel="noopener"
          className="inline-flex min-h-11 items-center gap-1.5 text-[var(--ds-text-secondary)]"
        >
          <Globe className="h-3.5 w-3.5" aria-hidden />
          {business.website_url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
        </a>
      )}
    </p>
  </div>
);
