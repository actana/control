// Agents, as the Panel's server and (later) the browser see them (#569, ADR 0041).
//
// An Agent is a harness plus its settings on one Core. The settings are a model
// name and a closed set of flags. There is no command, no arguments, no script
// and no environment anywhere in an Agent: a string a user typed that reached a
// Core's shell would be a way into the Core, so the only free text is a name and
// a model, and both are checked against a narrow pattern.

import { HARNESSES, type Harness } from "@actana/shared/domain";
import { HARNESS_AUTO_MODE_FLAGS } from "@actana/shared/harness-cli-config";

export { HARNESSES };
export type { Harness };

/**
 * The flags an Agent may carry. Each id is a name for a launch option, not the
 * option's spelling: the Core maps it to the harness's own flag when it
 * dispatches (#570), so no flag text is stored or accepted here.
 */
export const AGENT_FLAGS = ["skip-permissions"] as const;
export type AgentFlag = (typeof AGENT_FLAGS)[number];

/** The flags one harness accepts. A flag a harness has no spelling for is not offered. */
export function flagsForHarness(harness: Harness): readonly AgentFlag[] {
  return HARNESS_AUTO_MODE_FLAGS[harness] ? ["skip-permissions"] : [];
}

export function isAgentFlag(value: unknown): value is AgentFlag {
  return typeof value === "string" && (AGENT_FLAGS as readonly string[]).includes(value);
}

export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && (HARNESSES as readonly string[]).includes(value);
}

/** A model id as every harness spells one: letters, digits and `. _ : / @ + -`, no spaces, no quotes, no `$`. */
export const AGENT_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;

/** A name an operator reads in a list: one line of up to 60 characters. */
export const AGENT_NAME_MAX = 60;

/** The settings an Agent may have. Nothing else is accepted, and unknown fields are refused. */
export type AgentSettings = {
  model?: string | null;
  flags?: readonly string[];
};
