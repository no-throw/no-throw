/**
 * A JSON Schema evaluator over the subset `nothrow.schema.json` uses.
 *
 * The published schema is the contract hand-authors get editor validation
 * from, and the reader is what actually decides whether a manifest is
 * honored — so the two must be the same thing. Rather than hand-code a second
 * validator that can drift from the file we publish, the engine evaluates the
 * published schema directly. The subset is closed by what that file needs:
 * `$ref` into `$defs`, `type`, `enum`, `const`, `required`, `properties`,
 * `patternProperties`, `additionalProperties`, `items`, `pattern`, `oneOf`.
 */

/** Where a value failed the schema, as the property names leading to it. */
export interface SchemaIssue {
  readonly path: readonly string[];
}

type Schema = Record<string, unknown>;

/**
 * Every place `value` departs from `schema`. Empty means valid. Issues carry
 * their location because the manifest reader treats them differently by depth:
 * a bad entry floors that entry, a bad envelope floors the file.
 */
export function validate(schema: unknown, value: unknown): readonly SchemaIssue[] {
  if (!isSchema(schema)) return [{ path: [] }];
  const issues: SchemaIssue[] = [];
  check(schema, value, [], schema, issues);
  return issues;
}

function check(
  schema: Schema,
  value: unknown,
  path: readonly string[],
  root: Schema,
  issues: SchemaIssue[],
): void {
  const reference = schema["$ref"];
  if (typeof reference === "string") {
    const resolved = resolve(reference, root);
    if (resolved === undefined) issues.push({ path });
    else check(resolved, value, path, root, issues);
    return;
  }

  const before = issues.length;

  checkType(schema, value, path, issues);
  checkEnum(schema, value, path, issues);
  checkPattern(schema, value, path, issues);
  checkOneOf(schema, value, path, root, issues);

  // A value that is not even the right shape says nothing useful about its
  // members, and reporting every one of them would bury the real fault.
  if (issues.length !== before) return;

  if (Array.isArray(value)) checkItems(schema, value, path, root, issues);
  else if (isSchema(value)) checkObject(schema, value, path, root, issues);
}

function checkType(
  schema: Schema,
  value: unknown,
  path: readonly string[],
  issues: SchemaIssue[],
): void {
  const type = schema["type"];
  if (typeof type !== "string") return;
  if (!matchesType(type, value)) issues.push({ path });
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isSchema(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    default:
      return false;
  }
}

function checkEnum(
  schema: Schema,
  value: unknown,
  path: readonly string[],
  issues: SchemaIssue[],
): void {
  const allowed = schema["enum"];
  if (Array.isArray(allowed) && !allowed.includes(value)) {
    issues.push({ path });
  }
  if ("const" in schema && schema["const"] !== value) issues.push({ path });
}

function checkPattern(
  schema: Schema,
  value: unknown,
  path: readonly string[],
  issues: SchemaIssue[],
): void {
  const pattern = schema["pattern"];
  if (typeof pattern !== "string" || typeof value !== "string") return;
  if (!new RegExp(pattern, "u").test(value)) issues.push({ path });
}

/**
 * The branches in this schema are disjoint, so "some branch accepts it" and
 * "exactly one does" agree — and the looser test is the one whose failure
 * message points at the value rather than at a branch the author never meant.
 */
function checkOneOf(
  schema: Schema,
  value: unknown,
  path: readonly string[],
  root: Schema,
  issues: SchemaIssue[],
): void {
  const branches = schema["oneOf"];
  if (!Array.isArray(branches)) return;

  const accepted = branches.some((branch) => {
    if (!isSchema(branch)) return false;
    const attempt: SchemaIssue[] = [];
    check(branch, value, path, root, attempt);
    return attempt.length === 0;
  });
  if (!accepted) issues.push({ path });
}

function checkItems(
  schema: Schema,
  value: readonly unknown[],
  path: readonly string[],
  root: Schema,
  issues: SchemaIssue[],
): void {
  const items = schema["items"];
  if (!isSchema(items)) return;
  value.forEach((element, index) => {
    check(items, element, [...path, String(index)], root, issues);
  });
}

function checkObject(
  schema: Schema,
  value: Schema,
  path: readonly string[],
  root: Schema,
  issues: SchemaIssue[],
): void {
  const required = schema["required"];
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && !(key in value)) {
        issues.push({ path: [...path, key] });
      }
    }
  }

  const properties = asSchema(schema["properties"]);
  const patterns = asSchema(schema["patternProperties"]);
  const additional = schema["additionalProperties"];

  for (const [key, member] of Object.entries(value)) {
    const declared = properties?.[key];
    if (isSchema(declared)) {
      check(declared, member, [...path, key], root, issues);
      continue;
    }

    const matched = Object.entries(patterns ?? {}).filter(([pattern]) =>
      new RegExp(pattern, "u").test(key),
    );
    if (matched.length > 0) {
      for (const [, branch] of matched) {
        if (isSchema(branch)) check(branch, member, [...path, key], root, issues);
      }
      continue;
    }

    // Unknown fields are ignored by default — that is what let every wire
    // amendment land compatibly — so only an explicit rule rejects one.
    if (additional === false) issues.push({ path: [...path, key] });
    else if (isSchema(additional)) {
      check(additional, member, [...path, key], root, issues);
    }
  }
}

/** A local `#/a/b` pointer. The schema references nothing else. */
function resolve(reference: string, root: Schema): Schema | undefined {
  if (!reference.startsWith("#/")) return undefined;

  let current: unknown = root;
  for (const segment of reference.slice(2).split("/")) {
    if (!isSchema(current)) return undefined;
    current = current[decodeURIComponent(segment)];
  }
  return isSchema(current) ? current : undefined;
}

function asSchema(value: unknown): Schema | undefined {
  return isSchema(value) ? value : undefined;
}

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
