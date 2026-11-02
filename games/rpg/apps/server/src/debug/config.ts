/**
 * Debug/admin tools are opt-in and never available in production (issue #31). Two independent signals are required:
 * an explicit enable flag and an explicit, allowlisted non-production environment name.
 */
export const DEBUG_ENVIRONMENTS = ['development', 'test', 'qa', 'staging'] as const;
export type DebugEnvironment = typeof DEBUG_ENVIRONMENTS[number];

export interface RpgDebugToolsConfig {
  readonly enabled: boolean;
  /** Deployment environment name (`APP_ENV`). Production (or anything not allowlisted) refuses the tools. */
  readonly environment: string;
  /** `NODE_ENV`, checked separately so a production Node build can never host the tools. */
  readonly nodeEnv?: string | undefined;
}

export class DebugToolsRefusedError extends Error {
  constructor(message: string) { super(message); this.name = 'DebugToolsRefusedError'; }
}

/** Parses `RPG_DEBUG_TOOLS`, `APP_ENV` and `NODE_ENV`. Disabled by default; malformed flags fail closed at boot. */
export function parseRpgDebugToolsConfig(env: Readonly<Record<string, string | undefined>>): RpgDebugToolsConfig {
  const flag = env['RPG_DEBUG_TOOLS']?.trim() ?? '';
  if (!['', '0', '1', 'false', 'true'].includes(flag)) throw new Error('RPG_DEBUG_TOOLS must be 0, 1, false or true');
  const config = { enabled: flag === '1' || flag === 'true', environment: env['APP_ENV']?.trim() ?? '', nodeEnv: env['NODE_ENV']?.trim() };
  if (config.enabled) assertDebugToolsAllowed(config);
  return config;
}

/** Throws unless the tools are enabled in an explicit non-production environment. Called again at module registration. */
export function assertDebugToolsAllowed(config: RpgDebugToolsConfig): void {
  if (!config.enabled) throw new DebugToolsRefusedError('debug tools are disabled');
  const environment = config.environment.toLowerCase();
  if (environment === 'production' || environment === 'prod' || config.nodeEnv?.toLowerCase() === 'production') {
    throw new DebugToolsRefusedError('debug tools refuse to run with production configuration');
  }
  if (!(DEBUG_ENVIRONMENTS as readonly string[]).includes(environment)) {
    throw new DebugToolsRefusedError(`debug tools require APP_ENV to be one of ${DEBUG_ENVIRONMENTS.join(', ')}`);
  }
}
