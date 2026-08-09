import { writeFileSync } from "node:fs";
import { callGraphAt } from "../graph.js";

/**
 * What the call graph of a real codebase looks like, condensed. The memo unit
 * is the SCC (#30 §G), so the shape of that condensation — how many groups are
 * singletons, how big the biggest one gets — is what decides whether an
 * invalidation that must dirty a whole group is cheap or ruinous.
 */
function main(): void {
  const [targetDirectory, tsconfig, scope, outFile] = process.argv.slice(2);
  if (targetDirectory === undefined || tsconfig === undefined) {
    throw new Error("usage: scc <target-directory> <tsconfig> [scope] [out]");
  }

  const graph = callGraphAt(targetDirectory, tsconfig, scope ?? "");

  const sizes = new Map<number, number>();
  for (const group of graph.groups) {
    sizes.set(group.members.length, (sizes.get(group.members.length) ?? 0) + 1);
  }

  const cycles = graph.groups
    .filter((group) => group.members.length > 1)
    .map((group) => ({
      size: group.members.length,
      members: group.members.map(
        (member) =>
          `${short(member.file)}:${String(member.line)} ${member.name}`,
      ),
    }));

  const report = {
    programMs: Math.round(graph.programMs),
    graphMs: Math.round(graph.graphMs),
    functions: graph.nodes.length,
    edges: graph.edges,
    groups: graph.groups.length,
    sizeHistogram: [...sizes.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([size, count]) => ({ size, count })),
    cycles,
  };

  const json = `${JSON.stringify(report, undefined, 2)}\n`;
  if (outFile !== undefined) writeFileSync(outFile, json);
  process.stdout.write(
    `${JSON.stringify({ ...report, cycles: cycles.length }, undefined, 2)}\n`,
  );
}

function short(fileName: string): string {
  return fileName.split("/").slice(-2).join("/");
}

main();
