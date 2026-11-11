package kacoserial

import "errors"

// errorsAs keeps the standard library name out of protocol.go's imports.
func errorsAs(err error, target any) bool { return errors.As(err, target) }
