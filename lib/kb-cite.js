'use strict';

const idPattern = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;

function check(kbData, text) {
  const entries = new Map();
  for (const entry of kbData.entries) {
    const matches = entries.get(entry.id) || [];
    matches.push(entry);
    entries.set(entry.id, matches);
  }
  const sentences = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  let abstain = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.startsWith('>')) continue;
    if (['該当する情報がありません。', 'Not covered.'].includes(line)
        && /^Closest topic: \S.*$/.test(lines[index + 1] || '')) {
      abstain = true;
      index += 1;
      continue;
    }
    // Bracket tokens protect id dots; citations after punctuation stay with that sentence.
    const parts = line.match(/(?:\[[^\]\r\n]*\]|[^。.?？])+(?:[。.?？](?:[ \t]*\[[^\]\r\n]*\])*)?|[。.?？](?:[ \t]*\[[^\]\r\n]*\])*/g) || [];
    for (const part of parts) {
      const sentence = part.trim();
      if (!sentence) continue;
      const ending = sentence.replace(/[。.?？]$/, '').trimEnd();
      const citations = /(?:\[[^\]\r\n]+\][ \t]*)+$/.exec(ending);
      const ids = citations ? [...citations[0].matchAll(/\[([^\]\r\n]+)\]/g)].map((match) => match[1]) : [];
      const problems = new Set();
      if (!ids.length) problems.add('no-citation');
      for (const id of ids) {
        const matches = entries.get(id);
        if (!matches) problems.add('unknown-id');
        else if (!idPattern.test(id) || matches.length !== 1 || matches[0].status !== 'verified'
            || (kbData.flags.has(id) && kbData.flags.get(id).flagged !== false)) {
          problems.add('not-citable');
        }
      }
      sentences.push({ text: sentence, ids, problems: [...problems] });
    }
  }
  return { ok: sentences.every((sentence) => sentence.problems.length === 0), abstain, sentences };
}

module.exports = { check };
