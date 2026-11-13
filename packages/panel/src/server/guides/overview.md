# Handing work to an Agent with the Panel's MCP tools

A Task is a unit of work for one named Agent on one Core. You create it, the Agent's Session does it, and the Agent's report comes back as a result file that settles the Task. These guides are the whole recipe, served by the Panel itself.

The short version:

1. Pick a Core and an Agent: `list_cores`, then `list_agents`.
2. Hand the work off with `create_task` (with `startNow: true`) or `assign_task`. The answer already carries `watch.url`.
3. Wait by reading `watch.url` (a plain GET, no API key), with `actana task wait` or a `curl` loop. Never loop on `get_task`.
4. Read the Task with `get_task` once it settles: the Agent's report is a comment on it.

Three rules that save the most trouble:

- The result file is the only success signal. A Session state never makes a Task done, failed or partial.
- A timeout does not prove non-delivery: read the Task before you resend.
- Do not stop a Task you did not create.
