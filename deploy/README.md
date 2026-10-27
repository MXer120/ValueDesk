# deploy/

Everything needed to put ValueDesk online and keep it running. Two environments
share the instance's setup:

- **the test environment now being set up**: one EC2 instance made by a script, the
  site and `/api` on Vercel - runbook **`docs/deploy/EC2-VERCEL.md`**, the owner's
  steps `docs/deploy/OWNER-STEPS.md`;
- **the CloudFormation design** (CloudFront, WAF, three stacks) - runbook
  **`docs/deploy/DEPLOY.md`**, which is also the reference for everything on the
  instance.

| Directory | What | Runs |
|---|---|---|
| `aws/` | three CloudFormation stacks (network, compute, edge), `deploy.sh`, the offline validator | on your workstation, against AWS |
| `aws/ec2/` | `provision.sh`: the EC2 test environment, found by tag, created once, never deleted by script | on your workstation, against AWS |
| `server/` | the instance: bootstrap, systemd units (API, indexer, copy executor), environment templates, Caddy, backup, restore, health check | on the instance |
| `release/` | build and publish the web (S3 + CloudFront, or Vercel), release and roll back the server, operate the instance (SSM, or SSH) | on your workstation |
| `vercel/` | the Vercel deployment: the routes with the production headers, the `/api` function | packaged on your workstation, runs on Vercel |
| `smoke/` | the production smoke test: locally before a deploy, against the real site after one | on your workstation |

What you fill in: `aws/ec2/ec2.env` (or `aws/params.env`) and `release/web.env`,
each copied from its `.example` - and, for the move to Tokyo, `aws/ec2/ec2.tokyo.env`
from `aws/ec2/ec2.tokyo.env.example`, named with `VS_EC2_ENV` (EC2-VERCEL.md section 12). They are ignored by git; none holds a secret.
Build outputs and temporary files go to `.out/` directories here, ignored as well.

Nothing in this directory holds an account id, a key or a secret, and
`aws/validate_offline.py` fails if that ever changes.

Checks that need no AWS account:

```
python deploy/aws/validate_offline.py                                              # the templates and what depends on them
node --disable-warning=ExperimentalWarning --test "deploy/**/*.test.mjs"           # backup, health check, smoke harness, Vercel routes and function
node deploy/smoke/smoke.mjs --api=spawn --no-index --server-egress=deny --offline  # the production build behind the real hosted gate
deploy/aws/ec2/provision.sh up --print                                             # read-only: what the EC2 environment would create
```
