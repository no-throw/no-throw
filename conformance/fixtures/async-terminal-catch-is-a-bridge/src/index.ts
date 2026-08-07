async function sendTelemetry(): Promise<void> {
  throw "boom";
}

/** @nothrow */
function log(): void {}

function rethrow(): void {
  throw "boom";
}

/** @nothrow */
export function fireAndForget(): void {
  sendTelemetry().catch(log);
}

/** @nothrow */
export function rethrowingHandlerIsNoBridge(): void {
  sendTelemetry().catch(rethrow);
}
