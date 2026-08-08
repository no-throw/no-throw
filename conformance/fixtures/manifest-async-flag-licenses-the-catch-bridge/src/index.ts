import { fetchFlaky } from "flaky";

/** @nothrow */
const log = (error: unknown): void => {
  void error;
};

/** @nothrow */
export function fireAndForget(): void {
  fetchFlaky().catch(log);
}
