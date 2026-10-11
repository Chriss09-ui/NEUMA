# Materials parser fixtures

The small `testWORD`, `testEXCEL`, `testPPT`, and
`testPDF_no_extract_no_accessibility_owner_user.pdf` files are Apache Tika test resources,
provided under the Apache License 2.0 by the Apache Software Foundation.
Source: https://svn.apache.org/repos/asf/tika/trunk/tika-parsers/src/test/resources/test-documents/
License: https://www.apache.org/licenses/LICENSE-2.0

The encrypted PDF has a non-empty user password. Tests only verify that reading
without a password fails; they do not decrypt it or supply a password.

`paper.pdf` is a synthetic two-page PDF: the first page has native searchable text,
and the second page contains only an embedded image. It is used to verify page
rendering without OCR. Other fixtures created by the tests contain only synthetic
test text and pixels.
