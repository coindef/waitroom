/**
 * The hooks loader rule that rejected wait-anchor on Claude Code 2.1.318.
 *
 * `$` may be passed only to a function declared at the top of the hooks file
 * (a function declaration, or a const bound to one) or imported from this
 * module's own file. A helper nested inside `register` is not followed, and
 * the module does not load. No engine.
 */

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** Value imports and top-level functions. Nested helpers are left out. */
export const topLevelHelpers = (source: string): ReadonlySet<string> => {
  const text = stripComments(source)
  const names = new Set<string>()

  for (const match of text.matchAll(/^import\s+(type\s+)?\{([^}]+)\}\s+from/gm)) {
    if (match[1] !== undefined) continue
    for (const part of (match[2] ?? '').split(',')) {
      const piece = part.trim()
      if (piece === '' || piece.startsWith('type ')) continue
      const name = piece.split(/\s+as\s+/).pop()?.trim()
      if (name !== undefined && /^[A-Za-z_]/.test(name)) names.add(name)
    }
  }

  for (const match of text.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    const name = match[1]
    if (name !== undefined) names.add(name)
  }

  for (const match of text.matchAll(/^(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(/gm)) {
    const name = match[1]
    const start = match.index ?? 0
    const window = text.slice(start, start + 600)
    const head = window.split(/\n(?:export\s+)?(?:const|function|type|export const register)\b/)[0] ?? window
    if (name !== undefined && /=>/.test(head)) names.add(name)
  }

  return names
}

/** Callees that are handed `$` as an argument. `$.session.root()` is not one. */
export const dollarCallees = (source: string): string[] => {
  const text = stripComments(source)
  const found: string[] = []
  for (const match of text.matchAll(/(?<![.\w])([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\$(?![A-Za-z0-9_])/g)) {
    const name = match[1]
    // `async ($: …)` is a parameter list, not a call.
    if (name !== undefined && name !== 'async') found.push(name)
  }

  return found
}

/**
 * Names `$` is passed to that the loader will not follow.
 * The nested `remind` from the 2.1.318 failure is the case this exists for.
 */
export const dollarPassProblems = (source: string): string[] => {
  const allowed = topLevelHelpers(source)
  const problems = new Set<string>()
  for (const name of dollarCallees(source)) {
    if (!allowed.has(name)) problems.add(name)
  }

  return [...problems]
}
