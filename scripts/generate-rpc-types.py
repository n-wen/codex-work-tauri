#!/usr/bin/env python3
"""Generate Rust RPC method enums and wired Params/Response types from App Server schemas.

Schema is the source of truth. Re-run after:
  codex app-server generate-json-schema --out apps/codex-work/src-tauri/schemas
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / "src-tauri" / "schemas"
OUT = ROOT / "src-tauri" / "src" / "app_server" / "generated"

RUST_KEYWORDS = {
    "type", "match", "ref", "move", "box", "async", "await", "try", "self",
    "Self", "crate", "super", "mod", "use", "pub", "fn", "let", "mut", "const",
    "enum", "struct", "trait", "impl", "where", "dyn", "true", "false", "as",
    "if", "else", "loop", "while", "for", "in", "return", "break", "continue",
    "yield", "union", "static", "unsafe", "extern", "virtual", "become",
}

# Codex `generate-json-schema` currently drops experimental `dynamicTools` from
# extracted v2 ThreadStart/Resume *properties* (the type remains in definitions).
# Re-add the property on those JSON files after a schema refresh so generated
# structs still match the locked CLI.
WIRED_PARAM_SCHEMAS = [
    ("v1/InitializeParams.json", "initialize_params"),
    ("v2/ConfigReadParams.json", "config_read_params"),
    ("v2/ConfigValueWriteParams.json", "config_value_write_params"),
    ("v2/ThreadStartParams.json", "thread_start_params"),
    ("v2/ThreadResumeParams.json", "thread_resume_params"),
    ("v2/TurnStartParams.json", "turn_start_params"),
    ("v2/TurnInterruptParams.json", "turn_interrupt_params"),
    ("v2/ThreadListParams.json", "thread_list_params"),
    ("v2/ThreadReadParams.json", "thread_read_params"),
    ("v2/ThreadSetNameParams.json", "thread_set_name_params"),
    ("DynamicToolCallParams.json", "dynamic_tool_call_params"),
]

WIRED_RESPONSE_SCHEMAS = [
    ("CommandExecutionRequestApprovalResponse.json", "command_execution_approval_response"),
    ("FileChangeRequestApprovalResponse.json", "file_change_approval_response"),
    ("DynamicToolCallResponse.json", "dynamic_tool_call_response"),
]

WIRED_NOTIFICATION_SCHEMAS = [
    ("v2/AgentMessageDeltaNotification.json", "agent_message_delta_notification"),
]


def rust_ident(name: str) -> str:
    s = re.sub(r"[^0-9A-Za-z_]", "_", name)
    s = re.sub(r"_+", "_", s).strip("_")
    if not s:
        s = "value"
    if s[0].isdigit():
        s = f"n_{s}"
    if s in RUST_KEYWORDS:
        return f"r#{s}"
    return s


def camel_to_pascal(method: str) -> str:
    parts = re.split(r"[^0-9A-Za-z]+", method)
    return "".join(p[:1].upper() + p[1:] if p else "" for p in parts)


def extract_methods(schema_path: Path) -> list[str]:
    data = json.loads(schema_path.read_text())
    methods = []
    for item in data.get("oneOf", []):
        enum = item.get("properties", {}).get("method", {}).get("enum", [])
        if enum:
            methods.append(enum[0])
    return methods


def emit_method_enum(name: str, methods: list[str]) -> str:
    variants = []
    as_str_arms = []
    from_str_arms = []
    all_vars = []
    for m in methods:
        var = camel_to_pascal(m)
        variants.append(f"    {var},")
        as_str_arms.append(f'            Self::{var} => "{m}",')
        from_str_arms.append(f'            "{m}" => Some(Self::{var}),')
        all_vars.append(f"        Self::{var},")
    return f"""#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum {name} {{
{chr(10).join(variants)}
}}

impl {name} {{
    pub const ALL: &'static [Self] = &[
{chr(10).join(all_vars)}
    ];

    pub fn as_str(self) -> &'static str {{
        match self {{
{chr(10).join(as_str_arms)}
        }}
    }}

    pub fn from_method(value: &str) -> Option<Self> {{
        match value {{
{chr(10).join(from_str_arms)}
            _ => None,
        }}
    }}
}}

impl AsRef<str> for {name} {{
    fn as_ref(&self) -> &str {{
        self.as_str()
    }}
}}

impl std::fmt::Display for {name} {{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {{
        f.write_str(self.as_str())
    }}
}}
"""


class RustModule:
    def __init__(self, root: dict):
        self.root = root
        self.defs = dict(root.get("definitions") or {})
        self.emitted: dict[str, str] = {}
        self.order: list[str] = []
        self.anon = 0

    def def_of(self, name: str) -> dict:
        return self.defs[name]

    def fresh(self, hint: str) -> str:
        self.anon += 1
        return camel_to_pascal(f"{hint}_{self.anon}")

    def rust_type(self, schema: dict | bool, hint: str) -> str:
        if schema is True or schema == {}:
            return "serde_json::Value"
        if schema is False:
            return "serde_json::Value"
        if not isinstance(schema, dict):
            return "serde_json::Value"
        if "$ref" in schema:
            ref = schema["$ref"]
            name = ref.split("/")[-1]
            self.ensure_def(name)
            return name
        if "allOf" in schema:
            parts = [p for p in schema["allOf"] if p != {}]
            if len(parts) == 1:
                return self.rust_type(parts[0], hint)
            merged = {"type": "object", "properties": {}, "required": []}
            for p in parts:
                if "$ref" in p:
                    p = self.def_of(p["$ref"].split("/")[-1])
                merged["properties"].update(p.get("properties") or {})
                merged["required"] = list(
                    dict.fromkeys(merged["required"] + (p.get("required") or []))
                )
            return self.ensure_named_object(hint, merged)
        if "anyOf" in schema:
            return self.union_type(schema["anyOf"], hint)
        if "oneOf" in schema:
            return self.union_type(schema["oneOf"], hint)
        types = schema.get("type")
        if isinstance(types, list):
            non_null = [t for t in types if t != "null"]
            if schema.get("enum") and "string" in non_null:
                inner = self.ensure_named_enum(hint, schema["enum"])
                return f"Option<{inner}>" if "null" in types else inner
            if len(non_null) == 1:
                inner = self.rust_type({**schema, "type": non_null[0]}, hint)
                return f"Option<{inner}>" if "null" in types else inner
            return "serde_json::Value"
        if types == "string":
            if "enum" in schema:
                return self.ensure_named_enum(hint, schema["enum"])
            return "String"
        if types == "boolean":
            return "bool"
        if types == "integer":
            fmt = schema.get("format", "")
            if fmt in ("uint32",):
                return "u32"
            if fmt in ("uint16",):
                return "u16"
            if fmt in ("int64",):
                return "i64"
            if fmt in ("uint64", "uint"):
                return "u64"
            return "i64"
        if types == "number":
            return "f64"
        if types == "array":
            items = schema.get("items", True)
            inner = self.rust_type(items, hint.rstrip("s") if hint.endswith("s") else hint + "Item")
            return f"Vec<{inner}>"
        if types == "object" or "properties" in schema:
            return self.ensure_named_object(hint, schema)
        if "enum" in schema:
            return self.ensure_named_enum(hint, schema["enum"])
        return "serde_json::Value"

    def union_type(self, variants: list, hint: str) -> str:
        variants = [v for v in variants if v is not False]
        non_null = []
        has_null = False
        for v in variants:
            if v == {"type": "null"} or v.get("type") == "null":
                has_null = True
            else:
                non_null.append(v)
        if len(non_null) == 1:
            inner = self.rust_type(non_null[0], hint)
            return f"Option<{inner}>" if has_null else inner
        name = hint if hint[0].isupper() else camel_to_pascal(hint)
        self.ensure_union(name, non_null)
        return f"Option<{name}>" if has_null else name

    def ensure_def(self, name: str) -> None:
        if name in self.emitted:
            return
        self.emitted[name] = ""  # cycle guard
        schema = self.def_of(name)
        self.emitted[name] = self.render_named(name, schema)
        self.order.append(name)

    def ensure_named_enum(self, hint: str, values: list[str]) -> str:
        name = hint if hint[0].isupper() else camel_to_pascal(hint)
        if name not in self.emitted:
            self.emitted[name] = self.render_string_enum(name, values)
            self.order.append(name)
        return name

    def ensure_named_object(self, hint: str, schema: dict) -> str:
        name = hint if hint and hint[0].isupper() else camel_to_pascal(hint or self.fresh("Anon"))
        if name in self.emitted:
            return name
        self.emitted[name] = ""
        self.emitted[name] = self.render_struct(name, schema)
        self.order.append(name)
        return name

    def ensure_union(self, name: str, variants: list) -> None:
        if name in self.emitted:
            return
        self.emitted[name] = ""
        self.emitted[name] = self.render_union(name, variants)
        self.order.append(name)

    def render_named(self, name: str, schema: dict) -> str:
        if schema.get("type") == "string" and "enum" in schema:
            return self.render_string_enum(name, schema["enum"])
        if schema.get("type") == "string":
            return f"pub type {name} = String;\n"
        if schema.get("type") == "object" or "properties" in schema:
            return self.render_struct(name, schema)
        if "oneOf" in schema or "anyOf" in schema:
            vs = schema.get("oneOf") or schema.get("anyOf")
            return self.render_union(name, [v for v in vs if v != {"type": "null"}])
        if "enum" in schema:
            return self.render_string_enum(name, schema["enum"])
        return f"pub type {name} = serde_json::Value;\n"

    def render_string_enum(self, name: str, values: list[str]) -> str:
        arms = []
        for v in values:
            var = camel_to_pascal(v.replace("-", "_").replace("/", "_"))
            if var[0].isdigit():
                var = f"N{var}"
            arms.append(f'    #[serde(rename = "{v}")]\n    {var},')
        return f"""#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum {name} {{
{chr(10).join(arms)}
}}
"""

    def render_struct(self, name: str, schema: dict) -> str:
        props = schema.get("properties") or {}
        required = set(schema.get("required") or [])
        fields = []
        for key, ps in props.items():
            ty = self.rust_type(ps if isinstance(ps, dict) or isinstance(ps, bool) else True, camel_to_pascal(key))
            ident = rust_ident(re.sub(r"([a-z])([A-Z])", r"\1_\2", key).replace("-", "_").lower())
            is_opt = False
            if key not in required:
                if not ty.startswith("Option<"):
                    ty = f"Option<{ty}>"
                is_opt = True
            elif ty.startswith("Option<"):
                is_opt = True
            attrs = [f'rename = "{key}"']
            if is_opt:
                attrs.append("default")
                attrs.append("skip_serializing_if = \"Option::is_none\"")
            elif ty.startswith("Vec<") and isinstance(ps, dict) and ps.get("default") == []:
                attrs.append("default")
                attrs.append("skip_serializing_if = \"Vec::is_empty\"")
            fields.append(
                f"    #[serde({', '.join(attrs)})]\n    pub {ident}: {ty},"
            )
        extra = ""
        if schema.get("additionalProperties") is True:
            fields.append(
                '    #[serde(flatten)]\n    pub extra: std::collections::BTreeMap<String, serde_json::Value>,'
            )
        derives = "Debug, Clone, PartialEq, Serialize, Deserialize"
        if fields and all("Option<" in f or "BTreeMap" in f for f in fields):
            derives += ", Default"
        return f"""#[derive({derives})]
pub struct {name} {{
{chr(10).join(fields) if fields else "    #[serde(flatten)]\n    pub extra: serde_json::Value,"}
}}
"""

    def tagged_type_field(self, variant: dict) -> str | None:
        if variant.get("type") != "object":
            return None
        props = variant.get("properties") or {}
        t = props.get("type")
        if isinstance(t, dict) and t.get("type") == "string" and t.get("enum") and len(t["enum"]) == 1:
            return t["enum"][0]
        return None

    def render_union(self, name: str, variants: list) -> str:
        tagged = [self.tagged_type_field(v) for v in variants]
        if variants and all(t is not None for t in tagged):
            return self.render_internally_tagged(name, variants, tagged)
        string_vals: list[str] = []
        objects: list[dict] = []
        primitives: list[str] = []
        for i, v in enumerate(variants):
            if v.get("type") == "string" and "enum" in v:
                string_vals.extend(v["enum"])
            elif v.get("type") == "object":
                objects.append(v)
            elif v.get("type") == "string":
                primitives.append(f"    String(String),")
            elif v.get("type") == "array":
                inner = self.rust_type(v.get("items", True), name + "Item")
                primitives.append(f"    Array(Vec<{inner}>),")
            elif v.get("type") == "boolean":
                primitives.append("    Bool(bool),")
            elif v.get("type") == "integer":
                primitives.append("    Int(i64),")
            elif "$ref" in v:
                ty = self.rust_type(v, name)
                primitives.append(f"    Ref{i}({ty}),")
            else:
                objects.append(v)
        items = []
        if string_vals:
            lit = f"{name}Literal"
            self.ensure_named_enum(lit, string_vals)
            items.append(f"    {lit}({lit}),")
        items.extend(primitives)
        for v in objects:
            if not isinstance(v, dict) or v.get("type") != "object":
                continue
            title = v.get("title") or self.fresh(name)
            self.ensure_named_object(title, v)
            items.append(f"    {title}({title}),")
        if not items:
            items.append("    Value(serde_json::Value),")
        return f"""#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum {name} {{
{chr(10).join(items)}
}}
"""

    def render_internally_tagged(self, name: str, variants: list, tags: list[str]) -> str:
        items = []
        for v, tag in zip(variants, tags):
            var = camel_to_pascal(tag)
            props = dict(v.get("properties") or {})
            props.pop("type", None)
            required = [r for r in (v.get("required") or []) if r != "type"]
            fields = []
            for key, ps in props.items():
                ty = self.rust_type(ps, camel_to_pascal(key))
                ident = rust_ident(re.sub(r"([a-z])([A-Z])", r"\1_\2", key).replace("-", "_").lower())
                is_opt = key not in required
                if is_opt and not ty.startswith("Option<"):
                    ty = f"Option<{ty}>"
                attrs = [f'rename = "{key}"']
                if is_opt:
                    attrs.append("default")
                    attrs.append("skip_serializing_if = \"Option::is_none\"")
                fields.append(f"        #[serde({', '.join(attrs)})]\n        {ident}: {ty},")
            if fields:
                items.append(
                    f'    #[serde(rename = "{tag}")]\n    {var} {{\n' + "\n".join(fields) + "\n    },"
                )
            else:
                items.append(f'    #[serde(rename = "{tag}")]\n    {var},')
        return f"""#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum {name} {{
{chr(10).join(items)}
}}
"""

    def render_root(self, title: str) -> str:
        root_schema = {k: v for k, v in self.root.items() if k != "definitions"}
        body = self.render_named(title, root_schema)
        if title not in self.emitted:
            self.emitted[title] = body
            self.order.append(title)
        chunks = [
            "// @generated by apps/codex-work/scripts/generate-rpc-types.py. Do not edit.",
            "#![allow(dead_code)]",
            "use serde::{Deserialize, Serialize};",
            "",
        ]
        seen = set()
        for n in self.order:
            if n in seen:
                continue
            seen.add(n)
            chunks.append(self.emitted[n].rstrip() + "\n")
        return "\n".join(chunks)


def write_module(rel_schema: str, mod_name: str) -> None:
    path = SCHEMAS / rel_schema
    data = json.loads(path.read_text())
    title = data.get("title") or camel_to_pascal(mod_name)
    gen = RustModule(data)
    text = gen.render_root(title)
    (OUT / f"{mod_name}.rs").write_text(text)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    client_req = extract_methods(SCHEMAS / "ClientRequest.json")
    client_note = extract_methods(SCHEMAS / "ClientNotification.json")
    server_note = extract_methods(SCHEMAS / "ServerNotification.json")
    server_req = extract_methods(SCHEMAS / "ServerRequest.json")

    methods_rs = """// @generated by apps/codex-work/scripts/generate-rpc-types.py. Do not edit.
// Source: src-tauri/schemas/{ClientRequest,ClientNotification,ServerNotification,ServerRequest}.json
#![allow(dead_code)]

"""
    methods_rs += emit_method_enum("ClientRequestMethod", client_req)
    methods_rs += emit_method_enum("ClientNotificationMethod", client_note)
    methods_rs += emit_method_enum("ServerNotificationMethod", server_note)
    methods_rs += emit_method_enum("ServerRequestMethod", server_req)
    methods_rs += f"""
#[cfg(test)]
mod tests {{
    use super::*;

    #[test]
    fn method_counts_match_schema() {{
        assert_eq!(ClientRequestMethod::ALL.len(), {len(client_req)});
        assert_eq!(ClientNotificationMethod::ALL.len(), {len(client_note)});
        assert_eq!(ServerNotificationMethod::ALL.len(), {len(server_note)});
        assert_eq!(ServerRequestMethod::ALL.len(), {len(server_req)});
    }}

    #[test]
    fn method_as_str_roundtrips() {{
        for m in ClientRequestMethod::ALL {{
            assert_eq!(ClientRequestMethod::from_method(m.as_str()), Some(*m));
        }}
        for m in ClientNotificationMethod::ALL {{
            assert_eq!(ClientNotificationMethod::from_method(m.as_str()), Some(*m));
        }}
        for m in ServerNotificationMethod::ALL {{
            assert_eq!(ServerNotificationMethod::from_method(m.as_str()), Some(*m));
        }}
        for m in ServerRequestMethod::ALL {{
            assert_eq!(ServerRequestMethod::from_method(m.as_str()), Some(*m));
        }}
    }}
}}
"""
    (OUT / "methods.rs").write_text(methods_rs)

    mods = ["methods"]
    for rel, mod_name in WIRED_PARAM_SCHEMAS + WIRED_RESPONSE_SCHEMAS + WIRED_NOTIFICATION_SCHEMAS:
        write_module(rel, mod_name)
        mods.append(mod_name)

    mod_rs = "// @generated by apps/codex-work/scripts/generate-rpc-types.py. Do not edit.\n\n"
    for m in mods:
        mod_rs += f"pub mod {m};\n"
    mod_rs += """
pub use methods::{
    ClientNotificationMethod, ClientRequestMethod, ServerNotificationMethod, ServerRequestMethod,
};
"""
    (OUT / "mod.rs").write_text(mod_rs)
    print(f"wrote {len(mods)} modules to {OUT}")
    print(f"  ClientRequest={len(client_req)} ClientNotification={len(client_note)} ServerNotification={len(server_note)} ServerRequest={len(server_req)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
