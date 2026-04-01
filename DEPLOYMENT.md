# Quido Prototype Deployment

## What this setup does

- Serves the customer portal at `/`
- Serves the Ops UI at `/ops`
- Serves the API at `/api`
- Persists account data to a mounted disk using `DB_DIR`

## Recommended host

Use Render for the first public deployment. This repo includes a `render.yaml`
that configures:

- a Node web service
- a persistent disk mounted at `/var/data`
- `DB_DIR=/var/data/accounts`
- health check at `/api/health`

## Expected public URLs

- Customer portal: `https://<your-service>.onrender.com/`
- Ops UI: `https://<your-service>.onrender.com/ops`
- Health check: `https://<your-service>.onrender.com/api/health`

## Publish steps

1. Push this repo to GitHub.
2. In Render, choose `New +` -> `Blueprint`.
3. Connect the GitHub repo.
4. Render will detect `render.yaml`.
5. Approve the service and disk creation.
6. Wait for the first deploy to complete.
7. Open `/` for the customer portal and `/ops` for the Ops UI.

## Editing after go-live

1. Make local changes.
2. Test locally.
3. Push to GitHub.
4. Render auto-deploys the latest commit.

## Local run

From `backend`:

```powershell
npm install
npm start
```

Then open:

- `http://localhost:3001/`
- `http://localhost:3001/ops`

## Notes

- The portals automatically use same-origin `/api` when served over HTTP.
- When opened directly from the filesystem, they fall back to `http://localhost:3001/api`.
- Persistent account data is stored in `backend/db/accounts` locally and `/var/data/accounts` on Render.
