// Original hard-coach copy for the hype layer. Intense and direct, but our own words —
// no borrowed catchphrases from any real motivational speaker.

export const HYPE = {
  intro: [
    'Every lesson under your feet, you put there.',
    'Curiosity got you here. Discipline takes you up.',
    'Nothing on this map was given to you. You took all of it.',
  ],
  climb: [
    'One more step. Then one more. That is the whole secret.',
    'Comfort never raised a score.',
    'Hard lessons are just easy ones you haven’t met yet.',
    'You are not behind. You are mid-climb.',
    'Ready is a result, not a requirement.',
  ],
  frontier: [
    'This is the edge of what you know. This is where it gets good.',
    'The frontier is where you get dangerous.',
    'Everything you need for this one, you already own.',
  ],
  locked: [
    'Locked doesn’t mean no. It means not yet.',
    'You don’t get the key by staring at the door.',
    'Earn the step below it and this opens.',
  ],
  mastered: [
    'Locked in.',
    'That one’s yours forever.',
    'Another step. Higher.',
    'Brick laid.',
    'Your brain just rewired. Feel it.',
  ],
  comeback: [
    'You were here before. You’ll be past it soon.',
    'Slow climbs still reach the top.',
  ],
  summit: [
    'The score you want lives at the top.',
    'Look how far down the bottom is now.',
  ],
};

let lastPick = '';
/** Random line from a group, never the same line twice in a row. */
export function hype(group) {
  const pool = HYPE[group] || HYPE.climb;
  let line = pool[Math.floor(Math.random() * pool.length)];
  if (pool.length > 1 && line === lastPick) line = pool[(pool.indexOf(line) + 1) % pool.length];
  lastPick = line;
  return line;
}
