import { parse } from 'acorn';
import { simple } from 'acorn-walk';
import type { Node } from 'acorn';

export const BANNED_GLOBALS = new Set([
  'process', 'require', 'global', 'globalThis', 'Buffer', 'Deno',
  '__dirname', '__filename', 'module', 'exports', 'eval', 'Function',
  'WebAssembly', 'XMLHttpRequest', 'fetch', 'WebSocket', 'Worker',
  'SharedArrayBuffer',
]);

const BANNED_MEMBERS = new Set([
  'constructor', '__proto__', 'prototype',
]);

export interface PolicyResult {
  ok: boolean;
  errors: string[];
}

/**
 * True when the wrapped program is still the one call it was built as. Code that closes the
 * wrapping function early runs outside it, where a module accepts `import` and `export`.
 */
function wrapperIntact(ast: any): boolean {
  const [statement, ...rest] = ast.body;
  const call = statement?.type === 'ExpressionStatement' ? statement.expression : undefined;
  return rest.length === 0 && call?.type === 'CallExpression' && call.arguments.length === 0
    && call.callee.type === 'ArrowFunctionExpression';
}

export function preflight(code: string): PolicyResult {
  const errors: string[] = [];
  // User code is executed inside an async wrapper, so allow top-level await/return.
  // Parse the user code directly in module mode first to catch imports; then re-parse
  // wrapped to validate the rest of the AST.
  let directAst: Node | null = null;
  try {
    directAst = parse(code, { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true });
  } catch {
    // ignore — wrapper parse will be authoritative
  }
  if (directAst) {
    simple(directAst, {
      ImportDeclaration() { errors.push('imports are not allowed'); },
      ImportExpression() { errors.push('dynamic import() is not allowed'); },
    });
  }

  const wrapped = `(async () => { ${code}\n })()`;
  const visitors = {
    ImportDeclaration() { errors.push('imports are not allowed'); },
    ImportExpression() { errors.push('dynamic import() is not allowed'); },
    CallExpression(node: any) {
      const callee = node.callee;
      if (callee?.type === 'Identifier' && (callee.name === 'eval' || callee.name === 'Function')) {
        errors.push(`call to ${callee.name}() is not allowed`);
      }
    },
    NewExpression(node: any) {
      const callee = node.callee;
      if (callee?.type === 'Identifier' && callee.name === 'Function') {
        errors.push('new Function() is not allowed');
      }
    },
    Identifier(node: any) {
      if (BANNED_GLOBALS.has(node.name)) {
        errors.push(`reference to '${node.name}' is not allowed`);
      }
    },
    MemberExpression(node: any) {
      // `a.constructor`, `a['constructor']` and a template literal without substitutions. A
      // fully dynamic key (`a[k]`) cannot be decided statically: the runners are the boundary.
      const p = node.property;
      const name = !node.computed && p?.type === 'Identifier' ? p.name
        : node.computed && p?.type === 'Literal' && typeof p.value === 'string' ? p.value
        : node.computed && p?.type === 'TemplateLiteral' && p.expressions.length === 0 ? p.quasis[0]?.value?.cooked
        : undefined;
      if (name !== undefined && BANNED_MEMBERS.has(name)) errors.push(`access to .${name} is not allowed`);
    },
    // `const { constructor: F } = x` reads the same member without a MemberExpression.
    ObjectPattern(node: any) {
      for (const prop of node.properties) {
        const key = prop.type === 'Property' ? prop.key : undefined;
        const name = key?.type === 'Identifier' && !prop.computed ? key.name
          : key?.type === 'Literal' && typeof key.value === 'string' ? key.value
          : undefined;
        if (name !== undefined && BANNED_MEMBERS.has(name)) errors.push(`access to .${name} is not allowed`);
      }
    },
    MetaProperty(node: any) {
      if (node.meta?.name === 'import') errors.push('import.meta is not allowed');
    },
  };
  // A script and a module read HTML-like comments (`<!--`, `-->`) differently, so one text can
  // be two programs. A runner executes the code as one or the other: check it as both.
  for (const sourceType of ['module', 'script'] as const) {
    let ast: Node;
    try {
      ast = parse(wrapped, { ecmaVersion: 2022, sourceType, allowAwaitOutsideFunction: true });
    } catch (err) {
      return { ok: false, errors: [...errors, `Parse error: ${(err as Error).message}`] };
    }
    if (!wrapperIntact(ast)) errors.push('the code must not close the function that wraps it');
    simple(ast, visitors);
    // The second reading matters only when the first one found nothing.
    if (errors.length) break;
  }

  return { ok: errors.length === 0, errors };
}
