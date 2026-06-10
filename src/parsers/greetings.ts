// Greeting WAV → mailbox matching. Convention: the file's base name is the
// mailbox alias or its extension (e.g. jdoe.wav, 1001.wav). Case-insensitive.

export type VmBoxRef = { alias: string; extension: string | null };

export function matchGreeting(filename: string, boxes: VmBoxRef[]): string | null {
  const base = filename
    .split(/[\\/]/)
    .pop()!
    .replace(/\.wav$/i, "")
    .trim()
    .toLowerCase();
  if (!base) return null;
  for (const box of boxes) {
    if (box.alias.toLowerCase() === base) return box.alias;
  }
  for (const box of boxes) {
    if (box.extension && box.extension === base) return box.alias;
  }
  return null;
}
