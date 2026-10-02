# deploy/

Everything needed to put Valuescan on AWS and keep it running. The runbook - what
to fill in, what to run and in which order - is **`docs/deploy/DEPLOY.md`**.

| Directory | What | Runs |
|---|---|---|
| `aws/` | three CloudFormation stacks (network, compute, edge), `deploy.sh`, the offline validator | on your workstation, against AWS |
| `server/` | the instance: bootstrap, systemd units, environment templates, Caddy, backup, restore, health check | on the instance |
| `release/` | build and publish the web, release and roll back the server, operate the instance through SSM | on your workstation |
| `smoke/` | the production smoke test: locally before a deploy, against the real site after one | on your workstation |

What you fill in: `aws/params.env` and `release/web.env`, each copied from its
`.example`. Both are ignored by git; neither holds a secret. Build outputs and
temporary files go to `.out/` directories here, ignored as well.

Nothing in this directory holds an account id, a key or a secret, and
`aws/validate_offline.py` fails if that ever changes.

Checks that need no AWS account:

```
python deploy/aws/validate_offline.py                                              # the templates and what depends on them
node --disable-warning=ExperimentalWarning --test "deploy/**/*.test.mjs"           # backup, health check, smoke harness
node deploy/smoke/smoke.mjs --api=spawn --no-index --server-egress=deny --offline  # the production build behind the real hosted gate
```
