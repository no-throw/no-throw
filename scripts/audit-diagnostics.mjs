// §H of the spec makes diagnostic text normative: a sound floor with a mute
// message is indistinguishable from a bug, and this rule's whole adoption cost
// lives in those messages. A prose checklist would rot the first time somebody
// reworded a message, so the audit is a gate — every clause of §H names the
// artifact that asserts it, and a clause with no artifact fails the build.
//
// It reads the shipped plugin for the message catalog and the fixture corpus
// for what is asserted, so neither side can drift without this noticing.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixturesRoot = join(root, "conformance", "fixtures");

const { noEscapingThrow, validMark } = await import(
  new URL("../packages/eslint-plugin/dist/index.js", import.meta.url).href
);

/**
 * The labels an editor puts on an offered edit. They are asserted through the
 * suggestions a fixture pins rather than as diagnostics of their own, so they
 * are not owed a report.
 */
const OFFERS = new Set(["suggestBridge", "suggestAwaitBridge", "suggestAwait"]);

const catalog = new Map();
for (const [ruleName, rule] of [
  ["no-escaping-throw", noEscapingThrow],
  ["valid-mark", validMark],
]) {
  for (const [id, text] of Object.entries(rule.meta.messages)) {
    if (OFFERS.has(id)) continue;
    catalog.set(id, { rule: ruleName, text });
  }
}

/** Every diagnostic every fixture asserts, with the fixture it came from. */
const asserted = [];
for (const entry of readdirSync(fixturesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = join(fixturesRoot, entry.name, "expected.json");
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    continue;
  }
  for (const diagnostic of json.diagnostics ?? []) {
    asserted.push({ fixture: entry.name, ...diagnostic });
  }
}

/** Only the ones with text: a `messageId` alone asserts nothing about wording. */
const withText = asserted.filter(({ message }) => typeof message === "string");

/**
 * The outs, in the precedence order §H fixes them in. A floor names all of
 * them and names them in this order, so a message that lists a rung early
 * reads as advice to reach for the wrong one first.
 */
const OUTS_IN_ORDER = [
  "nothrow.overrides.json",
  "`@no-throw/*` overlay",
  "nothrow emit",
];

/**
 * Which messages are floors. Read off the catalog rather than listed here: a
 * floor is exactly a message that names the outs, so a new one joins this set
 * by saying what §H requires it to say, and a floor that stops saying it
 * leaves the set and trips the clause below.
 */
const floors = [...catalog]
  .filter(([, { text }]) => text.includes("Your outs, in precedence order:"))
  .map(([id]) => id);

const clauses = [
  {
    name: "Every normative message has a fixture asserting its text",
    why: "§H — diagnostic text is part of the spec, not of the implementation",
    check: () => {
      const covered = new Set(withText.map(({ messageId }) => messageId));
      return [...catalog.keys()]
        .filter((id) => !covered.has(id))
        .map((id) => `\`${id}\` (${catalog.get(id).rule}) is asserted by no fixture`);
    },
  },
  {
    name: "Every floor names its outs, in precedence order",
    why: "§H — the two-clause contract: [why it floored] + [the outs, in precedence order]",
    check: () =>
      withText
        .filter(({ messageId }) => floors.includes(messageId))
        .flatMap(({ fixture, messageId, message }) => {
          const at = OUTS_IN_ORDER.map((out) => message.indexOf(out));
          if (at.some((index) => index < 0)) {
            const missing = OUTS_IN_ORDER.filter(
              (out) => !message.includes(out),
            );
            return [`${fixture}: \`${messageId}\` names no ${missing.join(", ")}`];
          }
          return at.every((index, i) => i === 0 || index > at[i - 1])
            ? []
            : [`${fixture}: \`${messageId}\` names the outs out of precedence order`];
        }),
  },
  {
    name: "A floor tells not-yet-analyzed apart from unknowable-from-here",
    why: "§H — a `let` is a refinement the engine has not made; a parameter is not knowable at all",
    check: () => {
      const notYet = withText.filter(({ message }) =>
        /does not yet track|refinement not yet made/u.test(message),
      );
      const unknowable = withText.filter(({ message }) =>
        message.includes("unknowable from here"),
      );
      const problems = [];
      if (notYet.length === 0) problems.push("no fixture asserts a not-yet-analyzed floor");
      if (unknowable.length === 0) {
        problems.push("no fixture asserts an unknowable-from-here floor");
      }
      return problems;
    },
  },
  {
    name: "A hash-mismatch floor names the stale file",
    why: "§H via #17 — skew has to fail loudly enough to act on",
    check: () => {
      const named = withText.filter(({ message }) =>
        /no longer matches its package's files — `[^`]+` has changed/u.test(message),
      );
      return named.length === 0
        ? ["no fixture asserts a stale-manifest floor naming the file"]
        : [];
    },
  },
  {
    name: "A condition failure names the path and where the body enters it",
    why: "§H via #23 — the reader has to know which argument and why",
    check: () =>
      withText
        .filter(({ messageId }) =>
          ["conditionArgumentThrowing", "conditionArgumentFloored"].includes(
            messageId,
          ),
        )
        .flatMap(({ fixture, messageId, message }) =>
          /non-throwing given `[^`]+`/u.test(message) &&
          /enters `[^`]+` at /u.test(message)
            ? []
            : [`${fixture}: \`${messageId}\` names no path or no entry point`],
        ),
  },
  {
    name: "A dead mark reports its cause, and only what the cause lets it say",
    why: "§H via #53 — a nearest valid site where there is one, and never where climbing would change the claim",
    check: () => {
      const problems = [];
      const says = (id, pattern, what) => {
        const found = withText.filter(
          ({ messageId, message }) => messageId === id && pattern.test(message),
        );
        if (found.length === 0) problems.push(`no fixture asserts ${what}`);
      };

      says("ineffectiveMark", /nearest valid site is .+ on line \d+/u, "a mark naming its nearest valid site");
      says("ineffectiveMarkNoSite", /no valid site near it/u, "a mark saying there is no valid site");

      // The two that must *not* climb: inside any function, "move it onto the
      // enclosing function" is advice to claim something else.
      for (const id of ["markOnCallArgument", "markOnAssignment"]) {
        for (const { fixture, message } of withText.filter(
          ({ messageId }) => messageId === id,
        )) {
          if (/nearest valid site/u.test(message)) {
            problems.push(`${fixture}: \`${id}\` names a nearest valid site, which would change the claim`);
          }
        }
      }
      return problems;
    },
  },
  {
    name: "Suggestions are offered in both bridge shapes, and their absence is asserted too",
    why: "§H via #18 — the mechanical edit, shaped per context",
    check: () => {
      const offered = asserted.flatMap(({ suggestions }) => suggestions ?? []);
      const problems = [];
      if (!offered.some(({ output }) => joined(output).includes("try {") && !joined(output).includes("await"))) {
        problems.push("no fixture asserts a sync bridge suggestion");
      }
      if (!offered.some(({ output }) => /try \{\s*await /u.test(joined(output)))) {
        problems.push("no fixture asserts an async `try { await … } catch` suggestion");
      }
      if (!asserted.some(({ suggestions }) => Array.isArray(suggestions) && suggestions.length === 0)) {
        problems.push("no fixture asserts a diagnostic that offers no edit");
      }
      return problems;
    },
  },
  {
    name: "No rule may offer an autofix",
    why: "§H — wrapping a call in `try`/`catch` changes behavior, so the edit is always the reader's",
    // The artifact is the driver rather than a fixture, and deliberately so:
    // asserted per fixture it would hold for the fixtures that remembered,
    // while in the driver it holds for the whole corpus at once.
    check: () => {
      const driver = readFileSync(
        join(root, "conformance", "src", "driver-eslint.ts"),
        "utf8",
      );
      return /message\.fix !== undefined/u.test(driver)
        ? []
        : ["the conformance driver no longer refuses an autofix"];
    },
  },
];

const failures = [];
for (const clause of clauses) {
  const problems = clause.check();
  const mark = problems.length === 0 ? "OK  " : "FAIL";
  console.log(`${mark}  ${clause.name}`);
  console.log(`      ${clause.why}`);
  for (const problem of problems) console.log(`      → ${problem}`);
  if (problems.length > 0) failures.push(clause.name);
}

console.log(
  `\n${clauses.length} §H clauses over ${catalog.size} normative messages and ${asserted.length} asserted diagnostics.`,
);

if (failures.length > 0) {
  console.error(`\n${failures.length} clause(s) with no asserting fixture.`);
  process.exit(1);
}

function joined(output) {
  return output.join("\n");
}
