package com.voltpilot.api.mastr;

import java.util.List;

/**
 * Anti-corruption port for plant-registry lookups (the {@code
 * DayAheadPriceSource} pattern): callers depend on this, never on MaStR
 * specifics. Two implementations exist - the official SOAP webservice
 * ({@link MastrSoapClient}, needs the captain's Webdienst credentials) and the
 * keyless public JSON backend ({@link MastrJsonClient}, the dev/fallback
 * default). A future AT/CH registry adapter implements the same port.
 */
public interface PlantRegistryClient {

    /**
     * Fetch one unit's public master data by its normalized unit number
     * (e.g. {@code SEE966831669444}).
     */
    MastrUnit fetchUnit(String unitNumber) throws RegistryLookupException;

    /**
     * All units sharing one Lokation (S2, vp-mastr-mehrere-einheiten-konzept
     * Abschnitt 5.3) - the key for "one number is enough": the customer's
     * one typed SEE number finds every unit at the same Netzanschlusspunkt.
     * Includes the unit the customer already resolved (it IS connected to
     * its own Lokation); the caller dedupes. {@code default} (rather than a
     * second abstract method) keeps this a functional interface, so the
     * single-method test fakes of {@code MastrServiceTest} - which never
     * exercise the location search - still compile as lambdas.
     */
    default List<MastrUnit> fetchUnitsAtLocation(String locationNumber) throws RegistryLookupException {
        throw new RegistryLookupException(RegistryLookupException.Reason.UNAVAILABLE,
                "Die Lokations-Suche ist für diese Quelle nicht verfügbar.");
    }

    /** Short source id for logs ("mastr-soap" / "mastr-json"). */
    default String sourceId() {
        return getClass().getSimpleName();
    }
}
