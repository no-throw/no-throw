import { fetchSpecs, specCacheDir } from "../specs/source.js";

const report = await fetchSpecs();
console.log(`specs:  ${report.targets}`);
console.log(`cached: ${report.cached} (${(report.bytes / 1e6).toFixed(1)} MB) in ${specCacheDir()}`);
if (report.failures.length > 0) {
  console.log(`failed: ${report.failures.length}`);
  for (const [key, url, error] of report.failures.slice(0, 20)) {
    console.log(`  ${key.padEnd(28)} ${error}  ${url}`);
  }
}
