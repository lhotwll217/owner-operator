import { fixtureApp, SESSIONS } from "../fixtures/sessions.mjs";

const normalize = (value) => String(value)
  .toLowerCase()
  .replace(/[`*_~]/g, "")
  .replace(/[–—]/g, "-")
  .replace(/\s+/g, " ")
  .trim();

const fixtureRows = SESSIONS.map((session) => {
  const details = session.detailsHistory.at(-1);
  return {
    id: session.id,
    repo: session.repo,
    app: fixtureApp(session),
    topic: details.topic,
    nextSteps: details.nextSteps,
  };
});

function listItems(output) {
  const items = [];
  for (const line of String(output).split(/\r?\n/)) {
    const start = /^\s*(?:[-+*]|\d+[.)])\s+(.+)$/.exec(line);
    if (start) {
      items.push(start[1]);
    } else if (items.length && line.trim()) {
      items[items.length - 1] += ` ${line.trim()}`;
    }
  }
  return items;
}

export default (output, context) => {
  const requiredIds = context.test?.metadata?.recommendationIds ?? [];
  const stateRelevantIds = new Set(context.test?.metadata?.stateRelevantIds ?? []);
  const priorityRelevantIds = new Set(context.test?.metadata?.priorityRelevantIds ?? []);
  const items = listItems(output);
  const problems = [];

  if (items.length !== requiredIds.length) {
    problems.push(`expected ${requiredIds.length} list items, got ${items.length}`);
  }

  const matchedIds = [];
  for (const [index, item] of items.entries()) {
    const text = normalize(item);
    const matches = fixtureRows.filter((row) =>
      [row.repo, row.app, row.topic, row.nextSteps]
        .every((field) => text.includes(normalize(field)))
    );
    if (matches.length !== 1) {
      problems.push(`item ${index + 1} maps to ${matches.length} fixture rows`);
      continue;
    }
    const row = matches[0];
    matchedIds.push(row.id);
    if (!stateRelevantIds.has(row.id) && /\b(?:needs[- ]you|working|idle|done)\b/i.test(text)) {
      problems.push(`item ${index + 1} includes state that does not affect the recommendation`);
    }
    if (!priorityRelevantIds.has(row.id) && /\b(?:priority|p[1-5])\b/i.test(text)) {
      problems.push(`item ${index + 1} includes priority that does not affect the recommendation`);
    }
  }

  const required = [...requiredIds].sort();
  const matched = [...matchedIds].sort();
  if (required.join("\0") !== matched.join("\0")) {
    problems.push(`expected fixture ids [${required.join(", ")}], got [${matched.join(", ")}]`);
  }

  return {
    pass: problems.length === 0,
    score: problems.length === 0 ? 1 : 0,
    reason: problems.length === 0
      ? `mapped ${matchedIds.length} recommendations to unique fixture rows`
      : problems.join("; "),
  };
};
