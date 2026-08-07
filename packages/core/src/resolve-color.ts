import ts from "typescript";
import type {
  CalleeColor,
  Colored,
  ConsumptionColor,
  ConsumptionReason,
  FloorReason,
} from "./colors.js";
import {
  baseClassExpression,
  bodyOf,
  constructedBody,
  hasVisibleBody,
  inheritedFrom,
  isGenerator,
  returnedExpressions,
  type Bodied,
} from "./declarations.js";
import { calleeExpression, unbridgedEscapes, type Transfer } from "./escapes.js";
import { createFixpoint, type BodyEdges } from "./infer.js";
import {
  constituentsOf,
  isIteratorType,
  protocolMember,
  type Consumption,
  type Protocol,
} from "./iteration.js";
import { isMarkedFunction } from "./marks.js";
import { originatingCall } from "./originating-call.js";
import { colorPolicy } from "./policy.js";

/**
 * The color-resolution seam. Every "what color is this callee?" question goes
 * through here, so inference and the resolver chain — overrides, overlays,
 * shipped manifests, the baseline — land behind this one object instead of
 * being threaded through the walk.
 *
 * Inference is the last rung and a removable one: with the `declare` policy the
 * chain stops at the pins and everything unmarked floors, which is the sound
 * end of the range rather than a degraded mode.
 */
export interface ColorResolver {
  at(transfer: Transfer): CalleeColor;
  /** The color of running the iteration protocol at a consumption site. */
  consuming(site: Consumption): ConsumptionColor;
  /**
   * The color of consuming the iterator an expression denotes. One color, full
   * surface: a mark promises the call *and* the consumption, so a marked
   * function handing an iterator out has this half of its promise to keep too.
   */
  producing(expression: ts.Expression): ConsumptionColor;
}

/**
 * A generator's call and its iterator are two colors over one body — the call
 * runs the parameter list, consumption runs everything else — so what the graph
 * colors is a facet of a declaration rather than the declaration. For every
 * other function kind the call facet is the whole body, and the iteration facet
 * is whatever its `return` hands back.
 */
type Facet = "call" | "iteration";

interface ColorNode {
  readonly declaration: Bodied;
  readonly facet: Facet;
}

/**
 * What a site's color is made of: the reasons it is throwing outright, and the
 * nodes whose inferred colors join in. Keeping the pieces rather than a color
 * is what lets one resolution serve enforcement, which reports the first
 * reason, and inference, which follows the nodes.
 */
interface Surface<Reason extends string> {
  readonly floors: readonly Reason[];
  readonly nodes: readonly ColorNode[];
}

const CLEAN: Surface<never> = { floors: [], nodes: [] };

export function createColorResolver(checker: ts.TypeChecker): ColorResolver {
  const policy = colorPolicy();
  const fixpoint = createFixpoint<ColorNode>(edgesOf);
  // Node identity is the memo key, so a facet of a declaration has to be one
  // object however many sites ask about it.
  const interned = new Map<Bodied, Map<Facet, ColorNode>>();

  function nodeFor(declaration: Bodied, facet: Facet): ColorNode {
    let facets = interned.get(declaration);
    if (facets === undefined) {
      facets = new Map<Facet, ColorNode>();
      interned.set(declaration, facets);
    }
    const known = facets.get(facet);
    if (known !== undefined) return known;
    const node: ColorNode = { declaration, facet };
    facets.set(facet, node);
    return node;
  }

  /**
   * The chain up to, but not including, inference, for whichever facet is
   * asked for. A mark is trusted here and verified separately against its own
   * body — assume-then-verify, so a cycle through a seed is colored against the
   * mark and a lying mark fails loud where it was written rather than quietly
   * poisoning its callers.
   */
  function surfaceOf(
    target: Bodied | undefined,
    facet: Facet,
  ): Surface<FloorReason> {
    if (target === undefined) return floor("unresolvable");
    if (isMarkedFunction(target)) return CLEAN;
    if (!hasVisibleBody(target)) return floor("bodyless");
    if (policy === "declare") return floor("unmarked");
    return { floors: [], nodes: [nodeFor(target, facet)] };
  }

  /**
   * The color of consuming what an expression denotes, joined over every type
   * the value can have: a union runs whichever protocol the value turns out to
   * carry, so coloring one constituent would color by coin toss.
   */
  function consumptionSurface(site: Consumption): Surface<ConsumptionReason> {
    const types = constituentsOf(checker.getTypeAtLocation(site.typeAt), checker);
    return join(types.map((type) => constituentSurface(site, type)));
  }

  /**
   * The originating call answers first and answers for everything, because the
   * mark it carries is a promise about the whole surface; only where the syntax
   * names no call is the protocol resolved member by member.
   */
  function constituentSurface(
    site: Consumption,
    type: ts.Type,
  ): Surface<ConsumptionReason> {
    const iterator = isIteratorType(type, checker);
    const origin =
      site.source === undefined
        ? undefined
        : originatingCall(site.source, checker);

    if (iterator && origin !== undefined) {
      return surfaceOf(targetOf(origin, checker), "iteration");
    }

    const resolved = protocolSurface(type, site.protocol);
    // An iterator's own protocol members are the standard library's, so
    // "declared without a body" would name a `.d.ts` the author never wrote.
    // What they can act on is the call that produced the value.
    return iterator && resolved.floors.includes("bodyless")
      ? floor(untracedReason(site.source, checker))
      : resolved;
  }

  /** The protocol members a site runs, resolved through the static type. */
  function protocolSurface(
    type: ts.Type,
    protocol: Protocol,
  ): Surface<ConsumptionReason> {
    if (protocol.kind === "member") {
      return surfaceOf(protocolMember(type, protocol.name, checker), "call");
    }
    if (protocol.kind === "iterable") return iterableSurface(type);

    // A returned iterator is consumed by code we cannot see, so every part of
    // its surface is in scope.
    const parts: Surface<ConsumptionReason>[] = [];
    for (const name of ["next", "return"] as const) {
      const member = protocolMember(type, name, checker);
      if (member !== undefined) parts.push(surfaceOf(member, "call"));
    }
    if (protocolMember(type, "iterator", checker) !== undefined) {
      parts.push(iterableSurface(type));
    }
    return parts.length === 0 ? floor("unresolvable") : join(parts);
  }

  /** `[Symbol.iterator]()` runs, and what it hands back is driven to done. */
  function iterableSurface(type: ts.Type): Surface<ConsumptionReason> {
    const member = protocolMember(type, "iterator", checker);
    if (member === undefined) return floor("unresolvable");
    return join([surfaceOf(member, "call"), surfaceOf(member, "iteration")]);
  }

  /** The whole surface of the iterator an expression denotes. */
  function producedSurface(
    expression: ts.Expression,
  ): Surface<ConsumptionReason> {
    return consumptionSurface({
      node: expression,
      protocol: { kind: "iterator" },
      source: expression,
      typeAt: expression,
    });
  }

  /** One node's contribution to the graph, off the walk enforcement also uses. */
  function edgesOf(node: ColorNode): BodyEdges<ColorNode> {
    const { declaration, facet } = node;
    let throws = false;
    const callees: ColorNode[] = [];

    const follow = (surface: Surface<string>): void => {
      if (surface.floors.length > 0) throws = true;
      callees.push(...surface.nodes);
    };

    if (facet === "iteration" && !isGenerator(declaration)) {
      // A plain function's iterator is whatever it returns, and consuming that
      // is what consuming this one is. Every return counts, unfiltered: a
      // branch handing back something that is not an iterator is a question
      // with no answer rather than one to skip.
      const returned = returnedExpressions(declaration);
      if (returned.length === 0) return { throws: true, callees: [] };
      for (const expression of returned) follow(producedSurface(expression));
      return { throws, callees };
    }

    // The one region split there is: a generator's parameter list runs at the
    // call and its body runs at the consumption sites.
    const phase = !isGenerator(declaration)
      ? "all"
      : facet === "call"
        ? "eager"
        : "lazy";

    for (const escape of unbridgedEscapes(declaration, checker, phase)) {
      if (escape.kind === "throw") {
        throws = true;
      } else if (escape.kind === "transfer") {
        follow(surfaceOf(targetOf(escape.node, checker), "call"));
      } else if (escape.kind === "iterator-throw") {
        // `.throw()` is the consumer throwing, with a detour through the
        // iterator. Nothing colors it.
        throws = true;
      } else {
        follow(consumptionSurface(escape.site));
      }
    }

    // A class stands for a constructor it does not declare, and the implicit
    // `constructor(...args) { super(...args) }` still runs the base's effective
    // body. There is no `super()` in the syntax for the walk to have found.
    if (ts.isClassLike(declaration)) {
      const base = baseClassExpression(declaration);
      if (base !== undefined) {
        follow(surfaceOf(constructedBodyAt(base, checker), "call"));
      }
    }

    return { throws, callees };
  }

  function colorOf<Reason extends string>(
    surface: Surface<Reason>,
  ): Colored<Reason | "inferred"> {
    const [reason] = surface.floors;
    if (reason !== undefined) return { color: "throwing", reason };
    return surface.nodes.some((node) => fixpoint.isThrowing(node))
      ? { color: "throwing", reason: "inferred" }
      : { color: "non-throwing" };
  }

  return {
    at: (transfer) => colorOf(surfaceOf(targetOf(transfer, checker), "call")),
    consuming: (site) => colorOf(consumptionSurface(site)),
    producing: (expression) => colorOf(producedSurface(expression)),
  };
}

function floor<Reason extends string>(reason: Reason): Surface<Reason> {
  return { floors: [reason], nodes: [] };
}

function join<Reason extends string>(
  surfaces: readonly Surface<Reason>[],
): Surface<Reason> {
  return {
    floors: surfaces.flatMap((surface) => surface.floors),
    nodes: surfaces.flatMap((surface) => surface.nodes),
  };
}

/**
 * Which half of "no originating call" this is. A binding the rule does not
 * follow yet is a refinement we owe you; anything else is a question the syntax
 * cannot answer, and the fix is to bridge, or to name the call.
 */
function untracedReason(
  source: ts.Expression | undefined,
  checker: ts.TypeChecker,
): ConsumptionReason {
  if (source === undefined || !ts.isIdentifier(source)) return "untraced-opaque";
  const declaration = checker.getSymbolAtLocation(source)?.valueDeclaration;
  return declaration !== undefined && ts.isVariableDeclaration(declaration)
    ? "untraced-binding"
    : "untraced-opaque";
}

/** The body an escape site transfers control into, where one can be named. */
function targetOf(
  transfer: Transfer,
  checker: ts.TypeChecker,
): Bodied | undefined {
  if (ts.isNewExpression(transfer)) {
    return (
      constructedBodyAt(transfer.expression, checker) ??
      constructSignatureOf(transfer, checker)
    );
  }
  if (calleeExpression(transfer).kind === ts.SyntaxKind.SuperKeyword) {
    const base = inheritedFrom(transfer);
    return base === undefined ? undefined : constructedBodyAt(base, checker);
  }

  const declaration = checker.getResolvedSignature(transfer)?.declaration;
  return declaration !== undefined && ts.isFunctionLike(declaration)
    ? declaration
    : undefined;
}

/**
 * The class a constructor-position expression denotes, and the body `new` on it
 * enters. The resolved *signature* is no substitute: a derived class that
 * declares no constructor resolves to its base's, which would skip the derived
 * class's own field initializers.
 */
function constructedBodyAt(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): Bodied | undefined {
  const declaration =
    checker.getTypeAtLocation(expression).symbol?.valueDeclaration;
  return declaration !== undefined && ts.isClassLike(declaration)
    ? constructedBody(declaration)
    : undefined;
}

/**
 * A construct signature with no class behind it — `new Error()`, an interface's
 * `new ()` — is a bodyless declaration, and saying that beats saying nothing
 * resolved. Only a bodyless one is taken: a bodied signature the class lookup
 * missed means the expression was not one class, and reading a single branch of
 * it would be a guess.
 */
function constructSignatureOf(
  construction: ts.NewExpression,
  checker: ts.TypeChecker,
): ts.SignatureDeclaration | undefined {
  const declaration = checker.getResolvedSignature(construction)?.declaration;
  return declaration !== undefined &&
    ts.isFunctionLike(declaration) &&
    bodyOf(declaration) === undefined
    ? declaration
    : undefined;
}
