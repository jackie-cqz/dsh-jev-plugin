# dsh-jev-plugin

**English** | [简体中文](./README_zh.md)

A plugin that lets [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) agents use TypeSafe Jev (System One) for **typed decisions**.

Jev returns structured judgments rather than conversational text. This plugin exposes its three primitives as tools:

| Primitive | Purpose | Result |
|---|---|---|
| `noul` | Yes/no judgment | Probability from 0 to 1 |
| `choice` | Select a label | Selected label, probability distribution, confidence |
| `score` | Rate on an ordered scale | Score, probability distribution, confidence |

## Status

- Version: `0.1.0` (preparing for release).
- Target DSH: `0.1.7-rc.2`; `0.1.6-alpha.2` remains covered by installation smoke tests. Declared range: `>=0.1.6-alpha.2 <0.2.0`; other versions have not been individually verified.
- License: MIT.
- Standalone package installed through `dsh.bundle`; no changes to the DSH repository are required.

## Compatibility

| Component | Version or range |
|---|---|
| Target DeepSeek Harness | `0.1.7-rc.2` (also tested: `0.1.6-alpha.2`) |
| `@deepseek-ai/cordis` (peer dependency) | `^4.0.2` |
| `@deepseek-ai/dsh-tools` (peer dependency) | `^0.1.6-alpha.2` or `^0.1.7-rc.2` |
| Node (plugin) | `>=22` |
| Node (DSH 0.1.7 host) | `^22.19.0` or `>=24.0.0` |

Build and test dependencies are locked in `package-lock.json`. CI is configured for Node 22 and 24; local release checks have passed on Node 24.

Compatibility evidence for `0.1.7-rc.2`: typechecking and 782 plugin tests pass; tarball installation checks pass on both supported versions. A local upstream checkout also starts the Web profile and serves the Jev client bundle. Real TypeSafe calls and browser-rendered result cards were not revalidated in this compatibility pass.

### Development dependencies

`@deepseek-ai/dsh-tools@0.1.7-rc.2` declares these peers in addition to Cordis: `dsh-agent`, `dsh-invariants`, `dsh-llm`, `dsh-ptc-runtime`, `dsh-sandbox`, `dsh-sandbox-policy`, `dsh-scope`, `dsh-session`, `dsh-system-prompt`, and `dsh-user-approval` (all under `@deepseek-ai/`). Because `--legacy-peer-deps` does not install peers automatically, they are explicit development dependencies here. The target profile supplies them at runtime.

### TLS troubleshooting

If Node times out during the TLS handshake while `curl` connects successfully, try `--tls-max-v1.2` as a diagnostic. If required by your environment, apply the same option to the Node process running DSH. See Development below.

## Installation

For a local checkout, first run `npm ci --legacy-peer-deps` in the plugin directory, then replace the example path below with its actual location:

```sh
dsh --profile jev-dev --from-default-profile web --dump-config
dsh plugin --profile jev-dev add /path/to/dsh-jev-plugin
dsh --profile jev-dev --dump-config   # Look for tool-jev
dsh --profile jev-dev
```

The first command initializes a new Web profile; run it only once for an unused profile name. Adding a plugin to a new name without selecting the Web template creates a base-only profile. If your profile already exists, omit initialization.

From GitHub (replace `<commit-sha>` with the desired revision; initialize the Web profile as above first):

```sh
dsh plugin --profile jev-dev add github:jackie-cqz/dsh-jev-plugin#<commit-sha>
```

Git installs use the package's `prepare` script (`npm run build`) to build the artifacts. If pnpm blocks the build script, follow its message to add the package to `allowBuilds` in the profile's `pnpm-workspace.yaml`, then retry.

## Configuration

| Field | Default | Description |
|---|---|---|
| `apiKey` | — | TypeSafe API key; takes precedence over `apiKeyEnv` |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | Environment variable used when `apiKey` is unset |
| `baseURL` | `https://api.typesafe.ai/v1` | API root; trailing slashes are removed |
| `model` | `jev-latest` | Default model; tools can override it per call |
| `timeoutMs` | `10000` | Call timeout in milliseconds |
| `retry.maxAttempts` | `3` | Maximum attempts, including the first |
| `retry.baseDelayMs` | `500` | Initial backoff in milliseconds |
| `retry.maxDelayMs` | `5000` | Maximum delay between attempts |
| `maxStateChars` | `64000` | Maximum serialized state length; `0` disables the limit |
| `confidence.approveAt` | `0.8` | Confidence threshold for automatic acceptance via `verdictFor` |
| `confidence.escalateBelow` | `0.5` | Escalate below this confidence; must not exceed `approveAt` |
| `policy.enabled` | `false` | Enable the circuit breaker and minimum call interval |
| `policy.failureThreshold` | `5` | Consecutive failures before opening the circuit |
| `policy.openMs` | `30000` | Time before allowing a probe call |
| `policy.minIntervalMs` | `200` | Minimum interval between calls |
| `cache.enabled` | `false` | Cache responses for identical model, state, and questions |
| `cache.maxEntries` | `100` | Maximum cache entries; LRU eviction |
| `cache.ttlMs` | `60000` | Cache entry lifetime |
| `guard.enabled` | `false` | Enable the `tools/pre-execute` risk gate |
| `guard.tools` | `[]` | Tools to check; empty means all tools |
| `guard.question` | Built-in risk question | Question submitted to Jev |
| `guard.levels` | `["low","medium","high","critical"]` | Ordered risk labels; 2–10 entries |
| `guard.denyAt` | `3` | Deny at or above this score |
| `guard.askAt` | `1` | Request approval at or above this score |
| `guard.escalateOnLowConfidence` | `true` | Request approval below `confidence.escalateBelow` |
| `guard.reviseAt` | Highest level index | Reject with revision guidance; equal to `denyAt` by default, leaving no revision band |
| `guard.onError` | `"allow"` | Gate failure behavior: fail-open (`allow`) or fail-closed (`deny`) |
| `rules.enabled` | `false` | Enable synchronous offline denial rules; no API key needed |
| `rules.tools` | `[]` | Tools to check; empty means all tools |
| `rules.deny` | `[]` | Additional case-insensitive denial regexes; invalid patterns fail at load time |
| `review.enabled` | `false` | Enable `tools/post-execute` review; may rewrite completed tool results |
| `review.blockAt` / `review.onError` | `0.8` / `"accept"` | Correction probability threshold and error behavior |
| `routing.enabled` | `false` | Route models on `agent/request` using request complexity and `routing.models` |
| `context.enabled` | `false` | Enable context pruning on `agent/pre-step` |
| `context.maxDrops` / `context.shadow` | `0` / `false` | Drop limit (`0` means unlimited); shadow mode reports without changing context |
| `intent.enabled` | `false` | Decision logic exists, but instruction injection is not connected; enabling this does not inject messages |
| `quotaCooldownMs` | `900000` | Cooldown after `402`, independent of `policy.enabled`; `0` disables it |
| `enableDecide` / `enableEvaluate` | `true` | Register the corresponding tool |
| `telemetry.log` | `false` | Emit a sanitized structured record for each call |
| `telemetry.sampleRate` | `1` | Sampling fraction from 0 to 1 |
| `telemetry.errorRateAlert` | `0.5` | Error rate threshold for degraded health |
| `telemetry.alertMinCalls` | `10` | Minimum sample size before reporting health |

Validate gate thresholds for your workload: scores and confidence can vary. Changing `guard.levels` clamps default thresholds into range; explicitly configured out-of-range values fail validation. Start context pruning in shadow mode before allowing it to remove messages.

Oversized state is **rejected, never truncated**, so a decision cannot silently use incomplete input. Policy, caching, and the risk gate are disabled by default. Intent injection remains unavailable because the host lacks a pre-step message channel that records plugin authorship.

Prefer an environment variable over storing the key in `cordis.patch.yml`:

```sh
export TYPESAFE_API_KEY="..."
```

PowerShell:

```powershell
$env:TYPESAFE_API_KEY = "..."
```

If storing a key in configuration, use the secret role and restrict file permissions. The plugin redacts API keys from tool output, error messages, and logs.

## Tools

### `jev_decide`

Make a single decision from state, a question, a primitive, and optional labels.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `state` | JSON | Yes | String, plain object, or array to evaluate |
| `question` | string | Yes | Question for Jev |
| `kind` | `noul` / `choice` / `score` | Yes | Decision primitive |
| `options` | string[] | No | Choice labels (2–255 after deduplication) or ordered score labels (2–10) |
| `model` | string | No | Override the default model |

`state` rejects `null`, numbers, and booleans. Example response:

```json
{
  "model": "jev-1.13.0",
  "answer": {
    "type": "choice",
    "choice": "billing",
    "probabilities": { "billing": 0.91, "technical": 0.08, "sales": 0.01 },
    "confidence": 0.87
  },
  "usage": { "input_tokens": 320, "output_tokens": 34 }
}
```

### `jev_evaluate`

Pass Jev's native questions map to answer multiple questions in one call, including structured instructions and custom criteria.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `state` | JSON | Yes | Same accepted types as `jev_decide` |
| `questions` | JSON object | Yes | Non-empty native Jev questions map |
| `model` | string | No | Override the default model |

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": { "billing": "Payment issues", "technical": "Bugs", "sales": "Pricing" }
    },
    "is_urgent": { "type": "noul", "instructions": "Does this convey urgency?" }
  }
}
```

Returns `{ "model", "answers", "usage" }`, preserving the original answer structures. The plugin checks that `questions` is a non-empty object; TypeSafe validates its deeper structure.

Use `jev_decide` for one question, and `jev_evaluate` for multiple questions or custom instructions and criteria.

## Output contract

Both tools require `model`, `answer` (or `answers`), and `usage` in the response envelope. Missing fields produce a protocol error.

The model receives a readable summary followed by the complete canonical JSON:

```text
score: 2.99/3 = urgent (confidence=0.99)

{ "model": "jev-1.13.0", "answer": { ... }, "usage": { ... } }
```

Summaries map indices through `legend` and display probabilities as percentages. If an answer cannot be summarized, rendering falls back to canonical JSON without losing data.

## Web result cards

The package includes `lib/client.js`, loaded by the DSH module loader. It registers result cards for both tools, showing decision labels, probabilities, or scores while retaining complete JSON output. Settings pages and input-toolbar toggles are not included.

## Errors

Missing keys, invalid arguments, timeouts, cancellation, HTTP errors, and malformed responses have corresponding errors. `402` triggers quota cooldown; check credentials and permissions for `401` / `403`, and request arguments for `422`. Use `/jev-status` to inspect configuration, health, and cooldown state without revealing the key.

## Retries

- Up to three attempts by default, including the first, with exponential backoff and jitter capped by `retry.maxDelayMs`.
- `Retry-After` takes precedence when present, subject to the same delay cap.
- Retries cover `429`, `529`, `500`, `502`, `503`, `504`, and transient network failures.
- `401`, `403`, `422`, validation failures, and user cancellation are not retried.
- Timeout and caller cancellation constrain execution. Jev evaluations are read-only; retries do not repeat a write operation.

## Optional risk gate

Disabled by default. When enabled, the gate runs on `tools/pre-execute`, asks Jev to assess the tool call, and allows it, requests approval, or denies it.

```yaml
- id: tool-jev
  config:
    guard:
      enabled: true
      tools: ['run_shell', 'write_file']   # Empty means all tools
      denyAt: 3
      askAt: 1
```

The evaluated state contains the tool name and its arguments. A routine listing may be allowed; an explicit instruction to destroy production data may be denied. These are model judgments, not deterministic guarantees.

- No gate calls are made unless it is enabled.
- The default is fail-open (`guard.onError: "allow"`): gate errors let the original call proceed. Use `"deny"` for fail-closed behavior.
- Denial reasons omit argument contents. They report the tool, risk label, score, confidence, and machine-readable error codes; HTTP failures include a status code without the response body.

Scores and confidence may vary for identical input, and routine operations can trigger approval. Validate thresholds in the intended workflow.

**Privacy:** enabling the gate sends tool names and arguments to TypeSafe and records them in DSH session logs. Use `guard.tools` to limit its scope.

## Optional offline denial rules

Independent of the semantic gate, these synchronous text rules use `ctx.tools.guard()`. They need no network or API key, and their denial cannot be overridden by approval tokens.

```yaml
- id: tool-jev
  config:
    rules:
      enabled: true
      tools: ['bash', 'run_shell']
      deny: ['\bterraform\s+destroy\b']   # Add to the built-in rules
```

Rules register before the semantic gate, avoiding a Jev request for calls already denied offline. Built-ins cover recursive root deletion, `dd of=/dev/`, `mkfs`, unprotected force push, `DROP`/`TRUNCATE`, `chmod -R 777 /`, fork bombs, shutdown, and reboot. Examples:

```text
DENY   rm -rf /                    allow  rm -rf ./build
DENY   git push --force            allow  git push --force-with-lease
DENY   shutdown -h now             allow  echo reboot
DENY   dd if=/dev/zero of=/dev/sda
DENY   DROP TABLE users
```

This is an accident-prevention layer, not a security boundary. It matches known text patterns without interpreting shell semantics or preventing deliberate evasion through variables, encoding, or indirect scripts. Denial reasons do not echo arguments.

## Observability

`ctx.jev.stats()` reports calls, failures, retries, tokens, latency, models, admission-policy counters, and cache counters. `ctx.jev.health()` returns `healthy`, `degraded`, or `unknown`; fewer than `telemetry.alertMinCalls` samples yield `unknown`.

The **`/jev-status`** command shows enabled features, thresholds, model and endpoint, key source, call and retry counts, and health. Its Notes section explains inactivity, such as disabled gates, no checked calls, sampling, telemetry sink errors, or a missing key.

With `telemetry.log` enabled, every sampled call (including cache hits) emits a `channel: 'ops'` record containing only outcome, model, duration, tokens, retries, cache flags, and error codes. State, tool arguments, results, and keys are excluded from the telemetry interface. Records use the host's `ctx.sessionTelemetry` backend; this plugin does not depend on OpenTelemetry. Without a backend, it keeps counters without exporting records.

## The `jev-decisions` skill

The bundled skill explains when to use the tools, how to choose between them, and how to interpret results. From the plugin checkout, install it into a host that discovers skills under `~/.agents/skills/`:

```sh
cp -r skills/jev-decisions ~/.agents/skills/
```

The skill covers uncalibrated probabilities, zero-based score indices and `legend`, low confidence, unsuitable tasks, respecting gate decisions, and the fact that state leaves the machine. This location makes the skill available across projects in compatible hosts.

## Limitations and safety

- State is sent to TypeSafe and may appear in DSH session logs. Avoid unnecessary confidential data.
- Jev is not a calculator or fact database. Known weak areas include exact counting, arithmetic, dates, indirect reasoning, double negatives, and long contexts missing relevant state. Non-English accuracy may be lower than English accuracy.
- Do not rely on Jev alone to judge adversarial input.
- Oversized state is rejected instead of truncated.
- Optional hooks and Web cards are implemented; hooks are disabled by default. DSH credentials/Settings integration and intent instruction injection are not available.

## Development

### Release checks

```sh
npm ci --legacy-peer-deps
npm run check:release
```

This runs typechecking, tests, server and client builds, strict packaging checks, and a tarball installation smoke test. The `prepublishOnly` lifecycle runs the same gate before publication.

- `npm run check:pack` requires a build and checks the nine packaged files, entry points, bundle patch, non-empty artifacts, both READMEs and their language links, and common private-key/token patterns. Pattern scanning cannot detect every secret format.
- `npm run check:install` builds a real tarball from existing artifacts and installs it into `.release-smoke-*` with lifecycle scripts disabled. Using the target DSH `0.1.7-rc.2` runtime and a mock API, it checks calls, disposal, the client factory, and slot registration. Fixtures remain available for inspection and are excluded from Git and publication.
- Installation checks need registry access but no TypeSafe key. They do not replace DSH CLI profile or browser acceptance tests.
- CI is configured for Ubuntu/Windows and Node 22/24. For manual acceptance, install into a separate DSH profile, start the Web UI, call all three `jev_decide` primitives and multi-question `jev_evaluate`, and inspect result cards.

The CI installation gate also runs with `DSH_TEST_VERSION=0.1.6-alpha.2` to check the previous runtime. In PowerShell, set `$env:DSH_TEST_VERSION` before `npm run check:install`. Build tooling supports npm 10/11 array reports and npm 12 keyed pack reports.

### Local validation

```sh
npm install --legacy-peer-deps
npm run typecheck
npm test
npm run build   # dist/index.js, dist/index.d.ts, and lib/client.js
```

Real API smoke tests require `TYPESAFE_API_KEY`:

```sh
TYPESAFE_API_KEY=... npm run smoke
TYPESAFE_API_KEY=... npm run cases
TYPESAFE_API_KEY=... npm run cases -- score
```

In PowerShell, set `$env:TYPESAFE_API_KEY` first, then run the npm commands without the inline assignment.

The smoke script exercises the built plugin through the real DSH tool registry: three primitives, multi-question evaluation, object/array state, and missing or invalid keys. The cases script provides 17 scenario cases plus four known-weakness probes for counting, arithmetic, date comparison, and double negatives. It checks response structure and golden expectations where applicable; weakness probes are recorded without failing the run.

If Node handshakes time out while `curl` succeeds, try a temporary TLS 1.2 cap:

```sh
TYPESAFE_API_KEY=... node --tls-max-v1.2 scripts/smoke.mjs
TYPESAFE_API_KEY=... node --tls-max-v1.2 scripts/jev-cases.mjs
```

The plugin normally uses platform TLS defaults. Apply this option to the DSH Node process only if troubleshooting confirms it is needed in your environment.

## References

- [TypeSafe introduction](https://docs.typesafe.ai/introduction)
- [TypeSafe API](https://docs.typesafe.ai/api)
- [Jev model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
