import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Pause, Play } from 'lucide-react';

/**
 * Play control, scrubber and elapsed time for a call recording.
 *
 * The bars are decoration, not amplitude. Real amplitude needs the file decoded,
 * and nothing is downloaded until the first press — so a "real" waveform would
 * be a flat placeholder exactly when the player is most likely to be looked at.
 * A fixed pattern that fills as it plays says the same thing (how far in you
 * are) without pretending to describe the audio.
 */

const BAR_COUNT = 44;
// Deterministic from the index so the pattern never reshuffles on re-render.
const BAR_HEIGHTS = Array.from({ length: BAR_COUNT }, (_, i) =>
  38 + ((i * 37 + (i % 5) * 17) % 62)
);

const clock = (secs: number): string => {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

export const CallRecordingPlayer: React.FC<{
  /** Object URL once fetched; null until the first play. */
  src: string | null;
  /** Known up front from the call row, so the total reads right before load. */
  durationSeconds?: number | null;
  loading: boolean;
  /** Fetches the recording. Playback starts as soon as src arrives. */
  onLoad: () => void;
}> = ({ src, durationSeconds, loading, onLoad }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [actualDuration, setActualDuration] = useState<number | null>(null);
  // Set when play is pressed before the file exists; consumed once it arrives.
  const autoPlayRef = useRef(false);

  const total = actualDuration ?? durationSeconds ?? 0;
  const progress = total > 0 ? Math.min(1, elapsed / total) : 0;

  useEffect(() => {
    if (!src || !autoPlayRef.current) return;
    autoPlayRef.current = false;
    audioRef.current?.play().catch(() => setPlaying(false));
  }, [src]);

  const toggle = useCallback(() => {
    if (!src) {
      autoPlayRef.current = true;
      onLoad();
      return;
    }
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => setPlaying(false));
    else el.pause();
  }, [src, onLoad]);

  const seekTo = useCallback((fraction: number) => {
    const el = audioRef.current;
    if (!el || !total) return;
    el.currentTime = Math.max(0, Math.min(total, fraction * total));
    setElapsed(el.currentTime);
  }, [total]);

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={toggle}
        disabled={loading}
        aria-label={playing ? 'Metti in pausa' : 'Riproduci'}
        className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" />
          : playing ? <Pause className="h-4 w-4" />
          : <Play className="h-4 w-4 translate-x-px" />}
      </button>

      {/* A slider, not a row of divs: keyboard and screen-reader users get
          seeking for free, and the bars are painted behind it. */}
      <div className="relative min-w-0 flex-1">
        <div className="pointer-events-none flex h-8 items-center gap-[3px]" aria-hidden>
          {BAR_HEIGHTS.map((h, i) => (
            <span
              key={i}
              className={`w-full flex-1 rounded-full transition-colors ${
                i / BAR_COUNT <= progress
                  ? 'bg-[var(--ds-action-bg)]'
                  : 'bg-[var(--ds-border-strong)]'
              }`}
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(progress * 1000)}
          onChange={e => seekTo(Number(e.target.value) / 1000)}
          disabled={!src || !total}
          aria-label="Posizione nella registrazione"
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-default"
        />
      </div>

      <span className="flex-shrink-0 text-[13px] tabular-nums text-[var(--ds-text-muted)]">
        {playing || elapsed > 0 ? `${clock(elapsed)} / ${clock(total)}` : clock(total)}
      </span>

      {src && (
        <audio
          ref={audioRef}
          src={src}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setElapsed(0); }}
          onTimeUpdate={e => setElapsed((e.target as HTMLAudioElement).currentTime)}
          onLoadedMetadata={e => {
            const d = (e.target as HTMLAudioElement).duration;
            if (Number.isFinite(d)) setActualDuration(d);
          }}
          className="hidden"
        />
      )}
    </div>
  );
};
