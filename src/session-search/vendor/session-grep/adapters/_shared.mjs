// Shared helpers for adapters. Files starting with _ are not loaded as adapters.

// Flatten a message's content blocks to text. opts.includeTools: when false (the
// default), tool calls and results are excluded. Opt-in preserves their serialized
// names, arguments, IDs, and nested output as evidence rather than instructions.
export function contentToText(content, opts = {}) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks = [];
  for (const item of content) {
    if (typeof item === 'string') chunks.push(item);
    else if (item && typeof item === 'object' && ['toolCall', 'tool_use', 'tool_result'].includes(item.type)) {
      if (opts.includeTools) chunks.push(JSON.stringify(item));
    } else if (item && typeof item === 'object') {
      for (const key of ['text', 'output_text', 'input_text', 'content']) {
        if (typeof item[key] === 'string') chunks.push(item[key]);
      }
    }
  }
  return chunks.join('\n');
}
