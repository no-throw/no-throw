// rules/no-throw.mjs — THROWAWAY spike (no-throw ticket #6)
//
// A ~30-line typescript-eslint rule that is a thin SHELL over color-engine.mjs.
// Its only jobs: pull the checker off ParserServices, find the seeds, and turn
// engine escapes into ESLint reports. All the coloring logic lives in the engine.

import { ESLintUtils } from '@typescript-eslint/utils';
import { isMarked, collectEscapes } from '../color-engine.mjs';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/MidnightDesign/no-throw#${name}`,
);

export default createRule({
  name: 'no-escaping-throw',
  meta: {
    type: 'problem',
    docs: {
      description:
        'A @nothrow function must not let a throw escape: no uncaught throw, every throwing call bridged by try/catch.',
    },
    messages: {
      escapingThrow: 'Uncaught `throw` escapes this @nothrow function.',
      unbridgedCall:
        'Call to throwing `{{name}}` is not bridged by a try/catch in this @nothrow function.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const memo = new Map(); // shared across the whole file: infer each callee once

    const check = (esNode) => {
      const tsNode = services.esTreeNodeToTSNodeMap.get(esNode);
      if (!isMarked(tsNode)) return; // only seeds are enforced

      for (const escape of collectEscapes(tsNode, checker, memo)) {
        const reportAt = services.tsNodeToESTreeNodeMap.get(escape.node) ?? esNode;
        if (escape.kind === 'throw') {
          context.report({ node: reportAt, messageId: 'escapingThrow' });
        } else {
          context.report({ node: reportAt, messageId: 'unbridgedCall', data: { name: escape.name } });
        }
      }
    };

    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
      MethodDefinition: (node) => check(node.value),
    };
  },
});
