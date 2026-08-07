class Box {
  data = 1;

  get safe(): number {
    return 1;
  }

  get risky(): number {
    throw new Error("no");
  }
}

declare const box: Box;
declare const safeKey: "data" | "safe";
declare const riskyKey: "safe" | "risky";

/** @nothrow */
export function touchesSafe(): number {
  return box[safeKey];
}

/** @nothrow */
export function touchesRisky(): number {
  return box[riskyKey];
}
