// Shared chrome: Begin gate (unlocks audio), variant dock, sound toggles, hype caption.
import { createScore } from './score.js';
import { THEMES } from './audio-themes.js';

export const VARIANTS = [
  { id: 'ascent', name: 'The Ascent', blurb: 'A staircase you climb, one lesson per step.' },
  { id: 'second-brain', name: 'Second Brain', blurb: 'We copied your brain. This is its SAT wiring.' },
  { id: 'brain-3d', name: 'Brain 3D', blurb: 'Your second brain in 3D. Look around it by moving the mouse.' },
  { id: 'tiny-planet', name: 'Tiny Planet', blurb: 'Your SAT world as a little planet. Spin it, zoom in, explore.' },
  { id: 'uncharted', name: 'Uncharted', blurb: 'An ocean chart. Your frontier is the edge of the fog.' },
  { id: 'weekly-recap', name: 'Weekly Recap', blurb: 'Your week as a short hype recap, made for your phone.' },
  { id: 'origin-story', name: 'Origin Story', blurb: 'A cinematic trailer of your journey so far.' },
  { id: 'living-tree', name: 'Living Tree', blurb: 'Roots first, then branches. Watch it bloom.' },
  { id: 'shifting-stairs', name: 'Shifting Stairs', blurb: 'A tower of moving staircases. Choose your path up.' },
  { id: 'impossible-tower', name: 'Impossible Tower', blurb: 'Isometric, impossible architecture. Every level offers a choice.' },
];

const ICONS = {
  music: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
  voice: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>',
};

/** Query flags for QA: ?skipgate=1 jumps past the Begin gate (no audio). */
export const params = new URLSearchParams(location.search);

/**
 * mountChrome({ id, eyebrow, title, tagline, gateBackground, dark, beginLabel, voiceDefault, onBegin })
 * → { score, caption(text, ms), begun: Promise<{ sound: boolean }> }
 * - `onBegin({ sound })` runs after the gate closes (start your intro animation there).
 * - `score` is the shared procedural soundtrack (see score.js); it is silent until Begin.
 */
export function mountChrome(opts) {
  const { id, eyebrow = 'Your SAT knowledge graph', title, tagline = '', gateBackground = 'linear-gradient(160deg, #0A2B64, #103B84 55%, #1E6FBE)', dark = false, beginLabel = 'Begin', voiceDefault = false, onBegin } = opts;
  const score = createScore();
  score.useTheme(THEMES[id]);
  if (dark) document.documentElement.setAttribute('data-chrome', 'dark');

  // Dock
  const dock = document.createElement('nav');
  dock.className = 'kg-dock'; dock.setAttribute('aria-label', 'Knowledge graph variations');
  // Compact: numbers only, the current variant's name, all names on hover/focus.
  dock.innerHTML = VARIANTS.map((v, i) => `<a href="../${v.id}/index.html" title="${v.name}"${v.id === id ? ' aria-current="page"' : ''}><b>${i + 1}</b><span>${v.name}</span></a>`).join('')
    + '<a href="../index.html" title="All variations"><span class="all">All</span></a>';
  document.body.append(dock);

  // Sound toggles (the narrator toggle only where a variant actually narrates)
  const sound = document.createElement('div');
  sound.className = 'kg-sound';
  sound.innerHTML = (voiceDefault ? `<button class="kg-icon-btn" data-k="voice" aria-label="Narrator voice" title="Narrator voice">${ICONS.voice}</button>` : '')
    + `<button class="kg-icon-btn" data-k="music" aria-label="Music" title="Music (M)">${ICONS.music}</button>`;
  document.body.append(sound);
  const musicBtn = sound.querySelector('[data-k="music"]'), voiceBtn = sound.querySelector('[data-k="voice"]');
  score.onState((s) => { musicBtn.setAttribute('aria-pressed', String(s.started && s.musicOn)); voiceBtn?.setAttribute('aria-pressed', String(s.voiceOn)); });
  musicBtn.addEventListener('click', async () => { if (!score.started) await score.start({ music: true, voice: score.voiceOn }); else score.setMusic(!score.musicOn); });
  voiceBtn?.addEventListener('click', async () => { if (!score.started) await score.start({ music: false, voice: true }); else score.setVoice(!score.voiceOn); });
  addEventListener('keydown', (e) => { if ((e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && score.started) score.setMusic(!score.musicOn); });

  // Caption
  const cap = document.createElement('div');
  cap.className = 'kg-caption'; cap.setAttribute('aria-live', 'polite');
  document.body.append(cap);
  let capTimer = 0;
  function caption(text, ms = 3200) {
    cap.textContent = text; cap.classList.add('show');
    clearTimeout(capTimer); capTimer = setTimeout(() => cap.classList.remove('show'), ms);
  }

  // Gate
  let resolveBegun;
  const begun = new Promise((r) => { resolveBegun = r; });
  const gate = document.createElement('div');
  gate.className = 'kg-gate'; gate.style.background = gateBackground;
  gate.innerHTML = `<div class="kg-gate-inner"><div class="kg-eyebrow"></div><h1></h1><p></p>
    <div class="kg-gate-actions"><button class="kg-btn primary" data-go="sound"></button><button class="kg-btn ghost" data-go="silent">Without sound</button></div></div>`;
  gate.querySelector('.kg-eyebrow').textContent = eyebrow;
  gate.querySelector('h1').textContent = title;
  gate.querySelector('p').textContent = tagline;
  gate.querySelector('[data-go="sound"]').textContent = beginLabel;
  document.body.append(gate);
  const go = async (withSound) => {
    if (gate.classList.contains('hide')) return;
    if (withSound) await score.start({ music: true, voice: voiceDefault });
    gate.classList.add('hide');
    resolveBegun({ sound: withSound });
    onBegin?.({ sound: withSound });
  };
  gate.querySelector('[data-go="sound"]').addEventListener('click', () => go(true));
  gate.querySelector('[data-go="silent"]').addEventListener('click', () => go(false));
  // Deferred so the caller finishes its own setup before onBegin fires.
  if (params.has('skipgate')) { gate.style.transition = 'none'; setTimeout(() => go(false), 0); }
  else setTimeout(() => gate.querySelector('[data-go="sound"]').focus(), 50);

  return { score, caption, begun };
}
