"""vp-db-zeitgrenze: the simulation HTTP service's what-if/replan routes block
the request thread (cli._what_if_handler/_replan_handler docstrings), so they
get a Postgres statement_timeout; the async year-simulation job polled later
does not."""

from argparse import Namespace

from voltpilot_optimization import cli


def test_mit_statement_zeitgrenze_appends_options_to_a_plain_dsn():
    dsn = cli._mit_statement_zeitgrenze("postgresql://u:p@h:5432/db", {})
    assert dsn == "postgresql://u:p@h:5432/db?options=-c%20statement_timeout%3D30000"


def test_mit_statement_zeitgrenze_appends_to_an_existing_query_string():
    dsn = cli._mit_statement_zeitgrenze("postgresql://u:p@h:5432/db?connect_timeout=10", {})
    assert dsn == (
        "postgresql://u:p@h:5432/db?connect_timeout=10"
        "&options=-c%20statement_timeout%3D30000"
    )


def test_mit_statement_zeitgrenze_reads_the_env_override():
    dsn = cli._mit_statement_zeitgrenze(
        "postgresql://u:p@h:5432/db", {"OPTIMIZER_ANFRAGE_STATEMENT_TIMEOUT_MS": "5000"}
    )
    assert dsn.endswith("statement_timeout%3D5000")


def test_simulate_serve_gives_what_if_and_replan_the_bounded_dsn(monkeypatch):
    """The wiring in `_simulate_serve`: what-if/replan get the augmented DSN,
    the async simulation job (`load_prices`/`load_market_values`) keeps the
    plain one - captured via the handler factories and `SimulationDeps`
    without ever calling `httpd.serve_forever()`."""
    from voltpilot_optimization import cli as cli_mod
    from voltpilot_optimization.simulation import server as server_mod

    seen = {}

    def fake_what_if_handler(dsn, max_concurrent):
        seen["what_if_dsn"] = dsn
        return lambda doc: {}

    def fake_replan_handler(dsn, env, max_concurrent):
        seen["replan_dsn"] = dsn
        return lambda doc: {}

    class FakeHttpd:
        def serve_forever(self):
            return None

        def server_close(self):
            return None

        def shutdown(self):
            return None

    def fake_serve(store, port, what_if=None, replan=None):
        seen["deps_what_if"] = what_if
        seen["deps_replan"] = replan
        return FakeHttpd()

    monkeypatch.setattr(cli_mod, "_what_if_handler", fake_what_if_handler)
    monkeypatch.setattr(cli_mod, "_replan_handler", fake_replan_handler)
    monkeypatch.setattr(server_mod, "serve", fake_serve)
    monkeypatch.setattr(cli_mod.ServeRuntime, "install_signal_handlers", lambda self, *a, **k: None)
    monkeypatch.setattr(cli_mod.ServeRuntime, "wait_for_stop", lambda self: None)

    args = Namespace(port=8095, max_workers=1, max_what_if=2, max_replan=1)
    cli_mod._simulate_serve(args, {"POSTGRES_HOST": "h", "POSTGRES_PASSWORD": ""})

    assert "options=-c%20statement_timeout%3D30000" in seen["what_if_dsn"]
    assert "options=-c%20statement_timeout%3D30000" in seen["replan_dsn"]
