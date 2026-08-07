async function rejects(): Promise<number> {
  throw "boom";
}

/** @nothrow */
export async function throwsInBody(): Promise<number> {
  throw "boom";
}

/** @nothrow */
export async function foldsReturnedCall(): Promise<number> {
  return rejects();
}

/** @nothrow */
export const foldsImplicitArrowBody = async (): Promise<number> =>
  rejects();
