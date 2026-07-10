import { homedir } from "node:os";
import { join } from "node:path";

export const ownerOperatorHome = (): string => process.env.OO_HOME ?? join(homedir(), ".owner-operator");
export const daemonInfoPath = (): string => join(ownerOperatorHome(), "daemon.json");
export const daemonLogPath = (): string => join(ownerOperatorHome(), "daemon.log");
export const stateDatabasePath = (): string => join(ownerOperatorHome(), "state.db");
