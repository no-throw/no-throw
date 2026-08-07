class Clean {
  [key: string]: number;

  get a(): number {
    return 1;
  }

  get b(): number {
    return 2;
  }
}

class ThrowingGet {
  [key: string]: number;

  get a(): number {
    return 1;
  }

  get b(): number {
    throw new Error("no");
  }
}

class ThrowingSet {
  [key: string]: number;

  get a(): number {
    return 1;
  }

  set a(next: number) {
    throw new Error("no");
  }
}

declare const clean: Clean;
declare const throwingGet: ThrowingGet;
declare const throwingSet: ThrowingSet;
declare const either: Clean | ThrowingGet;
declare const key: string;

/** @nothrow */
export function joinsClean(): number {
  return clean[key];
}

/** @nothrow */
export function joinsThrowingGet(): number {
  return throwingGet[key];
}

/** @nothrow */
export function joinsThrowingSet(): void {
  throwingSet[key] = 1;
}

/** @nothrow */
export function readsThrowingSet(): number {
  return throwingSet[key];
}

/** @nothrow */
export function joinsEither(): number {
  return either[key];
}
