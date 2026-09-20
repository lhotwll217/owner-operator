// Codex CLI sessions: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, one
// {type, payload} record per line; messages are response_item/message payloads.
// Readable reasoning (event_msg/agent_reasoning text) is conversation text and
// always surfaced; encrypted response_item/reasoning records stay skipped.
// Boilerplate records (AGENTS.md preamble, IDE context, aborted turns) are skipped.
import { contentToText } from './_shared.mjs';

export default {
  name: 'codex',
  detect: (file) => file.includes('/.codex/') || /\/codex\//.test(file),
  message(obj, opts) {
    if (obj.payload?.type === 'agent_reasoning') {
      const text = typeof obj.payload.text === 'string' ? obj.payload.text : '';
      if (!text.trim()) return null;
      return { role: 'assistant', text, timestamp: obj.timestamp };
    }
    if (obj.payload?.type === 'reasoning') return null; // encrypted_content: not readable
    if (obj.type !== 'response_item' || !obj.payload) return null;
    if (['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(obj.payload.type)) {
      if (!opts.includeTools) return null;
      return {
        role: obj.payload.type.endsWith('_output') ? 'user' : 'assistant',
        text: JSON.stringify(obj.payload), timestamp: obj.timestamp,
      };
    }
    if (obj.payload.type !== 'message') return null;
    const role = obj.payload.role || 'unknown';
    if (!['user', 'assistant'].includes(role)) return null;
    const text = contentToText(obj.payload.content, opts);
    if (text.startsWith('# AGENTS.md instructions') || text.startsWith('# Context from my IDE setup:') || text.startsWith('<turn_aborted>') || text.slice(0, 5000).includes('<environment_context>')) return null;
    return { role, text, timestamp: obj.timestamp };
  },
};
