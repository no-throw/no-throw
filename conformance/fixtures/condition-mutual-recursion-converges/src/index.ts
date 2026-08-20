interface Node {
  readonly value: string;
  readonly children: readonly Node[];
}

function visitA(node: Node, cb: (n: Node) => void): void {
  cb(node);
  for (let i = 0; i < node.children.length; i += 1) visitB(node.children[i], cb);
}

function visitB(node: Node, cb: (n: Node) => void): void {
  visitA(node, cb);
}

/** @nothrow */
export function walk(root: Node, cb: (n: Node) => void): void {
  visitA(root, cb);
}

/** @nothrow */
export function collect(root: Node): void {
  walk(root, (n) => {
    seen.last = n.value;
  });
}

/** @nothrow */
export function parse(root: Node): void {
  walk(root, (n) => {
    parsed.last = JSON.parse(n.value);
  });
}

const seen = { last: "" };
const parsed: { last: unknown } = { last: undefined };
