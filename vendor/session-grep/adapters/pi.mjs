// Vendored Pi coding-agent adapter (badlogic/pi-mono): ~/.pi/agent/sessions/<cwd-slug>/
// <timestamp>_<uuid>.jsonl. Entries are {type, id, parentId, timestamp, message};
// conversation lives in type:"message" entries whose message.role is user/assistant.
// Tool output is its own message (role "toolResult") rather than a content block, so
// the --include-tools gate applies at the message level here. Non-conversation roles
// (bashExecution, custom) and non-message entries (session header, compaction,
// branch_summary) are skipped.
import { contentToText } from './_shared.mjs';

export default {
  name: 'pi',
  detect: (file) => file.includes('/.pi/') || /\/pi\//.test(file),
  message(obj, opts) {
    if (obj.type !== 'message' || !obj.message || typeof obj.message !== 'object') return null;
    const role = obj.message.role;
    if (role === 'toolResult') {
      if (!opts.includeTools) return null;
      // Claude tool_result blocks surface under user messages; mirror that role here.
      return { role: 'user', text: contentToText(obj.message.content, opts), timestamp: obj.timestamp };
    }
    if (!['user', 'assistant'].includes(role)) return null;
    return { role, text: contentToText(obj.message.content, opts), timestamp: obj.timestamp };
  },
};
