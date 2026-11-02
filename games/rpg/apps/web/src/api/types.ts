/**
 * Response DTOs of the current server (`@engine/server-kit` auth, `@rpg/server` characters).
 *
 * GAP: the server does not export response DTOs through `@rpg/protocol` yet, and the web app must not import the
 * server app. These shapes mirror the server code as of #27/#29 and must move into `@rpg/protocol` (and be produced by
 * the server from it) before the protocol grows further. The client only displays them; the server value always wins.
 */

/** `POST /auth/guest`, `/auth/signin`, `/auth/upgrade`. The token is also set as an HttpOnly cookie. */
export interface IssuedSessionDto {
  readonly accountId: string;
  readonly sessionToken: string;
  readonly expiresAtMs: number;
}

/** `GET /auth/session`. */
export interface SessionDto {
  readonly accountId: string;
  readonly guest: boolean;
  readonly email: string | null;
  readonly expiresAtMs: number;
}

export type AttributeKey = 'STR' | 'AGI' | 'INT' | 'VIT' | 'SPI';
export type ActivityState = 'none' | 'live' | 'expedition';

/** `GET /characters`, `GET /characters/:actorId`, and the bodies of character commands. */
export interface CharacterDto {
  readonly actorId: string;
  readonly accountId: string;
  readonly gameId: string;
  readonly name: string;
  readonly level: number;
  readonly xp: number;
  readonly attributes: Readonly<Record<AttributeKey, number>>;
  readonly unspentPoints: number;
  readonly skillLoadout: readonly string[];
  readonly automationRules: readonly unknown[];
  readonly activityState: ActivityState;
  readonly activityId: string | null;
  readonly version: number;
}

/** `GET /content`: version metadata only; the client has no content bundle endpoint yet. */
export interface ContentInfoDto {
  readonly game: string;
  readonly format: number;
  readonly contentHash: string;
}

/** Every server error body is `{ error: <stable code> }`. */
export interface ErrorBody {
  readonly error: string;
}
