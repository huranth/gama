# Update service

Edge function behind `gama update` and the background version check.

- Production: `https://gama-update.vercel.app/api/latest-version`
- Vercel project: `gama-update`
- Vercel root directory: `update`
- Function: `api/latest-version.ts`

## Contract

`GET /api/latest-version` reads the `latest` dist-tag from the npm registry and returns:

```json
{
  "version": "1.0.0",
  "packageName": "@huranth/gama-harness",
  "url": "https://www.npmjs.com/package/@huranth/gama-harness"
}
```

- `503` when the registry is unreachable, times out (5 seconds), or returns an invalid version.
- `405` for methods other than `GET` and `HEAD`.
- Successful responses are cached for 60 seconds with a 5 minute stale window.
- The client only trusts the returned `version`; the package it installs is fixed at build time.

## Local development

```sh
# From the repository root
npm run update:api:dev
```

The Vercel project is already linked, so this serves `http://localhost:3000/api/latest-version`.

Point a local build at it when testing the CLI:

```sh
GAMA_UPDATE_URL=http://localhost:3000/api/latest-version gama update --check
```

## Deploy

```sh
cd update && npx vercel --prod
```

## Configuration

| Variable             | Where       | Purpose                                        |
| -------------------- | ----------- | ---------------------------------------------- |
| `GAMA_PACKAGE_NAME`  | server      | Read a different npm package (defaults to @huranth/gama-harness) |
| `GAMA_UPDATE_URL`    | CLI         | Override the update endpoint                   |
| `GAMA_OFFLINE`       | CLI         | Disable update checks                          |

## Tests

```sh
npm run test:update
```
