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
                <div className="bg-[var(--color-surface)] rounded-lg border border-rose-300 dark:border-rose-500/40 p-4">
                    <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-md bg-rose-50 dark:bg-rose-500/15 flex items-center justify-center flex-shrink-0">
                            <AlertTriangle className="w-5 h-5 text-rose-600 dark:text-rose-400" />
                        </div>
                        <div className="min-w-0">
                            <h4 className="font-medium text-[14px] text-[var(--color-fg)]">
                                {this.props.label} — errore di rendering
                            </h4>
                            <p className="text-[12px] text-rose-600 dark:text-rose-400 break-words">
                                {this.state.error.message || String(this.state.error)}
                            </p>
                            <button
                                type="button"
                                onClick={() => this.setState({ error: null })}
                                className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-surface-2)]"
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
