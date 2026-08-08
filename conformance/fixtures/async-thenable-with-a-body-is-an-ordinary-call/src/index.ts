class SyncThenable {
  then(onFulfilled: (value: number) => void): void {
    onFulfilled(1);
    throw "boom";
  }
}

/** @nothrow */
function keep(_value: number): void {}

/** @nothrow */
export function callsAThenableWithABody(): void {
  new SyncThenable().then(keep);
}
