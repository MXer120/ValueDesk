# The EC2 test environment

One instance, defined once by `provision.sh`, for an AWS user that may launch EC2
resources but may not use CloudFormation, IAM or SSM. The runbook - why, what it
costs, the commands in order, how to move to a domain - is
**`docs/deploy/EC2-VERCEL.md`**; this is the reference for the script.

```
cp deploy/aws/ec2/ec2.env.example deploy/aws/ec2/ec2.env    # preset values; no secret in it
deploy/aws/ec2/provision.sh up --print                      # the plan: read-only lookups, the writes it would make
deploy/aws/ec2/provision.sh check                           # dry runs: may this profile make them?
deploy/aws/ec2/provision.sh up                              # create what is missing
deploy/aws/ec2/provision.sh status | stop | start | allow-ssh | snapshot | grow
```

| Resource | Tag `role` | Name | Notes |
|---|---|---|---|
| key pair | `ssh-key` | `<NAME>` | ed25519; private key to `SSH_KEY_FILE` (0600, ACL narrowed on Windows), never printed |
| security group | `origin-sg` | `<NAME>-origin` | default VPC; in 443 + 80 from anywhere, 22 from `SSH_CIDR` (this machine's address); out 443 + 80 |
| Elastic IP | `origin-ip` | `<NAME>-origin` | the origin name is `<ip-with-dashes>.sslip.io` until `ORIGIN_DOMAIN_NAME` is set |
| instance | `instance` | `<NAME>` | `AMI_ID`, `INSTANCE_TYPE`, encrypted gp3 root, IMDSv2 only, no public IP of its own, termination protection, stop on shutdown, launch client token `<NAME>-instance-1` |
| data volume | `data` | `<NAME>-data` | encrypted gp3 `DATA_VOLUME_GIB`, `/dev/sdf`; `bootstrap.sh` formats it only when blank |
| snapshots | `data-snapshot` | `<NAME>-data-<time>` | `provision.sh snapshot`; never deleted by the script |

All carry `project=valuescan` and `env=<NAME>` as well, and are found by those tags.

**What it never does:** delete, terminate, replace or detach anything; launch a
second instance (the client token makes a repeated launch return the first one);
touch a resource that is not tagged for this environment. A resource that differs
from `ec2.env` (another image, another type, a smaller volume) is reported with the
command that would change it.

**What it writes locally:** the private key (`SSH_KEY_FILE`) once, and
`deploy/aws/ec2/.out/state.env` (ignored by git: ids and the address, no secret),
which the scripts in `deploy/release` read to reach the instance over SSH.
