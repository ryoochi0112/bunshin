'use strict';

const { normalize } = require('./leak');

const idPattern = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;

function check(kbData, text, { scrub = [] } = {}) {
  const scrubStrings = [...new Set(scrub.map((value) => normalize(value).trim()).filter(Boolean))];
  const matchesScrub = (value) => scrubStrings.some((needle) => normalize(value).includes(needle));
  const entries = new Map();
  for (const entry of kbData.entries) {
    const matches = entries.get(entry.id) || [];
    matches.push(entry);
    entries.set(entry.id, matches);
  }
  const sentences = [];
  const cited = new Set();
  const addSentence = (sentence, ids, problems) => {
    const scrubbed = matchesScrub(sentence);
    if (scrubbed) problems.add('scrub');
    const safeIds = ids.map((id) => {
      if (matchesScrub(id)) return '[redacted]';
      cited.add(id);
      return id;
    });
    sentences.push({ text: scrubbed ? '[redacted]' : sentence, ids: safeIds, problems: [...problems] });
  };
  const scanExempt = (line) => {
    if (matchesScrub(line)) addSentence(line, [], new Set());
  };
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  let abstain = false;
  let handback = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    if (line.startsWith('>')) {
      scanExempt(line);
      continue;
    }
    if (['該当する情報がありません。', 'Not covered.'].includes(line)
        && /^Closest topic: \S.*$/.test(lines[index + 1] || '')) {
      abstain = true;
      scanExempt(line);
      scanExempt(lines[index + 1]);
      index += 1;
      continue;
    }
    if (['要確認（人の判断が必要です）。', 'Needs human.'].includes(line)
        && /^Reason: \S.*$/.test(lines[index + 1] || '')) {
      handback = true;
      scanExempt(line);
      scanExempt(lines[index + 1]);
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
      addSentence(sentence, ids, problems);
    }
  }
  return { ok: sentences.every((sentence) => sentence.problems.length === 0), abstain,
    handback, cited: [...cited], sentences };
}

module.exports = { check };
