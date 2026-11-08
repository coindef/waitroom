/**
 * SIMULATED HOST FIXTURE loader. Node needs a file extension on a TypeScript
 * import. The plugin sources keep the extensionless imports the other mods use.
 */

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (specifier.startsWith('.') && !specifier.endsWith('.ts') && !specifier.endsWith('.mjs')) {
      return nextResolve(`${specifier}.ts`, context)
    }
    throw error
  }
}
