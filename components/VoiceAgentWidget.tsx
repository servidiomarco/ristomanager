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

export const VoiceAgentWidget: React.FC = () => {
    useEffect(() => {
        if (document.getElementById(WIDGET_SCRIPT_ID)) return;
        const s = document.createElement('script');
        s.id = WIDGET_SCRIPT_ID;
        s.src = WIDGET_SCRIPT_URL;
        s.async = true;
        document.body.appendChild(s);
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
