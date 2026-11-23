// Shared mock SAT knowledge graph for every visual variation.
// Tree: Course (SAT) → Domain → Topic → (Subtopic →) Lesson. Lessons are leaves.
// States: mastered → frontier (ready: first unmastered rung of an unlocked ladder) → locked.

export const SPEC = ['SAT', [
  ['Algebra', [
    ['Linear equations', ['One-step equations', 'Multi-step equations', 'Variables on both sides', 'Equations with fractions']],
    ['Linear functions', [
      ['Slope', ['Slope from a graph', 'Slope from two points', 'Rate of change']],
      ['Slope-intercept form', ['Write y = mx + b', 'Graph from an equation', 'Interpret m and b']],
      ['Function notation', ['Evaluate f(x)', 'Solve f(x) = k', 'Functions in context']],
    ]],
    ['Systems of equations', ['Substitution', 'Elimination', 'Number of solutions', 'Systems word problems']],
    ['Linear inequalities', ['One-variable inequalities', 'Graph inequalities', 'Systems of inequalities']],
    ['Two-variable equations', ['Standard form', 'Parallel & perpendicular', 'Lines in context']],
  ]],
  ['Advanced Math', [
    ['Quadratics', [
      ['Factoring', ['GCF factoring', 'Trinomials (a = 1)', 'Trinomials (a ≠ 1)', 'Difference of squares']],
      ['Quadratic formula', ['Apply the formula', 'The discriminant', 'Formula in context']],
      ['Vertex form', ['Complete the square', 'Read the vertex', 'Max & min in context']],
    ]],
    ['Exponential functions', ['Growth & decay', 'Compound interest', 'Exponent rules', 'Exponential vs linear']],
    ['Polynomials', ['Add & multiply', 'Polynomial division', 'Zeros & factors']],
    ['Radicals & exponents', ['Simplify radicals', 'Rational exponents', 'Radical equations']],
    ['Nonlinear systems', ['Line meets parabola', 'Solve graphically']],
  ]],
  ['Problem Solving & Data', [
    ['Ratios & rates', ['Unit rates', 'Proportions', 'Unit conversion']],
    ['Percentages', ['Percent of a whole', 'Percent change', 'Successive percents']],
    ['Statistics', ['Mean, median & mode', 'Standard deviation', 'Box plots & histograms']],
    ['Probability', ['Simple probability', 'Two-way tables', 'Conditional probability']],
    ['Data models', ['Scatterplots', 'Line of best fit', 'Margin of error']],
  ]],
  ['Geometry & Trig', [
    ['Lines & angles', ['Vertical angles', 'Parallel lines & transversals', 'Triangle angle sum']],
    ['Triangles', ['Similar triangles', 'Pythagorean theorem', 'Special right triangles']],
    ['Circles', ['Arc length', 'Sector area', 'Circle equations', 'Inscribed angles']],
    ['Area & volume', ['Polygon area', 'Prisms & cylinders', 'Cones & spheres']],
    ['Trigonometry', ['SOH-CAH-TOA', 'Complementary angles', 'Radians']],
  ]],
  ['Reading & Writing', [
    ['Information & ideas', ['Central ideas', 'Textual evidence', 'Quantitative evidence', 'Inferences']],
    ['Craft & structure', ['Words in context', 'Text structure & purpose', 'Cross-text connections']],
    ['Expression of ideas', ['Transitions', 'Rhetorical synthesis']],
    ['Conventions', ['Subject-verb agreement', 'Punctuation boundaries', 'Verb tense', 'Pronoun clarity']],
  ]],
]];

// How far along the mock learner is per domain.
export const BIAS = { 'Algebra': 0.8, 'Advanced Math': 0.55, 'Problem Solving & Data': 0.65, 'Geometry & Trig': 0.35, 'Reading & Writing': 0.6 };
export const UNLOCK_AT = 0.5;

// One identity hue per domain, all from Dolphin's palette (dolphin-web/src/styles/theme.css).
export const DOMAIN_HUES = {
  'Algebra': '#2F9AE6',               // wave-3
  'Advanced Math': '#E35D6A',         // danger (coral)
  'Problem Solving & Data': '#3FA669', // success
  'Geometry & Trig': '#E8BE00',       // sun-shadow
  'Reading & Writing': '#5FC6F7',     // wave-2
};

export const pct = (m) => Math.round(m * 100) + '%';
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Mock SAT projection from overall mastery (400–1600, rounded to 10). */
export function projectedScore(m) {
  return Math.round((400 + 1200 * Math.pow(clamp(m, 0, 1), 0.85)) / 10) * 10;
}

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Build the graph. Every node:
 *   { id, label, parent, depth, children, index, leafCount, domain, domainIndex,
 *     mastered, progress, state, unlocked, m, frontier, masteredCount, rung, masteredAt }
 * Leaves have `state` ∈ 'mastered' | 'frontier' | 'locked', `progress` (0–1 partial for frontier),
 * `rung` (position in its ladder) and `masteredAt` (Date | null).
 */
export function createGraph({ seed = 20261121 } = {}) {
  const rand = mulberry32(seed);
  const nodes = [];
  const listeners = new Set();

  function build(spec, parent, depth) {
    const leaf = typeof spec === 'string';
    const n = {
      id: nodes.length, label: leaf ? spec : spec[0], parent, depth, children: [],
      index: parent ? parent.children.length : 0, leafCount: 0, domain: null, domainIndex: -1,
      mastered: false, progress: 0, state: 'locked', unlocked: false, m: 0, frontier: 0, masteredCount: 0,
      rung: 0, masteredAt: null,
    };
    nodes.push(n);
    if (parent) parent.children.push(n);
    if (depth === 1) { n.domain = n; n.domainIndex = n.index; }
    else if (parent && parent.domain) { n.domain = parent.domain; n.domainIndex = parent.domainIndex; }
    if (!leaf) for (const c of spec[1]) build(c, n, depth + 1);
    n.leafCount = n.children.length ? n.children.reduce((a, c) => a + c.leafCount, 0) : 1;
    if (leaf) n.rung = n.index;
    return n;
  }
  const root = build(SPEC, null, 0);
  const domains = root.children;
  const leaves = nodes.filter((n) => !n.children.length);
  const isLeafGroup = (n) => n.children.length > 0 && n.children.every((c) => !c.children.length);
  const leavesOf = (n) => (n.children.length ? n.children.flatMap(leavesOf) : [n]);
  const rawMastery = (n) => leavesOf(n).reduce((a, l) => a + (l.mastered ? 1 : l.progress), 0) / n.leafCount;
  // A domain's first two topics are always open; later topics and subtopic chains open once the
  // previous sibling reaches UNLOCK_AT mastery.
  const opens = (c, prevM) => c.depth < 2 || c.index === 0 || (c.depth === 2 && c.index < 2) || prevM >= UNLOCK_AT;

  function seedMastery(n, unlocked, bias) {
    if (!n.children.length) return;
    if (isLeafGroup(n)) {
      if (!unlocked) return;
      const k = clamp(Math.round(n.children.length * (bias + (rand() - 0.5) * 0.55)), 0, n.children.length);
      n.children.forEach((c, i) => {
        c.mastered = i < k;
        if (i === k) c.progress = rand() < 0.45 ? 0 : 0.15 + rand() * 0.45;
      });
      return;
    }
    let prev = null;
    for (const c of n.children) {
      seedMastery(c, unlocked && opens(c, prev ? rawMastery(prev) : 0), n.depth === 0 ? BIAS[c.label] : bias);
      prev = c;
    }
  }
  seedMastery(root, true, 0.5);

  function recompute(n = root, unlocked = true) {
    n.unlocked = unlocked;
    if (!n.children.length) return;
    if (isLeafGroup(n)) {
      let taken = false;
      for (const c of n.children) {
        c.unlocked = unlocked;
        if (c.mastered) { c.state = 'mastered'; c.m = 1; c.frontier = 0; c.masteredCount = 1; }
        else if (unlocked && !taken) { c.state = 'frontier'; c.m = c.progress; c.frontier = 1; c.masteredCount = 0; taken = true; }
        else { c.state = 'locked'; c.m = 0; c.frontier = 0; c.masteredCount = 0; }
      }
    } else {
      let prev = null;
      for (const c of n.children) { recompute(c, unlocked && opens(c, prev ? prev.m : 0)); prev = c; }
    }
    let sum = 0, fr = 0, mc = 0;
    for (const c of n.children) { sum += c.m * c.leafCount; fr += c.frontier; mc += c.masteredCount; }
    n.m = sum / n.leafCount; n.frontier = fr; n.masteredCount = mc;
  }
  recompute();

  // Fake a believable history: lessons were mastered rung-by-rung across topics over ~8 weeks.
  const DAY = 86400000;
  const today = new Date(); today.setHours(18, 0, 0, 0);
  const startDay = new Date(today.getTime() - 55 * DAY);
  const ladderOrder = (a, b) => a.rung - b.rung || a.domainIndex - b.domainIndex || a.parent.id - b.parent.id;
  const masteredSeq = leaves.filter((l) => l.mastered).sort(ladderOrder);
  masteredSeq.forEach((l, i) => {
    const t = masteredSeq.length > 1 ? i / (masteredSeq.length - 1) : 1;
    l.masteredAt = new Date(startDay.getTime() + Math.round(Math.pow(t, 0.9) * 54) * DAY + (i % 3) * 3600000);
  });

  const pathTo = (n) => { const p = []; for (let a = n; a; a = a.parent) p.unshift(a); return p; };

  /** Lessons in story order: mastered (by date) → frontier → locked (by rung). */
  function journey() {
    const mastered = leaves.filter((l) => l.state === 'mastered').sort((a, b) => a.masteredAt - b.masteredAt || ladderOrder(a, b));
    const frontier = leaves.filter((l) => l.state === 'frontier').sort((a, b) => a.domainIndex - b.domainIndex || a.parent.id - b.parent.id);
    const locked = leaves.filter((l) => l.state === 'locked').sort(ladderOrder);
    return [...mastered, ...frontier, ...locked];
  }
  const frontierLessons = () => leaves.filter((l) => l.state === 'frontier');

  function stats() {
    const dates = leaves.filter((l) => l.masteredAt).map((l) => l.masteredAt.getTime());
    const first = dates.length ? Math.min(...dates) : today.getTime();
    return {
      mastery: root.m,
      mastered: root.masteredCount,
      total: root.leafCount,
      frontier: root.frontier,
      locked: leaves.filter((l) => l.state === 'locked').length,
      score: projectedScore(root.m),
      goalScore: 1500,
      days: Math.max(1, Math.round((today.getTime() - first) / DAY) + 1),
      streak: 12,
    };
  }

  function blockerText(n) {
    const sib = n.parent.children.find((c) => c.state === 'frontier');
    if (sib && sib !== n) return `Finish “${sib.label}” first.`;
    for (let g = n.parent; g && g.parent; g = g.parent) {
      if (g.parent.unlocked && !g.unlocked && g.index > 0) return `Unlocks at ${pct(UNLOCK_AT)} in “${g.parent.children[g.index - 1].label}”.`;
    }
    return 'Locked.';
  }
  function statusText(n) {
    if (n.state === 'mastered') return 'Mastered';
    if (n.state === 'frontier') return n.progress > 0 ? `In progress · ${pct(n.progress)}` : 'Ready to learn';
    return blockerText(n);
  }

  /** Master a frontier lesson. Emits 'change' with { lesson, unlocked: lessons that just became frontier }. */
  function complete(lesson) {
    if (!lesson || lesson.children.length || lesson.state === 'mastered') return null;
    const before = new Set(frontierLessons());
    lesson.mastered = true; lesson.progress = 1; lesson.masteredAt = new Date();
    recompute();
    const unlocked = frontierLessons().filter((l) => !before.has(l));
    const evt = { lesson, unlocked, stats: stats() };
    listeners.forEach((fn) => fn(evt));
    return evt;
  }
  const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

  return { root, nodes, domains, leaves, pathTo, journey, frontierLessons, stats, blockerText, statusText, complete, onChange, recompute };
}
