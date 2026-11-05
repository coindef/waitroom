# wait-secret

Part of [waitroom](../README.md#plugins).

A Claude Code plugin that flags lines a turn wrote that look like a key or a
token. **wait-secret shows what in
it looks like a secret.** Local only. It only warns.

```
/plugin marketplace add coindef/waitroom
```
```
/plugin install wait-secret@waitroom
```

This install stays on its own. The four rooms are `/plugin install waitroom@waitroom`.

## What it shows

- **Once the turn ends.** The status line says `1 possible secret` (or
  `3 possible secrets`). It never says what kind, so someone looking over your
  shoulder learns nothing from it. Nothing at 0.
- **The list.** The row above the prompt lists each line, one per row:

  ```
  src/client.ts:12  sk-…3f9a  (OpenAI key?)
  .env.local:2  DB_PASS=…x8Lw  (env value?)
  ```

  Only the prefix and the last four characters are shown. The kind ends in `?`
  because it is a guess. Up to eight rows, then `N more…`. `Close` puts it
  away; `Don't show again` turns it off.

## What it looks for

Only lines this turn added, read from the local `git diff`
uses (tracked changes against HEAD, plus untracked files). A line that was
already uncommitted before the turn is not the turn's. Eight patterns, first
match on a line wins:

- `sk-ant-…` (Anthropic) and `sk-…` (OpenAI)
- `AKIA…` / `ASIA…` (AWS access key id)
- `ghp_…`, `gho_…`, `ghs_…`, `github_pat_…` (GitHub)
- `xoxb-…`, `xoxp-…` (Slack)
- `-----BEGIN … PRIVATE KEY-----`
- In a `.env` file (`.env`, `.env.local`, `prod.env`; not `.env.example`):
  `KEY=value` with a random-looking value
- Anywhere: `api_key = …`, `secret: …`, `token=…`, `password=…` with a
  random-looking value (16+ characters, letters and digits, high entropy, not a
  placeholder like `your-key-here` or `process.env.X`)

## Ignoring a false positive

Put `# wait-secret: ignore` or `// wait-secret: ignore` on the same line. That
line is never flagged. There is no button for it, on purpose.

## Limits

It sees what git sees. A file git ignores (a `.env` in `.gitignore`, say) is
not read, which is also a file that will not be committed. Outside a git
repository it stays silent. Patterns are a guess: a key in an unusual format
is missed, and a random-looking test fixture is flagged.

## What it never does

It never blocks a tool or a commit, never edits or deletes a file, makes no
network call, and sends no telemetry. It runs `git rev-parse`, `git diff` and
`git ls-files`, nothing else. The full value of a match is never shown, and
the state it keeps between the start and end of a turn holds digests of lines,
not the lines.

`/wait-secret` turns it off, and the next `/wait-secret` turns it back on —
the same switch as *Flag likely secrets a turn wrote* under `/plugin` →
wait-secret.

## Develop

```sh
claude plugin validate ./wait-secret
claude plugin test     ./wait-secret   # 21 tests
```

Every key in the tests is fake and built by concatenation
([tests/fake.ts](tests/fake.ts)), so no file here holds a whole token a secret
scanner would read as live.
