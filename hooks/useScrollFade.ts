import { useEffect, useRef } from 'react';

/**
 * Scroll-aware edge fade for a vertical scroll container.
 *
 * Pairs with the `.scroll-fade-y` CSS utility: this hook toggles its
 * `--fade-top` / `--fade-bottom` variables so the mask only fades an edge
 * when there's actually more content to scroll in that direction (no top
 * fade at the very top, no bottom fade at the very bottom).
 *
 * Reacts to scrolling, viewport resize (ResizeObserver) and content changes
 * such as nav items appearing/disappearing or the sidebar collapsing
 * (MutationObserver). Attach the returned ref to the scroll container.
 */
export function useScrollFade<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const canUp = scrollTop > 1;
      const canDown = scrollTop + clientHeight < scrollHeight - 1;
      el.style.setProperty('--fade-top', canUp ? 'var(--scroll-fade)' : '0px');
      el.style.setProperty('--fade-bottom', canDown ? 'var(--scroll-fade)' : '0px');
    };

    update();
    el.addEventListener('scroll', update, { passive: true });

    // Viewport height changes (window resize, sidebar expand/collapse padding).
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);

    // Content changes that alter scrollHeight without resizing the box —
    // e.g. nav items added/removed by permission, or labels toggled on collapse.
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(update) : null;
    mo?.observe(el, { childList: true, subtree: true, characterData: true });

    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, []);

  return ref;
}
