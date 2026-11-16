/**
 * wait-focus's state contract.
 *
 * There is no $.state key. The paths you name have to survive a restart, and
 * $.state does not. They are one value in $.store, keyed by the project root.
 * A missing project root writes nothing. The session id is not part of the
 * key: two sessions in one project share the list.
 */
declare module 'claude-code' {
  interface PluginState {
    'wait-focus': Record<string, never>
  }
}
