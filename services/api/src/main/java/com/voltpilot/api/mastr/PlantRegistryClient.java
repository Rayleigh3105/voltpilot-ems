package com.voltpilot.api.mastr;

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

    /** Short source id for logs ("mastr-soap" / "mastr-json"). */
    default String sourceId() {
        return getClass().getSimpleName();
    }
}
