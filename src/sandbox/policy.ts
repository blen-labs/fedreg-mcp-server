import { parse } from 'acorn';
import { simple } from 'acorn-walk';
import type { Node } from 'acorn';

const BANNED_GLOBALS = new Set([
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
  let ast: Node;
  try {
    ast = parse(wrapped, { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true });
  } catch (err) {
    return { ok: false, errors: [...errors, `Parse error: ${(err as Error).message}`] };
  }

  simple(ast, {
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
      if (!node.computed && node.property?.type === 'Identifier' && BANNED_MEMBERS.has(node.property.name)) {
        errors.push(`access to .${node.property.name} is not allowed`);
      }
    },
    MetaProperty(node: any) {
      if (node.meta?.name === 'import') errors.push('import.meta is not allowed');
    },
  });

  return { ok: errors.length === 0, errors };
}
