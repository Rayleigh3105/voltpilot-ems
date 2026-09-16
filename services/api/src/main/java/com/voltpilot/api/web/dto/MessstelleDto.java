package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Formen der Messstellen-Schnittstelle (UEMS AP-04 IP-3, {@code /api/v1/messstellen}).
 *
 * <p>Anders als der Rest der API in snake_case: die Antwort IST eine Messstelle nach
 * {@code docs/contracts/v2/messstelle.schema.json} — dieselben Feldnamen, dieselben Wörter —
 * plus vier Felder der Schnittstelle ({@code id}, {@code fehlt}, {@code angehalten_ab},
 * {@code archiviert_am}). {@code MessstelleApiTest} hält die Antwort ohne diese vier am Schema
 * fest.
 */
public final class MessstelleDto {
    private MessstelleDto() {}

    /** Eine Messgröße wie {@code $defs/groesse} des Vertrags. */
    public record Groesse(String groesse, String richtung, String einheit, String wertart) {}

    /** Ein abgelesener Zählerstand wie {@code $defs/stand}; {@code einheit} darf fehlen. */
    public record Stand(double wert, String einheit) {}

    /**
     * Eine führende Quelle wie {@code $defs/quellenbindung} (IP-13): {@code komponente} ist die
     * Kennung der Komponente, {@code kanal} ihr Kanalname (point_key), {@code geraet}/{@code einbau}
     * das Gerät und der Einbau, der sie zu Beginn speist.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Quellenbindung(
            String komponente,
            String kanal,
            String geraet,
            String einbau,
            String kanalWertart,
            OffsetDateTime gueltigAb,
            OffsetDateTime gueltigBis,
            Stand anfangsstand,
            Stand endstand,
            String anteil) {}

    /** Eine Vergleichsquelle wie {@code $defs/vergleichsbindung} (IP-13), mit Zweck. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vergleichsbindung(
            String komponente,
            String kanal,
            String geraet,
            String einbau,
            String kanalWertart,
            String zweck,
            OffsetDateTime gueltigAb,
            OffsetDateTime gueltigBis) {}

    /**
     * Eine Messstelle. {@code orte} und {@code elektrische_stellung} tragen ihre Zuordnungen
     * (AP-04 IP-7) — alle wirksamen Intervalle nach Beginn, aufgehobene nicht;
     * {@code fuehrende_quelle} und {@code vergleichsquellen} (auch je Nebengröße) ihre
     * Quellenbindungen (IP-13), beendete eingeschlossen. {@code kadenz_s} bleibt leer (die Kadenz
     * an der Quelle kommt mit AP-07). Eine gemessene Messstelle ohne Ort ist ehrlich ein Entwurf
     * mit {@code fehlt: ["ort"]}. {@code lebenszyklus} und {@code fehlt} leitet
     * {@code MessstelleRegeln.lebenszyklus} aus den gespeicherten Eingängen ab.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Messstelle(
            UUID id,
            String schemaVersion,
            String kennzeichen,
            String name,
            String art,
            String medium,
            Groesse hauptgroesse,
            List<Quellenbindung> fuehrendeQuelle,
            List<Vergleichsbindung> vergleichsquellen,
            List<Nebengroesse> nebengroessen,
            List<OrtZuordnung> orte,
            List<StellungZuordnung> elektrischeStellung,
            Integer kadenzS,
            String lebenszyklus,
            List<String> fehlt,
            String notiz,
            OffsetDateTime angehaltenAb,
            OffsetDateTime archiviertAm,
            BigDecimal anschlussleistungKw) {}

    /**
     * Ein Ort mit Gültigkeit wie {@code $defs/ortZuordnung}: {@code ort_art} unternehmen · standort ·
     * gebaeude · bereich, {@code kennzeichen} das Kurzzeichen des Orts ({@code U} = das
     * Unternehmen); {@code gueltig_bis} ist der LETZTE gültige Tag, {@code null} = offen.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record OrtZuordnung(String ortArt, String kennzeichen, LocalDate gueltigAb, LocalDate gueltigBis) {}

    /**
     * Die elektrische Stellung mit Gültigkeit wie {@code $defs/stellungZuordnung}: {@code anlage}
     * ist die ID der Anlage, {@code unterzaehler_von} das heutige Kennzeichen der Bezug-Messstelle
     * (nur bei „Unterzähler“).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record StellungZuordnung(
            String anlage, String stellung, String unterzaehlerVon, LocalDate gueltigAb, LocalDate gueltigBis) {}

    /** Eine Nebengröße wie {@code $defs/nebengroesse}: aktiv oder archiviert (einzeln oder mit der Messstelle). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Nebengroesse(
            String groesse,
            String richtung,
            String einheit,
            String wertart,
            String lebenszyklus,
            List<Quellenbindung> fuehrendeQuelle,
            List<Vergleichsbindung> vergleichsquellen) {}

    /**
     * Die Liste als Objekt, nicht als nacktes Array: das Register (IP-4) ergänzt seine Zeilen,
     * den Stichtag und {@code teilansicht} (AP-03), ohne die Form zu brechen. {@code messstellen}
     * (die Vertrags-Form, IP-3) und {@code register} nennen DIESELBEN Messstellen in derselben
     * Reihenfolge (nach Kennzeichen) — die Filter gelten für beide. {@code stichtag} ist der Tag,
     * an dem Ort und Stellung gelten; {@code zeitpunkt} der Augenblick, zu dem die Quelle gilt
     * (ein Tag: sein Beginn, wie {@code …/quellen?stichtag=}; ohne Stichtag: jetzt).
     * {@code teilansicht} bleibt {@code false}, bis AP-03 Rechte je Standort durchsetzt — bis dahin
     * sieht jeder den ganzen Kundenbereich (RLS). {@code aggregat} zählt „x von y Messstellen
     * liefern Daten“ (IP-15) über GENAU die gezeigten Zeilen — je Standort und für das ganze
     * Unternehmen.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Liste(List<Messstelle> messstellen, List<RegisterZeile> register, LocalDate stichtag,
            OffsetDateTime zeitpunkt, boolean teilansicht, RegisterAggregat aggregat) {}

    /**
     * Eine Zeile des Registers (AP-04 §5.16) zum Stichtag. {@code ort} ist immer da (mit
     * {@code grund}, auch „nicht_verortet“), {@code elektrische_stellung} {@code null}, wenn an dem
     * Tag keine gilt, {@code quelle} immer da (mit {@code stand}). {@code lebenszyklus} und
     * {@code fehlt} sind die der Messstellen-Antwort — der HEUTIGE Lebenszyklus (gespeichert ist nur
     * der heutige Eingang); ein Stichtag verschiebt Ort, Stellung und Quelle, nicht ihn.
     * {@code beobachtung} und {@code letzter_wert} gelten der HAUPTGRÖSSE über ihre führende Quelle
     * (IP-15); {@code nebengroessen} sagt dasselbe je Nebengröße über deren eigene führende Quelle.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RegisterZeile(
            UUID id,
            String kennzeichen,
            String name,
            String art,
            String medium,
            Groesse hauptgroesse,
            RegisterOrt ort,
            RegisterStellung elektrischeStellung,
            RegisterQuelle quelle,
            String lebenszyklus,
            List<String> fehlt,
            OffsetDateTime angehaltenAb,
            OffsetDateTime archiviertAm,
            RegisterBeobachtung beobachtung,
            RegisterWert letzterWert,
            List<RegisterNebengroesse> nebengroessen,
            List<RegisterFakt> fakten,
            RegisterBerechnung berechnung) {}

    /** Ein wirksamer, append-only protokollierter Fakt an der Messstelle. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RegisterFakt(String art, OffsetDateTime giltAb) {}

    /**
     * Die Vollständigkeit einer BERECHNETEN Messstelle zum Zeitpunkt (AP-10 IP-9) — abgeleitet von
     * {@code ZustandAbleitung.berechnet} über die Eingänge der Formel DES TAGES (bei einem Rest aus der
     * Stellung): {@code zustand} {@code vollstaendig} · {@code unvollstaendig}, {@code fehlend} die
     * Kennzeichen der Eingänge, die nicht liefern, {@code seit} der früheste Zeitpunkt, seit dem einer
     * schweigt, {@code text} der Kundensatz („Unvollständig seit 14:00 Uhr (fehlt: MS-12)“). {@code null}
     * an einer gemessenen Messstelle und an einer berechneten ohne Formel am Tag.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RegisterBerechnung(String zustand, List<String> fehlend, OffsetDateTime seit, String text) {}

    /**
     * Die Beobachtung EINER Größe (AP-04 IP-15) — abgeleitet, nie gespeichert und nie geraten:
     * {@code zustand} ist eines der vier Wörter von {@code ZustandAbleitung.LiefertDaten}
     * ({@code liefert} · {@code liefert_nicht_seit} · {@code wartet_auf_erste_daten} ·
     * {@code keine_datenquelle}), {@code text} der Kundensatz dazu. {@code seit} trägt nur
     * {@code liefert_nicht_seit} (ein Satz ohne Zeitpunkt wäre eine halbe Aussage).
     *
     * <p>{@code toleranz_s} ist das tatsächlich angewandte Fenster
     * {@code min(max(3 × kadenz_s, 300), 86400)} und {@code kadenz_s} die erwartete Häufigkeit —
     * beide mitgeführt, damit der Satz nachvollziehbar ist, und beide {@code null} bei
     * {@code keine_datenquelle}: ohne Kanal ist keine Kadenz bekannt, und eine erfundene wäre
     * eine erfundene Zahl. ⚠ 3 × Kadenz ist die BEOBACHTUNG; 2 × Kadenz ist die LÜCKE, eine
     * andere Aussage (AP-07 IP-9), die hier nicht vorkommt.
     *
     * <p>{@code geraet} ist der Einbau der führenden Quelle (Z-5b) — er steht auch im Satz, sobald
     * eine Größe nach einem Zählerwechsel noch auf ihre ersten Werte wartet („Wartet auf erste
     * Daten von Z-5b“); {@code null}, wenn keine Quelle gebunden ist.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RegisterBeobachtung(String zustand, String text, OffsetDateTime seit, Long toleranzS,
            Long kadenzS, String geraet) {}

    /**
     * Der letzte Wert mit Qualität „gut“ der führenden Quelle — {@code null}, solange es keinen
     * gibt (nie eine 0). Genau eines von {@code wert} und {@code text} ist gesetzt (die
     * Wert-Regel der Messreihe); {@code einheit} ist die des Messkanals, ohne jede Umrechnung.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RegisterWert(Double wert, String text, String einheit, OffsetDateTime zeitpunkt) {}

    /** Eine Nebengröße der Zeile mit ihrer eigenen Beobachtung über ihre eigene führende Quelle. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RegisterNebengroesse(UUID id, Groesse groesse, RegisterBeobachtung beobachtung,
            RegisterWert letzterWert) {}

    /**
     * „x von y Messstellen liefern Daten“ (AP-04 IP-15) über die Ableitung {@code aggregat} des
     * Zustandsvertrags: nur {@code liefert} zählt im Zähler, „keine Datenquelle“ steht im Nenner.
     * Gezählt werden GENAU die Zeilen dieser Antwort (die Filter gelten also auch hier), die eine
     * Beobachtung haben — eine BERECHNETE Messstelle hat keine (AP-10) und steht in keinem Nenner.
     * {@code standorte} nennt je Standort seine Zeilen, {@code unternehmen} alle — eine Messstelle
     * ohne Standort an dem Tag zählt deshalb nur beim Unternehmen.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RegisterAggregat(RegisterAbdeckung unternehmen, List<RegisterStandortAbdeckung> standorte) {}

    /** Zähler, Nenner und der Satz des Vertrags („14 von 17 Messstellen liefern Daten“). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RegisterAbdeckung(int erfuellt, int gesamt, String text) {}

    /** Dieselbe Zählung je Standort, mit seinem Kurzzeichen und Namen. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RegisterStandortAbdeckung(UUID id, String kurzzeichen, String name, int erfuellt,
            int gesamt, String text) {}

    /**
     * Der Ort am Stichtag und der daraus abgeleitete Standort — die Verortung des
     * Ortsbaum-Vertrags wie {@link StandortAm} ({@code kennzeichen} = {@code ort} dort, {@code pfad}
     * vom Ort hinauf bis zum Standort, {@code grund}); dazu die Namen und das Intervall, das an dem
     * Tag gilt. {@code id} ist die des Standorts, Gebäudes, Bereichs bzw. Unternehmens.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RegisterOrt(UUID id, String kennzeichen, String ortArt, String name, LocalDate gueltigAb,
            LocalDate gueltigBis, List<String> pfad, String standort, UUID standortId, String standortName,
            String grund) {}

    /** Die elektrische Stellung am Stichtag; {@code unterzaehler_von} ist das heutige Kennzeichen des Bezugs. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RegisterStellung(UUID anlage, String anlageName, String stellung, String unterzaehlerVon,
            LocalDate gueltigAb, LocalDate gueltigBis) {}

    /**
     * Die Quelle der Hauptgröße zum Zeitpunkt. {@code stand}: {@code gebunden} (eine führende Quelle
     * gilt), {@code berechnet} (eine berechnete Messstelle hat keine Quelle — ihre Formel kommt mit
     * AP-10) oder {@code keine_datenquelle} (gemessen, aber zu dem Zeitpunkt keine führende Quelle —
     * nie eine 0). {@code davor}: die führende Quelle, die vor der geltenden (bzw. vor dem Zeitpunkt)
     * zuletzt endete — „seit 18.11.2026 10:40 · davor Z-5a“. {@code vergleichsquellen}: wie viele
     * Vergleichsquellen der Hauptgröße zu dem Zeitpunkt laufen.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RegisterQuelle(String stand, RegisterBindung fuehrend, RegisterBindung davor,
            int vergleichsquellen) {}

    /**
     * Eine führende Bindung, wie das Register sie nennt: Komponente, Messwert (Kanal und sein
     * Anzeigename wie im Messkanal-Read-Model), Gerät, seit ({@code gueltig_ab}) und bis.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RegisterBindung(UUID id, UUID komponente, String komponenteName, String kanal, String kanalName,
            RegisterGeraet geraet, OffsetDateTime gueltigAb, OffsetDateTime gueltigBis) {}

    /**
     * Das Gerät des Messkanals: {@code geraet} das Kennzeichen (GR-4), {@code einbau} der Einbau, der
     * die Komponente zu Beginn der Bindung speist (Z-5b), {@code bezeichnung} sein Name — {@code null},
     * solange niemand einen vergeben hat (der Anlege-Weg vergibt keinen).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record RegisterGeraet(UUID id, String geraet, String einbau, String bezeichnung) {}

    /** Das nächste automatische Kennzeichen — der Zähler bewegt sich erst beim Speichern. */
    public record Vorschlag(String kennzeichen) {}

    /**
     * {@code POST /api/v1/messstellen}. {@code kennzeichen} leer (fehlend oder {@code null}) =
     * automatisch; {@code name} leer = fehlt noch (Entwurf). Art, Medium und Hauptgröße sind
     * danach nie mehr änderbar.
     */
    public record Anlegen(
            String kennzeichen,
            String name,
            String art,
            String medium,
            Groesse hauptgroesse,
            List<Groesse> nebengroessen,
            String notiz,
            @JsonProperty("anschlussleistung_kw") BigDecimal anschlussleistungKw) {

        /** Ohne Anschlussleistung — die Form von vor AP-08 IP-7. */
        public Anlegen(String kennzeichen, String name, String art, String medium, Groesse hauptgroesse,
                List<Groesse> nebengroessen, String notiz) {
            this(kennzeichen, name, art, medium, hauptgroesse, nebengroessen, notiz, null);
        }
    }

    /**
     * {@code PUT /api/v1/messstellen/{id}}: die änderbaren Felder, ganz (fehlend = leer) — seit AP-08
     * IP-7 auch die optionale {@code anschlussleistung_kw}.
     */
    public record Bearbeiten(String kennzeichen, String name, String notiz,
            @JsonProperty("anschlussleistung_kw") BigDecimal anschlussleistungKw) {

        public Bearbeiten(String kennzeichen, String name, String notiz) {
            this(kennzeichen, name, notiz, null);
        }
    }

    /**
     * {@code POST …/anhalten|fortsetzen|archivieren}. {@code zeitpunkt} auf die Minute mit
     * Versatz (E2), fehlend = jetzt; {@code grund} frei, steht im Änderungsprotokoll.
     */
    public record Uebergang(OffsetDateTime zeitpunkt, String grund) {}

    /**
     * {@code PUT …/{id}/ort}: der Ort ab dem Tag {@code gueltig_ab} — sein Kurzzeichen oder
     * {@code U} (das Unternehmen, nur berechnet). Das laufende Intervall endet am Vortag.
     * {@code korrektur: true} ersetzt statt dessen das Intervall, das an {@code gueltig_ab}
     * beginnt (das alte bleibt aufgehoben lesbar). {@code grund} steht im Protokoll.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record OrtAendern(String kennzeichen, LocalDate gueltigAb, Boolean korrektur, String grund) {}

    /**
     * {@code PUT …/{id}/stellung}: Anlage + Stellung (+ „Unterzähler von“ als Kennzeichen der
     * Bezug-Messstelle) ab dem Tag {@code gueltig_ab}; {@code korrektur} und {@code grund} wie beim Ort.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record StellungAendern(UUID anlage, String stellung, String unterzaehlerVon, LocalDate gueltigAb,
            Boolean korrektur, String grund) {}

    /**
     * {@code GET …/{id}/standort?am=}: der Stand der Zuordnungen an einem Tag. {@code ort},
     * {@code pfad}, {@code standort} und {@code grund} sind die Verortung des Ortsbaum-Vertrags
     * (Familie {@code messstelle_standort}: verortet · am_unternehmen · nicht_verortet ·
     * ort_nicht_im_baum); dazu die Art des Orts, die ID des Standorts und die Stellung an dem Tag.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record StandortAm(LocalDate am, String ort, String ortArt, List<String> pfad, String standort,
            UUID standortId, String grund, StellungZuordnung elektrischeStellung) {}
}
