package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Die Maßnahme (UEMS AP-18 IP-10, M1–M4, M6, M7; Vertrag {@code verbesserung.md}). Zahlen sind Dezimaltexte wie im
 * Vergleich der Bezugsbasis; die Ausgangslage ist die kanonische Kopie, wie gespeichert, mit Prüfsumme.
 */
public final class MassnahmeDto {

    private MassnahmeDto() {}

    /**
     * {@code POST /api/v1/massnahmen}. Herkunft {@code abweichung · energieziel · einsatz · von_hand}; die Kennung bei
     * {@code abweichung} (AW-…), bei {@code energieziel}/{@code einsatz} folgt sie dem Verweis. Messgrundlage: eine
     * Kennzahl mit freigegebener Bezugsbasis und die Monate der Ausgangslage ({@code JJJJ-MM} oder
     * {@code JJJJ-MM/JJJJ-MM}; ohne: der letzte abgeschlossene Monat). {@code standort} nur ohne Kennzahl.
     * {@code art} (Verbessern-Konzept v1, Entscheid 6) {@code gemessen · nicht_gemessen · organisatorisch} - fehlt sie,
     * gilt {@code gemessen} mit Kennzahl, aus Feststellung oder Audit {@code organisatorisch}, sonst
     * {@code nicht_gemessen}. {@code erwartete_einsparung_kwh_jahr}
     * (Entscheid 13) nur ohne Kennzahl und nur bei {@code nicht_gemessen}: die Schätzung einer Person, weniger Energie;
     * mit Kennzahl rechnet die Route die erwartete Wirkung in kWh im Jahr um.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlegen(String titel, String verantwortlich, LocalDate termin, String herkunft,
            String herkunftKennung, UUID kennzahl, String monate, UUID einsatz, Integer einstufungFassung,
            UUID energieziel, UUID standort, BigDecimal erwarteteWirkungProzent, String erwarteteWirkungWortlaut,
            String art, BigDecimal erwarteteEinsparungKwhJahr) {}

    /**
     * {@code PUT …/{id}}: Titel, Termin, erwartete Wirkung - solange geplant, immer mit Begründung. Die Schätzung in kWh
     * im Jahr ändert die Person nur ohne Kennzahl ({@code nicht_gemessen}); mit Kennzahl folgt sie der Zahl in Prozent.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Aendern(String titel, LocalDate termin, BigDecimal erwarteteWirkungProzent,
            String erwarteteWirkungWortlaut, String begruendung, BigDecimal erwarteteEinsparungKwhJahr) {}

    /** {@code PUT …/{id}/verantwortlicher}: ein aktiver Benutzer des Kundenbereichs ({@code sub}) mit Begründung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Verantwortlicher(String benutzer, String begruendung) {}

    /** {@code POST …/{id}/umgesetzt}: der Tag (nie in der Zukunft) und die Begründung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Umgesetzt(LocalDate am, String begruendung) {}

    /** {@code POST …/{id}/verwerfen}: die Begründung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Verwerfen(String begruendung) {}

    /** {@code POST …/{id}/eintraege}: ein Kommentar (1–2 000 Zeichen). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record NeuerEintrag(String art, String text) {}

    /**
     * {@code POST …/{id}/bewertungen} und {@code …/bewertungen/beantragen} (IP-12, WK6): Ergebnis
     * {@code belegt · nicht_belegt · nicht_messbar} und Begründung (10–500 Zeichen).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bewerten(String ergebnis, String begruendung) {}

    /**
     * {@code POST …/{id}/anstoesse/{aid}/antwort} (IP-17, M5): {@code bleibt} mit Begründung (10–500 Zeichen) ·
     * {@code neu_kopiert} (Ausgangslage neu aus dem Leser) · {@code neu_bewertet} mit {@code ergebnis} und Begründung
     * (Stand Nr. n + 1, wie {@code …/bewertungen}); bei {@code neu_kopiert} ist die Begründung wahlfrei.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record AnstossAntwort(String antwort, String begruendung, String ergebnis) {}

    /** {@code …/bewertungen/freigeben} (Begründung wahlfrei) und {@code …/bewertungen/ablehnen} (Begründung Pflicht). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Entscheid(String begruendung) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Verweis(UUID id, String kennzeichen, String name) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Person(String sub, String name) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Herkunft(String art, String kennung) {}

    /**
     * M2: Kennzahl × Bezugsbasis-Fassung × Ausgangslage. {@code ausgangslage} ist der gespeicherte kanonische Text
     * (byte-gleich), {@code pruefsumme} {@code sha256:…} darüber; {@code bewertungsmethode} die Methode der Fassung (M3).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Messgrundlage(Verweis kennzahl, Verweis bezugsbasis, int fassung, String bewertungsmethode,
            String ausgangslage, String pruefsumme, Map<String, Object> ausgangslageInhalt, String satz) {}

    /** M4: das Kennzeichen „ohne Messgrundlage — Wirkung nicht messbar“ mit dem Hinweis, welche Kennzahl fehlt. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record OhneMessgrundlage(String kennzeichen, String hinweis, String satz) {}

    /** F1: der Termin beim Abruf (Operation {@code frist}); {@code faellig} {@code ueberfaellig} oder {@code null}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Frist(LocalDate abruf, LocalDate termin, String faellig, Integer seitTagen, String satz) {}

    /** Eine Zeile des Protokolls {@code massnahme_aenderung} — Zustandswechsel, Änderung oder Kommentar. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Eintrag(long nr, String art, Map<String, Object> alt, Map<String, Object> neu, String begruendung,
            String kommentar, String person, Instant am) {}

    /**
     * Die erwartete Einsparung in kWh im Jahr (Verbessern-Konzept v1, Entscheid 13): eine Schätzung, nie mit beobachteten
     * Werten summiert. {@code kwh_jahr} weniger Energie positiv (mit Kennzahl: −Prozent × Grundlage, auch „mehr“ als
     * negative Zahl); {@code grundlage_kwh}/{@code grundlage_monate} nur mit Kennzahl - die gemessene Menge der letzten
     * zwölf abgeschlossenen Monate beim Anlegen bzw. Ändern; ohne Kennzahl {@code null} (eine Person hat geschätzt).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Einsparung(String kwhJahr, String grundlageKwh, String grundlageMonate) {}

    /**
     * Die beobachtete Wirkung in Kurzform für die Liste (Verbessern-Konzept v1 §6.5): dieselbe Operation {@code wirkung}
     * wie {@code …/{id}/wirkung}, nur die Summe - in der Liste je Maßnahme und in {@code …/wirkung} an ihrer Maßnahme,
     * an der einzelnen Maßnahme {@code null}. Nur an umgesetzten und bewerteten Maßnahmen mit Messgrundlage und
     * mindestens einem bewertbaren Monat, sonst {@code null}. Mengen als Dezimaltexte in {@code einheit};
     * {@code differenz} = Σ gemessen − Σ erwartet (weniger negativ), {@code erwartete_wirkung} = Prozent der Person ×
     * Σ erwartet über dieselben Monate (ohne Zahl der Person {@code null}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record WirkungKurz(String deltaProzent, String richtung, String urteil, int monateBewertbar, int monateSoll,
            String monateText, boolean vorlaeufig, String zeitraumVon, String zeitraumBis, String gemessen,
            String erwartet, String differenz, String erwarteteWirkung, String einheit, String energie) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Massnahme(UUID id, String kennzeichen, String titel, Person verantwortlich, LocalDate termin,
            UUID standortId, String zustand, Herkunft herkunft, Messgrundlage messgrundlage,
            OhneMessgrundlage ohneMessgrundlage, Verweis einsatz, Integer einstufungFassung, Verweis energieziel,
            String erwarteteWirkungProzent, String erwarteteWirkungWortlaut, LocalDate angelegtAm,
            LocalDate umgesetztAm, String umgesetztBegruendung, Instant verworfenAm, String verworfenGrund,
            Frist frist, String kopfSatz, Bewertung bewertung, Bewertung bewertungAntrag, List<Anstoss> anstoesse,
            List<Eintrag> verlauf, String art, Einsparung erwarteteEinsparung, WirkungKurz wirkungKurz) {

        /** Dieselbe Maßnahme mit der Wirkung in Kurzform (die Liste, {@code MassnahmeWirkung#mitKurzform}). */
        public Massnahme mitWirkungKurz(WirkungKurz kurz) {
            return new Massnahme(id, kennzeichen, titel, verantwortlich, termin, standortId, zustand, herkunft,
                    messgrundlage, ohneMessgrundlage, einsatz, einstufungFassung, energieziel, erwarteteWirkungProzent,
                    erwarteteWirkungWortlaut, angelegtAm, umgesetztAm, umgesetztBegruendung, verworfenAm,
                    verworfenGrund, frist, kopfSatz, bewertung, bewertungAntrag, anstoesse, verlauf, art,
                    erwarteteEinsparung, kurz);
        }
    }

    /**
     * {@code GET /api/v1/massnahmen/schaetzung?kennzahl=&prozent=} (Entscheid 13): die Umrechnung der erwarteten Wirkung
     * in kWh im Jahr, wie {@code POST} sie beim Anlegen festhält - über die gemessene Menge der Kennzahl in den letzten
     * zwölf abgeschlossenen Monaten. Ohne volle Grundlage {@code kwh_jahr} {@code null} und {@code grund}
     * ({@code monate_fehlen} mit {@code monate_mit_wert}, {@code einheit_nicht_kwh}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Schaetzung(UUID kennzahl, String prozent, String kwhJahr, String grundlageKwh,
            String grundlageMonate, int monateMitWert, String grund) {}

    /**
     * Ein Anstoß an der Maßnahme ({@code vorgang_anstoss}, M5, IP-17): Ausgangslage oder Bewertungs-Stand zitiert eine
     * alte Version, die Basis endete oder wurde neu gefasst — die Kopie bleibt byte-gleich, eine Person antwortet.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Anstoss(UUID id, String art, String anlassKennung, Instant angestossenAm, String zustand,
            String antwort, String antwortBegruendung, Instant beantwortetAm, String beantwortetVon) {}

    /**
     * Ein Stand Nr. n der Bewertung (IP-12, WK6): das Wort einer Person mit Begründung, nie zurückgenommen.
     * {@code kopie} ist der kanonische Text der Wirkung zum Bewertungstag (ohne Messgrundlage {@code null}),
     * {@code pruefsumme} sein {@code sha256:}; {@code person}/{@code am} wer bewertet bzw. beantragt hat, bei Vier-Augen
     * {@code entscheidung} die zweite Person; {@code satz} der Kundensatz aus §5.9, sonst {@code null}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Bewertung(int standNr, String status, String ergebnis, String begruendung, boolean vieraugen,
            Person person, Instant am, Person entscheidung, Instant entschiedenAm, String entscheidungsBegruendung,
            String kopie, String pruefsumme, String satz) {}

    /** {@code GET …/{id}/bewertungen}: alle Stände der Maßnahme nach Nr., auch beantragte und abgelehnte. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Bewertungen(UUID id, String kennzeichen, String zustand, List<Bewertung> bewertungen) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Liste(LocalDate abruf, List<Massnahme> massnahmen, List<UUID> imStandEnthalten) {}

    /**
     * Ein Monat der Wirkung (WK1, WK2, WK4): die Vergleichszeile des Bezugsbasis-Lesers gegen die Fassung am letzten Tag
     * des Monats, ob er endgültig ist, ob er zählt — sonst {@code grund} ({@code wirkung_grund}) mit dem Kundensatz —
     * und {@code kennzahl_roh}, der rohe Kennzahl-Wert ohne Wort (WK5, VG3).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record WirkungMonat(String periode, boolean endgueltig, boolean gezaehlt, String grund, String satz,
            String kennzahlRoh, BezugsbasisVergleichDto.Monat vergleich) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record WirkungAusschluss(String monat, String grund) {}

    /** Σ ÷ Σ über die bewertbaren Nachher-Monate (Operation {@code wirkung} → {@code zeitraum}); nie ein Mittel. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record WirkungSumme(String gemessen, String erwartet, String deltaProzent, String bandProzent,
            String richtung, String urteil, List<String> kennzeichen) {}

    /**
     * {@code GET …/{id}/wirkung?monate=} (IP-11, WK1–WK5): ein Leser, kein gespeicherter Wert. {@code grund}
     * {@code ohne_messgrundlage} (nur {@code satz}, keine Zahl) oder {@code nicht_umgesetzt} (noch keine Nachher-Monate,
     * kein Satz) — sonst {@code null} und die Nachher-Monate mit Summe, „x von N“, {@code vorlaeufig} und den
     * Ausschlüssen; die erwartete Wirkung und die Ausgangslage (Kopie, byte-gleich) stehen in {@code massnahme}.
     * {@code satz} ist {@code wirkung_vorlaeufig}, ohne Zahl der Person {@code wirkung_ohne_erwartung} (Entscheid 12);
     * {@code energie} der Energieträger des Zählers („Strom“, sonst „Energie“) - ohne Nachher-Monate {@code null}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Wirkung(Massnahme massnahme, LocalDate abruf, String grund, String umsetzungsmonat,
            String nachherVon, String nachherBis, List<WirkungMonat> monate, Integer monateBewertbar,
            Integer monateEndgueltig, Integer monateSoll, String monateText, Boolean vorlaeufig,
            List<WirkungAusschluss> nichtGezaehlt, WirkungSumme summe, String satz, String energie) {}
}
