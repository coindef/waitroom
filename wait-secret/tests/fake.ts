/**
 * Obviously fake keys, built by concatenation so no file in this repository
 * holds a whole token a secret scanner would read as live. Each one says
 * FAKE or TEST in its body and ends in a fixed tail the tests look for.
 */
const body = 'FAKE0TEST1fake2test3'

export const OPENAI = 'sk' + '-' + 'proj' + body + '3f9a'
export const ANTHROPIC = 'sk' + '-ant-' + 'api03' + body + '7c1d'
export const AWS = 'AK' + 'IA' + 'FAKE0TEST000' + '9Q2Z'
export const GITHUB = 'gh' + 'p_' + body + body.slice(0, 12) + 'b4e1'
export const GITHUB_PAT = 'github' + '_pat_' + body + '_' + body + 'aa01'
export const SLACK = 'xo' + 'xb-' + '000-111-' + body + '9z9z'
export const PRIVATE_KEY = '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----'
export const GENERIC = 'Qm7' + 'Fake9Test' + 'Zt4' + 'x8Lw'
