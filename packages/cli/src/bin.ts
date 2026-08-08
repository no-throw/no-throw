#!/usr/bin/env node

import { CANNOT_RUN, runEmit, type CommandResult } from "./emit.js";

const usage = [
  "nothrow — statically enforce that no throw escapes a @nothrow function",
  "",
  "Usage:",
  "  nothrow emit [--project <path>]           lower verified marks into nothrow.json",
  "  nothrow emit --check [--project <path>]   fail if the manifest has drifted",
  "",
  "`--project` names a `tsconfig.json`, or a directory holding one; it",
  "defaults to the working directory. The manifest is written beside the",
  "first `package.json` above the project, which is where a consumer's",
  "walk-up finds it.",
  "",
  "Exit codes: 0 wrote or matched · 1 refused or drifted · 2 could not run.",
].join("\n");

const result = run(process.argv.slice(2));

if (result.out !== "") process.stdout.write(result.out);
if (result.err !== "") process.stderr.write(result.err);
process.exit(result.code);

function run(argv: readonly string[]): CommandResult {
  const [command, ...rest] = argv;

  if (command !== "emit") {
    const problem =
      command === undefined
        ? "no command given"
        : `\`${command}\` is not a command`;
    return {
      code: CANNOT_RUN,
      out: "",
      err: `nothrow: ${problem}.\n\n${usage}\n`,
    };
  }

  let check = false;
  let project: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--check") {
      check = true;
    } else if (argument === "--project") {
      project = rest[index + 1];
      index += 1;
      if (project === undefined) {
        return {
          code: CANNOT_RUN,
          out: "",
          err: `nothrow: \`${argument}\` needs a path.\n\n${usage}\n`,
        };
      }
    } else {
      return {
        code: CANNOT_RUN,
        out: "",
        err: `nothrow: \`${argument}\` is not an option of \`emit\`.\n\n${usage}\n`,
      };
    }
  }

  return runEmit({ check, project, cwd: process.cwd() });
}
