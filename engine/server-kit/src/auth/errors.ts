/** Stable public errors deliberately exclude credentials, database details and account-existence hints. */
export class AuthError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(code: string, statusCode = 401) { super(code); this.name = 'AuthError'; this.code = code; this.statusCode = statusCode; }
}
