/**
 * `server-only` guards modules against being bundled into the client. The real
 * package resolves only under Next's react-server condition, which vitest does
 * not set, so unit tests alias it here (see vitest.config.ts).
 */
export {};
