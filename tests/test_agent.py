"""Unit tests for agent filter SQL construction, sanitization, and intent routing."""
from pipeline.agent import FILTER_DEFS, INTENTS, _filter_sql, _sanitize


def test_sanitize_int_accepts_numbers_rejects_injection():
    assert _sanitize("20", 15) == 20
    assert _sanitize("15; DROP TABLE x", 15) == 15
    assert _sanitize(None, 15) == 15


def test_sanitize_string_whitelists_letters_only():
    assert _sanitize("CA", "CA") == "CA"
    assert _sanitize("CA' OR 1=1 --", "CA") == "CA"


def test_filter_sql_uses_mart_and_default_threshold():
    sql = _filter_sql("roof")
    assert "feat_roof" in sql and "15" in sql and "LIMIT 25" in sql


def test_filter_sql_applies_custom_value():
    sql = _filter_sql("transit", value=400)
    assert "feat_transit" in sql and "400" in sql


def test_every_filter_def_builds_valid_sql():
    for name in FILTER_DEFS:
        sql = _filter_sql(name)
        assert sql.startswith("SELECT * FROM feat_")


def test_intents_match_assignment_question_bank():
    bank = {
        "roof": "Which properties have roofs older than 15 years?",
        "stable_owner": "Properties that have not exchanged ownership in more than 10 years",
        "regional": "Show properties with regional owners",
        "water": "Show properties with a view of water",
        "transit": "Properties within walking distance of public transportation",
        "starbucks": "Properties within walking distance of Starbucks",
    }
    for intent, question in bank.items():
        pattern = INTENTS[intent][0]
        assert pattern.search(question), f"{intent} did not match: {question}"
