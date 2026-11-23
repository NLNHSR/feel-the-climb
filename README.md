# Knowledge-graph viewer concepts

Interactive prototypes for showing a learner's SAT progress as a story. They all use one mock learner: 89 lessons, 60% mastered, projected score 1180, goal 1500.

Live demo: https://nlnhsr.github.io/feel-the-climb/

Everything is plain HTML, CSS and JavaScript. There's no build step, no framework and no `npm install`.

## Run it locally

```bash
git clone https://github.com/NLNHSR/feel-the-climb.git
cd feel-the-climb
python3 -m http.server 4317
```

Then open http://localhost:4317/

Use a server rather than opening the files directly: the pages use ES modules, and browsers block those over `file://`. Click **Begin** with sound on.

## What's here

```
feel-the-climb/
  index.html              hub page linking every variant
  fractal/index.html      v1: the fractal viewer (move the mouse toward a circle to zoom in)
    shared/               used by every variant
      graph.js            mock SAT graph + mastery data (createGraph, stats, journey, complete)
      chrome.js           Begin gate (unlocks audio), variant switcher, music toggle, captions
      score.js            Web Audio engine: per-variant synthesized music + score.sfx(event)
      audio-themes.js     which synth theme each variant uses
      lesson-card.js      the lesson card shown when you click a lesson
      dolphin.css         Dolphin colour tokens, fonts, buttons
      hype.js             motivational copy
    <variant>/index.html  one self-contained page per concept
```

The variants are `ascent`, `second-brain`, `brain-3d`, `tiny-planet`, `uncharted`, `weekly-recap`, `origin-story`, `living-tree`, `shifting-stairs` and `impossible-tower`. Each page has a "Sound design" comment at the top and QA query params, e.g. `?skipgate=1` to skip the Begin screen.

## Make your own changes

- **Edit a variant:** change `<variant>/index.html` and refresh.
- **Change the learner's data:** everything comes from `shared/graph.js`. `SPEC` is the course tree and `BIAS` sets how far along each domain is.
- **Add a variant:**
  1. Copy a variant folder.
  2. Add an entry to `VARIANTS` in `shared/chrome.js`, a card in `index.html`, and a theme in `shared/audio-themes.js`.
  3. Call `mountChrome({ id: '<your-id>', ... })` in the page.
- **Sounds:** call `score.sfx('hover' | 'select' | 'zoomIn' | 'complete' | ...)` and `score.setIntensity(0..1)`. Don't call the synth functions directly.
- **Narration:** Origin Story and Weekly Recap play recorded clips from `voice/`, registered with `score.setVoiceClips`. If a line has no recording, it's skipped.

## Publish your own copy

Fork this repo and turn on GitHub Pages (Settings → Pages → deploy from `main`, root folder). Any static host works. Fonts are already inlined, and the only external file is Three.js r128 from cdnjs, used by Tiny Planet.
