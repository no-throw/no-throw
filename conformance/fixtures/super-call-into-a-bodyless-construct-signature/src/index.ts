interface Handle {
  readonly label: string;
}

interface HandleFactory {
  new (label: string): Handle;
}

declare const Handle: HandleFactory;

export class Labeled extends Handle {
  /** @nothrow */
  public constructor(label: string) {
    super(label);
  }
}

export class Implicit extends Handle {}

/** @nothrow */
export function make(label: string): Implicit {
  return new Implicit(label);
}
