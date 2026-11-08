/**
 * wait-anchor's state contract.
 *
 * There is no $.state key. A note has to survive Stop and a process restart,
 * and $.state does not. The note is one value in $.store, keyed by the project
 * root and the host session id. Two sessions do not share that key. When
 * either half is missing, nothing is written.
 */
declare module 'claude-code' {
  interface PluginState {
    'wait-anchor': Record<string, never>
  }
}
