package direktvermarkter

// Capability is the heartbeat capability word this interface will announce
// once Stage 2/4 wires it in (vp-direktvermarktung-konzept d2 §9).
//
// Defined here now and used nowhere yet, on purpose. The word belongs to the
// shared supports[] vocabulary (cloud.BuiltSupports), which the project
// checks byte-for-byte across three languages: docs/contracts/v2/
// edge-supports-vectors.json against services/api's EdgeSupports.NAMES
// (Java) and frontend/portal's BOX_FAEHIGKEITEN (TS) - see internal/cloud/
// edge_supports_test.go, EdgeSupportsListenerTest.java,
// edgeSupportsVectors.test.ts. Adding the word to that chain, even reserved
// as not-yet-advertised, means editing Java and TS files, and this Stage 1
// PR is the box-side interface only (Firstmate decision 25.11.2026, Option
// A for the conflict with "out of scope: ... anything in the cloud or
// portal"). Stage 2/4 adds this constant to cloud.BuiltSupports() together
// with the matching contract/Java/TS entries, when the heartbeat actually
// has something true to say.
const Capability = "direktvermarktung"
