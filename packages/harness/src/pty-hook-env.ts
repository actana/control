// The hook env/URL builder lives in src/shared/mission-control-hook-env.ts as
// the single source of truth. Re-exported here to preserve existing
// import paths and tests.
export {
  type PtyHookEnv,
  LOCAL_HOOK_API_HOST,
  AGENT_LOCAL_HOOK_API_HOST,
  buildMissionControlApiUrl,
  buildLocalMissionControlApiUrl,
  buildAgentLocalHookApiUrl,
  hookEndpointSlug,
  buildSyntheticHookUrl,
} from "../../shared/src/mission-control-hook-env";
