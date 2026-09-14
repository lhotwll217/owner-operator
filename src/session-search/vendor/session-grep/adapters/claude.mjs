// Claude Code sessions: ~/.claude/projects/<project-slug>/<session-id>.jsonl,
// one JSON record per line; messages under .message.content as typed blocks.
import { contentToText } from './_shared.mjs';

export default {
  name: 'claude',
  fallback: true, // claims any file no other adapter detects
  detect: () => true,
  message(obj, opts) {
    if ((obj.type === 'user' || obj.type === 'assistant') && obj.message && typeof obj.message === 'object') {
      return { role: obj.message.role || obj.type, text: contentToText(obj.message.content, opts), timestamp: obj.timestamp };
    }
    return null;
  },
};
