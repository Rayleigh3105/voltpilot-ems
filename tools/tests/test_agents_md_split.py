"""Regressionen: python3 -m unittest discover -s tools/tests -p 'test_*.py'."""
import contextlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "agents_md_split", Path(__file__).resolve().parents[1] / "agents-md-split.py")
split = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(split)


class AgentsSplitTest(unittest.TestCase):
    def test_translated_title_preserves_filename_and_collision_suffix(self):
        taken = set()
        self.assertEqual(split.slugify("Was das ist", taken), "what-this-is")
        self.assertEqual(split.slugify("What this is", taken), "what-this-is-2")
        self.assertEqual(split.slugify("Größe & Richtung", taken), "groesse-richtung")

    def verify_fixture(self, source, target):
        def read(revision, path):
            if (revision, path) == ("before", "AGENTS.md"):
                return source
            self.assertEqual((revision, path),
                             ("after", "docs/agents/root/what-this-is.md"))
            return "# What this is\n\nHerkunft\n\n" + target

        with patch.object(split, "AREAS", [("AGENTS.md", "root", 42, ())]), \
                patch.object(split, "revision_text", side_effect=read), \
                contextlib.redirect_stdout(io.StringIO()):
            return split.verify("before", "after")

    def test_verify_reads_explicit_revisions_and_stable_filename(self):
        self.assertEqual(self.verify_fixture("## Was das ist\nText\n", "Text\n"), 0)

    def test_verify_rejects_changed_text(self):
        self.assertEqual(self.verify_fixture("## Was das ist\nText\n", "Anders\n"), 1)

    def test_verify_rejects_already_split_source(self):
        with self.assertRaisesRegex(ValueError, "bereits ein Wegweiser"):
            self.verify_fixture(split.MARKER + "\n", "")


if __name__ == "__main__":
    unittest.main()
