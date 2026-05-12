# Dockerfile for the HairCheck sidecar — works on Railway, Fly.io, Render,
# Cloud Run, anywhere. Single-file Node app, no dependencies beyond Node 18+
# (fetch, FormData, Blob built in).
#
# Build:   docker build -t haircheck-api .
# Run:     docker run -e OPENAI_API_KEY=sk-... -p 4322:4322 haircheck-api
#
# Railway: just push this folder, set OPENAI_API_KEY in the dashboard, done.
# Fly.io:  `fly launch` from this folder, set secret with `fly secrets set`.

FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./

# Container listens on PORT env var if set, otherwise 4322.
ENV PORT=4322
EXPOSE 4322

CMD ["node", "server.mjs"]
