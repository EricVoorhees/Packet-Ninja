package parity

import "testing"

func TestCompareMetadataJSONEqual(t *testing.T) {
	left := []byte(`{"name":"demo","versions":{"1.0.0":{"dist":{"integrity":"sha512-abc"}}}}`)
	right := []byte(`{"name":"demo","versions":{"1.0.0":{"dist":{"integrity":"sha512-abc"}}}}`)

	result, err := CompareMetadataJSON(left, right, 10)
	if err != nil {
		t.Fatalf("expected no error, received %v", err)
	}

	if !result.Equal {
		t.Fatalf("expected equal payloads, received diff=%+v", result)
	}
	if result.VersionMismatchCount != 0 {
		t.Fatalf("expected no version mismatches, received %d", result.VersionMismatchCount)
	}
	if result.ChecksumMismatchCount != 0 {
		t.Fatalf("expected no checksum mismatches, received %d", result.ChecksumMismatchCount)
	}
}

func TestCompareMetadataJSONDifferences(t *testing.T) {
	ares := []byte(`{
		"name":"demo",
		"versions":{
			"1.0.0":{"dist":{"integrity":"sha512-aaa","shasum":"111"}}
		}
	}`)

	shadow := []byte(`{
		"name":"demo",
		"versions":{
			"1.0.0":{"dist":{"integrity":"sha512-bbb","shasum":"111","size":42}},
			"1.1.0":{"dist":{"integrity":"sha512-ccc","shasum":"222"}}
		}
	}`)

	result, err := CompareMetadataJSON(ares, shadow, 20)
	if err != nil {
		t.Fatalf("expected no error, received %v", err)
	}

	if result.Equal {
		t.Fatalf("expected mismatch")
	}
	if len(result.Differences) == 0 {
		t.Fatalf("expected detailed differences")
	}
	if result.MissingFieldCount == 0 {
		t.Fatalf("expected missing fields count > 0")
	}
	if result.VersionMismatchCount == 0 {
		t.Fatalf("expected version mismatch count > 0")
	}
	if result.ChecksumMismatchCount == 0 {
		t.Fatalf("expected checksum mismatch count > 0")
	}
}

func TestCompareMetadataJSONLimit(t *testing.T) {
	ares := []byte(`{"items":[0,1,2,3,4,5,6,7,8,9]}`)
	shadow := []byte(`{"items":[10,11,12,13,14,15,16,17,18,19]}`)

	result, err := CompareMetadataJSON(ares, shadow, 2)
	if err != nil {
		t.Fatalf("expected no error, received %v", err)
	}

	if len(result.Differences) != 2 {
		t.Fatalf("expected exactly 2 differences, received %d", len(result.Differences))
	}
	if !result.Truncated {
		t.Fatalf("expected truncated flag to be true when diff limit is reached")
	}
}
