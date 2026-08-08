async function rejects(): Promise<void> {
  throw "boom";
}

/** A promise-returning function that is not `async`, so it can use both channels. */
function bothChannels(): Promise<void> {
  throw "boom";
}

/** @nothrow */
export async function bridgesAsync(): Promise<void> {
  try {
    await rejects();
  } catch {
    return;
  }
}

/** @nothrow */
export async function bridgesNonAsync(): Promise<void> {
  try {
    await bothChannels();
  } catch {
    return;
  }
}
