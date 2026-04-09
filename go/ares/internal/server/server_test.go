package server

import "testing"

func TestIsTarballPath(t *testing.T) {
	cases := []struct {
		path     string
		expected bool
	}{
		{path: "/react/-/react-18.3.1.tgz", expected: true},
		{path: "/@scope/pkg/-/pkg-1.0.0.tgz", expected: true},
		{path: "/react", expected: false},
		{path: "/-/v1/search", expected: false},
	}

	for _, testCase := range cases {
		if actual := isTarballPath(testCase.path); actual != testCase.expected {
			t.Fatalf("isTarballPath(%q) = %v, expected %v", testCase.path, actual, testCase.expected)
		}
	}
}

func TestIsMetadataPath(t *testing.T) {
	cases := []struct {
		path     string
		expected bool
	}{
		{path: "/react", expected: true},
		{path: "/@scope/pkg", expected: true},
		{path: "/@scope%2fpkg", expected: true},
		{path: "/-/v1/search", expected: false},
		{path: "/react/-/react-1.0.0.tgz", expected: false},
		{path: "/", expected: false},
	}

	for _, testCase := range cases {
		if actual := isMetadataPath(testCase.path); actual != testCase.expected {
			t.Fatalf("isMetadataPath(%q) = %v, expected %v", testCase.path, actual, testCase.expected)
		}
	}
}
