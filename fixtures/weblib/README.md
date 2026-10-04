# fixtures/weblib

Library calls that write into an object. Each exported function reads `?q=`
from the URL and passes it to a built-in that stores it (`Array.push`,
`Map.set`, `Set.add`, `Object.assign`, `URLSearchParams.append`) before the
object reaches a sink. The chains appear only with library write-back on (the
default) and matching `[[propagators]]` rules in the core's catalog.

`cleanPush` and `untypedPush` must produce no chain: a write into one array does
not taint another, and a `.push` on a receiver whose type is not visible is not
given a typed name.

The fixture has no endpoints or GraphQL operations, so extraction prints the
"0 endpoints and 0 operations" warning. The core repository's end-to-end test
uses CGF extracted from this directory.
