import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** List password-store entry names without decrypting their contents. */
export async function discoverPassEntries(
  storePath = process.env.PASSWORD_STORE_DIR || join(homedir(), ".password-store"),
): Promise<string[]> {
  const entries: string[] = [];

  async function walk(directory: string, prefix: string): Promise<void> {
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      children.map(async (child) => {
        if (child.name === ".git") return;
        const relative = prefix ? `${prefix}/${child.name}` : child.name;
        if (child.isDirectory()) {
          await walk(join(directory, child.name), relative);
        } else if (child.isFile() && child.name.endsWith(".gpg")) {
          entries.push(relative.slice(0, -4));
        }
      }),
    );
  }

  await walk(storePath, "");
  return entries.sort((left, right) => left.localeCompare(right));
}

export function parseKeyringAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const separator = pair.indexOf("=");
    const key = pair.slice(0, separator).trim();
    const attributeValue = separator >= 0 ? pair.slice(separator + 1).trim() : "";
    if (!key || !attributeValue) {
      throw new Error(
        'Use comma-separated key=value pairs, for example "service=pi-mtls, account=alice".',
      );
    }
    attributes[key] = attributeValue;
  }
  return attributes;
}

export function formatKeyringAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}
