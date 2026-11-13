#!/usr/bin/env python3
"""Look up a molecule on PubChem and admit it only with human-occurrence evidence."""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from human_molecule import verify_human_occurrence  # noqa: E402

PUBCHEM_URL = (
    "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/"
    "{name}/property/MolecularFormula,MolecularWeight/JSON"
)


def lookup_molecule(name: str, *, require_human_occurrence: bool = True) -> None:
    """Fetch MolecularFormula + MolecularWeight; optionally gate on human evidence."""
    url = PUBCHEM_URL.format(name=urllib.parse.quote(name))
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            data = json.load(response)
    except urllib.error.HTTPError as exc:
        print(f"PubChem lookup failed for {name!r}: HTTP {exc.code}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as exc:
        print(f"PubChem lookup failed for {name!r}: {exc.reason}", file=sys.stderr)
        sys.exit(1)

    props = data["PropertyTable"]["Properties"][0]
    formula = props["MolecularFormula"]
    weight = props["MolecularWeight"]
    cid = props["CID"]

    if not require_human_occurrence:
        print(f"{name}: formula={formula}, molecular_weight={weight}, cid={cid}")
        return

    try:
        evidence = verify_human_occurrence(cid)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        print(
            f"Found {name!r} in PubChem (CID {cid}), but could not verify human occurrence: {exc}",
            file=sys.stderr,
        )
        sys.exit(2)

    if not evidence["occurs_in_humans"]:
        print(
            f"{name!r} is in PubChem (CID {cid}) but is not included in the human molecule "
            "library: no reliable ChEBI/HMDB evidence that it occurs naturally in humans.",
            file=sys.stderr,
        )
        sys.exit(3)

    hmdb = ",".join(evidence["hmdb_ids"]) or "-"
    chebi = ",".join(f"CHEBI:{c}" for c in evidence["chebi_ids"][:4]) or "-"
    print(
        f"{name}: formula={formula}, molecular_weight={weight}, cid={cid}, "
        f"human_evidence={evidence['reason']}, hmdb={hmdb}, chebi={chebi}"
    )


if __name__ == "__main__":
    molecule = sys.argv[1] if len(sys.argv) > 1 else "water"
    raw = "--raw" in sys.argv[2:]
    lookup_molecule(molecule, require_human_occurrence=not raw)
