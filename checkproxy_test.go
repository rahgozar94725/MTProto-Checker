// checkProxy tests. The success path needs a real MTProxy and stays covered
// only by proxytest_test.go; everything here exercises the failure paths, and
// none of it leaves the machine — the network tests bind 127.0.0.1:0 and talk
// to their own listener, so the file needs no -short guard.
package main

import (
	"context"
	"strings"
	"testing"
)

// validSecret is 16 bytes of hex: mtproxy.ParseSecret reads that as a Simple
// secret and skips the codec-tag check, so a failure downstream of it is a
// transport failure and not an argument-validation one.
const validSecret = "000102030405060708090a0b0c0d0e0f"

// TestCheckProxyRejectsBadSecret covers the two errors checkProxy returns
// before it dials anything: the secret does not decode at all, or it decodes
// to bytes mtproxy.ParseSecret refuses.
func TestCheckProxyRejectsBadSecret(t *testing.T) {
	tests := []struct {
		name   string
		secret string
		want   string // substring of the wrap checkProxy adds
	}{
		// Neither hex nor base64 ('@' is outside both alphabets), and 'z' is
		// not in decodeSecret's trim set, so the trimmed candidate fails too.
		{"undecodable", "@@zz", "decode secret"},
		// Decodes to one byte: not 16, not more, so ParseSecret bails out.
		{"too short", "00", "create MTProxy resolver"},
		// 17 bytes makes it a Secured secret, whose first byte must be a known
		// codec tag; 0x01 is not one.
		{"unknown codec tag", "01" + validSecret, "create MTProxy resolver"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ping, err := checkProxy(context.Background(), "127.0.0.1", 443, tt.secret, 1)
			if err == nil {
				t.Fatalf("checkProxy(secret=%q) = %d, nil; want an error", tt.secret, ping)
			}
			if ping != 0 {
				t.Errorf("ping = %d, want 0 on failure", ping)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("error = %q, want it to mention %q", err, tt.want)
			}
		})
	}
}
