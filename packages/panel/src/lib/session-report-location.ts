/**
 * Where a Session's report lands, as shown on the New Session "Runs on" line
 * (design screen 03, issue 560).
 *
 * Today the Core's orchestration skill still tells agents to write under
 * `.actana/reports/` relative to the Session cwd (`~`). Issue 563 will make the
 * Shared-folder path the standard block every prompt carries; until then the
 * Panel shows that path so the Runs on line matches the 0.5.0 proposal and
 * marks the value 563 will standardize.
 */
export const SESSION_REPORT_LOCATION = "shared/sessions/";
