# Skipjack GitHub Action

Fetch the secrets and variables granted to a GitHub Actions workflow by a
Skipjack deployment. The action
authenticates with a short-lived GitHub OIDC token, so consuming repositories do
not need a long-lived Skipjack credential.

## Usage

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read

    steps:
      - uses: actions/checkout@v4
      - uses: bitnixdev/skipjack@v2026
      - run: ./deploy.sh
        # Granted secrets and variables are available as environment variables.
```

The `id-token: write` permission is required for GitHub to mint the OIDC token.
It does not grant this action write access to repository contents. Skipjack
verifies the token and applies its policies to the token's repository, ref,
environment, and reusable-workflow claims before returning any values.

By default the action connects to `https://skipjack.bitnix.dev` and maps a
workflow running in `owner/repository` to the lowercase Skipjack scope
`owner/repository`. Each default can be overridden when using a different
deployment or scope.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `url` | no | `https://skipjack.bitnix.dev` | HTTPS base URL of the Skipjack deployment. |
| `org` | no | GitHub repository owner | Skipjack organization slug. |
| `project` | no | GitHub repository name | Skipjack project slug. |
| `audience` | no | normalized `url` | OIDC audience configured by the Skipjack deployment. |

Secrets are registered with GitHub's log masker before any returned values are
exported to the environment. Variables are not masked. If a secret and variable
have the same name, the secret takes precedence.

Environment variables exported by an action are available only to later steps
in the same job; they cannot retroactively change the environment of the action
step itself or cross job boundaries.

The action rejects plaintext HTTP endpoints so the GitHub OIDC token and
returned secrets are always transported over TLS.

## Development

```sh
npm ci
npm run check
```

`dist/index.cjs` is committed because GitHub executes the checked-in bundle.
After changing `src/`, run `npm run build` and commit the updated bundle.
