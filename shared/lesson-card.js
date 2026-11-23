// Shared lesson card: open(lesson) shows state + action; "Start lesson" simulates finishing it.
import { pct } from './graph.js';
import { hype } from './hype.js';

/**
 * createLessonCard(graph, { score, caption, onComplete, onOpen, onClose })
 *  - onComplete(evt) fires after graph.complete(); evt = { lesson, unlocked, stats }.
 *    Animate your celebration there. The card already plays score.sfx('start') and score.sfx('complete').
 * → { open(lesson), close(), get lesson() }
 */
export function createLessonCard(graph, { score, caption, onComplete, onOpen, onClose } = {}) {
  const el = document.createElement('section');
  el.className = 'kg-card'; el.setAttribute('aria-live', 'polite');
  el.innerHTML = `<button class="kg-card-close" aria-label="Close">×</button><div class="kicker"></div><h2></h2>
    <div class="meta"><span class="kg-pill"></span><span class="pct"></span></div><div class="bar"><span></span></div>
    <p class="note"></p><div class="actions"></div>`;
  document.body.append(el);
  const $ = (s) => el.querySelector(s);
  let current = null;
  $('.kg-card-close').addEventListener('click', () => close());
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && current) close(); });

  function render() {
    const n = current;
    $('.kicker').textContent = graph.pathTo(n).slice(1, -1).map((a) => a.label).join(' · ');
    $('h2').textContent = n.label;
    const pill = $('.kg-pill');
    pill.className = 'kg-pill ' + n.state;
    pill.textContent = n.state === 'mastered' ? 'Mastered' : n.state === 'frontier' ? (n.progress > 0 ? 'In progress' : 'Ready') : 'Locked';
    const m = n.state === 'mastered' ? 1 : n.state === 'frontier' ? n.progress : 0;
    $('.pct').textContent = pct(m) + ' mastery';
    $('.bar span').style.width = pct(m);
    $('.bar span').style.background = m >= 0.85 ? 'var(--success)' : 'var(--wave-3)';
    const actions = $('.actions');
    actions.replaceChildren();
    const btn = (label, kind, fn, disabled) => {
      const b = document.createElement('button'); b.className = 'kg-btn ' + kind; b.textContent = label; b.disabled = !!disabled;
      if (fn) b.addEventListener('click', fn); actions.append(b); return b;
    };
    if (n.state === 'frontier') {
      $('.note').textContent = hype('frontier');
      const b = btn(n.progress > 0 ? 'Continue lesson' : 'Start lesson', 'primary', () => {
        b.disabled = true; b.textContent = 'Practicing…';
        score?.sfx('start');
        setTimeout(() => {
          const evt = graph.complete(n);
          score?.sfx('complete');
          caption?.(hype('mastered'));
          render();
          onComplete?.(evt);
        }, 900);
      });
    } else if (n.state === 'mastered') {
      const when = n.masteredAt ? n.masteredAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
      $('.note').textContent = `Mastered${when ? ' on ' + when : ''}. A quick review keeps it from fading.`;
      btn('Review', 'secondary');
      const next = n.parent.children.find((c) => c.state === 'frontier');
      if (next) btn('Next: ' + next.label, 'primary', () => open(next));
    } else {
      $('.note').textContent = `${graph.blockerText(n)} ${hype('locked')}`;
      btn('Locked', 'primary', null, true);
    }
  }
  function open(n) {
    if (!n || n.children.length) return;
    current = n; render(); el.classList.add('open'); score?.sfx('select'); onOpen?.(n);
  }
  function close() { if (!current) return; current = null; el.classList.remove('open'); onClose?.(); }
  return { open, close, get lesson() { return current; }, el };
}
