# After-Photo API (sidecar)

Tiny Node sidecar that takes a selfie and returns an AI-generated AFTER photo (full hair) using OpenAI `gpt-image-1`.

Runs on `http://localhost:4322`. The python static server (`localhost:4321`) calls it via CORS.

## Setup (one-time)

1. Open `_design-handoff/api/.env`
2. Paste your OpenAI key after `OPENAI_API_KEY=` (no quotes, no spaces). Save.
3. That's it — no `npm install`, no other deps.

## Run

```bash
node _design-handoff/api/server.mjs
```

Leave it running while you use the prototype. `Ctrl-C` to stop.

## Endpoints

- `POST /api/generate-after` — body: `{ photoDataUrl: "data:image/png;base64,..." }` → `{ afterPhoto: "data:image/png;base64,..." }`
- `GET /api/health` — sanity check

## Tuning the prompt

Edit `AFTER_PROMPT` at the top of `server.mjs`. Restart the server.

## Cost / safety

- Each call burns ~1 image-gen credit (~$0.04 at quality:high, 1024×1024).
- The frontend caches results in `localStorage` keyed by photo hash so the same selfie isn't regenerated.
- The key never leaves your machine. The frontend never sees it.
- `.env` is `.gitignored`.
