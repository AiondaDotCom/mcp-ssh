/**
 * ssh-config@5 value normalization.
 *
 * The parser returns a plain string for a single-token value, but an array of
 * token objects ({ val, separator, quoted }) as soon as a multi-value directive
 * carries more than one token. Affected directives (ssh-config/lib/ssh-config.js):
 *   Host, Match, ProxyCommand, SendEnv, IPQoS, CanonicalDomains,
 *   GlobalKnownHostsFile, UserKnownHostsFile
 *
 * Everything downstream must go through these helpers, otherwise a multi-alias
 * `Host a b` block is stored with an array where a string is expected and no
 * strict comparison against it can ever match — the cause of issue #12, where
 * such a host was unreachable under *either* alias.
 */
import type { HostInfo } from './types.js';

/** A single token as ssh-config reports it inside a multi-value directive. */
export interface ConfigToken {
  val: string;
  separator?: string;
  quoted?: boolean;
}

/** Either shape ssh-config can hand back for a directive value. */
export type ConfigValue = string | (ConfigToken | string)[] | null | undefined;

function isToken(value: unknown): value is ConfigToken {
  return typeof value === 'object' && value !== null && 'val' in value;
}

/** Normalize either shape into a list of plain string tokens. */
export function configValueTokens(value: ConfigValue): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map(v => (isToken(v) ? v.val : v)).filter(v => v !== '');
  }
  return [value];
}

/** Normalize either shape into a single readable string. */
export function configValueToString(value: ConfigValue): string {
  return configValueTokens(value).join(' ');
}

/** True if `alias` names this host — via any of its aliases or its hostname. */
export function hostMatchesAlias(host: HostInfo | undefined, alias: string | undefined): boolean {
  if (!host || !alias) return false;
  if (host.hostname === alias) return true;
  if (Array.isArray(host.aliases)) return host.aliases.includes(alias);
  return host.alias === alias;
}
