export type {
  AgentCliConfig,
  AgentCliUpdateCommands,
  AgentCliVersionRequirement,
  AgentCliVersionScheme,
  ManagedAgent,
} from "../../shared/src/agent-cli-config";

export {
  AGENT_CLI_CONFIG,
  AGENT_CLI_CONFIG_BY_COMMAND,
  MANAGED_AGENTS,
  agentCliConfigForAgent,
  agentCliConfigForCommand,
  resolveAgentCliUpdateCommands,
  spawnCommandForAgent,
  AGENT_SPAWN_COMMANDS,
} from "../../shared/src/agent-cli-config";
