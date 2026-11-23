// Per-variant audio, keyed by variant id (chrome.js calls score.useTheme(THEMES[id])).
//   synth:          name of the procedural engine in score.js (its own music + synthesized SFX)
//   variant:        engine-specific arrangement flavour (e.g. 'recap' = tighter, punchier origin-story)
//   synthLevel:     trim for the engine's music (1 = as mixed), synthSfxLevel: trim for its SFX
//   music / sfx:    optional sampled overrides; these always win over the synth versions:
//                   { music: url, bedLevel: 0..1, sfxLevel: 0..1, sfx: { event: url | url[] } }
// Events every variant fires: hover, select, back, zoomIn, zoomOut, start, complete, unlock, intro,
// riser, step (+ impact, whoosh) — plus engine extras (peek, sonar, footstep, grind, spin).
// A theme with no (known) `synth` and no `music` keeps the generic build-up score.
// Sample URLs are relative to the variant page (e.g. '../audio/ascent/bed.mp3').
export const THEMES = {
  'ascent': { synth: 'ascent' },
  'second-brain': { synth: 'second-brain' },
  'brain-3d': { synth: 'second-brain' },
  'tiny-planet': { synth: 'tiny-planet' },
  'uncharted': { synth: 'uncharted' },
  'origin-story': { synth: 'origin-story' },
  'weekly-recap': { synth: 'origin-story', variant: 'recap' },
  'living-tree': { synth: 'living-tree' },
  'shifting-stairs': { synth: 'shifting-stairs' },
  'impossible-tower': { synth: 'impossible-tower' },
};
