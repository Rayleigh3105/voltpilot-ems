#!/usr/bin/env python3
import argparse
import base64
from pathlib import Path


def bild(pfad: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(pfad.read_bytes()).decode("ascii")


def karte(titel: str, datei: Path, hinweis: str = "") -> str:
    return f'''<figure><div class="bild"><img src="{bild(datei)}" alt="{titel}"></div>
      <figcaption><strong>{titel}</strong>{f'<span>{hinweis}</span>' if hinweis else ''}</figcaption></figure>'''


def paar(titel: str, links: tuple[str, Path], rechts: tuple[str, Path], hinweis: str = "") -> str:
    return f'''<section><header><h2>{titel}</h2>{f'<p>{hinweis}</p>' if hinweis else ''}</header>
      <div class="paar">{karte(*links)}{karte(*rechts)}</div></section>'''


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--images", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    b = args.images
    benoetigt = [
        *(b / f"u1-{phase}-{breite}.png" for phase in ("vorher", "nachher") for breite in (375, 1440)),
        *(b / f"u2-vorher-{breite}.png" for breite in (375, 1440)),
        *(b / f"u2-nachher-{zustand}-{breite}.png" for zustand in ("karte", "vorschau", "bestaetigt") for breite in (375, 1440)),
    ]
    fehlt = [str(p) for p in benoetigt if not p.is_file()]
    if fehlt:
        raise SystemExit("Fehlende Bilder: " + ", ".join(fehlt))

    abschnitte = []
    for breite in (375, 1440):
        abschnitte.append(paar(
            f"U1 · Ein-Anlagen-Kunde · {breite} px",
            ("Vorher · main", b / f"u1-vorher-{breite}.png"),
            ("Nachher · UEMS", b / f"u1-nachher-{breite}.png"),
            "Befund: Text- und Pixel-Differenz 0; das Cockpit ist nach eingefrorenen Animationen bytegleich. Die Einstiege aus B9 sind additiv erreichbar, ändern diese Startansicht aber nicht.",
        ))
        abschnitte.append(paar(
            f"U2 · Einstieg · {breite} px",
            ("Vorher · main", b / f"u2-vorher-{breite}.png"),
            ("Nachher · Karte", b / f"u2-nachher-karte-{breite}.png"),
            "Am ersten Tag erscheint aus echten Läuferdaten die Karte „Noch nicht zugeordnet · 3 Anlagen“.",
        ))
        abschnitte.append(paar(
            f"U2 · Mitteilung und Ergebnis · {breite} px",
            ("Vorschau · Was sich ändert", b / f"u2-nachher-vorschau-{breite}.png"),
            ("Nach Bestätigung", b / f"u2-nachher-bestaetigt-{breite}.png"),
            "Die Vorschau fährt den Weg 2 + 1: der Wähler „Gehört zu“ legt Halle 2 zu Halle 1, die Adressfelder werden von drei auf zwei, und die Bestätigung legt zwei Standorte an.",
        ))

    html = f'''<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AP-14 IP-20 · Bestandskunde vorher/nachher</title><style>
:root{{--vp-primary:#95B9FF;--vp-action:#2C5282;--vp-navy:#1E3A5F;--vp-text:#1A1A1A;--vp-muted:#66717C;--vp-bg:#F8F9FA;--vp-surface:#FFF;--vp-border:#E9ECEF;--vp-warn:#b45309}}
*{{box-sizing:border-box}} body{{margin:0;background:var(--vp-bg);color:var(--vp-text);font:16px/1.55 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
main{{max-width:1500px;margin:auto;padding:40px 28px 80px}} h1,h2{{font-family:"Inter Tight",Inter,sans-serif;color:var(--vp-navy);letter-spacing:-.02em}} h1{{font-size:clamp(2rem,4vw,3rem);margin:0 0 18px}} .intro{{max-width:930px;font-size:1.08rem}} .intro p{{margin:.35rem 0}} .ehrlich{{margin:28px 0 42px;padding:22px;border:1px solid #b8d4ff;border-left:6px solid var(--vp-action);border-radius:14px;background:#fff}} .ehrlich h2{{margin:0 0 10px;font-size:1.2rem}} .ehrlich p{{margin:6px 0;color:var(--vp-muted)}} .befund{{color:#7a2e00!important;font-weight:700}}
section{{margin:34px 0 54px}} section>header{{display:flex;gap:16px;align-items:baseline;justify-content:space-between;flex-wrap:wrap;margin-bottom:14px}} section h2{{margin:0;font-size:1.35rem}} section header p{{margin:0;max-width:850px;color:var(--vp-muted)}} .paar{{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px;align-items:start}} figure{{min-width:0;margin:0;background:var(--vp-surface);border:1px solid var(--vp-border);border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(30,58,95,.08)}} .bild{{overflow:auto;background:#eef1f5;padding:12px}} img{{display:block;width:100%;height:auto;border-radius:8px}} figcaption{{display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap;padding:13px 16px}} figcaption span{{color:var(--vp-muted)}}
@media(max-width:800px){{main{{padding:24px 14px 50px}}.paar{{grid-template-columns:1fr}}}}
</style></head><body><main><h1>Was Bestandskunden am ersten Tag vorfinden</h1>
<div class="intro"><p>Der Ein-Anlagen-Kunde landet nach dem Rollout weiterhin in seinem vertrauten Cockpit; die neue Struktur wird nicht ungefragt eingerichtet.</p><p>Der Mehr-Anlagen-Kunde sieht erstmals drei offene Anlagen und bekommt vor jeder Änderung eine Vorschau; darin legt er zwei Hallen zu einem Standort zusammen.</p><p>Erst die Bestätigung ändert die Startseite zur Unternehmens-Übersicht; Steuerung, Fahrpläne und Freigaben bleiben davon getrennt.</p></div>
<aside class="ehrlich"><h2>Was an diesen Bildern echt ist – und was nicht</h2><p><strong>Echt:</strong> `main`- und UEMS-Portal aus ihrem jeweiligen Quellstand, echte API-Antworten aus MockMvc gegen eine Wegwerf-TimescaleDB, 168 `main`-Migrationen, danach UEMS-Migrationen und die drei Bestandsläufer. Die Bilder sind Playwright-Aufnahmen dieser Portal-Builds.</p><p><strong>Ersetzt:</strong> Keycloak-Anmeldung und Netztransport. Die Antworten sind für den Bildlauf aufgezeichnet; Live-Telemetrie wird nicht erfunden und bleibt daher leer oder nicht verfügbar.</p><p class="befund">Neu an diesen Bildern: Die Vorschau legt Halle 2 zu Halle 1 – aus drei Anlagen werden zwei Standorte.</p><p class="befund">Der Ein-Anlagen-Kunde: vorher und nachher bytegleich – geprüft an 7 Aufnahmen je Seite.</p></aside>
{''.join(abschnitte)}</main></body></html>'''
    args.output.write_text(html, encoding="utf-8")


if __name__ == "__main__":
    main()
