import { createRequire } from "node:module";

/**
 * Curated WebIDL, from `@webref/idl`. It contributes exactly two things: the
 * symbol set, and `[EnforceRange]`. #26 checked all 329 specs' extended
 * attributes and *not one* mentions throwing — IDL carries shapes only — so
 * every throw fact in this baseline comes from prose, and nothing here is ever
 * read as evidence that a member is clean.
 */

interface IdlExtAttr {
  readonly name: string;
}

interface IdlType {
  readonly idlType?: string | IdlType | readonly IdlType[];
  readonly union?: boolean;
  readonly generic?: string;
}

interface IdlArgument {
  readonly name: string;
  readonly idlType?: IdlType;
  readonly extAttrs?: readonly IdlExtAttr[];
  readonly optional?: boolean;
  readonly variadic?: boolean;
}

interface IdlMember {
  readonly type: string;
  readonly name?: string;
  readonly special?: string;
  readonly readonly?: boolean;
  readonly idlType?: IdlType;
  readonly extAttrs?: readonly IdlExtAttr[];
  readonly arguments?: readonly IdlArgument[];
}

interface IdlDefinition {
  readonly type: string;
  readonly name?: string;
  readonly partial?: boolean;
  readonly members?: readonly IdlMember[];
  readonly idlType?: IdlType;
  /** `A includes B` — `target` includes `includes`. */
  readonly target?: string;
  readonly includes?: string;
}

export type IdlKind = "operation" | "attribute" | "constructor" | "const";

export interface IdlArg {
  readonly name: string;
  readonly types: readonly string[];
  readonly enforceRange: boolean;
  readonly optional: boolean;
  readonly variadic: boolean;
  /** The declared type resolves to a `callback` or `callback interface`. */
  readonly callback: boolean;
}

export interface IdlRow {
  readonly spec: string;
  readonly owner: string;
  readonly name: string;
  readonly kind: IdlKind;
  readonly isStatic: boolean;
  readonly readonly: boolean;
  readonly args: readonly IdlArg[];
  /** Set when the row reached an interface through `A includes Mixin`. */
  readonly viaMixin: string | undefined;
}

export interface IdlCorpus {
  /** `Interface.member` → rows, mixins flattened onto every including host. */
  readonly byMember: ReadonlyMap<string, readonly IdlRow[]>;
  readonly dictionaries: ReadonlySet<string>;
  readonly callbacks: ReadonlySet<string>;
  readonly enums: ReadonlySet<string>;
  readonly interfaces: ReadonlySet<string>;
  /** Lowercased interface name → its IDL spelling (`console` vs `Console`). */
  readonly interfacesByLowerName: ReadonlyMap<string, string>;
  /** IDL interface → the mixins it includes, for prose attribution. */
  readonly mixinsOf: ReadonlyMap<string, readonly string[]>;
  readonly stats: {
    readonly specs: number;
    readonly members: number;
    readonly enforceRange: number;
    readonly callbackTaking: number;
    readonly throwBearingExtAttrs: readonly string[];
  };
}

interface WebrefIdl {
  parseAll(): Promise<Record<string, readonly IdlDefinition[]>>;
}

export async function loadIdlCorpus(): Promise<IdlCorpus> {
  const require = createRequire(import.meta.url);
  const webref = require("@webref/idl") as WebrefIdl;
  const parsed = await webref.parseAll();

  const callbacks = new Set<string>();
  const enums = new Set<string>();
  const dictionaries = new Set<string>();
  const interfaces = new Set<string>();
  const typedefs = new Map<string, IdlType>();
  const includes: { host: string; mixin: string }[] = [];

  for (const tree of Object.values(parsed)) {
    for (const definition of tree) {
      const name = definition.name;
      switch (definition.type) {
        case "callback":
          if (name !== undefined) callbacks.add(name);
          break;
        // A callback interface is both things at once: `NodeFilter` is what a
        // caller implements *and* a real global carrying the `SHOW_*`
        // constants, so it belongs in both indexes.
        case "callback interface":
          if (name !== undefined) {
            callbacks.add(name);
            interfaces.add(name);
          }
          break;
        case "enum":
          if (name !== undefined) enums.add(name);
          break;
        case "dictionary":
          if (name !== undefined) dictionaries.add(name);
          break;
        case "typedef":
          if (name !== undefined && definition.idlType !== undefined) {
            typedefs.set(name, definition.idlType);
          }
          break;
        case "interface":
        case "namespace":
        case "interface mixin":
          if (name !== undefined) interfaces.add(name);
          break;
        case "includes":
          if (definition.target !== undefined && definition.includes !== undefined) {
            includes.push({ host: definition.target, mixin: definition.includes });
          }
          break;
        default:
          break;
      }
    }
  }

  const resolveTypedef = (name: string, depth = 0): readonly string[] => {
    const target = typedefs.get(name);
    if (target === undefined || depth > 6) return [name];
    return flatten(target, depth + 1);
  };

  function flatten(type: IdlType | undefined, depth = 0): readonly string[] {
    if (type === undefined || depth > 8) return [];
    const inner = type.idlType;
    if (Array.isArray(inner)) {
      return (inner as readonly IdlType[]).flatMap((part) => flatten(part, depth + 1));
    }
    if (typeof inner === "string") return resolveTypedef(inner, depth);
    if (inner !== undefined) return flatten(inner as IdlType, depth + 1);
    return [];
  }

  const owned = new Map<string, IdlRow[]>();
  const rows: IdlRow[] = [];

  const argOf = (argument: IdlArgument): IdlArg => {
    const types = flatten(argument.idlType);
    return {
      name: argument.name,
      types,
      enforceRange: (argument.extAttrs ?? []).some(
        (attribute) => attribute.name === "EnforceRange",
      ),
      optional: argument.optional === true,
      variadic: argument.variadic === true,
      callback: types.some((type) => callbacks.has(type)),
    };
  };

  for (const [spec, tree] of Object.entries(parsed)) {
    for (const definition of tree) {
      if (
        definition.name === undefined ||
        !["interface", "namespace", "interface mixin", "callback interface"].includes(
          definition.type,
        )
      ) {
        continue;
      }
      const owner = definition.name;
      for (const member of definition.members ?? []) {
        const kind = kindOf(member);
        if (kind === undefined) continue;
        const name = kind === "constructor" ? "constructor" : member.name;
        if (name === undefined || name === "") continue;
        const row: IdlRow = {
          spec,
          owner,
          name,
          kind,
          isStatic: member.special === "static",
          readonly: member.readonly === true,
          args: (member.arguments ?? []).map(argOf),
          viaMixin: undefined,
        };
        rows.push(row);
        (owned.get(owner) ?? put(owned, owner)).push(row);
      }
    }
  }

  const byMember = new Map<string, IdlRow[]>();
  const index = (owner: string, row: IdlRow): void => {
    const key = `${owner}.${row.name}`;
    (byMember.get(key) ?? put(byMember, key)).push(row);
  };
  for (const row of rows) index(row.owner, row);

  const mixinsOf = new Map<string, string[]>();
  for (const { host, mixin } of includes) {
    (mixinsOf.get(host) ?? put(mixinsOf, host)).push(mixin);
    // `lib.dom.d.ts` keeps most mixins as their own interface but flattens some
    // into the host, so both spellings have to resolve.
    for (const row of owned.get(mixin) ?? []) index(host, { ...row, viaMixin: mixin });
  }

  const throwBearing = new Set<string>();
  for (const tree of Object.values(parsed)) {
    for (const definition of tree) {
      for (const member of definition.members ?? []) {
        for (const attribute of member.extAttrs ?? []) {
          if (/throw|error|exception|fail/i.test(attribute.name)) {
            throwBearing.add(attribute.name);
          }
        }
      }
    }
  }

  return {
    byMember,
    dictionaries,
    callbacks,
    enums,
    interfaces,
    interfacesByLowerName: new Map(
      [...interfaces].map((name) => [name.toLowerCase(), name]),
    ),
    mixinsOf,
    stats: {
      specs: Object.keys(parsed).length,
      members: rows.length,
      enforceRange: rows.filter((row) => row.args.some((arg) => arg.enforceRange))
        .length,
      callbackTaking: rows.filter((row) => row.args.some((arg) => arg.callback))
        .length,
      throwBearingExtAttrs: [...throwBearing].sort(),
    },
  };
}

function put<T>(map: Map<string, T[]>, key: string): T[] {
  const created: T[] = [];
  map.set(key, created);
  return created;
}

function kindOf(member: IdlMember): IdlKind | undefined {
  switch (member.type) {
    case "operation":
      return member.name === undefined || member.name === "" ? undefined : "operation";
    case "attribute":
      return "attribute";
    case "constructor":
      return "constructor";
    case "const":
      return "const";
    default:
      return undefined;
  }
}
