"""Value suggestions and unanalyzed filters; temporary fixtures only."""
import sqlite3
import time
import unittest
from unittest.mock import patch

from data_overview import FieldSpec, build_field_specs, compile_filter_group
import test_overview_media as fixtures


def unanalyzed_rule(field="semantic_analysis_count"):
    conclusion = field.replace("semantic_analysis_count", "analysis_is_negative")
    return {"logic": "and", "children": [
        {"logic": "or", "children": [
            {"field": field, "operator": "is_empty"},
            {"field": field, "operator": "eq", "value": 0},
        ]},
        {"field": conclusion, "operator": "is_empty"},
    ]}


class FilterValuesTests(unittest.TestCase):
    setUp = fixtures.OverviewMediaTests.setUp
    note = fixtures.OverviewMediaTests.note
    comment = fixtures.OverviewMediaTests.comment

    def populate(self):
        self.note(payload={"likeCount": 12, "publishedTime": {"value": "2026-08-01"}})
        self.comment(payload={"publishedTime": {"value": "2026-08-02"}})
        self.store._data_overview_approved_tokens["approved"] = time.time()

    def test_endpoint_accepts_all_filterable_fields_without_schema_suggestion_requirement(self):
        self.populate()
        with self.store._session() as db:
            fields = {dataset: build_field_specs(db, dataset) for dataset in ("notes", "comments")}
        with patch.object(self.store, "_data_overview_snapshot_token", return_value="approved"):
            for dataset, specs in fields.items():
                for spec in specs:
                    with self.subTest(dataset=dataset, field=spec.key):
                        request = {"dataset": dataset, "snapshotToken": "approved", "field": spec.key}
                        if spec.filterable:
                            result = self.store.data_overview_values(request)
                            self.assertTrue(result["ok"])
                            self.assertTrue(result["consistentSnapshot"])
                        else:
                            with self.assertRaises(ValueError):
                                self.store.data_overview_values(request)

    def test_zero_is_selectable_and_unanalyzed_for_notes_comments_and_joined_posts(self):
        self.populate()
        with patch.object(self.store, "_data_overview_snapshot_token", return_value="approved"):
            for dataset, field in (("notes", "semantic_analysis_count"), ("comments", "semantic_analysis_count"), ("comments", "post__semantic_analysis_count")):
                with self.subTest(dataset=dataset, field=field):
                    result = self.store.data_overview_values({"dataset": dataset, "snapshotToken": "approved", "field": field})
                    self.assertEqual([{"value": 0, "label": "0", "count": 1}], result["values"])
                    result = self.store.query_data_overview({"dataset": dataset, "snapshotToken": "approved", "filter": unanalyzed_rule(field)})
                    self.assertEqual(1, result["total"])

    def test_values_keep_numeric_type_and_search_treats_wildcards_literally(self):
        self.populate()
        with patch.object(self.store, "_data_overview_snapshot_token", return_value="approved"):
            result = self.store.data_overview_values({"dataset": "notes", "snapshotToken": "approved", "field": "source_like_count"})
            self.assertEqual(12, result["values"][0]["value"])
            result = self.store.data_overview_values({"dataset": "notes", "snapshotToken": "approved", "field": "title", "search": "%"})
            self.assertEqual([], result["values"])


class UnanalyzedCountTests(unittest.TestCase):
    def test_null_empty_and_zero_match_but_analyzed_records_do_not(self):
        with sqlite3.connect(":memory:") as db:
            # Nullable legacy fixture; current schema is NOT NULL DEFAULT 0.
            db.execute("CREATE TABLE samples(id TEXT, semantic_analysis_count INTEGER, conclusion TEXT)")
            db.executemany("INSERT INTO samples VALUES(?,?,?)", [
                ("null", None, ""), ("empty", "", ""), ("spaces", "   ", ""),
                ("zero", 0, ""), ("text_zero", "0", ""),
                ("legacy_no", 0, "否"), ("legacy_yes", 0, "是"),
                ("legacy_null_with_conclusion", None, "否"),
                ("analyzed_no", 1, "否"), ("analyzed_blank", 2, ""), ("analyzed_yes", 3, "是"),
            ])
            specs = {"semantic_analysis_count": FieldSpec("semantic_analysis_count", "count", "number", "semantic_analysis_count", "fixture")}
            specs["analysis_is_negative"] = FieldSpec("analysis_is_negative", "conclusion", "text", "conclusion", "fixture")
            def ids(rule):
                sql, args, _ = compile_filter_group(rule, specs)
                return {row[0] for row in db.execute("SELECT id FROM samples WHERE " + sql, args)}
            self.assertEqual({"null", "empty", "spaces", "zero", "text_zero"}, ids(unanalyzed_rule()))
            self.assertEqual({"null", "empty", "spaces", "legacy_null_with_conclusion"}, ids({"children": [{"field": "semantic_analysis_count", "operator": "is_empty"}]}))
            self.assertNotIn("null", ids({"children": [{"field": "semantic_analysis_count", "operator": "eq", "value": 0}]}))


class MissingSemanticConclusionTests(unittest.TestCase):
    """The shortcut means no conclusion, independently of analysis count."""

    def check_dataset(self, dataset):
        with sqlite3.connect(":memory:") as db:
            # Nullable legacy fixtures test NULL without weakening production DDL.
            db.execute("CREATE TABLE notes(note_id TEXT, semantic_analysis_count INTEGER, analysis_is_negative TEXT)")
            db.execute("CREATE TABLE comments(comment_id TEXT, note_id TEXT, semantic_analysis_count INTEGER, analysis_is_negative TEXT)")
            cases = [
                ("null", 0, None), ("empty", 0, ""), ("spaces", 0, "   "),
                ("positive_null", 2, None), ("positive_empty", 3, ""),
                ("positive_spaces", 4, "   "), ("null_count", None, ""),
                ("zero_yes", 0, "是"), ("zero_no", 0, "否"),
                ("positive_yes", 2, "是"), ("positive_no", 3, "否"),
            ]
            db.executemany("INSERT INTO notes VALUES(?,?,?)", cases)
            db.executemany("INSERT INTO comments VALUES(?,?,?,?)", [(key, key, count, result) for key, count, result in cases])
            specs = {field.key: field for field in build_field_specs(db, dataset)}
            rule = {"children": [{"field": "analysis_is_negative", "operator": "is_empty"}]}
            sql, args, conditions = compile_filter_group(rule, specs)
            base = "notes n" if dataset == "notes" else "comments c JOIN notes n ON n.note_id=c.note_id"
            key = "n.note_id" if dataset == "notes" else "c.comment_id"
            actual = {row[0] for row in db.execute(f"SELECT {key} FROM {base} WHERE {sql}", args)}
            self.assertEqual({"null", "empty", "spaces", "positive_null", "positive_empty", "positive_spaces", "null_count"}, actual)
            self.assertEqual(1, conditions)
            self.assertEqual([], args)

    def test_notes_missing_conclusion_ignores_count(self):
        self.check_dataset("notes")

    def test_comments_missing_conclusion_ignores_count(self):
        self.check_dataset("comments")


if __name__ == "__main__":
    unittest.main()
