export const agentCaller = (): boolean =>
  process.env.OO_AGENT === "1" || Boolean(process.env.OO_AGENT_RUN_LEASE_ID);
