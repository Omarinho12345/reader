/**
 * The overview: every slide of a deck as a grid of thumbnails, to pick one
 * from. The deck shows it over the stage (O), and the speaker view in its
 * own window; this is what the two share, as `window.Overview`.
 *
 * A thumbnail is the slide as the stage draws it, every step showing: drawn
 * at the projector's size (1280×720) in a frame of its own and scaled down,
 * as the speaker view's Now and Next are. A frame is only made as its
 * thumbnail scrolls into view, so a long deck costs only what's looked at.
 *
 * It's a listbox, and the highlighted slide has the keyboard (a roving
 * tabindex): the arrows move it a slide either way or a row up or down,
 * Home and End to the first and last. Enter, Space or a click picks the
 * slide; Esc puts the overview away.
 */
(() => {
  /** `paging: Slide %d / %d` from the front matter, as `slides` reads it: slide `i` of `n`. */
  function number(paging, i, n) {
    const fmt = paging && paging.includes('%d') ? paging : '%d / %d';
    let k = 0;
    return fmt.replace(/%d/g, () => String(k++ ? n : i + 1));
  }

  /**
   * An overview in `root`, an element of its own, hidden while it's away:
   *
   *   draw(i)     the render message that draws slide i, whole
   *   number(i)   what slide i's thumbnail is numbered
   *   say(text)   says it aloud, in a live region
   *   pick(i)     goes to slide i, once the overview is away
   *   closed(how) the overview was put away, by Esc or a pick (`how.picked`)
   *   done        slides before the current one show as done
   */
  function create(root, { draw, number, say, pick, closed, done = false }) {
    let slides = [];
    let at = 0;
    let observer = null;
    const waiting = new Map();  // a frame not yet ready -> its slide

    const list = document.createElement('ol');
    list.className = 'overview-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Overview');
    const hint = document.createElement('p');
    hint.className = 'overview-hint';
    hint.textContent = 'Arrows move · Enter goes to the slide, from its start · Esc back';
    // The keys are heard with the list, as well as seen above it.
    hint.id = `${root.id}-hint`;
    list.setAttribute('aria-describedby', hint.id);
    root.append(hint, list);

    const options = () => [...list.children];

    /** Slide i, as it's said: `Slide 3 of 12: Its title`. */
    function named(i) {
      const slide = `Slide ${i + 1} of ${slides.length}`;
      return slides[i].title ? `${slide}: ${slides[i].title}` : slide;
    }

    function open(all, current) {
      slides = all;
      list.replaceChildren(...slides.map((slide, i) => {
        const li = document.createElement('li');
        li.className = 'overview-slide';
        li.setAttribute('role', 'option');
        li.tabIndex = -1;
        li.dataset.index = i;
        if (slide.title) li.title = slide.title;
        const screen = document.createElement('span');
        screen.className = 'overview-screen';
        const label = document.createElement('span');
        label.className = 'overview-number';
        label.textContent = number(i);
        li.append(screen, label);
        return li;
      }));
      root.hidden = false;
      mark(current);
      observer?.disconnect();
      waiting.clear();
      // Drawn as they come into view, or all at once where that can't be told.
      if ('IntersectionObserver' in window) {
        observer = new IntersectionObserver((seen) => {
          for (const e of seen) if (e.isIntersecting) show(e.target);
        }, { root, rootMargin: '50% 0px' });
        for (const li of options()) observer.observe(li);
      } else {
        for (const li of options()) show(li);
      }
      highlight(current, { scroll: 'center' });
      // The slide with the highlight says itself, as it gets the keyboard;
      // what it doesn't say is that the overview is out.
      say('Overview');
    }

    function refresh(all, current, highlighted = at) {
      if (root.hidden || !all.length) return;
      const last = all.length - 1;
      open(all, Math.min(current, last));
      highlight(Math.min(highlighted, last));
    }

    function close({ picked = false } = {}) {
      if (root.hidden) return;
      root.hidden = true;
      observer?.disconnect();
      observer = null;
      waiting.clear();
      list.replaceChildren();
      closed({ picked });
    }

    /** Marks the slide being shown, and with `done`, those before it. */
    function mark(current) {
      for (const [i, li] of options().entries()) {
        li.classList.toggle('now', i === current);
        li.classList.toggle('done', done && i < current);
        if (i === current) li.setAttribute('aria-current', 'true');
        else li.removeAttribute('aria-current');
        const state = i === current ? 'now' : done && i < current ? 'done' : '';
        li.setAttribute('aria-label', state ? `${named(i)} (${state})` : named(i));
        li.querySelector('.overview-number').dataset.state = state;
      }
    }

    /** Gives slide i the highlight and the keyboard, so it's heard by its name. */
    function highlight(i, { scroll = 'nearest' } = {}) {
      const all = options();
      at = Math.max(0, Math.min(all.length - 1, i));
      for (const [k, li] of all.entries()) {
        li.tabIndex = k === at ? 0 : -1;
        li.setAttribute('aria-selected', String(k === at));
      }
      all[at].focus({ preventScroll: true });
      all[at].scrollIntoView?.({ block: scroll });
    }

    /** How many thumbnails make a row, as laid out. */
    function across() {
      const tops = options().map((li) => li.offsetTop);
      const n = tops.findIndex((top) => top !== tops[0]);
      return n > 0 ? n : tops.length;
    }

    function show(li) {
      observer?.unobserve(li);
      const screen = li.querySelector('.overview-screen');
      if (screen.firstChild) return;
      const frame = document.createElement('iframe');
      frame.title = '';
      frame.tabIndex = -1;
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('sandbox', 'allow-scripts');
      Frames.load(frame);
      screen.append(frame);
      Frames.fit(frame);
      waiting.set(frame, Number(li.dataset.index));
    }

    /** Draws again the thumbnails drawn so far, as the deck now draws a slide (at its text size). */
    function redraw() {
      for (const frame of root.querySelectorAll('iframe')) {
        if (!waiting.has(frame)) Frames.post(frame, draw(Number(frame.closest('li').dataset.index)));
      }
    }

    // A frame says it's ready as it loads; then it's drawn.
    window.addEventListener('message', (e) => {
      if (e.data?.type !== 'ready') return;
      for (const [frame, i] of waiting) {
        if (e.source !== frame.contentWindow) continue;
        waiting.delete(frame);
        if (slides[i]) Frames.post(frame, draw(i));
      }
    });
    window.addEventListener('resize', () => {
      for (const frame of root.querySelectorAll('iframe')) Frames.fit(frame);
    });

    function choose(i) {
      close({ picked: true });
      pick(i);
    }

    list.addEventListener('click', (e) => {
      const li = e.target.closest('[role="option"]');
      if (li) choose(Number(li.dataset.index));
    });

    /** A key while the overview is out. True if it was the overview's. */
    function key(e) {
      if (root.hidden || e.metaKey || e.ctrlKey || e.altKey) return false;
      const move = {
        ArrowLeft: -1, ArrowRight: 1, ArrowUp: -across(), ArrowDown: across(),
        Home: -Infinity, End: Infinity,
      }[e.key];
      if (move != null) {
        const to = Number.isFinite(move) ? at + move : move < 0 ? 0 : slides.length - 1;
        if (to >= 0 && to < slides.length && to !== at) highlight(to);
      } else if (e.key === 'Enter' || e.key === ' ') {
        choose(at);
      } else if (e.key === 'Escape') {
        close();
      } else if (e.key !== 'Tab') {
        return false;
      }
      return true;
    }

    return {
      open, refresh, close, key, mark, redraw,
      get isOpen() { return !root.hidden; },
    };
  }

  window.Overview = { create, number };
})();
