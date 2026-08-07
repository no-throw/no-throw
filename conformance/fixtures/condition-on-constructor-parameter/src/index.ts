class Runner {
  /** @nothrow */
  constructor(cb: () => void) {
    cb();
  }
}

/** @nothrow */
export function startClean(): Runner {
  return new Runner(tick);
}

/** @nothrow */
export function startRisky(): Runner {
  return new Runner(risky);
}

function tick(): void {
  ticks += 1;
}

function risky(): void {
  JSON.parse("{}");
}

let ticks = 0;
