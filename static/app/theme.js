/**
 * The theme, Light, Dark or System, chosen in the help: static/theme.js
 * keeps it and puts it on the app. Here its radio buttons are kept in step
 * with it, chosen here or in another window, and the document is drawn
 * again in it, in the preview and on the stage.
 */

import { el, deck } from './state.js';
import { renderNow } from './render.js';
import { showSlide, redrawOverview } from './deck.js';

export function wireTheme() {
  const radios = [...el.theme.querySelectorAll('input[type=radio]')];
  const tick = () => radios.forEach((r) => { r.checked = r.value === Theme.chosen(); });
  tick();
  el.theme.addEventListener('change', (e) => Theme.choose(e.target.value));
  let dark = Theme.dark();
  Theme.onChange((now) => {
    tick();
    if (now === dark) return;
    dark = now;
    renderNow();
    if (deck.open) {
      showSlide();
      redrawOverview();
    }
  });
}
