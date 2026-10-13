# NuGet Resilient Publish

Publish NuGet packages and symbols with independent uploads, bounded retries, and useful partial results. Uses Node.js 24 with no runtime dependencies or .NET SDK requirement for publishing.

## Usage

Build and pack your project before these steps. Configure a NuGet.org trusted publishing policy for your repository and workflow, and grant the job `id-token: write`.

```yaml
permissions:
  contents: read
  id-token: write

steps:
  # Build/pack or download artifacts first.
  - name: Log in to NuGet
    id: nuget-login
    uses: soenneker/nuget-resilient-login@v3
    with:
      user: soenneker

  - name: Publish packages and symbols
    id: publish
    uses: soenneker/nuget-resilient-publish@v1
    with:
      api-key: ${{ steps.nuget-login.outputs.NUGET_API_KEY }}
      packages: artifacts/*.nupkg
```

The `@v1` example applies after this action's first release is published. For local evaluation, check out this action into your workspace and use its relative directory, such as `uses: ./nuget-resilient-publish`. Pin a released commit SHA when you need an immutable reference.

An existing API key can instead be supplied as `api-key: ${{ secrets.NUGET_API_KEY }}` or through the `NUGET_API_KEY` environment variable. This action does not acquire or refresh credentials. Log in immediately before publishing; choose a total time budget within the key's remaining lifetime.

## Upload behavior

The action discovers and validates all selected files and required feed endpoints before uploading. Every explicit pattern must match at least one file. Overlapping patterns are deduplicated by resolved path; different files with the same package filename are rejected. All `.nupkg` packages finish before `.snupkg` symbols start. Uploads are sequential by default; `concurrency` allows up to four artifact workers in each phase. Matching adjacent symbol files are discovered automatically; missing companions are optional unless `require-symbols` is enabled. A failed package's companion is skipped, while unrelated artifacts can still complete.

If a package succeeds but its symbols time out, only the symbols are retried. A network failure can happen after the server accepts an upload; retrying a package may then return `409`, which is accepted by default. This does not compare the existing package's bytes with your artifact. Successful uploads are never restarted within the same action run.

Retries apply to recognized temporary connection failures, timeouts, and HTTP 408, 429, 500, 502, 503, and 504. Certificate errors, inaccessible files, DNS name-not-found, oversized service indexes, and unknown transport failures are not retried. Symbol HTTP 404 is retried only when its matching parent was accepted or already existed in this run. Delays use exponential backoff starting at five seconds, capped at sixty seconds plus up to 50% jitter. Valid `Retry-After` seconds or HTTP dates take precedence. A requested delay longer than five minutes stops publishing so the action never retries earlier than the service permits. Exhausted throttling also stops remaining uploads.

HTTP 503 with Retry-After establishes a cooldown for its publishing endpoint, including on the final attempt. HTTP 429 establishes a shared cooldown: all workers wait before starting another attempt, and a later throttle response can extend that deadline. Requests already in flight may finish. Fatal authentication, TLS, or throttling errors stop new work and interrupt retry waits; existing uploads settle before final results are written. Concurrency can improve throughput across many packages, but does not speed up an individual upload or guarantee faster service-side processing.

After two consecutive exhausted transient failure sequences on one publishing endpoint, queued uploads pause for at least thirty seconds. One trial upload then runs with no retries. A transient trial failure skips the remaining artifacts for that endpoint; a definitive response allows queued work to resume. Already-admitted uploads may finish. Package and symbol endpoint recovery is independent. Individual invalid-package errors do not open this recovery gate. Earlier failed artifacts remain failed and the action reports partial failure even if the endpoint recovers.

Authentication failures stop the run immediately with a fresh-key hint. Invalid packages, oversized uploads, redirects, and other permanent HTTP errors are not retried. Only sanitized diagnostic error messages and selected response headers are logged; API keys, successful response bodies, and raw network errors are never logged. Diagnostic reads are limited to two seconds. HTTPS is required and redirects are refused.

The default upload timeout is **600 seconds per attempt**, independently for each package or symbol file. `symbol-timeout-seconds` can override the symbol limit and otherwise inherits `timeout-seconds`. The **3300-second total budget** includes discovery, requests, retries, and waits. Service-index requests are capped at thirty seconds each. Connection establishment is limited to ten seconds, upload inactivity to sixty seconds, and waiting for response headers after uploading to 120 seconds. Upload progress resets only the inactivity timer; it does not extend the full-attempt limit. These phase limits are independently configurable. Cancellation aborts active requests and retry waits. Your workflow's `timeout-minutes` should leave room for build time, this budget, and cleanup.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `api-key` | `NUGET_API_KEY` environment variable | API key, including a short-lived trusted-publishing key |
| `packages` | `artifacts/*.nupkg` | Newline-separated file paths or positive glob patterns; supports `**` |
| `source` | `https://api.nuget.org/v3/index.json` | HTTPS NuGet V3 service index |
| `include-symbols` | `true` | Include selected and adjacent `.snupkg` files |
| `require-symbols` | `false` | Require an adjacent symbol file for every selected package, before any uploads; requires `include-symbols: 'true'` |
| `required-packages` | Empty | Newline-separated exact `.nupkg` filenames, including versions, which must be in the selected files |
| `concurrency` | `1` | Artifact workers, from 1 to 4; all share throttling cooldowns |
| `skip-duplicate` | `true` | Accept package/symbol HTTP 409 responses |
| `max-retries` | `3` | Additional attempts per request, from 0 to 10 |
| `timeout-seconds` | `600` | Whole upload attempt limit, from 1 to 1800 seconds |
| `connect-timeout-seconds` | `10` | Connection establishment limit, from 1 to 120 seconds |
| `upload-idle-timeout-seconds` | `60` | Time without client upload progress, from 1 to 1800 seconds |
| `response-timeout-seconds` | `120` | Wait for response headers after upload finishes, from 1 to 1800 seconds |
| `symbol-timeout-seconds` | `timeout-seconds` | Independent symbol attempt limit, from 1 to 1800 seconds |
| `total-timeout-seconds` | `3300` | Whole action time budget, from 1 to 21600 seconds |

Boolean inputs accept `true` or `false`. Quote numeric and boolean values in workflow YAML. Relative paths resolve from `GITHUB_WORKSPACE`. Use forward slashes for portable patterns. Negated patterns, empty artifacts, and legacy `.symbols.nupkg` files are rejected.

For a multi-package release, supply the full expected package list. For example, a three-package release could use:

```yaml
- uses: soenneker/nuget-resilient-publish@v1
  with:
    api-key: ${{ steps.nuget-login.outputs.NUGET_API_KEY }}
    packages: artifacts/*.nupkg
    concurrency: '2'
    require-symbols: 'true'
    symbol-timeout-seconds: '900'
    required-packages: |
      Soenneker.Librarian.Abstractions.${{ env.BUILD_VERSION }}.nupkg
      Soenneker.Librarian.Core.${{ env.BUILD_VERSION }}.nupkg
      Soenneker.Librarian.Memory.${{ env.BUILD_VERSION }}.nupkg
```

Required entries validate selected **filenames**, not the ID/version embedded in the archive. They do not select extra files or prohibit additional selected packages. Do not include paths or globs. This is not dependency ordering or transactional publication; the feed still processes each upload independently.

To retry symbols alone after a partially successful run:

```yaml
- uses: soenneker/nuget-resilient-publish@v1
  with:
    api-key: ${{ steps.nuget-login.outputs.NUGET_API_KEY }}
    packages: artifacts/*.snupkg
```

Standalone symbols are submitted directly; a missing parent (`404`) fails without waiting because the action has not established that the package exists. NuGet permits symbol resubmission, so rerunning symbols can resubmit previously accepted symbols. There is no durable checkpoint across workflow runs.

## Results

A job-summary table shows each artifact, size, outcome, attempts, elapsed time, last response, and failure. Progress logs report finished/total artifacts, active workers, elapsed time, and remaining time budget every fifteen seconds and after each artifact finishes. Remaining time is a budget, not an estimate of completion. Every active upload also logs its phase, cumulative request-body bytes sent by the client (including multipart framing), elapsed time, and attempt timeout every fifteen seconds. Client byte progress is not server acceptance. Retry logs include waiting Xms.

The `results` JSON array includes `file`, `kind`, `status`, `attempts`, `sizeBytes`, `durationMs`, `attemptDetails`, and optional `httpStatus`, `reason`, and `error`. Each attempt records its elapsed time, HTTP status or safe failure reason, client bytes sent, attempt timeout, and retry delay when applicable. Nested and aggregate transport causes are classified without exposing raw errors. Timeout reasons identify the connection, upload, or response phase. Artifact duration includes its retries and waits, but excludes initial queue time; artifacts skipped before entering a worker have zero duration; workers waiting on endpoint recovery include that wait. Raw transport errors and response bodies remain private.

Count outputs are named `pushed`, `duplicate`, `processing`, `failed`, `skipped`, and `total`. `duration-seconds` reports elapsed batch time before final reporting. With concurrent uploads, individual artifact durations overlap and should not be added together.

| Status | Meaning |
| --- | --- |
| `pushed` | The server accepted the upload; asynchronous validation may still fail |
| `duplicate` | A package upload returned HTTP 409 |
| `processing` | A symbol upload returned HTTP 409: symbols are already processing |
| `failed` | This artifact could not be uploaded |
| `skipped` | Its parent failed or publishing stopped before attempting it |

Partial results are written on operational failure and cancellation when the runner allows cleanup. Invalid configuration before discovery can fail without outputs. Use `if: always()` on later steps that inspect outputs. A failed artifact fails the action; symbol failures are not silently ignored. HTTP acceptance and symbol processing do not guarantee that a package is available for restore or that symbols have passed validation.

Reporting is best-effort after a publishing failure: an output or summary write error never replaces the original publishing error, and remaining reports are still attempted. A summary write failure only logs a warning. If uploads succeed but an action output cannot be written, the action fails with a distinct reporting error without retrying uploads.

## Feed and runner support

Runs on Linux, Windows, and macOS with a runner supporting Node 24 JavaScript actions. GitHub supplies the runtime; consumers do not need `setup-node` for this action. Files are streamed with a known content length instead of loading packages into memory.

Custom sources must expose an anonymously readable V3 index and authenticate uploads with `X-NuGet-ApiKey`. Only configure a source you trust: its advertised `PackagePublish/2.0.0` and `SymbolPackagePublish/4.9.0` endpoints receive your key, potentially on a different host. Set `include-symbols: 'false'` for feeds without symbol publishing. Credential providers, private authenticated indexes, basic authentication, local folder feeds, and `nuget.config` are not supported. Keep existing GitHub Packages publishing separate if its feed requires those authentication features.

On self-hosted runners, Node's TLS trust can be extended using `NODE_EXTRA_CA_CERTS`. To use environment proxies on a compatible Node 24 runner, configure `NODE_USE_ENV_PROXY=1` together with `HTTPS_PROXY` and `NO_PROXY` before the action process starts. TLS certificate verification remains enabled.

Protocol references: [package publishing](https://learn.microsoft.com/en-us/nuget/api/package-publish-resource), [symbol publishing](https://learn.microsoft.com/en-us/nuget/api/symbol-package-publish-resource).
