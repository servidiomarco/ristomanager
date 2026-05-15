import React, { useEffect } from 'react';

const WIDGET_SCRIPT_URL = 'https://elevenlabs.io/convai-widget/index.js';
const WIDGET_SCRIPT_ID = 'elevenlabs-convai-widget';
const AGENT_ID = 'agent_5401kq7cjqa8evzbvwpbeghefm6w';

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

// On mobile (<1024px, where our bottom tab bar is shown) we lift the
// widget above the nav so it doesn't overlap the tab buttons. The bar is
// ~72px tall and sits below the iOS safe-area, so the offset combines
// both plus a small gap.
const POSITION_OVERRIDE_CSS = `
@media (max-width: 1023.98px) {
    :host {
        bottom: calc(72px + env(safe-area-inset-bottom, 0px) + 16px) !important;
        right: 16px !important;
    }
}
`;

export const VoiceAgentWidget: React.FC = () => {
    useEffect(() => {
        if (document.getElementById(WIDGET_SCRIPT_ID)) return;
        const s = document.createElement('script');
        s.id = WIDGET_SCRIPT_ID;
        s.src = WIDGET_SCRIPT_URL;
        s.async = true;
        document.body.appendChild(s);
    }, []);

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
    return (
        <elevenlabs-convai
            agent-id={AGENT_ID}
            variant="compact"
            expandable="never"
        />
    );
};
