# AWS infrastructure (CloudFormation)

Three stacks, defined once. The runbook that puts them in context is
`docs/deploy/DEPLOY.md`; this file is the reference for the stacks themselves.

| Stack | Template | Region | What it holds | Bills |
|---|---|---|---|---|
| `valuescan-network` | `network.yaml` | REGION | VPC, one public subnet, the origin security group, the private ops bucket (release artifacts, index backups) | only what is stored in the bucket |
| `valuescan-compute` | `compute.yaml` | REGION | ONE instance, its encrypted data volume, an Elastic IP, the origin DNS record, the stop/start function, alarms | by the hour |
| `valuescan-edge` | `edge.yaml` | us-east-1 | the private site bucket, CloudFront, the certificate, the security headers, WAF, DNS | by use |

**The rules these templates are built around** (the owner's hard rule for AWS test
environments):

- One environment, defined in code, created once. Nothing here is created and
  deleted per test.
- The free network stays deployed. Only `valuescan-compute` goes up and down.
- Pausing is **stop**, never delete: `deploy.sh stop` / `deploy.sh start` change
  the `DesiredState` parameter. The instance id, both volumes, the Elastic IP and
  the DNS record stay. A stopped instance bills for storage and the address only.
- One region for compute. No fan-out.
- A stack delete is for the day the whole campaign is over.

## The topology (one choice, and why)

```
viewer ──HTTPS──> CloudFront ──┬── site bucket (S3, private, OAC)          /, /assets/*, /logos/*, ...
                               └── HTTPS, X-Origin-Verify ──> Caddy :443 ──> 127.0.0.1:8797 (index API, hosted mode)
                                                              on the instance, certificate for ORIGIN_DOMAIN_NAME
```

- **CloudFront talks to the origin over HTTPS** (topology B of
  `docs/deploy/SECURITY-HEADERS.md` §2.3). Caddy on the instance terminates TLS
  with a Let's Encrypt certificate for the origin name. The alternative - plain
  HTTP restricted to CloudFront's addresses - sends the origin secret and every
  request across the internet in clear text, and the security audit ranks it last.
- **Port 443 is open to CloudFront only** (the AWS-managed prefix list
  `com.amazonaws.global.cloudfront.origin-facing`), and every request must carry
  the origin secret, so another CloudFront customer's distribution gets a 403.
- **Port 80 is open to the world, for one reason:** with 443 closed to everyone
  but CloudFront, Let's Encrypt cannot validate over TLS, so Caddy answers the
  HTTP-01 challenge on port 80 (and redirects anything else to https, which
  outsiders cannot reach). The API is never served on port 80. The alternative,
  DNS validation, would put Route 53 write access on a public instance.
- **No SSH.** No key pair, no port 22, and the bootstrap disables the daemon.
  Shell access is SSM Session Manager; commands run through SSM Run Command.
- **The site and the API share one origin** (`https://DOMAIN/` and
  `https://DOMAIN/api/*`), so the browser needs no CORS and `'self'` covers the
  API in the CSP.

## Before the first deploy

1. AWS CLI v2 with credentials that may create these resources (CloudFormation,
   EC2, IAM, S3, CloudFront, ACM, Route 53, WAF, SSM, Lambda, SNS, CloudWatch).
2. `cp deploy/aws/params.env.example deploy/aws/params.env` and fill it in:
   `REGION`, `DOMAIN_NAME`, `HOSTED_ZONE_ID`, `ORIGIN_DOMAIN_NAME` at least.
   The file is ignored by git and holds no secret.
3. Offline validation (no AWS call):

   ```
   python deploy/aws/validate_offline.py
   ```

   With the public resource specification it also checks every property name
   (download the us-east-1 "Single file" JSON once from the page named in the
   script's header):

   ```
   python deploy/aws/validate_offline.py --spec path/to/CloudFormationResourceSpecification.json
   ```

4. AWS's own validation (read-only API calls):

   ```
   deploy/aws/deploy.sh validate
   ```

   which runs exactly:

   ```
   cd deploy/aws
   aws cloudformation validate-template --region <REGION>  --template-body file://network.yaml
   aws cloudformation validate-template --region <REGION>  --template-body file://compute.yaml
   aws cloudformation validate-template --region us-east-1 --template-body file://edge.yaml
   ```

   (`cfn-lint deploy/aws/*.yaml` is a good third opinion if you have it.)

## Deploy, in this order

Every `deploy.sh` command first creates a **change set and stops**. Read it, then
run the same command with `--execute`. `--print` shows the AWS commands and calls
nothing.

```
deploy/aws/deploy.sh secret  --execute   # 1. the origin secret, once (SSM Parameter Store, SecureString)
deploy/aws/deploy.sh network             # 2. change set ...
deploy/aws/deploy.sh network --execute   #    ... applied
deploy/aws/deploy.sh compute             # 3. THE instance launch of this environment
deploy/aws/deploy.sh compute --execute
deploy/release/bootstrap-instance.sh     # 4. set the instance up (docs/deploy/DEPLOY.md)
deploy/release/release-server.sh <tag>   # 5. the first server release
deploy/aws/deploy.sh edge                # 6. site bucket, certificate, CloudFront, WAF, DNS
deploy/aws/deploy.sh edge --execute
deploy/release/build-web.sh <tag> && deploy/release/publish-web.sh <tag>   # 7. the site
```

Why this order: the instance must exist before it can be bootstrapped; Caddy
needs the origin DNS record (created by `compute`) to obtain its certificate; the
edge then finds an origin that already answers over TLS. The edge stack takes
10-20 minutes (certificate validation, distribution).

In step 3 `deploy.sh` prints the image it resolved: put it into `params.env`
(`AMI_ID=ami-...`) and never change it.

After step 7, check what is really deployed:

```
node deploy/smoke/smoke.mjs --site=https://<DOMAIN_NAME> --origin=<ORIGIN_DOMAIN_NAME>
```

It compares the headers CloudFront sends with these templates, asks the gate
through the edge, walks every page and checks that the instance is closed to
everyone but CloudFront (`deploy/smoke/README.md`).

The origin secret is replaced with `deploy.sh secret --rotate --execute`, followed
by `deploy.sh edge --execute` and `deploy/release/bootstrap-instance.sh`
(`docs/deploy/DEPLOY.md`, "Rotating the origin secret").

### What the commands run

`deploy.sh` is a thin wrapper around `aws cloudformation deploy`. Without it:

```
cd deploy/aws

# network (REGION)
aws ec2 describe-managed-prefix-lists --region $REGION \
  --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
  --query 'PrefixLists[0].PrefixListId' --output text          # -> pl-...
aws cloudformation deploy --region $REGION --stack-name valuescan-network \
  --template-file network.yaml --no-execute-changeset \
  --parameter-overrides CloudFrontOriginPrefixListId=pl-...

# compute (REGION) - needs CAPABILITY_IAM (the instance role, the stop/start function's role)
aws ssm get-parameter --region $REGION \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --query Parameter.Value --output text                         # -> ami-...  (resolve ONCE)
aws cloudformation deploy --region $REGION --stack-name valuescan-compute \
  --template-file compute.yaml --capabilities CAPABILITY_IAM --no-execute-changeset \
  --parameter-overrides NetworkStackName=valuescan-network AmiId=ami-... InstanceType=t4g.large \
    OriginDomainName=origin.example.com HostedZoneId=Z... ConfigPrefix=/valuescan/prod AlertEmail=you@example.com

# edge (us-east-1) - the secret is passed from SSM, never typed or stored
aws cloudformation deploy --region us-east-1 --stack-name valuescan-edge \
  --template-file edge.yaml --no-execute-changeset \
  --parameter-overrides file://<a 0600 JSON file with DomainName, HostedZoneId, ApiOriginDomainName, OriginVerifySecret, ...>
```

Drop `--no-execute-changeset` to apply. In Git Bash set `MSYS_NO_PATHCONV=1`
first, or names starting with `/` are rewritten into Windows paths.

## Stop and start (no delete)

```
deploy/aws/deploy.sh stop  --execute     # DesiredState=stopped
deploy/aws/deploy.sh start --execute     # DesiredState=running
```

A small Lambda-backed custom resource calls `StopInstances` / `StartInstances` on
this one instance and waits. It cannot terminate anything. On start the units come
up by themselves (they are enabled); the indexer re-reads the gap it was away for.
While the instance is stopped the site keeps working - trading, Portfolio and Scan
go browser-direct - and the index pages say the index is unavailable.

## Parameters worth knowing

| Parameter (stack) | Default | Notes |
|---|---|---|
| `InstanceType` (compute) | `t4g.large` | Changing it stops and starts the instance; nothing is replaced. Sizing: `docs/deploy/DEPLOY.md`. |
| `CpuCredits` (compute) | `unlimited` | `standard` throttles at the baseline instead of billing surplus credits; `none` for non-burstable types. |
| `AmiId` (compute) | - | Pinned at creation. **A different id replaces the instance.** |
| `RootVolumeSizeGiB` (compute) | 16 | Creation only. **Changing it replaces the instance.** |
| `DataVolumeSizeGiB` (compute) | 40 | Can be raised any time; then `sudo xfs_growfs /var/lib/valuescan` on the instance. |
| `DataVolumeSnapshotId` (compute) | empty | Rebuild after a stack delete: the old data volume was snapshotted. |
| `DesiredState` (compute) | `running` | `stopped` stops the instance and keeps everything. |
| `TerminationProtection` (compute) | `true` | Makes an accidental replacement or delete fail. |
| `AlertEmail` (compute) | empty | Creates the SNS topic and three alarms (status check, CPU credit balance, surplus credits billed). |
| `BackupRetentionDays` (network) | 14 | Lifecycle expiry of `backups/` in the ops bucket. |
| `EnableWaf` (edge) | `true` | Rate limit on `/api/*` (2,000 per 5 minutes per address) plus two AWS managed rule groups on `/api/*`. |
| `GeoRestrictionType` / `GeoRestrictionCountries` (edge) | `none` | CloudFront country restriction. A legal decision for the owner. |
| `PriceClass` (edge) | `PriceClass_All` | |

## What an update can do to the instance

| You change | CloudFormation does |
|---|---|
| `DesiredState` | stops or starts it |
| `InstanceType`, `CpuCredits`, `TerminationProtection`, alarms, IAM policy | in place (a type change is a stop and start) |
| `DataVolumeSizeGiB`, `DataVolumeIops`, `DataVolumeThroughput` | in place, online |
| `AmiId`, `RootVolumeSizeGiB`, the subnet | **replacement** - refused while termination protection is on |

Stack termination protection is switched on by `deploy.sh --execute` for all three.

## Taking it down (the end of the campaign)

Stop is usually what you want. To remove everything:

1. `aws cloudformation update-termination-protection --no-enable-termination-protection` for each stack.
2. Edge: delete `valuescan-edge`. The site bucket is kept (it does not have to be
   emptied first).
3. Compute: set `TerminationProtection=false` (an update of its own), then delete
   `valuescan-compute`. The data volume is snapshotted, not lost; note the snapshot
   id for `DataVolumeSnapshotId`.
4. Network: delete `valuescan-network`. The ops bucket (backups, artifacts) and the
   site bucket are retained; empty and delete them by hand if they should go.

## If the instance cannot be launched

`deploy.sh compute --execute` is the one `RunInstances` of this environment. If the
account is not allowed to launch instances the stack fails at `Instance` and rolls
back; the network stack is unaffected. Do not retry in a loop and do not probe with
throwaway instances - `--dry-run` does not test the account-level gate either.
Resolve it with AWS Support, then run the command once more.

## Files

- `network.yaml`, `compute.yaml`, `edge.yaml` - the templates.
- `deploy.sh` - the wrapper (`validate`, `secret [--rotate]`, `network`, `compute`, `edge`, `stop`, `start`, `status`).
- `params.env.example` - the values to fill in.
- `validate_offline.py` - offline validation: YAML and intrinsic functions, every
  property against the resource specification, no account ids or secrets under
  `deploy/`, the headers and CSP equal to `SECURITY-HEADERS.md` and `index.html`,
  and the embedded Lambda and CloudFront function run against fakes.
