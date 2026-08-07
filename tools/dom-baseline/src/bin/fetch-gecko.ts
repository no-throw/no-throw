import { fetchGeckoIdl, geckoCacheDir, geckoThrowingKeys } from "../gecko.js";

const report = await fetchGeckoIdl();
console.log(`gecko .webidl files: ${report.files} (${(report.bytes / 1e6).toFixed(1)} MB) in ${geckoCacheDir()}`);
if (report.failures > 0) console.log(`failed: ${report.failures}`);

const keys = geckoThrowingKeys();
console.log(`members annotated [Throws]: ${keys.size}`);
console.log(
  "sample:",
  [...keys]
    .sort()
    .filter((key) => /^(Element|Node|Document|Range)[#.]/.test(key))
    .slice(0, 12)
    .join(" "),
);
console.log(
  "\nPresence is a sound throwing signal; absence is one implementation's behavior and is never read.",
);
