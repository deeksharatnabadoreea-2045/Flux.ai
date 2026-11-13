#!/usr/bin/env python3
"""Unit tests for human_molecule evidence evaluation (no network)."""

from __future__ import annotations

import unittest

from human_molecule import evaluate_human_occurrence, extract_chebi_human_signals


class HumanMoleculeTests(unittest.TestCase):
    def test_chebi_human_role(self) -> None:
        result = evaluate_human_occurrence(
            chebi_ids=["15377"],
            chebi_signals=[
                {
                    "human_roles": ["human metabolite"],
                    "proxy_roles": [],
                    "human_origin_sources": [],
                }
            ],
        )
        self.assertTrue(result["occurs_in_humans"])
        self.assertEqual(result["reason"], "chebi_human")

    def test_hmdb_plus_proxy(self) -> None:
        result = evaluate_human_occurrence(
            hmdb_ids=["HMDB0000538"],
            chebi_ids=["15422"],
            chebi_signals=[
                {
                    "human_roles": [],
                    "proxy_roles": ["fundamental metabolite"],
                    "human_origin_sources": [],
                }
            ],
        )
        self.assertTrue(result["occurs_in_humans"])
        self.assertEqual(result["reason"], "hmdb_and_mammalian_proxy")

    def test_hmdb_only_rejected(self) -> None:
        result = evaluate_human_occurrence(
            hmdb_ids=["HMDB0001879"],
            chebi_ids=["15365"],
            chebi_signals=[
                {
                    "human_roles": [],
                    "proxy_roles": [],
                    "human_origin_sources": [],
                }
            ],
        )
        self.assertFalse(result["occurs_in_humans"])
        self.assertEqual(result["reason"], "insufficient_evidence")

    def test_extract_signals(self) -> None:
        signals = extract_chebi_human_signals(
            {
                "roles_classification": {
                    "name": "role",
                    "children": [{"name": "human blood serum metabolite"}],
                },
                "compound_origins": [
                    {
                        "species_text": "Homo sapiens",
                        "species_accession": "9606",
                        "source": "DOI",
                        "source_accession": "10.1/test",
                    }
                ],
            },
            "27732",
        )
        self.assertEqual(signals["human_roles"], ["human blood serum metabolite"])
        self.assertEqual(len(signals["human_origin_sources"]), 1)


if __name__ == "__main__":
    raise SystemExit(unittest.main())
