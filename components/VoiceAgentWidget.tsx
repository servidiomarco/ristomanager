import React, { useEffect } from 'react';

const WIDGET_SCRIPT_URL = 'https://elevenlabs.io/convai-widget/index.js';
const WIDGET_SCRIPT_ID = 'elevenlabs-convai-widget';
const AGENT_ID = 'agent_5401kq7cjqa8evzbvwpbeghefm6w';

declare module 'react' {
    namespace JSX {
        interface IntrinsicElements {
            'elevenlabs-convai': React.DetailedHTMLProps<
                React.HTMLAttributes<HTMLElement> & { 'agent-id': string },
                HTMLElement
            >;
        }
    }
}

// The widget pins itself to bottom-right via :host CSS inside its shadow DOM
// (`position: fixed; right: 32px; bottom: 32px;`) and stacks expanded UI
// upward with `flex-direction: column-reverse`. To move it to top-right we
// inject a sibling <style> inside the shadow root that flips both rules.
const POSITION_OVERRIDE_CSS = `
:host {
    top: 1rem !important;
    right: 1rem !important;
    bottom: auto !important;
    left: auto !important;
}
[class*="_wrapper_"] {
    flex-direction: column !important;
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

    return <elevenlabs-convai agent-id={AGENT_ID} />;
};
