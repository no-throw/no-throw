#!/usr/bin/env node

const usage = [
  "nothrow — statically enforce that no throw escapes a @nothrow function",
  "",
  "Usage:",
  "  nothrow emit           lower verified marks into nothrow.json (not implemented yet)",
  "  nothrow emit --check   fail if the manifest has drifted (not implemented yet)",
].join("\n");

const [command] = process.argv.slice(2);

if (command === undefined) {
  process.stdout.write(`${usage}\n`);
  process.exit(1);
}

process.stderr.write(`nothrow: \`${command}\` is not implemented yet.\n\n${usage}\n`);
process.exit(1);
