/**
 * Flag parsing shared by every `lacrew` subcommand. One implementation, so a
 * rule about how a value is read ("the next token, unless it looks like a
 * flag") cannot drift between commands.
 */

/** The token after `flag`, unless it is itself a flag. */
export function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1];
  return undefined;
}

/** Every value a repeated flag carries, in order. */
export function flagValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] && !args[i + 1]!.startsWith("-")) out.push(args[i + 1]!);
  }
  return out;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}
