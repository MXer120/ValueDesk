# The EC2 test environment

One instance, defined once by `provision.sh`, for an AWS user that may launch EC2
resources but may not use CloudFormation, IAM or SSM. The runbook - why, what it
costs, the commands in order, how to move to a domain, how it moved to Tokyo - is
**`docs/deploy/EC2-VERCEL.md`**; this is the reference for the script.

```
cp deploy/aws/ec2/ec2.env.example deploy/aws/ec2/ec2.env    # preset values; no secret in it
deploy/aws/ec2/provision.sh up --print                      # the plan: read-only lookups, the writes it would make
deploy/aws/ec2/provision.sh check                           # dry runs: may this profile make them?
deploy/aws/ec2/provision.sh up                              # create what is missing
deploy/aws/ec2/provision.sh status | stop | start | allow-ssh | snapshot | grow
deploy/aws/ec2/provision.sh copy-snapshot [snap-...]        # another environment's data snapshot into REGION
```

**A second environment next to the first** - the move from Frankfurt to Tokyo - is a
second env file, named with `VS_EC2_ENV` (the scripts in `deploy/release` take it too):

```
cp deploy/aws/ec2/ec2.tokyo.env.example deploy/aws/ec2/ec2.tokyo.env
VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env deploy/aws/ec2/provision.sh up --print
```

| Env file | State file (`.out/`, written by `up` and `status`) |
|---|---|
| `ec2.env` | `state.env` |
| `ec2.<x>.env` (e.g. `ec2.tokyo.env`) | `state.<x>.env` (`state.tokyo.env`) |

A state file records the environment's `NAME` and `REGION`; `deploy/release/lib.sh`
refuses one that does not belong to the env file it was given.

| Resource | Tag `role` | Name | Notes |
|---|---|---|---|
| key pair | `ssh-key` | `<NAME>` | ed25519; private key to `SSH_KEY_FILE` (0600, ACL narrowed on Windows), never printed |
| security group | `origin-sg` | `<NAME>-origin` | default VPC; in 443 + 80 from anywhere, 22 from `SSH_CIDR` (this machine's address); out 443 + 80 |
| Elastic IP | `origin-ip` | `<NAME>-origin` | the origin name is `<ip-with-dashes>.sslip.io` until `ORIGIN_DOMAIN_NAME` is set |
| instance | `instance` | `<NAME>` | `AMI_ID`, `INSTANCE_TYPE`, encrypted gp3 root, IMDSv2 only, no public IP of its own, termination protection, stop on shutdown, launch client token `<NAME>-instance-1` |
| data volume | `data` | `<NAME>-data` | encrypted gp3 `DATA_VOLUME_GIB`, `/dev/sdf`; blank (`bootstrap.sh` formats it only when blank) or made from `DATA_VOLUME_SNAPSHOT` - only when it is created |
| snapshots | `data-snapshot` | `<NAME>-data-<time>` | `provision.sh snapshot`; never deleted by the script |
| snapshot copies | `data-snapshot-copy` | `<NAME>-data-from-<snap>` | `provision.sh copy-snapshot`: the newest completed `data-snapshot` of `SNAPSHOT_SOURCE_NAME` in `SNAPSHOT_SOURCE_REGION` (or the one named), encrypted with this region's default EBS key, tagged `source-snapshot=<id>` - so a second run finds it and copies nothing; never deleted by the script |

All carry `project=valuescan` and `env=<NAME>` as well, and are found by those tags.

**What it never does:** delete, terminate, replace or detach anything; launch a
second instance (the client token makes a repeated launch return the first one);
touch a resource that is not tagged for this environment; change a data volume that
exists (`DATA_VOLUME_SNAPSHOT` then only gets a note). A resource that differs from
the env file (another image, another type, a smaller volume) is reported with the
command that would change it.

**What it writes locally:** the private key (`SSH_KEY_FILE`) once, and the state
file in `deploy/aws/ec2/.out/` (ignored by git: ids and the address, no secret),
which the scripts in `deploy/release` read to reach the instance over SSH.

**The AMI** is per region. Without SSM, the newest Amazon Linux 2023 arm64 image:

```
aws ec2 describe-images --profile claude --region ap-northeast-1 --owners amazon \
  --filters 'Name=name,Values=al2023-ami-2023.*-kernel-6.1-arm64' 'Name=state,Values=available' \
  --query 'sort_by(Images,&CreationDate)[-1].[ImageId,Name,CreationDate]' --output text
```
