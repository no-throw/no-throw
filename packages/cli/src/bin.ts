#!/usr/bin/env node

import { runCheck } from "./check.js";
import { runEmit } from "./emit.js";
import { CANNOT_RUN, type CommandResult } from "./result.js";

const usage = [
  "nothrow — statically enforce that no throw escapes a @nothrow function",
  "",
  "Usage:",
  "  nothrow emit [--project <path>]           lower verified marks into nothrow.json",
  "  nothrow emit --check [--project <path>]   fail if the manifest has drifted",
  "  nothrow check [--project <path>]          name every carrier entry that reaches nothing",
  "",
  "`--project` names a `tsconfig.json`, or a directory holding one; it",
  "defaults to the working directory. The manifest is written beside the",
  "first `package.json` above the project, which is where a consumer's",
  "walk-up finds it, and where `check` looks for the carriers a project",
  "wrote or installed.",
  "",
  "Exit codes: 0 wrote, matched or all reached · 1 refused, drifted or",
  "reaching nothing · 2 could not run.",
].join("\n");

const result = run(process.argv.slice(2));

if (result.out !== "") process.stdout.write(result.out);
if (result.err !== "") process.stderr.write(result.err);
process.exit(result.code);

function run(argv: readonly string[]): CommandResult {
  const [command, ...rest] = argv;

  if (command !== "emit" && command !== "check") {
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

  const parsed = options(command, rest);
  if (parsed.kind === "error") {
    return { code: CANNOT_RUN, out: "", err: `${parsed.message}\n\n${usage}\n` };
  }

  return command === "emit"
    ? runEmit({
        check: parsed.check,
        project: parsed.project,
        cwd: process.cwd(),
      })
    : runCheck({ project: parsed.project, cwd: process.cwd() });
}

type Options =
  | {
      readonly kind: "options";
      readonly check: boolean;
      readonly project: string | undefined;
    }
  | { readonly kind: "error"; readonly message: string };

/**
 * `--check` is `emit`'s alone: on `check` it would read as a second mode of a
 * command that has one, and a flag that means nothing is a flag somebody will
 * expect to mean something.
 */
function options(command: string, rest: readonly string[]): Options {
  let check = false;
  let project: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--check" && command === "emit") {
      check = true;
    } else if (argument === "--project") {
      project = rest[index + 1];
      index += 1;
      if (project === undefined) {
        return {
          kind: "error",
          message: `nothrow: \`${argument}\` needs a path.`,
        };
      }
    } else {
      return {
        kind: "error",
        message: `nothrow: \`${argument}\` is not an option of \`${command}\`.`,
      };
    }
  }

  return { kind: "options", check, project };
}
