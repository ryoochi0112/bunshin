'use strict';

const defaultWindow = 24;

function normalize(text) {
  if (typeof text !== 'string') throw new Error('Leak scan text must be a string.');
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ');
}

function* windows(text, size) {
  const normalized = normalize(text);
  // Offsets count Unicode characters, so an astral character is one character.
  const offsets = [0];
  for (const character of normalized) offsets.push(offsets[offsets.length - 1] + character.length);
  for (let index = 0; index + size < offsets.length; index += 1) {
    yield normalized.slice(offsets[index], offsets[index + size]);
  }
}

function findLeaks(haystacks, needles, { window = defaultWindow } = {}) {
  if (!Number.isSafeInteger(window) || window < 1) throw new Error('Leak scan window must be a positive integer.');
  if (!Array.isArray(haystacks) || !Array.isArray(needles)) throw new Error('Leak scan inputs must be arrays.');
  if (haystacks.some((item) => !item || typeof item.name !== 'string' || !item.name || typeof item.text !== 'string')
    || needles.some((item) => !item || typeof item.id !== 'string' || !item.id || typeof item.text !== 'string')) {
    throw new Error('Invalid leak scan input.');
  }
  // Index answer windows once; each file then needs only a single pass.
  const index = new Map();
  const ids = new Set(needles.map((needle) => needle.id));
  for (const needle of needles) {
    for (const text of windows(needle.text, window)) {
      const previous = index.get(text);
      if (previous === undefined) index.set(text, needle.id);
      else if (typeof previous === 'string') {
        if (previous !== needle.id) index.set(text, new Set([previous, needle.id]));
      } else previous.add(needle.id);
    }
  }
  const findings = [];
  const reported = new Map();
  for (const haystack of haystacks) {
    const found = new Set();
    if (index.size) for (const text of windows(haystack.text, window)) {
      const matches = index.get(text);
      if (typeof matches === 'string') found.add(matches);
      else if (matches) for (const id of matches) found.add(id);
    }
    if (!reported.has(haystack.name)) reported.set(haystack.name, new Set());
    for (const id of ids) {
      if (found.has(id) && !reported.get(haystack.name).has(id)) {
        findings.push({ name: haystack.name, id });
        reported.get(haystack.name).add(id);
      }
    }
  }
  return findings;
}

module.exports = { normalize, findLeaks };
