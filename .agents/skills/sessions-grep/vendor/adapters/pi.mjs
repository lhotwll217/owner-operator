// pi sessions: the on-disk format of the pi coding agent (earendil-works/pi), also
// used by tools built on it (e.g. Owner Operator's own threads). One JSON record per
// line: a {type:"session", cwd} header, then {type:"message", timestamp, message:{role,
// content}} turns. `detect` is best-effort for --root auto mode (pi stores under a
// `pi/sessions/` path); when a root is configured with `type: pi` in
// SESSION_GREP_SOURCES_FILE, that routing is authoritative and detect is bypassed.
import { contentToText } from './_shared.mjs';

export default {
  name: 'pi',
  detect: (file) => /(^|\/)\.?pi\/sessions\//.test(file),
  message(obj, opts) {
    if (obj.type !== 'message' || !obj.message || typeof obj.message !== 'object') return null;
    const role = obj.message.role;
    if (!['user', 'assistant'].includes(role)) return null;
    return { role, text: contentToText(obj.message.content, opts), timestamp: obj.timestamp };
  },
};
