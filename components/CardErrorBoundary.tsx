import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props {
    label: string;
    children: React.ReactNode;
}

interface State {
    error: Error | null;
}

export class CardErrorBoundary extends React.Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error('[CardErrorBoundary]', this.props.label, error, info);
    }

    render() {
        if (this.state.error) {
            return (
                <div className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
                    <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[12px] bg-[var(--ds-critical-tint)]">
                            <AlertTriangle className="h-5 w-5 text-[var(--ds-critical-text)]" />
                        </div>
                        <div className="min-w-0">
                            <h4 className="text-[15px] font-semibold text-[var(--ds-text-primary)]">
                                {this.props.label} — errore di rendering
                            </h4>
                            <p className="break-words text-[13px] text-[var(--ds-critical-text)]">
                                {this.state.error.message || String(this.state.error)}
                            </p>
                            <button
                                type="button"
                                onClick={() => this.setState({ error: null })}
                                className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-[var(--ds-surface-row)] px-3 py-1.5 text-[13px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                            >
                                Riprova
                            </button>
                        </div>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}
