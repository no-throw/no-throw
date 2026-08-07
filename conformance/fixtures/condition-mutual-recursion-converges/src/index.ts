interface Node {
  readonly value: string;
  readonly children: readonly Node[];
}

function visitA(node: Node, cb: (n: Node) => void): void {
  cb(node);
  for (const child of node.children) visitB(child, cb);
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
    seen[seen.length] = n.value;
  });
}

/** @nothrow */
export function parse(root: Node): void {
  walk(root, (n) => {
    parsed[parsed.length] = JSON.parse(n.value);
  });
}

const seen: string[] = [];
const parsed: unknown[] = [];
