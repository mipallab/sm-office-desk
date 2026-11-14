import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export function parseCliArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token || !token.startsWith("--")) continue;

    const eqIdx = token.indexOf("=");
    if (eqIdx > 2) {
      const key = token.slice(2, eqIdx);
      const val = token.slice(eqIdx + 1);
      args[key] = val;
    } else {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

export async function promptMissingValue(
  currentValue: string | undefined,
  promptLabel: string
): Promise<string> {
  if (currentValue !== undefined && currentValue.trim().length > 0) {
    return currentValue.trim();
  }
  if (!input.isTTY) {
    throw new Error(`Missing required argument/env for ${promptLabel}`);
  }
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${promptLabel}: `);
    return answer.trim();
  } finally {
    rl.close();
  }
}
