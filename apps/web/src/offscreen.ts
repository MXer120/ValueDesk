/**
 * `data-off` on an element while it is outside the viewport, for its CSS to pause what it
 * animates there: an infinite animation of a custom property (the glare on the order ticket and
 * on the copy cards: a conic gradient through a mask) costs a style pass and a paint every frame
 * whether the element is seen or not. One observer for every element marked.
 */
let io: IntersectionObserver | null = null;

function observer(): IntersectionObserver | null {
  if (!io && typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) e.target.toggleAttribute('data-off', !e.isIntersecting);
    });
  }
  return io;
}

/** Mark `el` while it is off screen. Returns the unmark. */
export function markOffscreen(el: Element): () => void {
  const o = observer();
  if (!o) return () => {};
  o.observe(el);
  return () => {
    o.unobserve(el);
    el.removeAttribute('data-off');
  };
}
