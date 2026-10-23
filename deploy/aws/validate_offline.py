#!/usr/bin/env python3
"""
Offline validation of deploy/aws/*.yaml - everything that can be checked
without an AWS account. It never calls AWS.

    python deploy/aws/validate_offline.py                 # templates + project rules
    python deploy/aws/validate_offline.py --spec SPEC     # + every property against the
                                                          #   official resource specification

What it checks

  1. YAML        each template parses (CloudFormation's !Ref / !Sub / ... tags
                 included); no duplicate keys; no accidental dates or booleans.
  2. Structure   sections, parameter and resource shapes, DeletionPolicy values.
  3. Intrinsics  every Ref, Fn::GetAtt, Fn::Sub variable, Fn::If condition and
                 DependsOn points at something that exists; arities are right;
                 the Conditions section uses only condition functions.
  4. Hygiene     no account ids, access keys, private keys or secret-looking
                 defaults anywhere under deploy/; secret parameters are NoEcho
                 and have no default.
  5. Project     the headers and CSP in edge.yaml equal docs/deploy/SECURITY-HEADERS.md,
                 the <meta> policy of apps/web/index.html and what deploy/smoke
                 serves; the /scan/ hash matches the file; API errors are not
                 rewritten; one instance, no SSH, encrypted volumes; the inline
                 Lambda and the CloudFront function behave (they are run here
                 against fakes).
  6. Spec        with --spec: resource types exist, required properties are set,
                 no unknown property names at any depth, GetAtt attributes exist.
                 Download the specification once (it is public, ~18 MB):
                   https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/cfn-resource-specification.html
                   (the "Single file" link of us-east-1; save it as JSON)

This is not a substitute for `aws cloudformation validate-template` and a
change-set review (deploy/aws/README.md) - it catches what those would, earlier.

Requires Python 3.9+ and PyYAML (`pip install pyyaml`). Node is used for two
checks when it is on PATH (the CloudFront function, deploy/smoke's header table).
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import datetime
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import types
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("PyYAML is required: pip install pyyaml")

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
TEMPLATES = ["network.yaml", "compute.yaml", "edge.yaml"]

PSEUDO = {
    "AWS::AccountId", "AWS::NotificationARNs", "AWS::NoValue", "AWS::Partition",
    "AWS::Region", "AWS::StackId", "AWS::StackName", "AWS::URLSuffix",
}
TOP_LEVEL = {
    "AWSTemplateFormatVersion", "Description", "Metadata", "Parameters", "Rules",
    "Mappings", "Conditions", "Transform", "Resources", "Outputs",
}
RESOURCE_KEYS = {
    "Type", "Properties", "Condition", "DependsOn", "DeletionPolicy", "UpdateReplacePolicy",
    "UpdatePolicy", "CreationPolicy", "Metadata",
}
PARAM_TYPES_RE = re.compile(
    r"^(String|Number|CommaDelimitedList|List<Number>|List<String>|AWS::[A-Za-z0-9:]+(::Id|::Name|::KeyName)?"
    r"|List<AWS::[A-Za-z0-9:]+>|AWS::SSM::Parameter::(Name|Value<.+>))$"
)
CONDITION_FUNCS = {"Fn::And", "Fn::Equals", "Fn::Not", "Fn::Or", "Condition"}
# Functions CloudFormation resolves inside the Conditions section.
ALLOWED_IN_CONDITIONS = CONDITION_FUNCS | {"Ref", "Fn::FindInMap", "Fn::Join", "Fn::Select", "Fn::Split", "Fn::Sub"}
INTRINSICS = {
    "Ref", "Condition", "Fn::GetAtt", "Fn::Sub", "Fn::Join", "Fn::Select", "Fn::Split", "Fn::If",
    "Fn::Equals", "Fn::Not", "Fn::And", "Fn::Or", "Fn::FindInMap", "Fn::ImportValue", "Fn::Base64",
    "Fn::GetAZs", "Fn::Cidr", "Fn::Transform", "Fn::Length", "Fn::ToJsonString",
}

CSP_HEADER_ONLY = {"manifest-src": ["'self'"], "frame-ancestors": ["'none'"], "upgrade-insecure-requests": []}
CSP_MAX_LEN = 1783  # CloudFront's limit for a response headers policy
IMAGES_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"
PERMISSIONS_POLICY = (
    "accelerometer=(), autoplay=(self \"https://www.youtube.com\" \"https://player.twitch.tv\" \"https://player.kick.com\" \"https://player.vimeo.com\"), camera=(), display-capture=(), encrypted-media=(), geolocation=(), "
    "gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=(), "
    "xr-spatial-tracking=(), browsing-topics=(), clipboard-read=(), clipboard-write=(self), fullscreen=(self)"
)


# --- findings ---------------------------------------------------------------------

class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.passed: list[str] = []

    def err(self, where: str, msg: str) -> None:
        self.errors.append(f"{where}: {msg}")

    def warn(self, where: str, msg: str) -> None:
        self.warnings.append(f"{where}: {msg}")

    def ok(self, msg: str) -> None:
        self.passed.append(msg)


# --- YAML with CloudFormation tags ----------------------------------------------------

class CfnLoader(yaml.SafeLoader):
    """SafeLoader + the short-form intrinsics, refusing duplicate keys."""


def _mapping(loader: CfnLoader, node: yaml.MappingNode) -> dict:
    loader.flatten_mapping(node)
    out: dict = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=True)
        if key in out:
            raise yaml.constructor.ConstructorError(
                None, None, f"duplicate key {key!r}", key_node.start_mark)
        out[key] = loader.construct_object(value_node, deep=True)
    return out


def _intrinsic(loader: CfnLoader, suffix: str, node: yaml.Node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node, deep=True)
    else:
        value = _mapping(loader, node)
    if suffix in ("Ref", "Condition"):
        return {suffix: value}
    if suffix == "GetAtt" and isinstance(value, str):
        value = value.split(".", 1)
    return {"Fn::" + suffix: value}


CfnLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _mapping)
CfnLoader.add_multi_constructor("!", _intrinsic)


def load_template(path: Path):
    return yaml.load(path.read_text(encoding="utf-8"), Loader=CfnLoader)


# --- generic template checks -------------------------------------------------------------

def is_intrinsic(v) -> bool:
    return isinstance(v, dict) and len(v) == 1 and next(iter(v)) in INTRINSICS


class Template:
    def __init__(self, name: str, doc: dict, rep: Report, spec: dict | None) -> None:
        self.name = name
        self.doc = doc
        self.rep = rep
        self.spec = spec
        self.params: dict = doc.get("Parameters") or {}
        self.resources: dict = doc.get("Resources") or {}
        self.conditions: dict = doc.get("Conditions") or {}
        self.mappings: dict = doc.get("Mappings") or {}
        self.outputs: dict = doc.get("Outputs") or {}
        self.used_params: set[str] = set()
        self.used_conditions: set[str] = set()

    # ---- structure

    def check_structure(self) -> None:
        r, n = self.rep, self.name
        for key in self.doc:
            if key not in TOP_LEVEL:
                r.err(n, f"unknown top-level section {key!r}")
        if self.doc.get("AWSTemplateFormatVersion") != "2010-09-09":
            r.err(n, "AWSTemplateFormatVersion must be the string '2010-09-09'")
        desc = self.doc.get("Description")
        if not isinstance(desc, str) or not desc.strip():
            r.err(n, "Description is missing")
        elif len(desc.encode("utf-8")) > 1024:
            r.err(n, f"Description is {len(desc.encode('utf-8'))} bytes (limit 1024)")
        if not self.resources:
            r.err(n, "no Resources")
        if len(self.resources) > 500:
            r.err(n, "more than 500 resources")
        if len(self.params) > 200:
            r.err(n, "more than 200 parameters")
        if len(self.outputs) > 200:
            r.err(n, "more than 200 outputs")
        for lid in list(self.params) + list(self.resources) + list(self.conditions) + list(self.outputs):
            if not isinstance(lid, str) or not re.fullmatch(r"[A-Za-z0-9]{1,255}", lid):
                r.err(n, f"logical id {lid!r} must be alphanumeric")
        for pname, p in self.params.items():
            where = f"{n} Parameters.{pname}"
            if not isinstance(p, dict) or "Type" not in p:
                r.err(where, "needs a Type")
                continue
            if not PARAM_TYPES_RE.match(str(p["Type"])):
                r.err(where, f"unknown parameter type {p['Type']!r}")
            for k in p:
                if k not in {"Type", "Default", "Description", "AllowedValues", "AllowedPattern", "ConstraintDescription",
                             "MinLength", "MaxLength", "MinValue", "MaxValue", "NoEcho"}:
                    r.err(where, f"unknown key {k!r}")
            if "Description" in p and len(str(p["Description"])) > 4000:
                r.err(where, "Description longer than 4000 characters")
            if "AllowedPattern" in p:
                try:
                    pat = re.compile(str(p["AllowedPattern"]))
                    if "Default" in p and not pat.fullmatch(str(p["Default"])):
                        r.err(where, f"Default {p['Default']!r} does not match AllowedPattern")
                except re.error as e:
                    r.err(where, f"AllowedPattern is not a valid regular expression: {e}")
            if "AllowedValues" in p and "Default" in p and p["Default"] not in p["AllowedValues"]:
                r.err(where, f"Default {p['Default']!r} is not one of AllowedValues")
            if re.search(r"secret|password|token|privatekey", pname, re.I):
                if p.get("NoEcho") is not True:
                    r.err(where, "a secret parameter must be NoEcho")
                if "Default" in p:
                    r.err(where, "a secret parameter must not have a Default")
        for rname, res in self.resources.items():
            where = f"{n} Resources.{rname}"
            if not isinstance(res, dict) or not isinstance(res.get("Type"), str):
                r.err(where, "needs a Type")
                continue
            for k in res:
                if k not in RESOURCE_KEYS:
                    r.err(where, f"unknown resource attribute {k!r}")
            for pol in ("DeletionPolicy", "UpdateReplacePolicy"):
                if pol in res and res[pol] not in ("Delete", "Retain", "Snapshot", "RetainExceptOnCreate"):
                    r.err(where, f"{pol} {res[pol]!r} is not valid")
            if res.get("DeletionPolicy") == "Snapshot" and res["Type"] not in SNAPSHOT_TYPES:
                r.err(where, f"DeletionPolicy Snapshot is not supported for {res['Type']}")
            cond = res.get("Condition")
            if cond is not None:
                self._use_condition(cond, where)
            deps = res.get("DependsOn")
            for d in ([deps] if isinstance(deps, str) else deps or []):
                if d not in self.resources:
                    r.err(where, f"DependsOn {d!r} is not a resource")
        for oname, o in self.outputs.items():
            where = f"{n} Outputs.{oname}"
            if not isinstance(o, dict) or "Value" not in o:
                r.err(where, "needs a Value")
                continue
            for k in o:
                if k not in {"Value", "Description", "Export", "Condition"}:
                    r.err(where, f"unknown key {k!r}")
            if "Condition" in o:
                self._use_condition(o["Condition"], where)
            if "Export" in o and (not isinstance(o["Export"], dict) or set(o["Export"]) != {"Name"}):
                r.err(where, "Export must be {Name: ...}")

    def _use_condition(self, name, where: str) -> None:
        if not isinstance(name, str) or name not in self.conditions:
            self.rep.err(where, f"condition {name!r} is not defined")
        else:
            self.used_conditions.add(name)

    # ---- intrinsic functions

    def check_intrinsics(self) -> None:
        for cname, c in self.conditions.items():
            self._walk(c, f"{self.name} Conditions.{cname}", in_conditions=True)
            if not (isinstance(c, dict) and len(c) == 1 and next(iter(c)) in CONDITION_FUNCS):
                self.rep.err(f"{self.name} Conditions.{cname}", "must be a condition function")
        for rname, res in self.resources.items():
            if isinstance(res, dict):
                self._walk(res.get("Properties"), f"{self.name} Resources.{rname}.Properties")
        for oname, o in self.outputs.items():
            if isinstance(o, dict):
                self._walk(o.get("Value"), f"{self.name} Outputs.{oname}.Value")
                self._walk(o.get("Export"), f"{self.name} Outputs.{oname}.Export")
        for p in self.params:
            if p not in self.used_params:
                self.rep.warn(f"{self.name} Parameters.{p}", "is never referenced")
        for c in self.conditions:
            if c not in self.used_conditions:
                self.rep.warn(f"{self.name} Conditions.{c}", "is never used")

    def _ref_target(self, target, where: str, extra: frozenset = frozenset()) -> None:
        if not isinstance(target, str):
            self.rep.err(where, f"Ref target must be a string, got {target!r}")
        elif target in self.params:
            self.used_params.add(target)
        elif target not in self.resources and target not in PSEUDO and target not in extra:
            self.rep.err(where, f"Ref {target!r} is not a parameter, resource or pseudo parameter")

    def _getatt(self, res: str, attr, where: str) -> None:
        if res not in self.resources:
            self.rep.err(where, f"GetAtt on {res!r}, which is not a resource")
            return
        rtype = self.resources[res].get("Type", "")
        if not isinstance(attr, str):
            return  # an intrinsic as the attribute name
        if self.spec and rtype in self.spec["ResourceTypes"]:
            attrs = self.spec["ResourceTypes"][rtype].get("Attributes", {})
            if attr not in attrs:
                self.rep.err(where, f"{rtype} has no attribute {attr!r} (it has: {', '.join(sorted(attrs)) or 'none'})")

    def _walk(self, v, where: str, in_conditions: bool = False) -> None:
        r = self.rep
        if isinstance(v, (datetime.date, datetime.datetime)):
            r.err(where, f"unquoted date {v} - quote it so it stays a string")
            return
        if isinstance(v, list):
            for i, item in enumerate(v):
                self._walk(item, f"{where}[{i}]", in_conditions)
            return
        if not isinstance(v, dict):
            return
        if len(v) == 1:
            fn, arg = next(iter(v.items()))
            if fn in INTRINSICS:
                if in_conditions and fn not in ALLOWED_IN_CONDITIONS:
                    r.err(where, f"{fn} cannot be used in the Conditions section")
                self._intrinsic(fn, arg, where, in_conditions)
                return
            if isinstance(fn, str) and fn.startswith("Fn::"):
                r.err(where, f"unknown intrinsic function {fn}")
        for k, item in v.items():
            if not isinstance(k, str):
                r.err(where, f"key {k!r} is not a string (quote it)")
            self._walk(item, f"{where}.{k}", in_conditions)

    def _intrinsic(self, fn: str, arg, where: str, in_cond: bool) -> None:
        r = self.rep
        w = f"{where} {fn}"
        if fn == "Ref":
            self._ref_target(arg, w)
        elif fn == "Condition":
            self._use_condition(arg, w)
        elif fn == "Fn::GetAtt":
            if isinstance(arg, list) and len(arg) == 2 and isinstance(arg[0], str):
                self._getatt(arg[0], arg[1], w)
                self._walk(arg[1], w, in_cond)
            else:
                r.err(w, "needs [LogicalId, Attribute] or 'LogicalId.Attribute'")
        elif fn == "Fn::Sub":
            if isinstance(arg, str):
                self._sub(arg, {}, w)
            elif isinstance(arg, list) and len(arg) == 2 and isinstance(arg[0], str) and isinstance(arg[1], dict):
                self._sub(arg[0], arg[1], w)
                for k, item in arg[1].items():
                    self._walk(item, f"{w}.{k}", in_cond)
            else:
                r.err(w, "needs a string or [string, {Var: value}]")
        elif fn == "Fn::If":
            if isinstance(arg, list) and len(arg) == 3:
                self._use_condition(arg[0], w)
                self._walk(arg[1], f"{w}[1]", in_cond)
                self._walk(arg[2], f"{w}[2]", in_cond)
            else:
                r.err(w, "needs [condition, value-if-true, value-if-false]")
        elif fn == "Fn::Join":
            if isinstance(arg, list) and len(arg) == 2 and isinstance(arg[0], str) and (isinstance(arg[1], list) or is_intrinsic(arg[1])):
                self._walk(arg[1], w, in_cond)
            else:
                r.err(w, "needs [delimiter, [values]]")
        elif fn == "Fn::Select":
            if isinstance(arg, list) and len(arg) == 2:
                if isinstance(arg[0], (int, str)) and not str(arg[0]).lstrip("-").isdigit():
                    r.err(w, "index must be an integer")
                self._walk(arg[0], w, in_cond)
                self._walk(arg[1], w, in_cond)
            else:
                r.err(w, "needs [index, list]")
        elif fn == "Fn::Split":
            if isinstance(arg, list) and len(arg) == 2 and isinstance(arg[0], str):
                self._walk(arg[1], w, in_cond)
            else:
                r.err(w, "needs [delimiter, string]")
        elif fn == "Fn::Equals":
            if isinstance(arg, list) and len(arg) == 2:
                self._walk(arg, w, in_cond)
            else:
                r.err(w, "needs exactly two values")
        elif fn == "Fn::Not":
            if isinstance(arg, list) and len(arg) == 1:
                self._walk(arg, w, in_cond)
            else:
                r.err(w, "needs exactly one condition")
        elif fn in ("Fn::And", "Fn::Or"):
            if isinstance(arg, list) and 2 <= len(arg) <= 10:
                self._walk(arg, w, in_cond)
            else:
                r.err(w, "needs 2 to 10 conditions")
        elif fn == "Fn::FindInMap":
            if isinstance(arg, list) and len(arg) in (3, 4):
                if isinstance(arg[0], str) and arg[0] not in self.mappings:
                    r.err(w, f"mapping {arg[0]!r} is not defined")
                self._walk(arg[1:], w, in_cond)
            else:
                r.err(w, "needs [MapName, TopLevelKey, SecondLevelKey]")
        elif fn == "Fn::ImportValue":
            if isinstance(arg, (list,)) or arg is None:
                r.err(w, "needs a string or a function that returns one")
            if isinstance(arg, dict) and next(iter(arg)) in ("Fn::GetAtt",):
                r.err(w, "cannot depend on a resource attribute")
            self._walk(arg, w, in_cond)
        elif fn == "Fn::GetAZs":
            self._walk(arg, w, in_cond)
        elif fn == "Fn::Cidr":
            if not (isinstance(arg, list) and len(arg) == 3):
                r.err(w, "needs [ipBlock, count, cidrBits]")
            self._walk(arg, w, in_cond)
        else:
            self._walk(arg, w, in_cond)

    def _sub(self, text: str, local: dict, where: str) -> None:
        for m in re.finditer(r"\$\{([^}]*)\}", text):
            var = m.group(1)
            if var.startswith("!"):
                continue  # ${!Literal}
            var = var.strip()
            if var in local:
                continue
            if "." in var and not var.startswith("AWS::"):
                res, attr = var.split(".", 1)
                self._getatt(res, attr, f"{where} ${{{var}}}")
            else:
                self._ref_target(var, f"{where} ${{{var}}}")
        for k in local:
            if not re.search(r"\$\{\s*" + re.escape(k) + r"\s*\}", text):
                self.rep.warn(where, f"Sub variable {k!r} is defined but not used")

    # ---- the resource specification

    def check_spec(self) -> None:
        if not self.spec:
            return
        rts, pts = self.spec["ResourceTypes"], self.spec["PropertyTypes"]
        for rname, res in self.resources.items():
            if not isinstance(res, dict):
                continue
            rtype = res.get("Type", "")
            where = f"{self.name} Resources.{rname}"
            if rtype.startswith("Custom::") or rtype == "AWS::CloudFormation::CustomResource":
                if "ServiceToken" not in (res.get("Properties") or {}):
                    self.rep.err(where, "a custom resource needs ServiceToken")
                continue
            if rtype not in rts:
                self.rep.err(where, f"resource type {rtype} is not in the specification")
                continue
            self._spec_props(rtype, rts[rtype].get("Properties", {}), res.get("Properties") or {}, f"{where}.Properties", pts)

    def _spec_props(self, rtype: str, defs: dict, props, where: str, pts: dict) -> None:
        if is_intrinsic(props):
            fn, arg = next(iter(props.items()))
            if fn == "Fn::If" and isinstance(arg, list) and len(arg) == 3:
                for branch in arg[1:]:
                    if branch != {"Ref": "AWS::NoValue"}:
                        self._spec_props(rtype, defs, branch, where, pts)
            return
        if not isinstance(props, dict):
            self.rep.err(where, f"expected a map of properties, got {type(props).__name__}")
            return
        for k, v in props.items():
            if k not in defs:
                self.rep.err(where, f"unknown property {k!r} (known: {', '.join(sorted(defs))})")
                continue
            self._spec_value(rtype, defs[k], v, f"{where}.{k}", pts)
        for k, d in defs.items():
            if d.get("Required") and k not in props:
                self.rep.err(where, f"required property {k!r} is missing")

    def _complex(self, rtype: str, type_name: str, pts: dict) -> dict | None:
        for key in (f"{rtype}.{type_name}", type_name):
            if key in pts:
                return pts[key]
        return None

    def _spec_value(self, rtype: str, d: dict, v, where: str, pts: dict) -> None:
        if v == {"Ref": "AWS::NoValue"}:
            return
        if is_intrinsic(v):
            fn, arg = next(iter(v.items()))
            if fn == "Fn::If" and isinstance(arg, list) and len(arg) == 3:
                self._spec_value(rtype, d, arg[1], f"{where}[if-true]", pts)
                self._spec_value(rtype, d, arg[2], f"{where}[if-false]", pts)
            return
        prim = d.get("PrimitiveType")
        t = d.get("Type")
        if prim:
            if prim != "Json" and isinstance(v, (dict, list)):
                self.rep.err(where, f"expected a {prim}, got a {'map' if isinstance(v, dict) else 'list'}")
            return
        if t == "List":
            if not isinstance(v, list):
                self.rep.err(where, "expected a list")
                return
            for i, item in enumerate(v):
                self._spec_item(rtype, d, item, f"{where}[{i}]", pts)
        elif t == "Map":
            if not isinstance(v, dict):
                self.rep.err(where, "expected a map")
                return
            for k, item in v.items():
                self._spec_item(rtype, d, item, f"{where}.{k}", pts)
        elif t:
            sub = self._complex(rtype, t, pts)
            if sub is None:
                return
            if "Properties" in sub:
                self._spec_props(rtype, sub["Properties"], v, where, pts)
            else:  # an alias of a primitive or a list
                self._spec_value(rtype, sub, v, where, pts)

    def _spec_item(self, rtype: str, d: dict, item, where: str, pts: dict) -> None:
        if item == {"Ref": "AWS::NoValue"}:
            return
        if is_intrinsic(item):
            fn, arg = next(iter(item.items()))
            if fn == "Fn::If" and isinstance(arg, list) and len(arg) == 3:
                self._spec_item(rtype, d, arg[1], f"{where}[if-true]", pts)
                self._spec_item(rtype, d, arg[2], f"{where}[if-false]", pts)
            return
        if d.get("PrimitiveItemType"):
            if d["PrimitiveItemType"] != "Json" and isinstance(item, (dict, list)):
                self.rep.err(where, f"expected a {d['PrimitiveItemType']}")
            return
        it = d.get("ItemType")
        if it:
            sub = self._complex(rtype, it, pts)
            if sub and "Properties" in sub:
                self._spec_props(rtype, sub["Properties"], item, where, pts)


SNAPSHOT_TYPES = {
    "AWS::EC2::Volume", "AWS::RDS::DBInstance", "AWS::RDS::DBCluster", "AWS::ElastiCache::CacheCluster",
    "AWS::ElastiCache::ReplicationGroup", "AWS::Redshift::Cluster", "AWS::Neptune::DBCluster",
    "AWS::DocDB::DBCluster",
}


# --- hygiene: nothing secret or account-specific under deploy/ -------------------------------

SECRET_PATTERNS = [
    (re.compile(r"(?<![\w.])\d{12}(?!\w|\.\d)"), "a 12-digit number (an AWS account id?)"),
    (re.compile(r"\b(AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16}\b"), "an AWS access key or principal id"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "a private key"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"), "a GitHub token"),
    (re.compile(r"\b0x[0-9a-fA-F]{64}\b"), "a 32-byte hex value (a private key?)"),
]
ASSIGN_RE = re.compile(
    r"(?i)\b([A-Z0-9_]*(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY|API_KEY)[A-Z0-9_]*)\s*[=:]\s*[\"']?([^\s\"'#]+)")
PLACEHOLDER_RE = re.compile(r"^(__.*__|<.*>|\$.*|\{\{.*|.*\}\}|true|false|set|unset|none|null|required|no|yes|0|1)$", re.I)
TEXT_SUFFIXES = {".yaml", ".yml", ".sh", ".mjs", ".js", ".py", ".md", ".env", ".example", ".service", ".timer",
                 ".conf", ".json", ".template", ".txt", ""}


def check_hygiene(rep: Report, root: Path) -> None:
    files = [p for p in sorted(root.rglob("*")) if p.is_file() and ".out" not in p.parts and "__pycache__" not in p.parts]
    scanned = 0
    for p in files:
        if p.suffix not in TEXT_SUFFIXES:
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        scanned += 1
        try:
            rel = p.relative_to(REPO).as_posix()
        except ValueError:
            rel = p.as_posix()
        if p.resolve() == Path(__file__).resolve():
            continue  # this file names the patterns it looks for
        for lineno, line in enumerate(text.splitlines(), 1):
            for pat, what in SECRET_PATTERNS:
                if pat.search(line):
                    rep.err(f"{rel}:{lineno}", f"contains {what}")
            for m in ASSIGN_RE.finditer(line):
                name, value = m.group(1), m.group(3)
                if PLACEHOLDER_RE.match(value) or len(value) < 12:
                    continue
                if re.fullmatch(r"[A-Za-z0-9+/=_-]{20,}", value):
                    rep.err(f"{rel}:{lineno}", f"{name} is assigned a literal value - secrets never go into the repo")
    rep.ok(f"hygiene: {scanned} files under deploy/ carry no account id, key or secret")


# --- project rules ----------------------------------------------------------------------------

def parse_csp(text: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for part in text.split(";"):
        tokens = part.split()
        if tokens:
            out[tokens[0].lower()] = tokens[1:]
    return out


def csp_equal(a: dict, b: dict) -> list[str]:
    diff = []
    for d in sorted(set(a) | set(b)):
        if d not in a:
            diff.append(f"{d} is missing on the left")
        elif d not in b:
            diff.append(f"{d} is missing on the right")
        elif sorted(a[d]) != sorted(b[d]):
            only_a = sorted(set(a[d]) - set(b[d]))
            only_b = sorted(set(b[d]) - set(a[d]))
            diff.append(f"{d}: only left {only_a}, only right {only_b}")
    return diff


def meta_csp(index_html: str) -> dict[str, list[str]] | None:
    m = re.search(r'http-equiv="Content-Security-Policy"\s+content="([^"]*)"', index_html)
    return parse_csp(m.group(1)) if m else None


def doc_csp(doc: str) -> dict[str, list[str]] | None:
    m = re.search(r"### 1\.2 Content-Security-Policy.*?```\n(.*?)```", doc, re.S)
    if not m:
        return None
    return parse_csp(m.group(1).replace("__API_ORIGIN__", " "))


def scan_script_hash(scan_html: str) -> str | None:
    m = re.search(r"<script>([\s\S]*?)</script>", scan_html)
    if not m:
        return None
    return "sha256-" + base64.b64encode(hashlib.sha256(m.group(1).encode("utf-8")).digest()).decode()


def policy_config(t: Template, logical: str) -> dict:
    return ((t.resources.get(logical) or {}).get("Properties") or {}).get("ResponseHeadersPolicyConfig") or {}


def csp_of(t: Template, logical: str) -> str:
    return (((policy_config(t, logical).get("SecurityHeadersConfig") or {}).get("ContentSecurityPolicy") or {})
            .get("ContentSecurityPolicy") or "")


def custom_headers(cfg: dict) -> dict[str, str]:
    return {i["Header"]: i["Value"] for i in ((cfg.get("CustomHeadersConfig") or {}).get("Items") or [])}


def check_edge(t: Template, rep: Report, repo: Path) -> None:
    n = t.name
    index_html = (repo / "apps/web/index.html").read_text(encoding="utf-8")
    sec_doc = (repo / "docs/deploy/SECURITY-HEADERS.md").read_text(encoding="utf-8")
    scan_html = (repo / "apps/web/public/scan/index.html").read_bytes().decode("utf-8")

    site = csp_of(t, "SiteHeadersPolicy")
    scan = csp_of(t, "ScanHeadersPolicy")
    images = csp_of(t, "ImagesHeadersPolicy")
    for name, value in (("site", site), ("scan", scan), ("images", images)):
        if not value:
            rep.err(n, f"the {name} response headers policy has no CSP")
        if "\n" in value or "  " in value:
            rep.err(n, f"the {name} CSP is not one line with single spaces")
        if len(value) > CSP_MAX_LEN:
            rep.err(n, f"the {name} CSP is {len(value)} characters (CloudFront's limit is {CSP_MAX_LEN})")
    site_p = parse_csp(site)

    meta = meta_csp(index_html)
    if meta is None:
        rep.err(n, "apps/web/index.html has no <meta> CSP to compare with")
    else:
        expected = {**meta, **CSP_HEADER_ONLY}
        diff = csp_equal(site_p, expected)
        if diff:
            rep.err(n, "the site CSP differs from apps/web/index.html's <meta> policy (+ the header-only directives): "
                    + "; ".join(diff))
        else:
            rep.ok(f"edge: site CSP ({len(site)} chars) = index.html's <meta> policy + manifest-src, frame-ancestors, upgrade-insecure-requests")
    doc = doc_csp(sec_doc)
    if doc is None:
        rep.err(n, "could not find the policy in docs/deploy/SECURITY-HEADERS.md section 1.2")
    else:
        diff = csp_equal(site_p, doc)
        if diff:
            rep.err(n, "the site CSP differs from docs/deploy/SECURITY-HEADERS.md section 1.2: " + "; ".join(diff))
        else:
            rep.ok("edge: site CSP = docs/deploy/SECURITY-HEADERS.md section 1.2")
    for d in ("ws:", "wss:", "https:", "http:", "*"):
        if d in site_p.get("connect-src", []):
            rep.err(n, f"connect-src contains the wildcard {d}")
    if "'unsafe-inline'" in site_p.get("script-src", []) or "'unsafe-eval'" in site_p.get("script-src", []):
        rep.err(n, "script-src must not allow unsafe-inline or unsafe-eval")

    want_hash = scan_script_hash(scan_html)
    expected_scan = {k: list(v) for k, v in site_p.items()}
    expected_scan["script-src"] = site_p.get("script-src", []) + [f"'{want_hash}'"]
    diff = csp_equal(parse_csp(scan), expected_scan)
    if diff:
        rep.err(n, f"the /scan/ CSP must be the site CSP plus the inline script's hash '{want_hash}': " + "; ".join(diff))
    else:
        rep.ok(f"edge: /scan/ CSP = site CSP + {want_hash} (matches apps/web/public/scan/index.html)")
    if b"\r\n" in (repo / "apps/web/public/scan/index.html").read_bytes():
        rep.warn(n, "apps/web/public/scan/index.html has CRLF line endings here; the hash is for LF (what git stores)")
    if images != IMAGES_CSP:
        rep.err(n, f"the image-directory CSP must be exactly: {IMAGES_CSP}")
    elif IMAGES_CSP not in sec_doc:
        rep.err(n, "the image-directory CSP is no longer the one in SECURITY-HEADERS.md")
    else:
        rep.ok("edge: /logos/ and /addrbook/ CSP = SECURITY-HEADERS.md")

    if PERMISSIONS_POLICY not in sec_doc:
        rep.err(n, "SECURITY-HEADERS.md's Permissions-Policy changed; update this validator and edge.yaml")
    for logical in ("SiteHeadersPolicy", "ScanHeadersPolicy", "ImagesHeadersPolicy"):
        cfg = policy_config(t, logical)
        sh = cfg.get("SecurityHeadersConfig") or {}
        problems = []
        sts = sh.get("StrictTransportSecurity") or {}
        if not (sts.get("AccessControlMaxAgeSec") == 63072000 and sts.get("IncludeSubdomains") is True
                and sts.get("Preload") is False and sts.get("Override") is True):
            problems.append("HSTS must be max-age=63072000; includeSubDomains, no preload")
        if (sh.get("FrameOptions") or {}).get("FrameOption") != "DENY":
            problems.append("X-Frame-Options must be DENY")
        if (sh.get("ContentTypeOptions") or {}).get("Override") is not True:
            problems.append("X-Content-Type-Options: nosniff is missing")
        if (sh.get("ReferrerPolicy") or {}).get("ReferrerPolicy") != "strict-origin-when-cross-origin":
            problems.append("Referrer-Policy must be strict-origin-when-cross-origin")
        if (sh.get("XSSProtection") or {}).get("Protection") is not False:
            problems.append("X-XSS-Protection must be 0")
        ch = custom_headers(cfg)
        if ch.get("Permissions-Policy") != PERMISSIONS_POLICY:
            problems.append("Permissions-Policy differs from SECURITY-HEADERS.md")
        if ch.get("Cross-Origin-Opener-Policy") != "same-origin-allow-popups":
            problems.append("Cross-Origin-Opener-Policy must be same-origin-allow-popups")
        if ch.get("Cross-Origin-Resource-Policy") != "same-origin":
            problems.append("Cross-Origin-Resource-Policy must be same-origin")
        if "Cross-Origin-Embedder-Policy" in ch:
            problems.append("Cross-Origin-Embedder-Policy must not be sent (it breaks AppKit's wallet images)")
        for p in problems:
            rep.err(f"{n} {logical}", p)
        if not problems:
            rep.ok(f"edge: {logical} sends the header set of SECURITY-HEADERS.md section 1.1")
    api_sh = policy_config(t, "ApiHeadersPolicy").get("SecurityHeadersConfig") or {}
    if set(api_sh) != {"StrictTransportSecurity"} or api_sh["StrictTransportSecurity"].get("Override") is not False:
        rep.err(f"{n} ApiHeadersPolicy", "must only add HSTS with Override false: the API sends its own headers")

    dist = ((t.resources.get("Distribution") or {}).get("Properties") or {}).get("DistributionConfig") or {}
    if dist.get("CustomErrorResponses"):
        rep.err(n, "CustomErrorResponses apply to every behaviour: they would turn the API's 403/404 into index.html")
    else:
        rep.ok("edge: no distribution-wide error rewriting (the API's 403/404 reach the browser)")
    vc = dist.get("ViewerCertificate") or {}
    if vc.get("MinimumProtocolVersion") != "TLSv1.2_2021" or vc.get("SslSupportMethod") != "sni-only":
        rep.err(n, "viewer certificate must be sni-only with TLSv1.2_2021")
    if dist.get("HttpVersion") != "http2and3":
        rep.err(n, "HttpVersion must be http2and3")
    origins = {o.get("Id"): o for o in dist.get("Origins") or []}
    api_o = origins.get("api") or {}
    coc = api_o.get("CustomOriginConfig") or {}
    if coc.get("OriginProtocolPolicy") != "https-only" or coc.get("OriginSSLProtocols") != ["TLSv1.2"]:
        rep.err(n, "the API origin must be https-only with TLSv1.2")
    hdrs = {h.get("HeaderName"): h.get("HeaderValue") for h in api_o.get("OriginCustomHeaders") or []}
    secret_ref = hdrs.get("X-Origin-Verify")
    if not (isinstance(secret_ref, dict) and "Ref" in secret_ref and (t.params.get(secret_ref["Ref"]) or {}).get("NoEcho") is True):
        rep.err(n, "the API origin must send X-Origin-Verify from a NoEcho parameter")
    else:
        rep.ok("edge: /api/* goes to the instance over HTTPS with X-Origin-Verify from a NoEcho parameter")
    site_o = origins.get("site") or {}
    if "OriginAccessControlId" not in site_o:
        rep.err(n, "the site origin must use Origin Access Control")
    behaviours = {b.get("PathPattern"): b for b in dist.get("CacheBehaviors") or []}
    default = dist.get("DefaultCacheBehavior") or {}
    want = {
        "/api/*": ("api", "ApiHeadersPolicy", "ApiCachePolicy"),
        "/assets/*": ("site", "SiteHeadersPolicy", None),
        "/logos/*": ("site", "ImagesHeadersPolicy", "SiteCachePolicy"),
        "/addrbook/*": ("site", "ImagesHeadersPolicy", "SiteCachePolicy"),
        "/scan/*": ("site", "ScanHeadersPolicy", "SiteCachePolicy"),
    }
    for pattern, (origin, headers, cache) in want.items():
        b = behaviours.get(pattern)
        if not b:
            rep.err(n, f"no cache behaviour for {pattern}")
            continue
        if b.get("TargetOriginId") != origin:
            rep.err(n, f"{pattern} must target the {origin} origin")
        if b.get("ResponseHeadersPolicyId") != {"Ref": headers}:
            rep.err(n, f"{pattern} must use {headers}")
        if cache and b.get("CachePolicyId") != {"Ref": cache}:
            rep.err(n, f"{pattern} must use {cache}")
        if b.get("Compress") is not True:
            rep.err(n, f"{pattern} must compress")
    api_b = behaviours.get("/api/*") or {}
    if not set(api_b.get("AllowedMethods") or []) <= {"GET", "HEAD", "OPTIONS"}:
        rep.err(n, "/api/* must allow GET, HEAD and OPTIONS only (every hosted route is a GET)")
    if api_b.get("FunctionAssociations"):
        rep.err(n, "/api/* must not run the SPA rewrite")
    if default.get("TargetOriginId") != "site" or default.get("ResponseHeadersPolicyId") != {"Ref": "SiteHeadersPolicy"}:
        rep.err(n, "the default behaviour must serve the site bucket with SiteHeadersPolicy")
    if not default.get("FunctionAssociations"):
        rep.err(n, "the default behaviour needs the SPA rewrite function")
    api_cache = ((t.resources.get("ApiCachePolicy") or {}).get("Properties") or {}).get("CachePolicyConfig") or {}
    key = api_cache.get("ParametersInCacheKeyAndForwardedToOrigin") or {}
    if (api_cache.get("MinTTL"), api_cache.get("DefaultTTL")) != (0, 0):
        rep.err(n, "ApiCachePolicy must have MinTTL 0 and DefaultTTL 0: only what the origin marks cacheable is cached")
    if (key.get("QueryStringsConfig") or {}).get("QueryStringBehavior") != "all" or "Origin" not in ((key.get("HeadersConfig") or {}).get("Headers") or []):
        rep.err(n, "ApiCachePolicy's key must hold every query string and the Origin header")
    bucket = (t.resources.get("SiteBucket") or {}).get("Properties") or {}
    if set((bucket.get("PublicAccessBlockConfiguration") or {}).values()) != {True}:
        rep.err(n, "the site bucket must block all public access")
    if "WebsiteConfiguration" in bucket:
        rep.err(n, "the site bucket must not be a website endpoint")

    fn = ((t.resources.get("SpaRewriteFunction") or {}).get("Properties") or {}).get("FunctionCode")
    if isinstance(fn, str):
        run_cloudfront_function(fn, rep)


CF_CASES = [
    ("/", "/index.html"), ("/trade", "/index.html"), ("/explore", "/index.html"), ("/scan", "/index.html"),
    ("/portfolio/", "/index.html"), ("/leaderboard", "/index.html"), ("/copy", "/index.html"),
    ("/scan/", "/scan/index.html"), ("/scan/index.html", "/scan/index.html"),
    ("/index.html", "/index.html"), ("/favicon.svg", "/favicon.svg"), ("/robots.txt", "/robots.txt"),
    ("/assets/index-abc123.js", "/assets/index-abc123.js"), ("/logos/BTC.svg", "/logos/BTC.svg"),
    ("/some.thing/deeper", "/index.html"),
]


def run_cloudfront_function(code: str, rep: Report) -> None:
    node = shutil.which("node")
    if not node:
        rep.warn("edge.yaml SpaRewriteFunction", "node is not on PATH: the function was not executed")
        return
    harness = code + "\nconst cases = " + json.dumps(CF_CASES) + ";\n" + (
        "let bad = 0;\n"
        "for (const [uri, want] of cases) {\n"
        "  const req = handler({ request: { uri, querystring: { address: { value: '0xabc' } }, headers: {} } });\n"
        "  if (req.uri !== want || !req.querystring.address) { bad++; console.log(`FAIL ${uri} -> ${req.uri} (want ${want})`); }\n"
        "}\n"
        "process.exit(bad ? 1 : 0);\n"
    )
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "fn.cjs"
        f.write_text(harness, encoding="utf-8")
        out = subprocess.run([node, str(f)], capture_output=True, text=True)
    if out.returncode != 0:
        rep.err("edge.yaml SpaRewriteFunction", "wrong rewrite: " + (out.stdout + out.stderr).strip())
    else:
        rep.ok(f"edge: the SPA rewrite function maps {len(CF_CASES)} sample paths correctly")
    if len(code.encode("utf-8")) > 10 * 1024:
        rep.err("edge.yaml SpaRewriteFunction", "larger than CloudFront's 10 KB limit")


def check_network(t: Template, rep: Report) -> None:
    n = t.name
    sg = (t.resources.get("OriginSecurityGroup") or {}).get("Properties") or {}
    prefix_rules = 0
    for rule in sg.get("SecurityGroupIngress") or []:
        lo, hi = rule.get("FromPort"), rule.get("ToPort")
        if isinstance(lo, int) and isinstance(hi, int) and lo <= 22 <= hi:
            rep.err(n, "the origin security group opens port 22: there is no SSH, access is SSM")
        if lo == 443 and "CidrIp" in rule:
            rep.err(n, "443 must be open to the CloudFront prefix list only, never to a CIDR")
        if "SourcePrefixListId" in rule:
            prefix_rules += 1
        if rule.get("IpProtocol") in (-1, "-1"):
            rep.err(n, "the origin security group must not allow all protocols inbound")
    if prefix_rules != 1:
        rep.err(n, f"exactly one rule may reference the CloudFront prefix list (it weighs 55 of 60 rules); found {prefix_rules}")
    else:
        rep.ok("network: inbound is 443 from the CloudFront prefix list and 80 for ACME; no SSH")
    for name, res in t.resources.items():
        if res.get("Type") in ("AWS::EC2::Instance", "AWS::EC2::NatGateway", "AWS::EC2::EIP", "AWS::ElasticLoadBalancingV2::LoadBalancer",
                               "AWS::EC2::VPCEndpoint"):
            rep.err(n, f"{name} ({res['Type']}) bills by the hour: it belongs in compute.yaml, not in the network stack")
    bucket = (t.resources.get("OpsBucket") or {}).get("Properties") or {}
    if set((bucket.get("PublicAccessBlockConfiguration") or {}).values()) != {True}:
        rep.err(n, "the ops bucket must block all public access")
    rep.ok("network: nothing in the stack bills by the hour")


FAKE_CFNRESPONSE = "SUCCESS = 'SUCCESS'\nFAILED = 'FAILED'\ncalls = []\n" \
    "def send(event, context, status, data, physical=None, noEcho=False, reason=None):\n" \
    "    calls.append({'status': status, 'data': data, 'physical': physical, 'reason': reason})\n"


class FakeEc2:
    def __init__(self, state: str, fail: bool = False) -> None:
        self.state, self.fail, self.log = state, fail, []

    def describe_instances(self, InstanceIds):
        if self.fail:
            raise RuntimeError("describe failed")
        return {"Reservations": [{"Instances": [{"State": {"Name": self.state}}]}]}

    def stop_instances(self, InstanceIds):
        self.log.append("stop")
        self.state = "stopping"

    def start_instances(self, InstanceIds):
        self.log.append("start")
        self.state = "pending"

    def get_waiter(self, name):
        ec2 = self

        class W:
            def wait(self, InstanceIds, WaiterConfig):
                ec2.log.append("wait:" + name)
                ec2.state = {"instance_stopped": "stopped", "instance_running": "running"}[name]
        return W()


def check_compute(t: Template, rep: Report) -> None:
    n = t.name
    instances = [(k, v) for k, v in t.resources.items() if v.get("Type") == "AWS::EC2::Instance"]
    if len(instances) != 1:
        rep.err(n, f"exactly one instance is allowed, found {len(instances)}")
        return
    for forbidden in ("AWS::AutoScaling::AutoScalingGroup", "AWS::EC2::LaunchTemplate", "AWS::EC2::SpotFleet", "AWS::EC2::EC2Fleet"):
        if any(v.get("Type") == forbidden for v in t.resources.values()):
            rep.err(n, f"{forbidden} would create and delete instances; the rule is one fixed instance")
    name, inst = instances[0]
    p = inst.get("Properties") or {}
    if "KeyName" in p:
        rep.err(n, "the instance must not have a key pair: there is no SSH")
    if "UserData" in p:
        rep.err(n, "no UserData: a change to it restarts the instance on a stack update; bootstrap runs through SSM")
    if (p.get("MetadataOptions") or {}).get("HttpTokens") != "required":
        rep.err(n, "IMDSv2 must be required")
    for m in p.get("BlockDeviceMappings") or []:
        if (m.get("Ebs") or {}).get("Encrypted") is not True:
            rep.err(n, "the root volume must be encrypted")
    if "DisableApiTermination" not in p:
        rep.err(n, "set DisableApiTermination")
    if "ImageId" in p and not (isinstance(p["ImageId"], dict) and t.params.get(p["ImageId"].get("Ref"), {}).get("Type") == "AWS::EC2::Image::Id"):
        rep.err(n, "ImageId must be a pinned AWS::EC2::Image::Id parameter (a 'latest' SSM lookup would replace the instance on updates)")
    vols = [v for v in t.resources.values() if v.get("Type") == "AWS::EC2::Volume"]
    if len(vols) != 1 or (vols[0].get("Properties") or {}).get("Encrypted") is not True or vols[0].get("DeletionPolicy") != "Snapshot":
        rep.err(n, "one encrypted data volume with DeletionPolicy Snapshot is expected")
    state = t.params.get("DesiredState") or {}
    if state.get("AllowedValues") != ["running", "stopped"]:
        rep.err(n, "a DesiredState parameter (running | stopped) must exist")
    role = (t.resources.get("InstanceRole") or {}).get("Properties") or {}
    if not any("AmazonSSMManagedInstanceCore" in json.dumps(a) for a in role.get("ManagedPolicyArns") or []):
        rep.err(n, "the instance role needs AmazonSSMManagedInstanceCore (Session Manager is the only way in)")
    if "s3:DeleteObject" in json.dumps(role) or '"s3:*"' in json.dumps(role):
        rep.err(n, "the instance role must not be able to delete backups")
    rep.ok("compute: one instance, no key pair, no UserData, IMDSv2, encrypted volumes, SSM role, pinned AMI")

    code = (((t.resources.get("PowerFunction") or {}).get("Properties") or {}).get("Code") or {}).get("ZipFile")
    if not isinstance(code, str):
        rep.err(n, "PowerFunction has no inline code")
        return
    try:
        compiled = compile(code, "PowerFunction", "exec")
    except SyntaxError as e:
        rep.err(n, f"PowerFunction does not compile: {e}")
        return
    if len(code.encode("utf-8")) > 4096:
        rep.err(n, f"PowerFunction's inline code is {len(code.encode('utf-8'))} bytes (ZipFile limit 4096)")

    def run(event: dict, ec2: FakeEc2):
        fake_boto = types.ModuleType("boto3")
        fake_boto.client = lambda name: ec2  # type: ignore[attr-defined]
        fake_resp = types.ModuleType("cfnresponse")
        exec(FAKE_CFNRESPONSE, fake_resp.__dict__)
        saved = {k: sys.modules.get(k) for k in ("boto3", "cfnresponse")}
        sys.modules["boto3"], sys.modules["cfnresponse"] = fake_boto, fake_resp
        try:
            ns: dict = {}
            with contextlib.redirect_stdout(io.StringIO()):  # the handler logs its failures
                exec(compiled, ns)
                ns["handler"](event, None)
        finally:
            for k, v in saved.items():
                if v is None:
                    sys.modules.pop(k, None)
                else:
                    sys.modules[k] = v
        return fake_resp.calls  # type: ignore[attr-defined]

    def ev(kind: str, want: str = "running") -> dict:
        return {"RequestType": kind, "ResourceProperties": {"InstanceId": "i-test", "DesiredState": want}}

    cases = [
        ("create, already running", ev("Create"), FakeEc2("running"), "SUCCESS", []),
        ("stop a running instance", ev("Update", "stopped"), FakeEc2("running"), "SUCCESS", ["stop", "wait:instance_stopped"]),
        ("start a stopped instance", ev("Update", "running"), FakeEc2("stopped"), "SUCCESS", ["start", "wait:instance_running"]),
        ("stop, already stopped", ev("Update", "stopped"), FakeEc2("stopped"), "SUCCESS", []),
        ("start while it is stopping", ev("Update", "running"), FakeEc2("stopping"), "SUCCESS",
         ["wait:instance_stopped", "start", "wait:instance_running"]),
        ("stop while it is booting", ev("Update", "stopped"), FakeEc2("pending"), "SUCCESS",
         ["wait:instance_running", "stop", "wait:instance_stopped"]),
        ("delete does nothing", ev("Delete", "stopped"), FakeEc2("running"), "SUCCESS", []),
        ("a terminated instance fails cleanly", ev("Update"), FakeEc2("terminated"), "FAILED", []),
        ("an API error fails cleanly", ev("Update"), FakeEc2("running", fail=True), "FAILED", []),
        ("an unknown state is refused", ev("Update", "hibernated"), FakeEc2("running"), "FAILED", []),
    ]
    bad = 0
    for label, event, ec2, want_status, want_log in cases:
        try:
            calls = run(event, ec2)
        except Exception as e:  # the handler must never raise: CloudFormation would wait for the timeout
            rep.err(f"{n} PowerFunction", f"{label}: raised {e!r}")
            bad += 1
            continue
        if len(calls) != 1 or calls[0]["status"] != want_status or ec2.log != want_log:
            rep.err(f"{n} PowerFunction", f"{label}: responses {calls}, EC2 calls {ec2.log} (expected {want_status}, {want_log})")
            bad += 1
        elif not str(calls[0]["physical"]).startswith("power-"):
            rep.err(f"{n} PowerFunction", f"{label}: physical id {calls[0]['physical']!r}")
            bad += 1
        if any(c in ("terminate",) for c in ec2.log):
            rep.err(f"{n} PowerFunction", "must never terminate")
    if "terminate" in code.lower().replace("terminated", ""):
        rep.err(f"{n} PowerFunction", "must not call TerminateInstances")
    if not bad:
        rep.ok(f"compute: the stop/start function behaves in {len(cases)} simulated cases and always answers CloudFormation")


def check_smoke_headers(t: Template, rep: Report, repo: Path) -> None:
    """deploy/smoke serves the local build with the values this template configures."""
    mod = repo / "deploy/smoke/prod-headers.mjs"
    node = shutil.which("node")
    if not mod.exists() or not node:
        rep.warn("deploy/smoke/prod-headers.mjs", "not compared (file or node missing)")
        return
    out = subprocess.run([node, str(mod), "--json"], capture_output=True, text=True)
    if out.returncode != 0:
        rep.err("deploy/smoke/prod-headers.mjs", "did not run: " + out.stderr.strip()[:300])
        return
    smoke = json.loads(out.stdout)
    pairs = [("site", "SiteHeadersPolicy"), ("scan", "ScanHeadersPolicy"), ("images", "ImagesHeadersPolicy")]
    bad = 0
    for key, logical in pairs:
        if smoke["csp"][key] != csp_of(t, logical):
            rep.err("deploy/smoke/prod-headers.mjs", f"the {key} CSP differs from edge.yaml's {logical}")
            bad += 1
    if smoke["headers"].get("Permissions-Policy") != PERMISSIONS_POLICY:
        rep.err("deploy/smoke/prod-headers.mjs", "Permissions-Policy differs from edge.yaml")
        bad += 1
    expect = {
        "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-XSS-Protection": "0",
    }
    for k, v in expect.items():
        if smoke["headers"].get(k) != v:
            rep.err("deploy/smoke/prod-headers.mjs", f"{k} is {smoke['headers'].get(k)!r}, edge.yaml sends {v!r}")
            bad += 1
    if not bad:
        rep.ok("smoke: deploy/smoke serves the build with exactly the headers and CSPs edge.yaml configures")


def check_hosted_routes(rep: Report, repo: Path) -> None:
    """Every route the hosted server answers must sit under the /api/* behaviour."""
    src = (repo / "apps/server/src/hosted.ts").read_text(encoding="utf-8")
    block = re.search(r"export const HOSTED_ROUTES[^=]*=\s*\[(.*?)\n\];", src, re.S)
    routes = re.findall(r"method:\s*'(\w+)',\s*url:\s*'([^']+)'", block.group(1)) if block else []
    if not routes:
        rep.err("apps/server/src/hosted.ts", "could not read HOSTED_ROUTES")
        return
    bad = [f"{m} {u}" for m, u in routes if not u.startswith("/api/") or m not in ("GET", "HEAD")]
    if bad:
        rep.err("edge.yaml", "these hosted routes are not reachable through the /api/* behaviour (GET, HEAD, OPTIONS): " + ", ".join(bad))
    else:
        rep.ok(f"edge: all {len(routes)} hosted routes are GETs under /api/*")


# --- main ----------------------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Offline validation of deploy/aws/*.yaml")
    ap.add_argument("--spec", help="path to CloudFormationResourceSpecification.json (optional)")
    ap.add_argument("--quiet", action="store_true", help="print problems only")
    ap.add_argument("--templates-dir", help=argparse.SUPPRESS)  # the validator's own tests
    args = ap.parse_args()
    tdir = Path(args.templates_dir).resolve() if args.templates_dir else HERE

    rep = Report()
    spec = None
    if args.spec:
        spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
        rep.ok(f"resource specification {spec.get('ResourceSpecificationVersion')} loaded "
               f"({len(spec['ResourceTypes'])} resource types)")

    templates: dict[str, Template] = {}
    for name in TEMPLATES:
        path = tdir / name
        try:
            doc = load_template(path)
        except (yaml.YAMLError, OSError) as e:
            rep.err(name, f"does not parse: {e}")
            continue
        if not isinstance(doc, dict):
            rep.err(name, "is not a mapping")
            continue
        size = len(path.read_bytes())
        if size > 51200:
            rep.warn(name, f"is {size} bytes: over 51,200 it must be deployed from S3 (aws cloudformation deploy --s3-bucket)")
        before = len(rep.errors)
        t = Template(name, doc, rep, spec)
        t.check_structure()
        t.check_intrinsics()
        t.check_spec()
        templates[name] = t
        if len(rep.errors) == before:
            rep.ok(f"{name}: parses ({size} bytes); {len(t.params)} parameters, {len(t.resources)} resources, "
                   f"{len(t.outputs)} outputs; intrinsic functions are well-formed"
                   + ("; every property matches the specification" if spec else ""))

    def guarded(name: str, check, *a) -> None:
        """A template whose shape is wrong was reported above; the project rules then cannot be read."""
        try:
            check(*a)
        except (AttributeError, TypeError, KeyError, IndexError) as e:
            rep.err(name, f"the project rules could not be checked - the template has an unexpected shape ({type(e).__name__}: {e})")

    net, comp, edge = (templates.get(n) for n in TEMPLATES)
    if net:
        guarded("network.yaml", check_network, net, rep)
    if comp:
        guarded("compute.yaml", check_compute, comp, rep)
    if net and comp:
        exports = set()
        for o in net.outputs.values():
            name = (o.get("Export") or {}).get("Name")
            if isinstance(name, dict) and "Fn::Sub" in name:
                exports.add(name["Fn::Sub"].replace("${AWS::StackName}", "${NetworkStackName}"))
        imports = set(re.findall(r"\$\{NetworkStackName\}-[A-Za-z]+", (tdir / "compute.yaml").read_text(encoding="utf-8")))
        missing = imports - exports
        if missing:
            rep.err("compute.yaml", f"imports values network.yaml does not export: {sorted(missing)}")
        else:
            rep.ok(f"compute: its {len(imports)} imports are all exported by network.yaml")
    if edge:
        guarded("edge.yaml", check_edge, edge, rep, REPO)
        guarded("edge.yaml", check_smoke_headers, edge, rep, REPO)
        check_hosted_routes(rep, REPO)
    check_hygiene(rep, tdir if args.templates_dir else HERE.parent)

    if not args.quiet:
        for line in rep.passed:
            print("ok    " + line)
    for line in rep.warnings:
        print("warn  " + line)
    for line in rep.errors:
        print("FAIL  " + line)
    print(f"\n{len(rep.passed)} checks passed, {len(rep.warnings)} warnings, {len(rep.errors)} errors"
          + ("" if spec else "  (run with --spec for property-level checks)"))
    return 1 if rep.errors else 0


if __name__ == "__main__":
    sys.exit(main())
