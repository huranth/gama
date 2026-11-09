# Update

Checks npm for the latest harness release.

## API

`GET /api/latest-version`

```json
{
  "version": "1.0.0",
  "packageName": "@huranth/gama-harness",
  "url": "https://www.npmjs.com/package/@huranth/gama-harness"
}
```

Returns `503` when npm is down and `405` for other methods. Caches for 60 seconds.

## Run

```sh
npm run update:api:dev
```

Local URL: `http://localhost:3000/api/latest-version`.

## Deploy

```sh
cd update && npx vercel --prod
```

## Env

| Name | Where | Use |
| --- | --- | --- |
| `GAMA_PACKAGE_NAME` | server | Package to check |
| `GAMA_UPDATE_URL` | CLI | Custom endpoint |
| `GAMA_OFFLINE` | CLI | Disable checks |
