/**
 * NO STICKY HOVER ON A TOUCH SCREEN (nav pass, 2026-11-18): a PostCSS step (vite.config.ts) that puts every rule
 * styling an element while it is hovered inside `@media (hover: hover)`.
 *
 * A phone keeps :hover on whatever was tapped last: a copy card stayed lifted 3px with its shadow, Buy/Sell stayed
 * brightened after an order, a row kept its tint - until something else was tapped. There were 647 :hover rules and
 * not one behind (hover: hover). Where the primary pointer can hover (a mouse, a trackpad) the media query is true and
 * every rule is exactly as before, in the same place in the cascade; on a touch screen they no longer apply, and a
 * tap's feedback is the press state instead (PhoneTabBar.css, the touch block).
 *
 * Left as they are:
 *   - a selector whose :hover sits only inside :not(...) - it applies when NOT hovered, so on a touch screen always;
 *   - a rule that REVEALS something on hover (it sets opacity, visibility, display, pointer-events, max-height,
 *     clip-path, width or height): a phone reaches those controls by the tap that hovers them, and a reveal kept
 *     sticky is the lesser harm than a control that never shows;
 *   - rules already inside a media query about hover.
 * A selector list is split: the hover selectors move into the media query right after the rule, the others stay.
 */

const REVEAL = /^(opacity|visibility|display|pointer-events|max-height|clip-path|width|height)$/i;

/** The selector with every :not(...) group taken out (nested parentheses respected). */
function withoutNot(sel) {
  let out = '';
  for (let i = 0; i < sel.length; i++) {
    if (sel.startsWith(':not(', i)) {
      let depth = 0;
      let j = i + 4;
      for (; j < sel.length; j++) {
        if (sel[j] === '(') depth++;
        else if (sel[j] === ')' && --depth === 0) break;
      }
      i = j;
      continue;
    }
    out += sel[i];
  }
  return out;
}

/** Whether this one selector styles something only while a pointer hovers it. */
export function hoverOnly(selector) {
  return /:hover\b/.test(withoutNot(selector));
}

function inHoverMedia(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'atrule' && /^(media|supports)$/i.test(p.name) && /\bhover\b/i.test(p.params)) return true;
    if (p.type === 'atrule' && /keyframes$/i.test(p.name)) return true;
  }
  return false;
}

function reveals(rule) {
  let r = false;
  rule.walkDecls((d) => {
    if (REVEAL.test(d.prop)) r = true;
  });
  return r;
}

export function hoverMedia({ stats } = {}) {
  return {
    postcssPlugin: 'vs-hover-media',
    Once(root, { AtRule }) {
      const rules = [];
      root.walkRules((rule) => {
        if (rule.selector.includes(':hover') && !inHoverMedia(rule)) rules.push(rule);
      });
      for (const rule of rules) {
        const hover = [];
        const rest = [];
        for (const s of rule.selectors) (hoverOnly(s) ? hover : rest).push(s);
        if (!hover.length) continue;
        if (reveals(rule)) {
          if (stats) stats.kept++;
          continue;
        }
        const media = new AtRule({ name: 'media', params: '(hover: hover)' });
        media.append(rule.clone({ selectors: hover }));
        if (rest.length) {
          rule.selectors = rest;
          rule.after(media);
        } else {
          rule.replaceWith(media);
        }
        if (stats) stats.wrapped++;
      }
    },
  };
}
hoverMedia.postcss = true;
