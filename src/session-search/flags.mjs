// The session-search wrapper's flags that consume the next argument as their value. Shared with
// `oo search` so it can find its own flags without reading a wrapper value as one.
export const SESSION_SEARCH_OUTER_VALUE_FLAGS = ["--target-type", "--source", "--target-root", "--limit", "--max-chars"];
export const SESSION_SEARCH_PASSTHROUGH_VALUE_FLAGS = [
  "--query", "--skim", "--session", "--at", "--since", "--until", "--sort", "--before", "--after", "--role", "--focus",
];
export const SESSION_SEARCH_VALUE_FLAGS = new Set([...SESSION_SEARCH_OUTER_VALUE_FLAGS, ...SESSION_SEARCH_PASSTHROUGH_VALUE_FLAGS]);
