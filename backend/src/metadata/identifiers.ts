export function quoteIdent(quoted: boolean, name: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe identifier: ${name}`);
  }
  if (quoted) return `"${name}"`;
  if (name !== name.toUpperCase()) {
    throw new Error(`Unquoted Oracle identifiers must be uppercase: ${name}`);
  }
  return name;
}

export function assertLogicalName(name: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe column name: ${name}`);
  }
}
