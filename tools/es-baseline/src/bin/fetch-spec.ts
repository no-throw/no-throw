import { fetchSpec, SPEC_URL, specCachePath } from "../spec/source.js";

const bytes = await fetchSpec();
console.log(`${SPEC_URL} → ${specCachePath()} (${(bytes / 1e6).toFixed(1)} MB)`);
