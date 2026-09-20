# RP-Hub unified mirror publisher

This package contains the standalone Cloudflare Worker for the RP-Hub update
mirror. The Worker serves the public status page, the `/admin` publisher
console, the version manifest, and immutable snapshot files from a private R2
bucket. It does not contain or replace either site package.

## Required deployment order

1. Create a dedicated **private** R2 bucket named `rp-hub-update-mirror`.
   Leave Public Access disabled and do not attach an R2 bucket domain.
2. For a new installation, configure the secrets and deploy the Worker:

   ```powershell
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put WEBHOOK_URL
   npx wrangler secret put WEBHOOK_TOKEN
   npx wrangler deploy
   ```

   `GITHUB_TOKEN` is required. Any valid PAT works for downloading artifacts
   from a public repository — no special scope is needed (tested with
   fine-grained default PAT). Classic PAT with `public_repo`/`repo` is also
   sufficient.
   `ADMIN_TOKEN` is required for every write endpoint. `WEBHOOK_URL` and
   `WEBHOOK_TOKEN` are optional; omit the optional values when webhooks are not
   used.
3. In Worker Settings, open **Domains & Routes** and bind the Custom Domain
   `update.rph.mornye.uk` to this Worker.
4. For this artifact-sync update, do not redeploy the site packages or create a
   new Worker. Replace the existing publisher `worker.js`, then verify
   `https://update.rph.mornye.uk/` (public status HTML) and
   `https://update.rph.mornye.uk/manifest.json` (JSON manifest). `/admin` is the
   authenticated management console; write APIs require
   `Authorization: Bearer <ADMIN_TOKEN>` and return 403 when the token is not
   configured.
5. This artifact-sync round does not change either site tree or site package.
   Set `APP_UPDATE_MIRROR_BASE=off` only as the explicit
   legacy GitHub escape hatch.

The Worker streams manifest and snapshot bytes directly from the private R2
binding. Manifest responses use `public, max-age=60`; immutable snapshots use
`public, max-age=86400, immutable`. Internal `_mirror/*` objects are never
served over HTTP. The public page has no JavaScript or external assets and
shows versions plus human-readable pending reasons without configuration or
secret values.

## Runtime configuration

Only `releaseLimit` (integer clamped to 1-12) and `webhookEnabled` (boolean)
may be stored in R2 at `_mirror/config.json`. Invalid or malformed stored data
is ignored fail-soft. The upstream repository, precheck rules, file rules, and
all secrets are not runtime configuration.

The scheduled sync runs at `7,37 * * * *`. The free plan allowance is 100,000
requests per day; a complete sync is approximately one release-list request
plus one Actions-artifact list request. A new artifact uses one ZIP download;
an artifact that is expired or returns HTTP 401/403/410 falls back to the
existing commit/tree fetch path, records that fallback in the publish event,
and exposes the deduplicated `syncError` in `/admin`.
If artifact bytes fail digest or ZIP/TAR parsing, the round records a
`syncError` and does not silently fall back. If that allowance is eventually
insufficient, upgrade the Worker plan or move the hostname back to a
separately public bucket domain; clients continue to use the same manifest and
snapshot paths.

The free plan also caps each invocation at 50 external subrequests. A
tree-based snapshot build costs up to 33 external fetches, so each sync round
builds at most one tree-based snapshot (artifact ZIP intake is cheap and not
metered). On a fresh bucket the mirror therefore backfills one release per
round — roughly one release per half hour on the default cron, or trigger
`/api/sync` from `/admin` repeatedly until the status page shows every
version. Rounds that defer work report `snapshotBudget.deferred: true` in the
sync response.

No deployment is performed while creating this package.
