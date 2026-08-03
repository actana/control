// Password policy for the Operator, shared by the two forms that collect one
// (setup, change-password) and the server that enforces it
// (server/services/operator.ts). The server is the authority; the client uses
// these to say so before making a round trip.
export const MIN_PASSWORD_LENGTH = 8;
/** Bounded so a huge body can't turn one scrypt call into a denial of service. */
export const MAX_PASSWORD_LENGTH = 512;
