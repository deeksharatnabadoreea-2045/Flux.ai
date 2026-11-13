#!/usr/bin/env python3
"""Evidence gate for molecules that naturally occur in humans.

PubChem remains the compound identity source. This module only decides whether
Flux should display a compound, using ChEBI (via PubChem CHEBI synonyms) and
HMDB IDs annotated on the PubChem record. Fail closed when evidence is missing.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

PUBCHEM_SYNONYMS_URL = (
    "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/{cid}/synonyms/JSON"
)
PUBCHEM_HMDB_ID_URL = (
    "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/{cid}/JSON"
    "?heading=HMDB%20ID"
)
CHEBI_COMPOUND_URL = (
    "https://www.ebi.ac.uk/chebi/backend/api/public/compound/{id}/"
)

HUMAN_METABOLITE_ROLE_RE = re.compile(r"human.*metabolite|metabolite.*human", re.I)
MAMMALIAN_PROXY_ROLES = frozenset(
    {
        "fundamental metabolite",
        "mammalian metabolite",
        "mouse metabolite",
        "rat metabolite",
    }
)
MAX_CHEBI_LOOKUPS = 6
USER_AGENT = "Flux.ai-human-molecule/1.0"


def _get_json(url: str) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=45) as response:
        return json.load(response)


def fetch_chebi_ids_for_cid(cid: int | str) -> list[str]:
    url = PUBCHEM_SYNONYMS_URL.format(cid=urllib.parse.quote(str(cid)))
    try:
        data = _get_json(url)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return []
        raise
    synonyms = data.get("InformationList", {}).get("Information", [{}])[0].get("Synonym", [])
    ids: list[str] = []
    seen: set[str] = set()
    for syn in synonyms:
        match = re.match(r"^CHEBI:(\d+)$", str(syn), flags=re.I)
        if not match or match.group(1) in seen:
            continue
        seen.add(match.group(1))
        ids.append(match.group(1))
    return ids


def _walk_strings(node: Any, out: list[str]) -> None:
    if isinstance(node, str):
        out.append(node)
        return
    if isinstance(node, list):
        for child in node:
            _walk_strings(child, out)
        return
    if isinstance(node, dict):
        for value in node.values():
            _walk_strings(value, out)


def fetch_hmdb_ids_for_cid(cid: int | str) -> list[str]:
    url = PUBCHEM_HMDB_ID_URL.format(cid=urllib.parse.quote(str(cid)))
    try:
        data = _get_json(url)
    except urllib.error.HTTPError as exc:
        if exc.code in (400, 404):
            return []
        raise
    strings: list[str] = []
    _walk_strings(data, strings)
    ids: list[str] = []
    seen: set[str] = set()
    for value in strings:
        match = re.match(r"^(HMDB\d+)$", value, flags=re.I)
        if not match:
            continue
        normalized = match.group(1).upper()
        # Keep canonical HMDB prefix casing.
        normalized = "HMDB" + normalized[4:]
        if normalized in seen:
            continue
        seen.add(normalized)
        ids.append(normalized)
    return ids


def _walk_role_names(node: Any, out: list[str]) -> None:
    if node is None:
        return
    if isinstance(node, list):
        for child in node:
            _walk_role_names(child, out)
        return
    if isinstance(node, dict):
        name = node.get("name")
        if isinstance(name, str) and name.strip():
            out.append(name.strip())
        for value in node.values():
            if isinstance(value, (dict, list)):
                _walk_role_names(value, out)


def _is_homo_sapiens_origin(origin: dict[str, Any]) -> bool:
    species = str(origin.get("species_text") or "").strip().lower()
    accession = str(origin.get("species_accession") or "").strip()
    return (
        species in {"homo sapiens", "human"}
        or accession == "9606"
        or accession.endswith(":9606")
    )


def extract_chebi_human_signals(record: dict[str, Any], chebi_id: str) -> dict[str, Any]:
    role_names: list[str] = []
    _walk_role_names(record.get("roles_classification"), role_names)
    human_roles = [name for name in role_names if HUMAN_METABOLITE_ROLE_RE.search(name)]
    proxy_roles = [name for name in role_names if name.lower() in MAMMALIAN_PROXY_ROLES]
    human_origin_sources = []
    for origin in record.get("compound_origins") or []:
        if not isinstance(origin, dict) or not _is_homo_sapiens_origin(origin):
            continue
        human_origin_sources.append(
            {
                "species": str(origin.get("species_text") or "Homo sapiens"),
                "source": str(origin.get("source") or ""),
                "source_accession": str(origin.get("source_accession") or ""),
                "chebi_id": str(chebi_id),
            }
        )
    return {
        "human_roles": human_roles,
        "proxy_roles": proxy_roles,
        "human_origin_sources": human_origin_sources,
    }


def fetch_chebi_compound(chebi_id: str) -> dict[str, Any]:
    url = CHEBI_COMPOUND_URL.format(id=urllib.parse.quote(str(chebi_id)))
    return _get_json(url)


def evaluate_human_occurrence(
    *,
    hmdb_ids: list[str] | None = None,
    chebi_ids: list[str] | None = None,
    chebi_signals: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    hmdb_ids = list(dict.fromkeys(hmdb_ids or []))
    chebi_ids = list(dict.fromkeys(chebi_ids or []))
    signals = chebi_signals or []

    human_roles = list(
        dict.fromkeys(role for signal in signals for role in signal.get("human_roles") or [])
    )
    proxy_roles = list(
        dict.fromkeys(role for signal in signals for role in signal.get("proxy_roles") or [])
    )
    human_origin_sources = [
        origin
        for signal in signals
        for origin in signal.get("human_origin_sources") or []
    ]

    chebi_human = bool(human_roles or human_origin_sources)
    hmdb_with_proxy = bool(hmdb_ids) and bool(proxy_roles)
    occurs = chebi_human or hmdb_with_proxy

    if chebi_human and hmdb_with_proxy:
        reason = "chebi_human_and_hmdb_mammalian_proxy"
    elif chebi_human:
        reason = "chebi_human"
    elif hmdb_with_proxy:
        reason = "hmdb_and_mammalian_proxy"
    else:
        reason = "insufficient_evidence"

    return {
        "occurs_in_humans": occurs,
        "reason": reason,
        "hmdb_ids": hmdb_ids,
        "chebi_ids": chebi_ids,
        "human_roles": human_roles,
        "proxy_roles": proxy_roles,
        "human_origin_sources": human_origin_sources,
    }


def verify_human_occurrence(cid: int | str) -> dict[str, Any]:
    chebi_ids = fetch_chebi_ids_for_cid(cid)
    hmdb_ids = fetch_hmdb_ids_for_cid(cid)
    chebi_signals: list[dict[str, Any]] = []
    for chebi_id in chebi_ids[:MAX_CHEBI_LOOKUPS]:
        try:
            record = fetch_chebi_compound(chebi_id)
            chebi_signals.append(extract_chebi_human_signals(record, chebi_id))
        except urllib.error.HTTPError:
            continue
        except urllib.error.URLError:
            continue
    return evaluate_human_occurrence(
        hmdb_ids=hmdb_ids,
        chebi_ids=chebi_ids,
        chebi_signals=chebi_signals,
    )
