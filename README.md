# LLM Speedtest

A lightweight desktop app for benchmarking **locally running LLMs** through any
OpenAI-compatible inference server (Ollama, vLLM, llama.cpp server, LM Studio,
SGLang…). It measures what your hardware actually delivers — prefill speed,
decode throughput, and per-token cost — straight from the API stream, with a UI
light enough to not steal VRAM from the model being tested.

Built with **Tauri 2 (Rust)** + **Vue 3 (Composition API)** + **ECharts**.

## Features

### Single-run benchmarking (Benchmark tab)

- **Real-time KPIs** from stream chunks and final usage payloads:
  - **TTFT** — time to first content token.
  - **TTFR** — time to first response chunk (any SSE data, includes network).
  - **TPS** — decode throughput; **Peak t/s** over a trailing 1-second window
    (robust stutter metric), plus mean/min.
  - **PP speed** — prompt-processing (prefill) speed, `prompt_tokens ÷ est_ppt`.
  - **TPOT** — mean time per output token.
  - **Token audit** — `prompt_tokens` / `completion_tokens` / `total_tokens`,
    with Ollama `prompt_eval_count` / `eval_count` fallbacks and
    `eval_duration`-based engine cross-checks.
- **Live speed chart** — instantaneous tokens/second per chunk, exposing
  stutter and spikes; zoomable for long runs. Streaming response feed.
- **Saved runs & comparison** (Compare tab) — persist runs locally, overlay
  TPS curves, compare KPI/hardware side-by-side, import/export JSON & CSV.

### Benchmark suites (Suite tab)

llama-bench-style test matrices over any OpenAI-compatible endpoint:

- **Matrix**: prompt-processing targets (pp), generation lengths (tg), context
  depths (padded natural text as system message), and concurrency levels —
  executed as depth → concurrency → ctx/pp/tg, matching llama-benchy's row
  order. Defaults mirror llama-benchy: `pp2048`, `tg32`, depth `0, 4096`,
  concurrency `1, 2`, 1 warmup + 3 measured runs, coherence check on, exact
  generation lengths and prefix-caching measurement enabled.
- **Statistics**: configurable discarded warmup runs, measured runs, and
  mean ± std aggregation per row.
- **Latency adjustment**: a baseline probe (1-token generation, `/models`
  round-trip, or off) is subtracted from TTFR to yield **est_ppt** — an
  estimate of pure server-side prompt processing. This matters most for
  *remote* endpoints where network round-trip would otherwise inflate TTFT.
- **Prefix caching** — two-step measurement: context-load rows (`ctx_pp`,
  `ctx_tg`) followed by cached-context runs at the same depth; pp rates on
  cached rows count only the newly processed tokens.
- **Cache busting** — every measured pp/tg request embeds a unique nonce, so a
  server-side prefix cache cannot serve repeated prompts and fake near-zero
  prefill times (only the `ctx_*` load rows intentionally hit the cache).
- **Exact-length runs** — `min_tokens` + `ignore_eos` for fixed output length
  (supported by vLLM, llama.cpp).
- **Coherence check** — asks the model "2 + 2" with deterministic decoding and
  a 64-token budget (thinking models included); flags FAILED instead of
  silently benchmarking a broken backend.
- **Charts** — throughput vs concurrency (saturation) and throughput vs
  context depth. Exports: JSON (full fidelity incl. time series), CSV,
  Markdown (llama-bench-style table).

Rows are labeled like llama-benchy: `pp2048 (c1)`, `tg32 @ d4096 (c2)`,
`ctx_pp @ d4096 (c1)`. Each row reports **t/s (total)** (aggregate across
concurrent requests) and **t/s (req)** (per-request speed — prompt-processing
for pp rows, decode for tg rows), plus peak 1-second-window decode speed,
ttfr, est_ppt, e2e_ttft, and tpot — so blank
cells only ever mean "not applicable"; a hover tooltip on the test name shows
the raw stream diagnostics (chunks / content chunks / usage chunks) if a
server streams unusually.

Example Markdown export (values from a real run against llama.cpp server +
Qwen3 IQ3_XXS; peak t/s is blank for c2 rows because overlapping requests have
no single shared 1-second window):

| test                |           t/s (total) |        t/s (req) | peak t/s      | peak t/s (req) |        ttfr (ms) |      est_ppt (ms) |     e2e_ttft (ms) |
|:--------------------|----------------------:|-----------------:|--------------:|---------------:|-----------------:|------------------:|------------------:|
| pp2048 (c1)         |       239.55 ± 9.13   |   239.55 ± 9.13  |               |                |  7880.0 ± 154.0  |   7786.69 ± 154.0 |   7880.0 ± 154.0  |
| tg32 (c1)           |        45.48 ± 1.05   |    45.48 ± 1.05  | 46.95 ± 1.09  |  46.95 ± 1.09  |                  |                   |                   |
| pp2048 (c2)         |       248.47 ± 14.18  |   125.80 ± 7.25  |               |                | 15291.78 ± 750.6 |  15198.47 ± 750.6 | 15291.78 ± 750.6  |
| tg32 (c2)           |        56.25 ± 1.61   |    31.58 ± 2.71  |               |   32.44 ± 3.01 |                  |                   |                   |
| ctx_pp @ d4096 (c1) |       263.70 ± 11.47  |   263.70 ± 11.47 |               |                | 13780.65 ± 676.1 |  13687.34 ± 676.1 | 13780.65 ± 676.1  |

…followed by the `ctx_tg` / `pp2048 @ d4096` / `tg32 @ d4096` rows and the
remaining concurrency level, for 12 rows in total with the default matrix.

### Engine-agnostic integration

- Just point it at a base URL; the endpoint is normalized automatically
  (`http://host:port` → `…/v1/chat/completions`).
- **Thinking-model aware** — tokens streamed as `reasoning_content` (Qwen3-style
  thinking) or completion-style `text` count as decode work, not just
  `delta.content`. Multi-token/block-streamed chunks are handled without
  fabricating decode timings.

### Hardware identification

The OpenAI protocol carries no hardware info, so the app fills the gap:

1. **Detect** probes well-known engine paths on the same port (Ollama
   `/api/version` + `/api/ps`, vLLM `/version` + `/metrics`, llama.cpp
   `/props`, SGLang `/get_server_info`, LM Studio `/api/v0/models`) and
   reports engine type, version, model lists, GGUF quantization hints, and —
   for Ollama — per-model VRAM usage.
2. **Same-host auto-detect** — when the endpoint is `localhost`, local
   hardware is read via Rust and auto-fills the Hardware field. Reported:
   CPU model + cores, RAM, disks with **SSD/HDD classification** and free
   space, GPUs, and OS. Sources: `sysinfo` for CPU/RAM/disks (with a
   `/proc/mounts` + `statvfs` fallback on Linux), WMI `Win32_VideoController`
   for GPUs on Windows, and `lspci` → sysfs PCI scan → NVIDIA `/proc` on
   Linux (no `pciutils` required). Example auto-filled label:

   `AMD Ryzen 5 3600 6-Core Processor · 6C/12T · 126 GB RAM · GeForce RTX 3090 · 953.9 GB SSD (412 GB free) · Linux (Ubuntu 24.04)`

   The frontend tolerates legacy/partial payloads, so older binaries degrade
   gracefully instead of erroring.
3. **Manual hardware label** — for remote machines, type it once per endpoint;
   it is stored with every saved run and shown in the comparison table.

> **Remote endpoints:** no LLM API exposes the serving machine's hardware, and
> a remote box can't be queried without software running there. Over the
> network, Detect reports engine/model/VRAM info only; label the hardware
> manually or run a metrics exporter on that machine.

### Screenshots

<img width="811" height="554" alt="image" src="https://github.com/user-attachments/assets/45dd61c7-8914-4b3b-a9c1-6838e91eacc6" />

<img width="811" height="554" alt="image" src="https://github.com/user-attachments/assets/9bdff60e-5478-41c6-b973-694eee538635" />

<img width="811" height="554" alt="image" src="https://github.com/user-attachments/assets/61f9f8db-a52d-4cb8-9b57-3da7c6b53552" />


## Installation

There are no prebuilt downloads — build once on the target machine (see
[Development](#development) for the one-time toolchain setup), then install:

### Windows

```powershell
npm run tauri build -- --no-bundle   # standalone exe, UI embedded
.\src-tauri\target\release\llm-speedtest.exe
```

Run the exe directly (no dev server needed), or build full installers
(MSI/NSIS) with `npm run tauri build` — they land in
`src-tauri\target\release\bundle\`.

### Linux

A full `npm run tauri build` produces packages under
`src-tauri/target/release/bundle/`:

| Artifact | Distros | Install / run |
|---|---|---|
| `…_amd64.deb` | Debian / Ubuntu / Mint | `sudo apt install "./LLM Speedtest_0.1.0_amd64.deb"` |
| `…x86_64.rpm` | Fedora / RHEL / openSUSE | `sudo dnf install ./LLM\ Speedtest-0.1.0-1.x86_64.rpm` |
| `…_amd64.AppImage` | Any distro, no install | `chmod +x` the file and run it (needs `libfuse2` on some distros) |

Launch **LLM Speedtest** from the applications menu, or run `llm-speedtest`
from a terminal. Uninstall with `sudo apt remove llm-speedtest` (deb) or your
package manager's equivalent.

## How metrics are computed

| Metric | Source | Fallback |
|---|---|---|
| TTFR | wall clock, start → first stream chunk | — |
| TTFT | wall clock, start → first content token | — |
| est_ppt | `TTFR − baseline latency` (min 0) | `prompt_eval_duration` shown separately |
| PP t/s | `prompt_tokens ÷ est_ppt` | `eval_count ÷ (prompt_eval_duration / 1e9)` |
| TPS (decode) | `completion_tokens ÷ decode wall time` | `eval_count ÷ (eval_duration / 1e9)` |
| TPOT | `decode wall time ÷ completion_tokens` | `eval_duration ÷ eval_count` |
| Peak t/s | max tokens/sec over any trailing 1 s window | per-chunk peak |
| Suite t/s (total) | aggregate tokens ÷ wall time across concurrent requests | equals t/s (req) at concurrency 1 |
| Suite t/s (req) | mean per-request rate — `prompt_tokens ÷ est_ppt` (pp rows), decode rate (tg rows) | — |
| Token counts | standard `usage` in final chunk | Ollama `prompt_eval_count` / `eval_count` |

The live chart estimates per-chunk tokens from payload length (chars ÷ 4);
headline metrics always prefer server-reported counts. Suite prompt sizes are
**calibrated against the server's own token counts** (probe → rescale loop),
so sweeps hit their target token counts without shipping a tokenizer.

## Development

Prerequisites: Node 18+ and Rust. The native webview runtime is per-platform:
WebView2 (Windows — see below), WebKitGTK 4.1 (Linux — see below), WKWebView
(macOS — preinstalled; `xcode-select --install` for the build tools).

### Windows build notes

The desktop app builds natively with the MSVC toolchain. One-time setup:

1. **Visual Studio C++ Build Tools** — install from
   [visualstudio.microsoft.com/visual-cpp-build-tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
   and select the **"Desktop development with C++"** workload (provides
   `cl.exe`, the Windows SDK, and the linker). Visual Studio Community/Pro
   with that workload also works.
2. **Rust (MSVC target)** — install from [rustup.rs](https://rustup.rs); on
   Windows choose the default `stable-x86_64-pc-windows-msvc` toolchain.
3. **WebView2 Runtime** — preinstalled on Windows 10 (1803+) and Windows 11.
   If missing, install the [Evergreen
   Runtime](https://developer.microsoft.com/microsoft-edge/webview2/).

Verify the toolchain, then build:

```powershell
rustc --version    # should report the -msvc host triple
npm install
npm run tauri dev  # dev app with hot reload
```

Notes:

- `npm run tauri build` produces the standalone release exe
  (`src-tauri/target/release/llm-speedtest.exe`); add installers (MSI/NSIS) by
  running it without `--no-bundle` — Tauri downloads WiX/NSIS automatically
  on first use.
- The frontend-only commands (`npm run dev`, `npm run build`, `npm test`)
  work on any OS and do not require the C++ toolchain.

### Linux build notes

Building the desktop app on Linux requires the GTK/WebKit development
libraries. Without them the build fails in `pango-sys` / `gdk-sys` /
`gdk-pixbuf-sys` / `atk-sys`.

Debian / Ubuntu:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev build-essential pkg-config \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev file
```

Fedora:

```bash
sudo dnf install webkit2gtk4.1-devel gtk3-devel libxdo-devel openssl-devel \
  libayatana-appindicator3-devel librsvg2-devel
```

Arch:

```bash
sudo pacman -S webkit2gtk-4.1 gtk3 libxdo
```

Verify what the `-sys` crates look for, then build:

```bash
pkg-config --modversion gtk+-3.0        # prints e.g. 3.24.x
pkg-config --modversion webkit2gtk-4.1  # prints e.g. 2.4x.x
npm run tauri build                     # first build takes several minutes
```

Notes:

- Tauri 2 requires **webkit2gtk-4.1** — the older `libwebkit2gtk-4.0-dev`
  does not satisfy it.
- **Never reuse `node_modules` across operating systems.** A `node_modules`
  folder copied from Windows loses Unix exec permissions (`vite: Permission
  denied`) and contains Windows-native binaries. On each OS run a fresh
  `rm -rf node_modules && npm install`.
- Installers produced by the full build are covered in
  [Installation](#installation).

```bash
npm install

# unit tests (metrics engine, runner, prompts, probes, export, SSE parsing)
npm test

# typecheck + production build
npm run typecheck
npm run build

# frontend in a plain browser (streaming falls back to fetch; Tauri-only
# features such as hardware auto-detect are disabled)
npm run dev

# mock OpenAI-compatible SSE server for local testing (port 15201)
npm run mock:server

# full desktop app
npm run tauri dev
npm run tauri build
```

> **Which binary to run:** `tauri dev` produces a *dev* build
> (`src-tauri/target/debug/`) that loads the UI from the Vite dev server
> (port 1420) — run it via `npm run tauri dev`, never standalone. The
> standalone app is the *release* build, `src-tauri/target/release/`
> (`llm-speedtest.exe` on Windows, `llm-speedtest` on Linux/macOS; ~11 MB,
> UI embedded): build it with `npm run tauri build -- --no-bundle`, then run
> it directly — no dev server required.

Mock server environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `15201` | Listen port |
| `MOCK_ENGINE` | `ollama` | Probe surface: `ollama` (`/api/version`, `/api/ps`) or `llamacpp` (`/props`) |
| `MOCK_TOKENS` | `60` | Output length (also caps `min_tokens`) |
| `MOCK_PP_MS` | `0.15` | Simulated prefill ms per prompt token |
| `MOCK_MODEL` | `mock-7b-instruct` | Reported model name |

The mock emulates prompt-proportional prefill, sinusoidal decode stutter,
`max_tokens`/`min_tokens`, prefix-cache hits, and answers coherence questions.

Point the app at your server:

| Server | Endpoint |
|---|---|
| Ollama | `http://localhost:11434` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234` |
| llama.cpp server | `http://localhost:8080` |

## Architecture

```
src/
  engine/
    metrics.ts    MetricsAccumulator — TTFR/TTFT/TPOT/TPS/token accounting,
                  peak-window stats, stream diagnostics (pure, unit-tested)
    runner.ts     Suite orchestration: matrix execution per depth ×
                  concurrency, warmups, cache-busted prompts, prefix-cache
                  ctx rows, calibration, mean ± std aggregation
    prompts.ts    Natural-text padding + server-calibrated prompt lengths
    latency.ts    Baseline latency probes (generation / api / none)
    probe.ts      Engine detection + system-info bridge (Detect button)
    export.ts     JSON / CSV / Markdown serialization, download & import
    streaming.ts  streamCompletion — Tauri invoke (reqwest, CORS-free) or
                  browser fetch + SSE parse
    parse.ts      chunk / SSE-line parsing
    url.ts        endpoint normalization
  stores/
    benchmark.ts  single-run orchestration, live state, localStorage runs
    suite.ts      suite config, progress, results
  components/
    ConfigPanel.vue     endpoint/model/prompt/hardware configuration + Detect
    LiveRun.vue         KPI cards, live chart, response stream feed
    SuitePanel.vue      suite matrix configuration + progress
    SuiteResults.vue    llama-bench-style table + depth/concurrency charts
    ComparisonView.vue  saved-run table + overlaid TPS curves + import/export
    SpeedChart.vue      ECharts live-throughput wrapper (tree-shaken)
    LineChart.vue       ECharts XY wrapper for suite curves
    KpiCard.vue         single metric card used on the Benchmark tab
src-tauri/
  src/lib.rs      Tauri commands: stream_completion (reqwest SSE bridge via
                  Channel), probe_endpoint (concurrent engine probes),
                  get_system_info (sysinfo; WMI GPUs on Windows; on Linux
                  lspci → sysfs PCI scan → NVIDIA /proc, disks via sysinfo
                  with a /proc/mounts + statvfs fallback)
scripts/
  mock-server.mjs      mock OpenAI-compatible SSE server
  generate-icons.mjs   icon generator (PNG + multi-size ICO, no deps)
tests/                  Vitest unit tests for all engine modules
```

All HTTP runs through Rust (`reqwest`) inside the desktop app, so local and
LAN servers without CORS headers work out of the box; the browser dev fallback
uses direct `fetch` for quick iteration. Suite orchestration is executor-
injected, so the whole matrix logic is unit-tested without a server.

## License

First-party code in this repository is licensed under the **Apache License,
Version 2.0** — see [`LICENSE`](LICENSE).