#!/usr/bin/env python3
"""Look up a molecule's formula and molecular weight on PubChem."""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request

PUBCHEM_URL = (
    "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/"
    "{name}/property/MolecularFormula,MolecularWeight/JSON"
)


def lookup_molecule(name: str) -> None:
    """Fetch and print MolecularFormula + MolecularWeight for a compound name."""
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
    print(f"{name}: formula={formula}, molecular_weight={weight}")


if __name__ == "__main__":
    molecule = sys.argv[1] if len(sys.argv) > 1 else "aspirin"
    lookup_molecule(molecule)
