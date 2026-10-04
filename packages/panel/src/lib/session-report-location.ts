/**
 * Where a Session's report lands, as shown on the New Session "Runs on" line
 * (design screen 03, issue 560).
 *
 * The Core's standard block (issue 563, ADR 0041 D37) names the Shared-folder
 * path `~/shared/sessions/<session-id>/report-<turn>.md`. This constant is the
 * prefix the Runs on line shows for that contract.
 */
export const SESSION_REPORT_LOCATION = "shared/sessions/";
