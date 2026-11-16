# open-reel

One interface for many image and video generation models. Open source, runs on
your machine, and uses your own API keys.

- **Compare models side by side.** Send one prompt to several models and see
  each result with its time and cost.
- **Iterate like a conversation.** Any image can become the reference for your
  next prompt, or the first frame of a video.
- **Keep everything.** Every result is saved locally with the prompt and
  parameters that produced it, in a searchable gallery.

Supported today: [fal](https://fal.ai), [Replicate](https://replicate.com) and
[OpenRouter](https://openrouter.ai) for images and video, and OpenAI (GPT
Image) and Google Gemini (Nano Banana) for images. A desktop app and locally
run models are planned.

## Run it

You need [Bun](https://bun.sh) 1.4 or newer.

```sh
git clone <this repository> && cd open-reel
bun install
bun run build
bun run start
```

This opens `http://localhost:4096`. Add an API key under **Providers**, pick
one or more models, and write a prompt.

Options: `bun run start --port 5000 --no-open --data-dir ./data` (see
`bun run start --help`).

Keys can also come from the environment: `FAL_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `REPLICATE_API_TOKEN`, `OPENROUTER_API_KEY`.

## Your data

Sessions, images and keys live in `~/.local/share/open-reel` (or
`$XDG_DATA_HOME/open-reel`, or `$OPEN_REEL_DATA_DIR`). The directory is
readable only by you. Keys are sent only to the provider they belong to and are
never returned by the API.

The server listens on `127.0.0.1` only and refuses requests that do not come
from its own page, so other websites you visit cannot use your keys.

## Develop

```sh
OPEN_REEL_FAKE=1 bun run dev:server   # API on :4096, with a key-free fake provider
bun run dev:web                       # UI on :5173 with hot reload
bun test && bun run typecheck && bun run lint
```

| Package              | What it holds                                                |
| -------------------- | ------------------------------------------------------------ |
| `packages/core`      | Domain types, job engine, storage, and the provider contract |
| `packages/providers` | One adapter per provider                                     |
| `packages/server`    | HTTP API and the live event stream                           |
| `packages/cli`       | The `open-reel` command                                      |
| `apps/web`           | The React interface                                          |

After changing `packages/core/src/db/schema.ts`, run
`bunx drizzle-kit generate` inside `packages/core`.

## Add a provider

A provider is one file in `packages/providers/src` implementing
`ProviderAdapter` from `@open-reel/core`:

1. `listModels()` describes each model and what it supports (aspect ratios,
   seed, images per request, reference images). The interface builds itself
   from this.
2. `submit()` starts a request and returns a JSON-serializable handle.
3. `events()` follows that handle and yields `progress`, then `completed` or
   `failed`.

If the provider has a server-side queue, set `resumable = true` and the handle
is used to re-attach after a restart (`fal.ts` is the example). If it answers
in a single request, do the call inside `events()` and set `resumable = false`
(`openai.ts`).

Then register it in `packages/providers/src/index.ts` and add a test file that
calls `providerContract(new YourProvider())` and exercises the adapter against
a scripted `fetch`, as the existing tests do.

## License

MIT
