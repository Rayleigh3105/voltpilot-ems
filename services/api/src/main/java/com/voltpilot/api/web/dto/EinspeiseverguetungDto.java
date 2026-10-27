package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.LocalDate;

/**
 * Die Karte "Einspeisevergütung" einer Anlage (Einstellungen › Strom &amp; Geld):
 * welcher Satz je eingespeister kWh HEUTE in Fahrplan und Erlöse eingeht und
 * woher er kommt. Gebaut von
 * {@link com.voltpilot.api.optimizer.EinspeiseverguetungStand} - die Herkunft
 * ({@code angegeben}/{@code eeg}) ist dieselbe SQL-Wahrheit, mit der die Erlöse
 * ihren Einspeise-Erlös beschriften
 * ({@link com.voltpilot.api.optimizer.SlotEconomics#exportVerguetungQuelleSql}).
 *
 * <p>{@code zustand} ist ein geschlossenes Vokabular (Vektoren:
 * {@code docs/contracts/einspeiseverguetung-vectors.json}, Block
 * {@code zustaende}):
 * <ul>
 *   <li>{@code angegeben} - der Satz des Kunden wirkt ({@code wirksamCtKwh} =
 *       {@code angegebenCtKwh});</li>
 *   <li>{@code eeg} - der aus dem EEG hergeleitete Satz wirkt
 *       ({@code wirksamCtKwh} = {@code hergeleitetCtKwh});</li>
 *   <li>{@code eeg_abgelaufen} - die EEG-Vergütung ist nach 20 Jahren beendet
 *       ({@code eegEndeAm} liegt zurück), keine Angabe: Börsenpreis;</li>
 *   <li>{@code ohne_angabe} - kein Inbetriebnahmedatum und keine Angabe:
 *       Börsenpreis, nie eine erfundene Zahl;</li>
 *   <li>{@code netzladen} - Netzladen ist erlaubt: Börsenpreis
 *       (Ausschließlichkeitsprinzip), eine Angabe ruht;</li>
 *   <li>{@code direktvermarktung} - Börsenpreis + Marktprämie, keine feste
 *       Vergütung (eine Angabe ruht).</li>
 * </ul>
 *
 * @param wirksamCtKwh der feste Satz, der heute wirkt; null = keiner (Börse)
 * @param angegebenCtKwh die gespeicherte Angabe des Kunden; null = keine. Sie
 *     kann gespeichert sein und trotzdem ruhen (Netzladen, Direktvermarktung)
 * @param inbetriebnahmeAbSolarspitzengesetz die Antwort des Kunden „in Betrieb
 *     ab dem 25.02.2025?" - nur ohne Inbetriebnahmedatum (sonst null: das
 *     Datum entscheidet); null = nicht angegeben
 * @param hergeleitetCtKwh der Satz aus dem EEG-Satzplan für Inbetriebnahme und
 *     Leistung; null ohne Inbetriebnahmedatum
 * @param hergeleitetGenaehert der Satzplan rechnet für dieses Datum mit
 *     Jahresstufen (vor dem EEG 2023) - ein Näherungswert
 * @param inbetriebnahme die Inbetriebnahme der PV-Anlage (MaStR)
 * @param leistungKwp ihre Leistung; null = unbekannt (der Satzplan nimmt dann
 *     das Band bis 10 kWp)
 * @param eegEndeAm der letzte Tag der EEG-Vergütung (31.12. des 20. Jahres
 *     nach dem Inbetriebnahmejahr); null ohne Inbetriebnahmedatum
 * @param ohneVerguetungBeiNegativpreis § 51a EEG gilt (Inbetriebnahme ab
 *     25.02.2025 nach dem Datum, ohne Datum nach der Antwort des Kunden): bei
 *     negativem Börsenpreis gibt es keine Vergütung - auch nicht für einen
 *     angegebenen Satz
 * @param anzulegenderWertCtKwh bei Direktvermarktung der anzulegende Wert der
 *     Marktprämie (null = nicht hinterlegt), sonst null
 */
public record EinspeiseverguetungDto(
        String zustand,
        BigDecimal wirksamCtKwh,
        BigDecimal angegebenCtKwh,
        Boolean inbetriebnahmeAbSolarspitzengesetz,
        BigDecimal hergeleitetCtKwh,
        boolean hergeleitetGenaehert,
        LocalDate inbetriebnahme,
        BigDecimal leistungKwp,
        LocalDate eegEndeAm,
        boolean ohneVerguetungBeiNegativpreis,
        BigDecimal anzulegenderWertCtKwh) {
}
