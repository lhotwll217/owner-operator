// Shared helpers for adapters. Files starting with _ are not loaded as adapters.

// Flatten a message's content blocks to text. opts.includeTools: when false (the
// default), tool_result blocks are excluded — they are file/command echoes, ~45% of
// corpus bytes, and mostly restate what the conversation already says.
export function contentToText(content, opts = {}) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks = [];
  for (const item of content) {
    if (typeof item === 'string') chunks.push(item);
    else if (item && typeof item === 'object' && (item.type !== 'tool_result' || opts.includeTools)) {
      for (const key of ['text', 'output_text', 'input_text', 'content']) {
        if (typeof item[key] === 'string') chunks.push(item[key]);
      }
    }
  }
  return chunks.join('\n');
}
