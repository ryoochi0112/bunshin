'use strict';

function sourceUrl(text) {
  if (/\s/u.test(text)) return false;
  try {
    const url = new URL(text);
    return /^https?:\/\//.test(text) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function inspectSources(reply) {
  const invalid = (problem) => ({ sources: [], none: false, problems: [problem] });
  if (typeof reply !== 'string' || !reply.trim()) return invalid('Reply must not be empty.');
  const lines = reply.trimEnd().split(/\r?\n/);
  const headers = lines.flatMap((line, index) => /^Sources:/.test(line) ? [index] : []);
  if (headers.length !== 1) return invalid('Reply must end with exactly one Sources: block.');
  const start = headers[0];
  if (!lines.slice(0, start).join('\n').trim()) return invalid('Reply must contain an answer before Sources:.');
  if (lines[start] === 'Sources: none' && start === lines.length - 1) {
    return { sources: [], none: true, problems: [] };
  }
  if (lines[start] !== 'Sources:' || start === lines.length - 1) {
    return invalid('Sources: must list pages or be the terminal line Sources: none.');
  }
  const sources = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^- (.+) — (\S+)$/.exec(line);
    if (!match || !match[1].trim() || !sourceUrl(match[2])) {
      return invalid('Each source must be - <page title> — <url> with an HTTP(S) URL.');
    }
    sources.push({ title: match[1], url: match[2] });
  }
  return { sources, none: false, problems: [] };
}

function parseSources(reply) {
  const { sources, none } = inspectSources(reply);
  return { sources, none };
}

// Structural checks only: the judge/online acceptance checks truth, per-claim
// support, abstention language, and the meaning of a position or objection.
function checkSpecReply(reply) {
  const { problems } = inspectSources(reply);
  return { ok: problems.length === 0, problems };
}

function checkIdeaReply(reply, identity) {
  const names = new Set(Array.isArray(identity?.priorities)
    ? identity.priorities.filter((priority) => typeof priority?.name === 'string' && priority.name.trim())
      .map((priority) => priority.name) : []);
  const named_priorities = typeof reply === 'string'
    ? [...new Set([...reply.matchAll(/\(priority: ([^()\r\n]+)\)/g)]
      .map((match) => match[1]).filter((name) => names.has(name)))] : [];
  return { ok: named_priorities.length > 0, named_priorities };
}

module.exports = { parseSources, checkSpecReply, checkIdeaReply };
