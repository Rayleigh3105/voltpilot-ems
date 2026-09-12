# Direktvermarktungsadapter

Der Dienst ist ein **Stub**: `MarketingAdapter` definiert die Anbietergrenze, `StubMarketingAdapter` bestätigt Beispielaufträge. Eine reale Anbieterverbindung oder Zertifizierung ist damit nicht implementiert.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
python -m voltpilot_marketing_adapter
pytest
```

Befehle in diesem Verzeichnis ausführen. Weitere Einordnung: [Architektur](../../docs/architecture.md).
