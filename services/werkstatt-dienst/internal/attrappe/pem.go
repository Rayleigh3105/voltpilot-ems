package attrappe

import (
	"encoding/pem"
	"io"
)

func pemEncode(w io.Writer, typ string, b []byte) error {
	return pem.Encode(w, &pem.Block{Type: typ, Bytes: b})
}
