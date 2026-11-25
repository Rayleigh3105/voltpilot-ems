package direktvermarkter

// Capability is the heartbeat capability word of the direct-marketing
// DELIVERY (vp-direktvermarktung-konzept d2 §5.7 "Zustellung"): a box
// reporting it consumes the retained partner profile, asks for and stores the
// access, acknowledges, and reports the heartbeat block direktvermarktung.
// The cloud delivers only to a box reporting it.
//
// It lives in the shared supports[] vocabulary (cloud.BuiltSupports, Go-core
// box kinds only), which the project checks byte-for-byte across three
// languages: docs/contracts/v2/edge-supports-vectors.json against
// services/api's EdgeSupports.NAMES (Java) and the portal's capability table
// - see internal/cloud/edge_supports_test.go, EdgeSupportsListenerTest.java,
// edgeSupportsVectors.test.ts.
const Capability = "direktvermarktung"
