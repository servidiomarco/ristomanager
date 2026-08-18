import React, { useEffect, useState } from 'react';

const WIDGET_SCRIPT_URL = 'https://elevenlabs.io/convai-widget/index.js';
const WIDGET_SCRIPT_ID = 'elevenlabs-convai-widget';
// L'agent id arriva da /public/contact (env ELEVENLABS_AGENT_ID del backend):
// tenerlo nel bundle legava il frontend a un singolo ristorante. Senza id
// configurato il widget non si monta.
const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

declare module 'react' {
    namespace JSX {
        interface IntrinsicElements {
            'elevenlabs-convai': React.DetailedHTMLProps<
                React.HTMLAttributes<HTMLElement> & {
                    'agent-id': string;
                    variant?: string;
                    expandable?: string;
                },
                HTMLElement
            >;
        }
    }
}

// Pin the widget to the top-right corner. Use the iOS safe-area inset so
// it clears the status bar / notch on PWA installs; bottom is reset to
// `auto` because the widget's default :host rule positions from bottom.
const POSITION_OVERRIDE_CSS = `
:host {
    top: calc(env(safe-area-inset-top, 0px) + 16px) !important;
    right: 16px !important;
    bottom: auto !important;
    left: auto !important;
}
`;

export const VoiceAgentWidget: React.FC = () => {
    const [agentId, setAgentId] = useState<string>('');

    useEffect(() => {
        let cancelled = false;
        fetch(`${API_URL}/public/contact`)
            .then(r => (r.ok ? r.json() : null))
            .then(data => {
                if (!cancelled && typeof data?.voice_agent_id === 'string') {
                    setAgentId(data.voice_agent_id);
                }
            })
            .catch(() => { /* senza id il widget resta smontato */ });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        if (!agentId) return;
        if (document.getElementById(WIDGET_SCRIPT_ID)) return;
        const s = document.createElement('script');
        s.id = WIDGET_SCRIPT_ID;
        s.src = WIDGET_SCRIPT_URL;
        s.async = true;
        document.body.appendChild(s);
    }, [agentId]);

    useEffect(() => {
        const inject = (): boolean => {
            const widget = document.querySelector('elevenlabs-convai');
            if (!widget || !widget.shadowRoot) return false;
            if (widget.shadowRoot.querySelector('style[data-position-override]')) return true;
            const style = document.createElement('style');
            style.setAttribute('data-position-override', '');
            style.textContent = POSITION_OVERRIDE_CSS;
            widget.shadowRoot.appendChild(style);
            return true;
        };

        if (inject()) return;
        let attempts = 0;
        const interval = window.setInterval(() => {
            if (inject() || ++attempts > 50) window.clearInterval(interval);
        }, 200);
        return () => window.clearInterval(interval);
    }, []);

    // `variant="compact"` collapses the trigger to a small floating button.
    // `expandable="never"` keeps it from auto-expanding into the larger
    // pre-call panel, so the call is started straight from the compact pill.
    if (!agentId) return null;
    return (
        <elevenlabs-convai
            agent-id={agentId}
            variant="compact"
            expandable="never"
        />
    );
};
