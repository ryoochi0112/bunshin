'use strict';

const { normalize } = require('./leak');
const { citable } = require('./kb');

const ACK_LINES = ['ありがとうございます！', 'ありがとうございます。', '確認ありがとうございます！',
  '確認ありがとうございます。', 'ご確認ありがとうございます！', 'ご確認ありがとうございます。',
  'Thanks!', 'Thanks for checking.'];

function check(kbData, text, { scrub = [] } = {}) {
  const scrubStrings = [...new Set(scrub.map((value) => normalize(value).trim()).filter(Boolean))];
  const matchesScrub = (value) => scrubStrings.some((needle) => normalize(value).includes(needle));
  const facts = citable(kbData);
  const known = new Set(kbData.entries.map((entry) => entry.id));
  for (const section of kbData.ssot?.sections || []) {
    for (const statement of section.statements) known.add(statement.id);
  }
  const sentences = [];
  const cited = new Set();
  const addSentence = (sentence, ids, problems, exempt = false) => {
    const scrubbed = matchesScrub(sentence);
    if (scrubbed) problems.add('scrub');
    const safeIds = ids.map((id) => {
      if (matchesScrub(id)) return '[redacted]';
      cited.add(id);
      return id;
    });
    sentences.push({ text: scrubbed ? '[redacted]' : sentence, ids: safeIds, problems: [...problems], exempt });
  };
  const scanExempt = (line) => {
    if (matchesScrub(line)) addSentence(line, [], new Set(), true);
  };
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const firstNonEmpty = lines.findIndex((line) => line);
  let abstain = false;
  let handback = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    if (index === firstNonEmpty && ACK_LINES.includes(line)) {
      addSentence(line, [], new Set(), true);
      continue;
    }
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
        if (!facts.has(id)) problems.add(known.has(id) ? 'not-citable' : 'unknown-id');
      }
      addSentence(sentence, ids, problems);
    }
  }
  return { ok: sentences.every((sentence) => sentence.problems.length === 0), abstain,
    handback, cited: [...cited], sentences };
}

module.exports = { check, ACK_LINES };
