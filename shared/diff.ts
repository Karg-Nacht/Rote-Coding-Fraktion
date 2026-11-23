export type DiffLine = {
  kind: "header" | "hunk" | "context" | "add" | "delete";
  old?: number;
  next?: number;
};

export function diffLines(patch: string): DiffLine[] {
  let old = 0,
    next = 0,
    oldLeft = 0,
    nextLeft = 0;
  return patch.split("\n").map((line) => {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[3]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      nextLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      return { kind: "hunk" };
    }
    if (oldLeft || nextLeft) {
      if (line.startsWith("+") && nextLeft > 0) {
        nextLeft--;
        return { kind: "add", next: next++ };
      }
      if (line.startsWith("-") && oldLeft > 0) {
        oldLeft--;
        return { kind: "delete", old: old++ };
      }
      if (line.startsWith(" ") && oldLeft > 0 && nextLeft > 0) {
        oldLeft--;
        nextLeft--;
        return { kind: "context", old: old++, next: next++ };
      }
    }
    return { kind: "header" };
  });
}
