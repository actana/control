import { z } from "zod";
import {
  HARNESSES,
  type Harness,
} from "@actana/shared/ai-runtime-defaults";
import { listAiRuntimeModels } from "../services/ai-runtime-models";
import { json, parseSearchParams } from "./_helpers";

const listModelsParams = z.object({
  agent: z.enum(HARNESSES),
});

export async function list(url: URL): Promise<Response> {
  const parsed = parseSearchParams(url, listModelsParams);
  if (!parsed.ok) return parsed.response;
  const agent = parsed.data.agent as Harness;
  return json(await listAiRuntimeModels(agent));
}
